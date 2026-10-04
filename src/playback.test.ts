import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderApiError, providerError, type FormatInfoV1 } from 'puros-provider-sdk'
import { YtmPlaybackRuntime, lossyFormat } from './playback'
import type { YtDlpResult } from './ytdlp'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function configValue(config: string, option: string): string {
  const line = config.split('\n').find((entry) => entry.startsWith(`${option} `))!
  return line.slice(option.length + 2, -1).replace(/'"'"'/g, "'")
}

function setup(options: {
  opus?: boolean
  result?: Partial<YtDlpResult>
  durationMs?: number | null
  failures?: ProviderApiError[]
  sessionState?: 'connected' | 'expired' | 'signed-out'
  hold?: Promise<void>
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ytm-playback-'))
  roots.push(root)
  const cacheRoot = fs.realpathSync(fs.mkdirSync(path.join(root, 'cache'), { recursive: true }) ?? path.join(root, 'cache'))
  const dataRoot = path.join(root, 'data')
  const resourceRoot = path.join(root, 'resources')
  fs.mkdirSync(path.join(resourceRoot, 'helper', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(resourceRoot, 'helper', 'dist', 'deno'), '')
  const cache = new Map<string, { path: string; format: FormatInfoV1; resolvedSourceId: string }>()
  const configs: string[] = []
  const failures = [...(options.failures ?? [])]
  const cookieFiles: string[] = []
  const runYtDlp = vi.fn(async (_helpers: unknown, config: string, runOptions?: { signal?: AbortSignal }) => {
    configs.push(config)
    await options.hold
    if (runOptions?.signal?.aborted) throw new ProviderApiError(providerError('CANCELLED', 'cancelled', { retryable: true }))
    const failure = failures.shift()
    if (failure) throw failure
    const opus = config.includes('opus')
    const output = configValue(config, '--output').replace('%(id)s.%(format_id)s.%(ext)s', opus ? 'ZFZM6jDTWd4.251.webm' : 'ZFZM6jDTWd4.140.m4a')
    fs.writeFileSync(output, 'audio-bytes')
    return {
      id: 'ZFZM6jDTWd4', formatId: opus ? '251' : '140', acodec: opus ? 'opus' : 'mp4a.40.2', abrKbps: opus ? 152.687 : 129.51,
      sampleRate: opus ? 48_000 : 44_100, channels: 2, ext: opus ? 'webm' : 'm4a', container: null, filepath: output,
      filesize: 11, durationSeconds: 545, ...options.result,
    } satisfies YtDlpResult
  })
  const remux = vi.fn(async (_helpers: unknown, _kind: 'ogg' | 'm4a', input: string, output: string) => { fs.copyFileSync(input, output) })
  const probeDurationMs = vi.fn(async () => options.durationMs === undefined ? 545_020 : options.durationMs)
  const markExpired = vi.fn()
  const puts: unknown[] = []
  const events: unknown[] = []
  const runtime = new YtmPlaybackRuntime({
    host: {
      paths: { getCacheRoot: async () => cacheRoot, getDataRoot: async () => dataRoot, getResourceRoot: async () => resourceRoot },
      helpers: {} as never,
      cache: {
        get: async ({ sourceId, qualityKey }) => cache.get(`${qualityKey}:${sourceId}`) ?? null,
        inspectFormat: async () => null,
        canPlayFormat: async (format) => format !== 'OPUS' || options.opus !== false,
        put: async (entry) => { puts.push(entry); cache.set(`${entry.qualityKey}:${entry.sourceId}`, { path: entry.path, format: entry.format, resolvedSourceId: entry.resolvedSourceId! }) },
        trim: async () => {},
      },
      catalog: { getStoredTrack: async () => null, getPlaybackRecoverySeed: async () => null, listTracksNeedingFormat: async () => [], updateTrackFormat: async () => {} },
      events: { emit: async (event) => { events.push(event) } },
      logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
    },
    session: {
      status: () => ({ state: options.sessionState ?? 'connected', account: options.sessionState === 'signed-out' ? null : { name: 'A', handle: null } }),
      accountKey: () => (options.sessionState ?? 'connected') === 'connected' ? 'acct' : null,
      markExpired,
      async withCookieFile(task) {
        const file = path.join(root, `cookies-${cookieFiles.length}.txt`)
        cookieFiles.push(file)
        fs.writeFileSync(file, '# Netscape HTTP Cookie File\n', { mode: 0o600 })
        try { return await task(file) } finally { fs.rmSync(file, { force: true }) }
      },
    },
    runYtDlp: runYtDlp as never,
    remux: remux as never,
    probeDurationMs: probeDurationMs as never,
    sleep: async () => {},
  })
  return { runtime, runYtDlp, remux, probeDurationMs, puts, events, configs, cacheRoot, markExpired, cookieFiles }
}

describe('YouTube Music playback preparation', () => {
  it('produces a complete, cached Opus artifact at 48 kHz and cleans up intermediates', async () => {
    const { runtime, puts, cacheRoot, remux, cookieFiles, events } = setup()
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-123' })
    expect(artifact).toMatchObject({ lifecycle: 'complete', format: { format: 'OPUS', sampleRate: 48_000, bitDepth: 0, bitrate: 153, channels: 2, isLossless: false, isHiRes: false } })
    expect(path.dirname(artifact.path)).toBe(path.join(cacheRoot, 'audio', 'acct'))
    expect(path.basename(artifact.path)).toBe('ZFZM6jDTWd4.251.r1.ogg')
    expect(remux.mock.calls[0][1]).toBe('ogg')
    expect(puts).toEqual([expect.objectContaining({ sourceId: 'ZFZM6jDTWd4', resolvedSourceId: 'ZFZM6jDTWd4', resolvedQuality: 'OPUS-251', qualityKey: 'best-opus-aac-r1-acct' })])
    expect(fs.readdirSync(path.join(cacheRoot, 'work'))).toEqual([])
    expect(fs.readdirSync(path.join(cacheRoot, 'audio', 'acct'))).toEqual(['ZFZM6jDTWd4.251.r1.ogg'])
    expect(cookieFiles.every((file) => !fs.existsSync(file))).toBe(true)
    expect(events.some((event) => (event as { progress?: { state: string } }).progress?.state === 'completed')).toBe(true)
  })

  it('uses the cache afterwards and downloads each track once for concurrent callers', async () => {
    const { runtime, runYtDlp } = setup()
    const [a, b] = await Promise.all([
      runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' }),
      runtime.prefetch({ sourceId: 'ZFZM6jDTWd4' }),
    ])
    expect(a.path).toBe(b!.path)
    await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })
    expect(runYtDlp).toHaveBeenCalledOnce()
  })

  it('asks for AAC only when this Mac cannot decode Ogg Opus, and keeps it in M4A', async () => {
    const { runtime, configs, remux, puts } = setup({ opus: false })
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })
    expect(configs[0]).not.toContain('opus')
    expect(remux.mock.calls[0][1]).toBe('m4a')
    expect(artifact.format).toMatchObject({ format: 'AAC', sampleRate: 44_100, bitDepth: 0, bitrate: 130, isLossless: false })
    expect(puts[0]).toMatchObject({ qualityKey: 'best-aac-r1-acct' })
  })

  it('retries transient failures a bounded number of times', async () => {
    const network = () => new ProviderApiError(providerError('NETWORK', 'x', { retryable: true }))
    const recovered = setup({ failures: [network()] })
    await expect(recovered.runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).resolves.toMatchObject({ lifecycle: 'complete' })
    expect(recovered.runYtDlp).toHaveBeenCalledTimes(2)
    const exhausted = setup({ failures: [network(), network(), network(), network()] })
    await expect(exhausted.runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'NETWORK' } })
    expect(exhausted.runYtDlp).toHaveBeenCalledTimes(3)
    expect(exhausted.puts).toEqual([])
  })

  it('marks the session expired when yt-dlp is refused, without retrying', async () => {
    const { runtime, runYtDlp, markExpired } = setup({ failures: [new ProviderApiError(providerError('AUTH_EXPIRED', 'x', { retryable: false }))] })
    await expect(runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    expect(runYtDlp).toHaveBeenCalledOnce()
    expect(markExpired).toHaveBeenCalledOnce()
  })

  it('never publishes a file whose decoded length or identity is wrong', async () => {
    const short = setup({ durationMs: 120_000 })
    await expect(short.runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).rejects.toThrow(/unexpected length/)
    expect(short.puts).toEqual([])
    expect(fs.readdirSync(path.join(short.cacheRoot, 'audio', 'acct'))).toEqual([])
    const other = setup({ result: { id: 'aaaaaaaaaaa' } })
    await expect(other.runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).rejects.toThrow(/different video/)
    const truncated = setup({ result: { filesize: 99 } })
    await expect(truncated.runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'NETWORK' } })
  })

  it('cancels a session’s download and reports prefetch failures as null', async () => {
    let release!: () => void
    const { runtime } = setup({ hold: new Promise((resolve) => { release = resolve }) })
    const pending = runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'session-abc' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await runtime.cancelSession('session-abc')).toBe(true)
    release()
    await expect(pending).rejects.toMatchObject({ providerError: { code: 'CANCELLED' } })
    expect(await runtime.cancelSession('unknown-session')).toBe(false)
    const failing = setup({ failures: [new ProviderApiError(providerError('NOT_FOUND', 'gone', { retryable: false }))] })
    await expect(failing.runtime.prefetch({ sourceId: 'ZFZM6jDTWd4' })).resolves.toBeNull()
  })

  it('requires a live session and a valid video ID', async () => {
    await expect(setup({ sessionState: 'signed-out' }).runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
    await expect(setup({ sessionState: 'expired' }).runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    await expect(setup().runtime.resolve({ sourceId: '../etc/passwd', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
  })
})

describe('lossy format labels', () => {
  it('reports the Opus decode rate and never a source bit depth or lossless flag', () => {
    expect(lossyFormat('OPUS', { sampleRate: 44_100, channels: 2, bitrateKbps: 160.4 })).toEqual({
      format: 'OPUS', sampleRate: 48_000, bitDepth: 0, bitrate: 160, channels: 2, isLossless: false, isHiRes: false, isMqa: false, isDsd: false,
    })
    expect(lossyFormat('AAC', { sampleRate: 44_100, channels: 2, bitrateKbps: 256 })).toMatchObject({ sampleRate: 44_100, bitDepth: 0, isLossless: false, isHiRes: false })
  })
})
