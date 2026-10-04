import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderApiError, providerError, type ProviderEventV1 } from 'puros-provider-sdk'
import { packet, readOgg, webm } from './fixtures/webm'
import { YtmPlaybackRuntime } from './playback'
import { READY_SAMPLES } from './progressive'
import type { YtDlpResult } from './ytdlp'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const PACKETS = Array.from({ length: 1500 }, (_, index) => packet(index)) // 30 s of 20 ms Opus packets
const DISCARD_NS = 6_833_333 // 328 samples
const SOURCE = webm(PACKETS, { discardNs: DISCARD_NS })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function configValue(config: string, option: string): string {
  const line = config.split('\n').find((entry) => entry.startsWith(`${option} `))!
  return line.slice(option.length + 2, -1)
}

type Attempt = { ext?: 'webm' | 'm4a'; failAfter?: number; gate?: Promise<void> }

function setup(attempts: Attempt[] = [{}]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ytm-progressive-'))
  roots.push(root)
  const cacheRoot = fs.realpathSync(fs.mkdirSync(path.join(root, 'cache'), { recursive: true }) ?? path.join(root, 'cache'))
  const resourceRoot = path.join(root, 'resources')
  fs.mkdirSync(path.join(resourceRoot, 'helper', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(resourceRoot, 'helper', 'dist', 'deno'), '')
  const events: ProviderEventV1[] = []
  const puts: Array<{ path: string }> = []
  let run = 0
  /** Writes the WebM in 40 chunks, 25 ms apart, like yt-dlp's sequential `--no-part` download. */
  const runYtDlp = async (_helpers: unknown, config: string, options?: { signal?: AbortSignal; onProgress?: (p: { downloadedBytes: number; totalBytes: number; bytesPerSecond: number }) => void }) => {
    const attempt = attempts[Math.min(run++, attempts.length - 1)]
    const ext = attempt.ext ?? 'webm'
    const output = configValue(config, '--output').replace('%(id)s.%(format_id)s.%(ext)s', `ZFZM6jDTWd4.${ext === 'webm' ? '251' : '140'}.${ext}`)
    const body = ext === 'webm' ? SOURCE : Buffer.from('m4a-bytes')
    const chunk = Math.ceil(body.length / 40)
    for (let offset = 0; offset < body.length; offset += chunk) {
      if (options?.signal?.aborted) throw new ProviderApiError(providerError('CANCELLED', 'cancelled', { retryable: true }))
      if (attempt.failAfter !== undefined && offset >= body.length * attempt.failAfter) {
        throw new ProviderApiError(providerError('NETWORK', 'HTTP 403', { retryable: true }))
      }
      fs.appendFileSync(output, body.subarray(offset, offset + chunk))
      options?.onProgress?.({ downloadedBytes: offset + chunk, totalBytes: body.length, bytesPerSecond: 1 })
      await sleep(25)
      if (offset === 0) await attempt.gate
    }
    return {
      id: 'ZFZM6jDTWd4', formatId: ext === 'webm' ? '251' : '140', acodec: ext === 'webm' ? 'opus' : 'mp4a.40.2',
      abrKbps: 150, sampleRate: ext === 'webm' ? 48_000 : 44_100, channels: 2, ext, container: null,
      filepath: output, filesize: body.length, durationSeconds: 30,
    } satisfies YtDlpResult
  }
  const runtime = new YtmPlaybackRuntime({
    host: {
      paths: { getCacheRoot: async () => cacheRoot, getDataRoot: async () => path.join(root, 'data'), getResourceRoot: async () => resourceRoot },
      helpers: {} as never,
      cache: {
        get: async () => null,
        inspectFormat: async () => null,
        canPlayFormat: async () => true,
        put: async (entry) => { puts.push(entry) },
        trim: async () => {},
      },
      catalog: { getStoredTrack: async () => null, getPlaybackRecoverySeed: async () => null, listTracksNeedingFormat: async () => [], updateTrackFormat: async () => {} },
      events: { emit: async (event) => { events.push(event) } },
      logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
    },
    session: {
      status: () => ({ state: 'connected', account: { name: 'A', handle: null } }),
      accountKey: () => 'acct',
      markExpired: () => {},
      async withCookieFile(task) { return task(path.join(root, 'cookies.txt')) },
    },
    runYtDlp: runYtDlp as never,
    remux: (async (_helpers: unknown, _kind: string, input: string, output: string) => { fs.copyFileSync(input, output) }) as never,
    probeDurationMs: (async () => 30_000) as never,
    sleep: async () => {},
  })
  const sessionEvents = () => events.filter((event): event is Extract<ProviderEventV1, { type: 'playback.session' }> => event.type === 'playback.session').map((event) => event.session)
  const completion = () => new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (sessionEvents().some((session) => ['completed', 'failed', 'cancelled'].includes(session.state))) { clearInterval(timer); resolve() }
    }, 10)
  })
  return { runtime, events, puts, cacheRoot, sessionEvents, completion }
}

describe('progressive Opus playback', () => {
  it('hands core a growing Ogg Opus file mid-download and finalizes it in place', { timeout: 20_000 }, async () => {
    const { runtime, puts, cacheRoot, sessionEvents, completion, events } = setup()
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-123' })
    expect(artifact).toMatchObject({ lifecycle: 'growing', sessionId: 'session-123', format: { format: 'OPUS', sampleRate: 48_000, bitDepth: 0, isLossless: false } })
    expect(path.dirname(artifact.path)).toBe(path.join(cacheRoot, 'audio', 'acct'))
    // The download is still running, yet the file already holds complete, playable pages.
    expect(puts).toHaveLength(0)
    const partial = readOgg(fs.readFileSync(artifact.path))
    expect(partial.pages.every((page) => page.headerType !== 4)).toBe(true)
    expect(partial.packets.length - 2).toBeGreaterThanOrEqual(READY_SAMPLES / 960)
    runtime.markPlaybackStarted('session-123')

    await completion()
    const states = sessionEvents().map((session) => session.state)
    expect(states[0]).toBe('created')
    expect(states).toContain('running')
    expect(states.at(-1)).toBe('completed')
    const done = sessionEvents().at(-1)!
    expect(done.artifactPath).toBe(path.join(cacheRoot, 'audio', 'acct', 'ZFZM6jDTWd4.251.r1.ogg'))
    expect(done.format).toMatchObject({ format: 'OPUS', bitrate: 150 })
    expect(done.playbackStarted).toBe(true)
    expect(puts).toEqual([expect.objectContaining({ path: done.artifactPath })])
    // Same inode, renamed: the growing path is gone, the final file is complete and end-trimmed.
    expect(fs.existsSync(artifact.path)).toBe(false)
    const final = readOgg(fs.readFileSync(done.artifactPath!))
    expect(final.packets.slice(2)).toEqual(PACKETS)
    expect(final.pages.at(-1)).toMatchObject({ headerType: 4, granule: BigInt(1500 * 960 - 328) })
    // Progress advances in virtual segments with a monotonic revision shared with session events.
    const revisions = events.map((event) => event.type === 'playback.progress' ? event.progress.revision : event.type === 'playback.session' ? event.session.revision : null).filter((value): value is number => value !== null)
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
    const segments = events.flatMap((event) => event.type === 'playback.progress' && event.progress.itemsCompleted != null ? [event.progress.itemsCompleted] : [])
    expect(segments.at(-1)).toBeGreaterThan(segments[0])
    expect(fs.readdirSync(path.join(cacheRoot, 'work'))).toEqual([])
  })

  it('gives prefetch and a joined caller the finished file only', { timeout: 20_000 }, async () => {
    const { runtime } = setup()
    const [growing, prefetched] = await Promise.all([
      runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-123' }),
      runtime.prefetch({ sourceId: 'ZFZM6jDTWd4' }),
    ])
    expect(growing.lifecycle).toBe('growing')
    expect(prefetched).toMatchObject({ lifecycle: 'complete' })
  })

  it('streams a prefetch that is still downloading when playback catches up with it', { timeout: 20_000 }, async () => {
    let release!: () => void
    const { runtime, puts, sessionEvents, completion } = setup([{ gate: new Promise<void>((resolve) => { release = resolve }) }])
    const prefetched = runtime.prefetch({ sourceId: 'ZFZM6jDTWd4' })
    await sleep(50) // the prefetch download has started and is paused after its first chunk
    const playing = runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-456' })
    release()
    const artifact = await playing
    expect(artifact).toMatchObject({ lifecycle: 'growing', sessionId: 'session-456', format: { format: 'OPUS' } })
    expect(puts).toHaveLength(0)
    await completion()
    const done = sessionEvents().at(-1)!
    expect(done).toMatchObject({ sessionId: 'session-456', state: 'completed' })
    // One download serves both: the prefetch gets the same finished file.
    expect(await prefetched).toMatchObject({ lifecycle: 'complete', path: done.artifactPath })
    expect(puts).toHaveLength(1)
    const final = readOgg(fs.readFileSync(done.artifactPath!))
    expect(final.packets.slice(2)).toEqual(PACKETS)
  })

  it('continues the same Ogg stream when a retried download resumes after an expired stream URL', { timeout: 20_000 }, async () => {
    const { runtime, sessionEvents, completion } = setup([{ failAfter: 0.5 }, {}])
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-123' })
    expect(artifact.lifecycle).toBe('growing')
    await completion()
    const done = sessionEvents().at(-1)!
    expect(done.state).toBe('completed')
    const final = readOgg(fs.readFileSync(done.artifactPath!))
    expect(final.packets.slice(2)).toEqual(PACKETS)
    expect(final.pages.at(-1)!.granule).toBe(BigInt(1500 * 960 - 328))
  })

  it('reports a failed session and deletes the growing file when the download cannot finish', { timeout: 20_000 }, async () => {
    const { runtime, sessionEvents, completion, puts } = setup([{ failAfter: 0.5 }, { failAfter: 0 }, { failAfter: 0 }])
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-123' })
    await completion()
    expect(sessionEvents().at(-1)).toMatchObject({ state: 'failed', error: { code: 'NETWORK' } })
    expect(fs.existsSync(artifact.path)).toBe(false)
    expect(puts).toEqual([])
    await expect(runtime.prefetch({ sourceId: 'ZFZM6jDTWd4' })).resolves.toBeNull()
  })

  it('cancels a running session', { timeout: 20_000 }, async () => {
    const { runtime, sessionEvents, completion } = setup()
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-123' })
    expect(await runtime.cancelSession('session-123')).toBe(true)
    await completion()
    expect(sessionEvents().at(-1)).toMatchObject({ state: 'cancelled' })
    expect(fs.existsSync(artifact.path)).toBe(false)
  })

  it('uses the finished-file path for AAC even with a session', { timeout: 20_000 }, async () => {
    const { runtime, sessionEvents } = setup([{ ext: 'm4a' }])
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-123' })
    expect(artifact).toMatchObject({ lifecycle: 'complete', format: { format: 'AAC' } })
    expect(sessionEvents().at(-1)).toMatchObject({ state: 'completed', artifactPath: artifact.path })
  })
})
