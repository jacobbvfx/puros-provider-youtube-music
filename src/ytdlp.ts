import { ProviderApiError, providerError, type ProviderHelpersHostV1 } from 'puros-provider-sdk'
import { trackUrl } from './ids'

/**
 * yt-dlp runs as the declared `ytdlp` helper with a fixed argv
 * (`--ignore-config --config-locations -`); every option, including the URL,
 * arrives as a config file on stdin, so no path or ID ever becomes a free argv
 * atom. Tested against yt-dlp 2026.08.19 (official `yt-dlp_macos`, which
 * bundles yt-dlp-ejs 0.8.0) with Deno as the JavaScript runtime.
 */
export const YTDLP_ARGS = ['--ignore-config', '--config-locations', '-']

const PROGRESS_PREFIX = '[puros-progress] '
const RESULT_PREFIX = '[puros-result] '

/** `shlex.split`-safe single quoting (yt-dlp reads stdin config with `shlex.split(…, comments=True)`). */
export function shellQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new TypeError('yt-dlp option values must be single-line')
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Best audio-only stream in a codec core can decode, chosen by yt-dlp's own
 * format sorting (quality tier, then codec preference, then bitrate). No itag,
 * bitrate or Premium tier is assumed; YouTube's server-side DRC variants are
 * avoided when an unprocessed one exists.
 */
export function formatSelector(allowOpus: boolean): string {
  const codecs = allowOpus ? '^(opus|mp4a)' : '^mp4a'
  const base = `ba[vcodec=none][acodec~='${codecs}'][protocol=https]`
  return `${base}[format_id!*=drc]/${base}`
}

export interface YtDlpConfigInput {
  videoId: string
  cookiePath: string
  denoPath: string
  outputDirectory: string
  cacheDirectory: string
  allowOpus: boolean
}

export function buildYtDlpConfig(input: YtDlpConfigInput): string {
  const options: Array<[string, string?]> = [
    ['--no-js-runtimes'],
    ['--js-runtimes', `deno:${input.denoPath}`],
    ['--no-remote-components'],
    ['--no-plugin-dirs'],
    ['--cookies', input.cookiePath],
    ['--cache-dir', input.cacheDirectory],
    ['--no-playlist'],
    ['--no-part'],
    ['--no-mtime'],
    ['--no-write-info-json'],
    ['--no-write-thumbnail'],
    ['--no-embed-metadata'],
    ['--no-embed-thumbnail'],
    ['--fixup', 'never'],
    ['--no-overwrites'],
    ['--quiet'],
    ['--no-warnings'],
    ['--progress'],
    ['--newline'],
    ['--progress-template', `download:${PROGRESS_PREFIX}%(progress.{downloaded_bytes,total_bytes,total_bytes_estimate,speed,eta,status})j`],
    ['--print', `after_move:${RESULT_PREFIX}%(.{id,format_id,acodec,abr,asr,audio_channels,ext,container,filepath,filesize,duration,protocol})j`],
    ['--format', formatSelector(input.allowOpus)],
    ['--output', `${input.outputDirectory}/%(id)s.%(format_id)s.%(ext)s`],
    ['--socket-timeout', '20'],
    ['--retries', '3'],
    ['--fragment-retries', '3'],
  ]
  const lines = options.map(([option, value]) => value === undefined ? option : `${option} ${shellQuote(value)}`)
  // The URL goes last and without a `--` separator: that would turn the helper's own argv into URLs.
  lines.push(shellQuote(trackUrl(input.videoId)))
  return `${lines.join('\n')}\n`
}

export interface YtDlpProgress {
  downloadedBytes: number
  totalBytes: number | null
  bytesPerSecond: number | null
}

export interface YtDlpResult {
  id: string
  formatId: string
  acodec: string
  abrKbps: number | null
  sampleRate: number | null
  channels: number | null
  ext: string
  container: string | null
  filepath: string
  filesize: number | null
  durationSeconds: number | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function parseProgressLine(line: string): YtDlpProgress | null {
  const index = line.indexOf(PROGRESS_PREFIX)
  if (index < 0) return null
  try {
    const value = JSON.parse(line.slice(index + PROGRESS_PREFIX.length)) as Record<string, unknown>
    const downloaded = finite(value.downloaded_bytes)
    if (downloaded === null) return null
    return {
      downloadedBytes: downloaded,
      totalBytes: finite(value.total_bytes) ?? finite(value.total_bytes_estimate),
      bytesPerSecond: finite(value.speed),
    }
  } catch {
    return null
  }
}

export function parseResultLine(line: string): YtDlpResult | null {
  const index = line.indexOf(RESULT_PREFIX)
  if (index < 0) return null
  let value: Record<string, unknown>
  try { value = JSON.parse(line.slice(index + RESULT_PREFIX.length)) as Record<string, unknown> } catch { return null }
  if (typeof value.id !== 'string' || typeof value.format_id !== 'string' || typeof value.filepath !== 'string'
    || typeof value.acodec !== 'string' || typeof value.ext !== 'string') return null
  return {
    id: value.id,
    formatId: value.format_id,
    acodec: value.acodec,
    abrKbps: finite(value.abr),
    sampleRate: finite(value.asr),
    channels: finite(value.audio_channels),
    ext: value.ext,
    container: typeof value.container === 'string' ? value.container : null,
    filepath: value.filepath,
    filesize: finite(value.filesize),
    durationSeconds: finite(value.duration),
  }
}

/** Map yt-dlp's stderr to a typed error; never includes raw helper output. */
export function classifyYtDlpFailure(stderr: string, exitCode: number | null): ProviderApiError {
  const text = stderr.toLowerCase()
  const error = (code: Parameters<typeof providerError>[0], message: string, retryable: boolean) =>
    new ProviderApiError(providerError(code, message, { retryable, details: { helper: 'yt-dlp', exitCode: exitCode ?? -1 } }))
  if (/cookies are no longer valid|sign in to confirm you.re not a bot|login_required|please sign in/.test(text)) {
    return error('AUTH_EXPIRED', 'YouTube rejected the imported session for playback. Paste a new cookie in Settings → Accounts → YouTube Music.', false)
  }
  if (/sign in to confirm your age|age-restricted|inappropriate for some users/.test(text)) {
    return error('PERMISSION_DENIED', 'YouTube requires age verification for this track on the signed-in account', false)
  }
  if (/members-only|join this channel|requires payment|premium members/.test(text)) {
    return error('PERMISSION_DENIED', 'This track is not available to the signed-in account', false)
  }
  if (/video unavailable|this video is not available|video has been removed|private video|not available in your country|this video is unavailable/.test(text)) {
    return error('NOT_FOUND', 'This track is unavailable on YouTube Music', false)
  }
  if (/requested format is not available|no video formats found/.test(text)) {
    return error('NOT_SUPPORTED', 'YouTube offered no audio-only AAC or Opus stream for this track', false)
  }
  if (/http error 429|too many requests/.test(text)) return error('RATE_LIMITED', 'YouTube is rate limiting playback requests; try again shortly', true)
  if (/http error 403|forbidden|http error 5\d\d|timed out|timeout|connection|temporary failure|unable to download/.test(text)) {
    return error('NETWORK', 'Downloading the YouTube Music stream failed; it will be retried', true)
  }
  if (/js challenge|n challenge|signature|javascript runtime|jsc/.test(text)) {
    return error('PROVIDER_UNAVAILABLE', 'yt-dlp could not solve the YouTube player challenge', true)
  }
  return error('INTERNAL', `yt-dlp failed (exit ${exitCode ?? 'signal'})`, false)
}

export interface RunYtDlpOptions {
  signal?: AbortSignal
  onProgress?(progress: YtDlpProgress): void | Promise<void>
  /** Terminate when the helper prints nothing for this long. */
  idleTimeoutMs?: number
  /** Hard cap for one run. */
  totalTimeoutMs?: number
}

const MAX_STDERR = 64 * 1024

/** Run one yt-dlp download; resolves with its `after_move` result. */
export async function runYtDlp(helpers: ProviderHelpersHostV1, config: string, options: RunYtDlpOptions = {}): Promise<YtDlpResult> {
  const { handleId } = await helpers.spawn({ binaryId: 'ytdlp', args: YTDLP_ARGS })
  let stopReason: 'cancelled' | 'idle' | 'total' | null = null
  const stop = (reason: 'cancelled' | 'idle' | 'total') => {
    stopReason ??= reason
    void helpers.terminate(handleId).catch(() => {})
  }
  const onAbort = () => stop('cancelled')
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const idleMs = options.idleTimeoutMs ?? 120_000
  let idleTimer = setTimeout(() => stop('idle'), idleMs)
  const totalTimer = setTimeout(() => stop('total'), options.totalTimeoutMs ?? 8 * 60_000)
  const touch = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stop('idle'), idleMs)
  }
  const decoder = new TextDecoder()
  const errorDecoder = new TextDecoder()
  let pending = ''
  let stderr = ''
  let result: YtDlpResult | null = null
  const acceptLine = async (line: string) => {
    const progress = parseProgressLine(line)
    if (progress) {
      await options.onProgress?.(progress)
      return
    }
    result = parseResultLine(line) ?? result
  }
  try {
    if (options.signal?.aborted) stop('cancelled')
    await helpers.write({ handleId, data: config })
    await helpers.closeStdin(handleId)
    while (true) {
      const event = await helpers.read(handleId)
      touch()
      if (event.type === 'stdout') {
        pending += decoder.decode(event.data, { stream: true })
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          await acceptLine(line)
        }
      } else if (event.type === 'stderr') {
        stderr = (stderr + errorDecoder.decode(event.data, { stream: true })).slice(-MAX_STDERR)
      } else if (event.type === 'error') {
        throw new ProviderApiError(providerError('INTERNAL', 'The yt-dlp helper failed to run', { retryable: false }))
      } else if (event.type === 'exit') {
        pending += decoder.decode()
        if (pending.trim()) await acceptLine(pending)
        if (stopReason === 'cancelled') throw new ProviderApiError(providerError('CANCELLED', 'YouTube Music download cancelled', { retryable: true }))
        if (stopReason) throw new ProviderApiError(providerError('TIMEOUT', 'yt-dlp stopped responding while downloading', { retryable: true }))
        const finished = result as YtDlpResult | null
        if (event.exitCode !== 0 || !finished) throw classifyYtDlpFailure(stderr, event.exitCode)
        return finished
      }
    }
  } catch (error) {
    await helpers.terminate(handleId).catch(() => {})
    throw error
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
