import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PROVIDER_SESSION_ID_PATTERN,
  ProviderApiError,
  providerError,
  type FormatInfoV1,
  type PlaybackArtifactV1,
  type PlaybackResolveRequestV1,
  type ProviderErrorV1,
  type ProviderHostV1,
  type ProviderPlaybackSessionStateV1,
} from 'puros-provider-sdk'
import { probeDurationMs, remux } from './ffmpeg'
import { requireVideoId } from './ids'
import { applyOggOpusEndTrim, webmOpusDiscardSamples } from './opusTrim'
import { GrowingOpusFile, PROGRESS_SEGMENT_BYTES, findDownloadingWebm } from './progressive'
import type { YtmSessionService } from './session'
import { buildYtDlpConfig, runYtDlp, type YtDlpProgress, type YtDlpResult } from './ytdlp'

/** Bump when the preparation pipeline changes so older cache entries are not reused. */
export const PREPARATION_REVISION = 1
const AUDIO_DIR = 'audio'
const WORK_DIR = 'work'
const MAX_CONCURRENT = 2
const MAX_ATTEMPTS = 3
const DURATION_TOLERANCE_MS = 2_000
const RETRYABLE = new Set(['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE'])
const TAIL_INTERVAL_MS = 200

type Host = Pick<ProviderHostV1, 'paths' | 'cache' | 'helpers' | 'logger' | 'catalog'> & { events: Pick<ProviderHostV1['events'], 'emit'> }
type Session = Pick<YtmSessionService, 'withCookieFile' | 'accountKey' | 'status' | 'markExpired'>
type Intent = 'playback' | 'prefetch'

export interface PlaybackDeps {
  host: Host
  session: Session
  runYtDlp?: typeof runYtDlp
  remux?: typeof remux
  probeDurationMs?: typeof probeDurationMs
  sleep?: (ms: number) => Promise<void>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  let settled = false
  const promise = new Promise<T>((ok, fail) => {
    resolve = (value) => { settled = true; ok(value) }
    reject = (error) => { settled = true; fail(error) }
  })
  promise.catch(() => {})
  return { promise, resolve, reject, get settled() { return settled } }
}

interface ProgressiveSession {
  sessionId: string
  revision: number
  playbackStarted: boolean
  state: ProviderPlaybackSessionStateV1
}

interface Job {
  key: string
  sourceId: string
  intent: Intent
  abort: AbortController
  sessions: Set<string>
  /** First usable artifact: a growing Ogg (progressive Opus) or the finished file. */
  artifact: ReturnType<typeof deferred<PlaybackArtifactV1>>
  /** The finished, verified, cached artifact. */
  done: ReturnType<typeof deferred<PlaybackArtifactV1>>
  progressive: ProgressiveSession | null
  /** Set while yt-dlp downloads: turns this download into a progressive session for a caller. */
  startProgressive: ((sessionId: string) => void) | null
}

function apiError(code: ProviderErrorV1['code'], message: string, retryable = false): ProviderApiError {
  return new ProviderApiError(providerError(code, message, { retryable }))
}

function errorCode(error: unknown): string {
  return error instanceof ProviderApiError ? error.providerError.code : 'INTERNAL'
}

function errorShape(error: unknown): ProviderErrorV1 {
  if (error instanceof ProviderApiError) return error.providerError
  return providerError('INTERNAL', error instanceof Error ? error.message.slice(0, 500) : 'YouTube Music playback preparation failed', { retryable: false })
}

/** Strict v1 fields only (host values may carry extra members). */
export function plainFormat(format: FormatInfoV1): FormatInfoV1 {
  return {
    format: format.format,
    sampleRate: format.sampleRate,
    bitDepth: format.bitDepth,
    bitrate: Number.isFinite(format.bitrate) ? Math.round(format.bitrate) : 0,
    channels: format.channels,
    isLossless: format.isLossless,
    isHiRes: format.isHiRes,
    isMqa: format.isMqa,
    isDsd: format.isDsd,
  }
}

/**
 * What the file really is: a lossy codec at its decode rate, with no source
 * bit depth and never a lossless/Hi-Res label. Opus always decodes at 48 kHz,
 * whatever "input sample rate" its header records.
 */
export function lossyFormat(codec: 'OPUS' | 'AAC', input: { sampleRate: number | null; channels: number | null; bitrateKbps: number | null }): FormatInfoV1 {
  return {
    format: codec,
    sampleRate: codec === 'OPUS' ? 48_000 : Math.round(input.sampleRate ?? 0),
    bitDepth: 0,
    bitrate: Math.max(0, Math.round(input.bitrateKbps ?? 0)),
    channels: Math.max(0, Math.round(input.channels ?? 0)),
    isLossless: false,
    isHiRes: false,
    isMqa: false,
    isDsd: false,
  }
}

export function codecOf(acodec: string): 'OPUS' | 'AAC' | null {
  const value = acodec.toLowerCase()
  if (value === 'opus') return 'OPUS'
  if (value.startsWith('mp4a')) return 'AAC'
  return null
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * yt-dlp → stream-copy remux → verified file artifact in the provider cache.
 *
 * Each track is downloaded once (single flight), at most two at a time with
 * playback ahead of prefetch. With a caller session and Opus, playback starts
 * from a growing Ogg Opus file that is remuxed while yt-dlp downloads the WebM
 * (`playback.progressive`), also when playback catches up with a prefetch that
 * is still downloading; AAC and prefetch use the finished file. Either way
 * the artifact becomes `complete` only after yt-dlp exited cleanly, the file
 * decoded end to end, and its length matched the length YouTube reported.
 */
export class YtmPlaybackRuntime {
  private readonly jobs = new Map<string, Job>()
  private readonly sessions = new Map<string, Job>()
  private readonly queue: Array<{ job: Job; start: () => void }> = []
  private running = 0
  private active = true
  private opusSupport: Promise<boolean> | null = null
  private readonly runYtDlp: typeof runYtDlp
  private readonly remux: typeof remux
  private readonly probe: typeof probeDurationMs
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: PlaybackDeps) {
    this.runYtDlp = deps.runYtDlp ?? runYtDlp
    this.remux = deps.remux ?? remux
    this.probe = deps.probeDurationMs ?? probeDurationMs
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private get host() { return this.deps.host }

  /** Drop intermediates of a previous run that crashed or was killed. */
  async cleanupStaleFiles(): Promise<void> {
    const root = await this.host.paths.getCacheRoot()
    await fs.rm(path.join(root, WORK_DIR), { recursive: true, force: true }).catch(() => {})
    const entries = await fs.readdir(path.join(root, AUDIO_DIR), { recursive: true, withFileTypes: true }).catch(() => [])
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith('.tmp-'))
      .map((entry) => fs.rm(path.join(entry.parentPath, entry.name), { force: true }).catch(() => {})))
  }

  async resolve(request: PlaybackResolveRequestV1): Promise<PlaybackArtifactV1> {
    const context = await this.context(request.sourceId)
    const cached = await this.cached(request.sourceId, context.qualityKey)
    if (cached) return cached
    const sessionId = request.intent === 'playback' && request.sessionId && PROVIDER_SESSION_ID_PATTERN.test(request.sessionId)
      ? request.sessionId : undefined
    return this.join(request.sourceId, context, request.intent, sessionId).artifact.promise
  }

  async prefetch(request: Omit<PlaybackResolveRequestV1, 'intent'>): Promise<PlaybackArtifactV1 | null> {
    try {
      const context = await this.context(request.sourceId)
      const cached = await this.cached(request.sourceId, context.qualityKey)
      if (cached) return cached
      // Gapless queueing needs a finished file, never a growing one.
      return await this.join(request.sourceId, context, 'prefetch', undefined).done.promise
    } catch (error) {
      if (errorCode(error) !== 'CANCELLED') {
        await this.host.logger.info('YouTube Music prefetch skipped', { sourceId: request.sourceId, code: errorCode(error) }).catch(() => {})
      }
      return null
    }
  }

  /** Cancel the work a caller session waits on; shared work stops once nobody waits. */
  async cancelSession(sessionId: string): Promise<boolean> {
    const job = this.sessions.get(sessionId)
    if (!job) return false
    this.sessions.delete(sessionId)
    job.sessions.delete(sessionId)
    if (job.sessions.size === 0 && job.intent === 'playback') job.abort.abort()
    return true
  }

  /** `playback.progressive`: core started reading the growing file. */
  markPlaybackStarted(sessionId: string): void {
    const job = this.sessions.get(sessionId)
    if (!job?.progressive || job.progressive.playbackStarted) return
    job.progressive.playbackStarted = true
    void this.emitSession(job)
  }

  async cancelAll(): Promise<void> {
    for (const job of this.jobs.values()) job.abort.abort()
    for (const { job } of this.queue.splice(0)) {
      const cancelled = apiError('CANCELLED', 'YouTube Music download cancelled', true)
      job.artifact.reject(cancelled)
      job.done.reject(cancelled)
    }
  }

  async shutdown(): Promise<void> {
    this.active = false
    await this.cancelAll()
  }

  /** Whether any download is in flight; stale-file cleanup must wait for none. */
  busy(): boolean { return this.jobs.size > 0 }

  // ---- context and cache ----

  private canPlayOpus(): Promise<boolean> {
    this.opusSupport ??= Promise.resolve().then(() => this.host.cache.canPlayFormat('OPUS')).catch(() => false)
    return this.opusSupport
  }

  private async context(sourceId: string) {
    if (!this.active) throw apiError('PROVIDER_UNAVAILABLE', 'YouTube Music provider is inactive', true)
    requireVideoId(sourceId)
    const status = this.deps.session.status()
    if (status.state === 'expired') throw apiError('AUTH_EXPIRED', 'Your YouTube Music session has expired. Paste a new cookie in Settings → Accounts → YouTube Music.')
    const account = this.deps.session.accountKey()
    if (!account) throw apiError('NOT_AUTHENTICATED', 'Connect YouTube Music in Settings → Accounts')
    const allowOpus = await this.canPlayOpus()
    return { account, allowOpus, qualityKey: `best-${allowOpus ? 'opus-aac' : 'aac'}-r${PREPARATION_REVISION}-${account}` }
  }

  private async cached(sourceId: string, qualityKey: string): Promise<PlaybackArtifactV1 | null> {
    const cached = await this.host.cache.get({ sourceId, qualityKey })
    if (!cached || cached.resolvedSourceId !== sourceId) return null
    if (cached.format.format === 'OPUS' && !await this.canPlayOpus()) return null
    return { path: cached.path, lifecycle: 'complete', format: plainFormat(cached.format) }
  }

  // ---- scheduling ----

  private join(sourceId: string, context: { account: string; allowOpus: boolean; qualityKey: string }, intent: Intent, sessionId: string | undefined): Job {
    const key = `${context.qualityKey}:${sourceId}`
    const existing = this.jobs.get(key)
    const job: Job = existing ?? {
      key, sourceId, intent, abort: new AbortController(), sessions: new Set(),
      artifact: deferred(), done: deferred(), progressive: null, startProgressive: null,
    }
    if (sessionId) {
      job.sessions.add(sessionId)
      this.sessions.set(sessionId, job)
    }
    if (!existing) {
      const created = job
      this.jobs.set(key, created)
      this.queue.push({ job: created, start: () => {
        void this.run(created, context).finally(() => {
          if (this.jobs.get(key) === created) this.jobs.delete(key)
          for (const session of created.sessions) if (this.sessions.get(session) === created) this.sessions.delete(session)
          this.running -= 1
          this.pump()
        })
      } })
      this.sortQueue()
      this.pump()
    } else if (intent === 'playback') {
      if (job.intent === 'prefetch') {
        job.intent = 'playback'
        this.sortQueue()
      }
      // Playback caught up with a prefetch that is still downloading: stream it instead of waiting for the finished file.
      if (sessionId) job.startProgressive?.(sessionId)
    }
    return job
  }

  private sortQueue(): void {
    const rank = (entry: { job: Job }) => (entry.job.intent === 'playback' ? 0 : 1)
    this.queue.sort((a, b) => rank(a) - rank(b))
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const next = this.queue.shift()!
      if (next.job.abort.signal.aborted) {
        const cancelled = apiError('CANCELLED', 'YouTube Music download cancelled', true)
        next.job.artifact.reject(cancelled)
        next.job.done.reject(cancelled)
        this.jobs.delete(next.job.key)
        continue
      }
      this.running += 1
      next.start()
    }
  }

  // ---- the download ----

  private nextRevision(job: Job, local: { revision: number }): number {
    // One counter for session and progress events: core reopens a starved growing file only after it advances.
    if (job.progressive) {
      job.progressive.revision += 1
      return job.progressive.revision
    }
    local.revision += 1
    return local.revision
  }

  private async emitSession(job: Job, extra: { artifactPath?: string; format?: FormatInfoV1; error?: ProviderErrorV1 } = {}): Promise<void> {
    const session = job.progressive
    if (!session) return
    session.revision += 1
    await this.host.events.emit({
      type: 'playback.session',
      session: {
        sessionId: session.sessionId,
        sourceId: job.sourceId,
        state: session.state,
        playbackStarted: session.playbackStarted,
        revision: session.revision,
        ...(extra.artifactPath ? { artifactPath: extra.artifactPath } : {}),
        ...(extra.format ? { format: extra.format } : {}),
        ...(extra.error ? { error: extra.error } : {}),
      },
    }).catch(() => {})
  }

  private async emitProgress(
    job: Job,
    progress: YtDlpProgress | null,
    growingBytes: number | null,
    startedAt: number,
    state: 'running' | 'completed',
    local: { revision: number },
  ): Promise<void> {
    const target = job.progressive?.sessionId ?? [...job.sessions][0]
    if (!target) return
    const downloaded = progress?.downloadedBytes ?? 0
    const total = progress?.totalBytes ?? null
    const elapsed = Math.max(1, Date.now() - startedAt)
    const bytesCompleted = growingBytes ?? downloaded
    await this.host.events.emit({
      type: 'playback.progress',
      progress: {
        sessionId: target,
        sourceId: job.sourceId,
        state,
        bytesCompleted,
        bytesTotal: total,
        ...(growingBytes !== null ? {
          // Virtual segments of the growing Ogg (its size tracks the WebM's closely).
          itemsCompleted: Math.floor(growingBytes / PROGRESS_SEGMENT_BYTES),
          itemsTotal: total ? Math.max(1, Math.ceil(total / PROGRESS_SEGMENT_BYTES)) : null,
        } : {}),
        percent: state === 'completed' ? 100 : total ? Math.min(99, (downloaded / total) * 100) : null,
        bytesPerSecond: progress?.bytesPerSecond ?? Math.round((downloaded / elapsed) * 1000),
        estimatedRemainingMs: null,
        playbackStarted: job.progressive?.playbackStarted ?? false,
        revision: this.nextRevision(job, local),
      },
    }).catch(() => {})
  }

  private async run(job: Job, context: { account: string; allowOpus: boolean; qualityKey: string }): Promise<void> {
    const signal = job.abort.signal
    const cacheRoot = await this.host.paths.getCacheRoot()
    const workDirectory = path.join(cacheRoot, WORK_DIR, randomUUID())
    const audioDirectory = path.join(cacheRoot, AUDIO_DIR, context.account)
    const startedAt = Date.now()
    const local = { revision: 0 }
    let lastEmit = 0
    let lastProgress: YtDlpProgress | null = null
    let growing: GrowingOpusFile | null = null
    let attemptDirectory: string | null = null
    let tailTimer: ReturnType<typeof setInterval> | null = null
    let tailing: Promise<void> = Promise.resolve()
    let tailFailure: unknown = null
    let outcome: { ok: true; artifact: PlaybackArtifactV1 } | { ok: false; error: unknown }

    const handOut = async () => {
      if (!growing || !job.progressive || job.artifact.settled || !growing.ready) return
      job.progressive.state = 'running'
      await this.emitSession(job)
      job.artifact.resolve({
        path: growing.growingPath,
        lifecycle: 'growing',
        // The bitrate is known once the download completes; the completed session event carries it.
        format: lossyFormat('OPUS', { sampleRate: 48_000, channels: growing.channels, bitrateKbps: null }),
        sessionId: job.progressive.sessionId,
      })
    }

    const tail = async () => {
      if (!growing || !attemptDirectory || tailFailure) return
      try {
        const found = await findDownloadingWebm(attemptDirectory, job.sourceId)
        if (found) await growing.attach(found.path, found.formatId)
        if (!growing.attached) return
        await growing.pump()
        await handOut()
        const now = Date.now()
        if (now - lastEmit >= 250) {
          lastEmit = now
          await this.emitProgress(job, lastProgress, growing.bytes, startedAt, 'running', local)
        }
      } catch (error) {
        if (job.artifact.settled) {
          // Core already plays the growing file: this download cannot continue it.
          tailFailure = error
          job.abort.abort()
          return
        }
        // Not handed out yet: fall back to the download-first path for this track.
        await this.host.logger.warn('YouTube Music progressive remux unavailable; finishing the download first', {
          sourceId: job.sourceId, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        }).catch(() => {})
        const abandoned = growing
        growing = null
        await abandoned?.discard()
      }
    }

    const startProgressive = (sessionId: string) => {
      if (!context.allowOpus || job.progressive || tailFailure || signal.aborted) return
      job.progressive = { sessionId, revision: 0, playbackStarted: false, state: 'created' }
      growing = new GrowingOpusFile(path.join(audioDirectory, `.tmp-growing-${job.sourceId}.${randomUUID()}.ogg`))
      void this.emitSession(job)
      tailTimer = setInterval(() => { tailing = tailing.then(tail) }, TAIL_INTERVAL_MS)
    }

    try {
      await fs.mkdir(workDirectory, { recursive: true, mode: 0o700 })
      await fs.mkdir(audioDirectory, { recursive: true })
      const again = await this.cached(job.sourceId, context.qualityKey)
      if (again) {
        outcome = { ok: true, artifact: again }
        return
      }
      const resourceRoot = await this.host.paths.getResourceRoot()
      const denoPath = path.join(resourceRoot, 'helper', 'dist', 'deno')
      if (!await fs.access(denoPath).then(() => true, () => false)) {
        throw apiError('PROVIDER_UNAVAILABLE', 'The YouTube Music playback helpers are missing; rebuild or reinstall the provider')
      }
      const caller = job.intent === 'playback' ? [...job.sessions][0] : undefined
      if (caller) startProgressive(caller)
      job.startProgressive = startProgressive
      const downloaded = await this.download(job, context, denoPath, workDirectory, signal, async (progress) => {
        lastProgress = progress
        if (growing) return // the tail loop reports progress with the growing file's size
        const now = Date.now()
        if (now - lastEmit < 250) return
        lastEmit = now
        await this.emitProgress(job, progress, null, startedAt, 'running', local)
      }, (directory) => { attemptDirectory = directory })
      // The WebM is complete: a caller arriving now gets the finished file.
      job.startProgressive = null
      if (tailTimer) clearInterval(tailTimer)
      tailTimer = null
      await tailing
      if (tailFailure) throw tailFailure
      const growingFile = growing as GrowingOpusFile | null
      const useGrowing = !!growingFile && growingFile.attached && downloaded.ext === 'webm'
        && codecOf(downloaded.acodec) === 'OPUS' && growingFile.formatId === downloaded.formatId
      if (!useGrowing) await growingFile?.discard()
      const artifact = useGrowing
        ? await this.finalizeGrowing(job, downloaded, growingFile!, audioDirectory, signal)
        : await this.finalize(job, downloaded, audioDirectory, signal)
      await this.host.cache.put({
        sourceId: job.sourceId,
        qualityKey: context.qualityKey,
        path: artifact.path,
        format: artifact.format,
        resolvedSourceId: job.sourceId,
        resolvedQuality: `${artifact.format.format}-${downloaded.formatId}`,
      })
      await this.host.cache.trim().catch(() => {})
      await this.host.catalog.updateTrackFormat({ sourceId: job.sourceId, format: artifact.format }).catch(() => {})
      await this.emitProgress(job, { downloadedBytes: 1, totalBytes: 1, bytesPerSecond: null }, useGrowing ? growingFile!.bytes : null, startedAt, 'completed', local)
      outcome = { ok: true, artifact }
    } catch (error) {
      const cancelled = signal.aborted && !tailFailure
      const failure = cancelled && errorCode(error) !== 'CANCELLED' ? apiError('CANCELLED', 'YouTube Music download cancelled', true) : tailFailure ?? error
      outcome = { ok: false, error: failure }
    } finally {
      job.startProgressive = null
      if (tailTimer) clearInterval(tailTimer)
      await tailing.catch(() => {})
      if (!outcome!.ok) await (growing as GrowingOpusFile | null)?.discard()
      // Intermediates (the downloaded WebM/M4A, a partial Ogg) are gone before anyone sees the result.
      await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => {})
      if (outcome!.ok && job.progressive) {
        job.progressive.state = 'completed'
        await this.emitSession(job, { artifactPath: outcome!.artifact.path, format: outcome!.artifact.format })
      }
      if (!outcome!.ok && job.progressive && job.progressive.state !== 'completed') {
        const cancelled = errorCode(outcome!.error) === 'CANCELLED'
        job.progressive.state = cancelled ? 'cancelled' : 'failed'
        await this.emitSession(job, cancelled ? {} : { error: errorShape(outcome!.error) })
      }
      if (outcome!.ok) {
        job.artifact.resolve(outcome!.artifact)
        job.done.resolve(outcome!.artifact)
      } else {
        job.artifact.reject(outcome!.error)
        job.done.reject(outcome!.error)
      }
    }
  }

  /** yt-dlp with a bounded retry for transient failures (e.g. an expired stream URL answering 403). */
  private async download(
    job: Job,
    context: { allowOpus: boolean },
    denoPath: string,
    workDirectory: string,
    signal: AbortSignal,
    onProgress: (progress: YtDlpProgress) => Promise<void>,
    onAttempt: (directory: string) => void = () => {},
  ): Promise<YtDlpResult> {
    const dataRoot = await this.host.paths.getDataRoot()
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) throw apiError('CANCELLED', 'YouTube Music download cancelled', true)
      const attemptDirectory = path.join(workDirectory, `attempt-${attempt}`)
      await fs.mkdir(attemptDirectory, { recursive: true, mode: 0o700 })
      onAttempt(attemptDirectory)
      try {
        const result = await this.deps.session.withCookieFile((cookiePath) => this.runYtDlp(this.host.helpers, buildYtDlpConfig({
          videoId: job.sourceId,
          cookiePath,
          denoPath,
          outputDirectory: attemptDirectory,
          cacheDirectory: path.join(dataRoot, 'yt-dlp-cache'),
          allowOpus: context.allowOpus,
        }), { signal, onProgress }))
        return await this.verifyDownload(job, result, attemptDirectory)
      } catch (error) {
        const code = errorCode(error)
        if (code === 'AUTH_EXPIRED') {
          this.deps.session.markExpired()
          await this.host.events.emit({ type: 'warning', code: 'auth_expired', message: 'Your YouTube Music session expired. Paste a new cookie in Settings → Accounts → YouTube Music.', retryable: false }).catch(() => {})
        }
        if (!RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS || signal.aborted) throw error
        await this.host.logger.warn('YouTube Music download failed; retrying', { sourceId: job.sourceId, code, attempt }).catch(() => {})
        await this.sleep(code === 'RATE_LIMITED' ? 5_000 * attempt : 1_500 * attempt)
      }
    }
  }

  /** The exact requested video, one audio-only file inside our work directory, fully written. */
  private async verifyDownload(job: Job, result: YtDlpResult, attemptDirectory: string): Promise<YtDlpResult> {
    if (result.id !== job.sourceId) throw apiError('INTERNAL', 'yt-dlp returned a different video than requested')
    if (!codecOf(result.acodec)) throw apiError('NOT_SUPPORTED', `yt-dlp selected an unsupported codec (${result.acodec})`)
    const real = await fs.realpath(result.filepath).catch(() => null)
    if (!real || !isInside(real, await fs.realpath(attemptDirectory))) throw apiError('INTERNAL', 'yt-dlp wrote outside its work directory')
    const stat = await fs.stat(real)
    if (!stat.isFile() || stat.size === 0) throw apiError('INTERNAL', 'yt-dlp produced no audio file')
    if (result.filesize !== null && result.filesize > 0 && stat.size !== result.filesize) {
      throw apiError('NETWORK', 'The YouTube Music download is incomplete', true)
    }
    return { ...result, filepath: real }
  }

  /** The growing Ogg becomes the cached artifact once it is closed and verified like any other file. */
  private async finalizeGrowing(job: Job, downloaded: YtDlpResult, growing: GrowingOpusFile, audioDirectory: string, signal: AbortSignal): Promise<PlaybackArtifactV1> {
    await growing.complete()
    const final = path.join(audioDirectory, `${job.sourceId}.${downloaded.formatId}.r${PREPARATION_REVISION}.ogg`)
    const format = await this.verifyPrepared(growing.growingPath, 'OPUS', downloaded, signal)
    // A reader that opened the growing path keeps its inode; the completed session event names the final path.
    await fs.rename(growing.growingPath, final)
    return { path: final, lifecycle: 'complete', format }
  }

  /** Decode the whole file, compare its length with YouTube's, and describe it. */
  private async verifyPrepared(file: string, codec: 'OPUS' | 'AAC', downloaded: YtDlpResult, signal: AbortSignal): Promise<FormatInfoV1> {
    if (signal.aborted) throw apiError('CANCELLED', 'YouTube Music download cancelled', true)
    const durationMs = await this.probe(this.host.helpers, file, signal)
    const expectedMs = downloaded.durationSeconds !== null ? downloaded.durationSeconds * 1000 : null
    if (durationMs === null || durationMs <= 0
      || (expectedMs !== null && Math.abs(durationMs - expectedMs) > Math.max(DURATION_TOLERANCE_MS, expectedMs * 0.02))) {
      throw apiError('INTERNAL', 'The prepared YouTube Music audio has an unexpected length', true)
    }
    const inspected = await this.host.cache.inspectFormat(file).catch(() => null)
    if (inspected && inspected.format !== codec) throw apiError('INTERNAL', `The prepared file is ${inspected.format}, not ${codec}`)
    const stat = await fs.stat(file)
    const measuredKbps = durationMs > 0 ? (stat.size * 8) / durationMs : null
    const format = lossyFormat(codec, {
      sampleRate: inspected?.sampleRate || downloaded.sampleRate,
      channels: inspected?.channels || downloaded.channels,
      // YouTube's declared average bitrate of the stream; the file-size estimate includes container overhead.
      bitrateKbps: downloaded.abrKbps ?? measuredKbps,
    })
    if (format.channels <= 0 || format.sampleRate <= 0) throw apiError('INTERNAL', 'The prepared YouTube Music audio has no readable stream info')
    if (signal.aborted) throw apiError('CANCELLED', 'YouTube Music download cancelled', true)
    return format
  }

  private async finalize(job: Job, downloaded: YtDlpResult, audioDirectory: string, signal: AbortSignal): Promise<PlaybackArtifactV1> {
    const codec = codecOf(downloaded.acodec)!
    const extension = codec === 'OPUS' ? 'ogg' : 'm4a'
    const temporary = path.join(audioDirectory, `.tmp-${job.sourceId}.${randomUUID()}.${extension}`)
    const final = path.join(audioDirectory, `${job.sourceId}.${downloaded.formatId}.r${PREPARATION_REVISION}.${extension}`)
    try {
      await this.remux(this.host.helpers, codec === 'OPUS' ? 'ogg' : 'm4a', downloaded.filepath, temporary, signal)
      if (codec === 'OPUS' && downloaded.ext === 'webm') {
        await applyOggOpusEndTrim(temporary, await webmOpusDiscardSamples(downloaded.filepath))
      }
      const format = await this.verifyPrepared(temporary, codec, downloaded, signal)
      await fs.rename(temporary, final)
      return { path: final, lifecycle: 'complete', format }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }
}
