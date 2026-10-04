import { describe, expect, it, vi } from 'vitest'
import type { ProviderHelperOutputV1, ProviderHelpersHostV1 } from 'puros-provider-sdk'
import {
  YTDLP_ARGS,
  buildYtDlpConfig,
  classifyYtDlpFailure,
  formatSelector,
  parseProgressLine,
  parseResultLine,
  runYtDlp,
  shellQuote,
} from './ytdlp'

/** Tiny shlex.split(comments=True) for single-quoted configs, as yt-dlp reads stdin. */
function shlexSplit(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let active = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === "'") quoted = false
      else current += char
    } else if (char === "'") { quoted = true; active = true } else if (char === '"') {
      const end = text.indexOf('"', index + 1)
      current += text.slice(index + 1, end)
      index = end
      active = true
    } else if (/\s/.test(char)) {
      if (active) out.push(current)
      current = ''
      active = false
    } else { current += char; active = true }
  }
  if (active) out.push(current)
  return out
}

const input = {
  videoId: 'ZFZM6jDTWd4',
  cookiePath: "/Users/x/Library/Application Support/Puros/providers/youtube-music/session-tmp/it's.txt",
  denoPath: '/Applications/Puros.app/Contents/Resources/providers/youtube-music/helper/dist/deno',
  outputDirectory: '/Users/x/cache/work/1/attempt-1',
  cacheDirectory: '/Users/x/data/yt-dlp-cache',
  allowOpus: true,
}

describe('yt-dlp configuration', () => {
  it('quotes values so shlex returns them unchanged, and refuses multi-line values', () => {
    expect(shlexSplit(shellQuote("a b'c"))).toEqual(["a b'c"])
    expect(() => shellQuote('a\nb')).toThrow()
  })

  it('passes everything on stdin with the URL last and no "--" separator', () => {
    const argv = shlexSplit(buildYtDlpConfig(input))
    expect(argv.at(-1)).toBe('https://music.youtube.com/watch?v=ZFZM6jDTWd4')
    expect(argv).not.toContain('--')
    expect(argv[argv.indexOf('--cookies') + 1]).toBe(input.cookiePath)
    expect(argv[argv.indexOf('--js-runtimes') + 1]).toBe(`deno:${input.denoPath}`)
    expect(argv.indexOf('--no-js-runtimes')).toBeLessThan(argv.indexOf('--js-runtimes'))
    expect(argv).toContain('--no-remote-components')
    expect(argv[argv.indexOf('--fixup') + 1]).toBe('never')
    expect(argv[argv.indexOf('--output') + 1]).toBe(`${input.outputDirectory}/%(id)s.%(format_id)s.%(ext)s`)
    expect(YTDLP_ARGS).toEqual(['--ignore-config', '--config-locations', '-'])
  })

  it('selects audio-only streams by codec and yt-dlp ranking, never a fixed itag, avoiding DRC', () => {
    expect(formatSelector(true)).toBe("ba[vcodec=none][acodec~='^(opus|mp4a)'][protocol=https][format_id!*=drc]/ba[vcodec=none][acodec~='^(opus|mp4a)'][protocol=https]")
    expect(formatSelector(false)).not.toContain('opus')
    expect(formatSelector(true)).not.toMatch(/\b(?:140|141|251|774)\b/)
  })
})

describe('yt-dlp output', () => {
  it('parses progress and the after_move result printed by the templates', () => {
    expect(parseProgressLine('[puros-progress] {"downloaded_bytes": 1024, "total_bytes": null, "total_bytes_estimate": 4096.5, "speed": 2048.1, "eta": 1, "status": "downloading"}'))
      .toEqual({ downloadedBytes: 1024, totalBytes: 4096.5, bytesPerSecond: 2048.1 })
    expect(parseResultLine('[puros-result] {"id": "ZFZM6jDTWd4", "format_id": "251", "acodec": "opus", "abr": 152.687, "asr": 48000, "audio_channels": 2, "ext": "webm", "container": "webm_dash", "filepath": "/w/a.webm", "filesize": 10394980, "duration": 545, "protocol": "https"}'))
      .toMatchObject({ id: 'ZFZM6jDTWd4', formatId: '251', acodec: 'opus', abrKbps: 152.687, sampleRate: 48_000, channels: 2, ext: 'webm', filesize: 10_394_980, durationSeconds: 545 })
    expect(parseResultLine('[download] 50%')).toBeNull()
  })

  it('classifies failures into typed errors without echoing helper output', () => {
    const cases: Array<[string, string, boolean]> = [
      ['WARNING: The provided YouTube account cookies are no longer valid.\nERROR: Sign in to confirm you’re not a bot', 'AUTH_EXPIRED', false],
      ['ERROR: [youtube] x: Video unavailable', 'NOT_FOUND', false],
      ['ERROR: [youtube] x: Requested format is not available', 'NOT_SUPPORTED', false],
      ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'NETWORK', true],
      ['ERROR: HTTP Error 429: Too Many Requests', 'RATE_LIMITED', true],
      ['ERROR: [youtube] x: Sign in to confirm your age', 'PERMISSION_DENIED', false],
    ]
    for (const [stderr, code, retryable] of cases) {
      const error = classifyYtDlpFailure(`${stderr}\nsecret-cookie-value`, 1)
      expect(error.providerError).toMatchObject({ code, retryable })
      expect(error.message).not.toContain('secret-cookie-value')
    }
  })
})

function fakeHelpers(script: (push: (event: ProviderHelperOutputV1) => void, stdin: string) => void) {
  const queue: ProviderHelperOutputV1[] = []
  let waiter: ((event: ProviderHelperOutputV1) => void) | null = null
  let stdin = ''
  const push = (event: ProviderHelperOutputV1) => {
    if (waiter) { const next = waiter; waiter = null; next(event) } else queue.push(event)
  }
  const helpers: ProviderHelpersHostV1 & { terminated: number } = {
    terminated: 0,
    spawn: vi.fn(async () => ({ handleId: 'h1' })),
    write: vi.fn(async ({ data }) => { stdin += typeof data === 'string' ? data : new TextDecoder().decode(data) }),
    closeStdin: vi.fn(async () => { script(push, stdin) }),
    read: vi.fn(async () => queue.shift() ?? new Promise<ProviderHelperOutputV1>((resolve) => { waiter = resolve })),
    terminate: vi.fn(async () => { helpers.terminated += 1; push({ type: 'exit', exitCode: null, signal: 'SIGTERM' }) }),
  }
  return helpers
}

const encode = (text: string) => new TextEncoder().encode(text)

describe('yt-dlp runner', () => {
  it('spawns only the declared argv, streams progress and returns the result', async () => {
    let received = ''
    const helpers = fakeHelpers((push, stdin) => {
      received = stdin
      push({ type: 'stdout', data: encode('[puros-progress] {"downloaded_bytes": 10, "total_bytes": 20}\n[puros-res') })
      push({ type: 'stdout', data: encode('ult] {"id":"ZFZM6jDTWd4","format_id":"251","acodec":"opus","ext":"webm","filepath":"/w/a.webm"}\n') })
      push({ type: 'exit', exitCode: 0, signal: null })
    })
    const progress = vi.fn()
    const result = await runYtDlp(helpers, 'config\n', { onProgress: progress })
    expect(helpers.spawn).toHaveBeenCalledWith({ binaryId: 'ytdlp', args: YTDLP_ARGS })
    expect(received).toBe('config\n')
    expect(progress).toHaveBeenCalledWith({ downloadedBytes: 10, totalBytes: 20, bytesPerSecond: null })
    expect(result.formatId).toBe('251')
  })

  it('fails on a non-zero exit even when a result line was printed', async () => {
    const helpers = fakeHelpers((push) => {
      push({ type: 'stdout', data: encode('[puros-result] {"id":"a","format_id":"1","acodec":"opus","ext":"webm","filepath":"/w"}\n') })
      push({ type: 'stderr', data: encode('ERROR: HTTP Error 403: Forbidden') })
      push({ type: 'exit', exitCode: 1, signal: null })
    })
    await expect(runYtDlp(helpers, 'x')).rejects.toMatchObject({ providerError: { code: 'NETWORK', retryable: true } })
  })

  it('terminates the helper on cancellation and on an idle timeout', async () => {
    const abort = new AbortController()
    const hanging = fakeHelpers(() => {})
    const cancelled = runYtDlp(hanging, 'x', { signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    abort.abort()
    await expect(cancelled).rejects.toMatchObject({ providerError: { code: 'CANCELLED' } })
    expect(hanging.terminated).toBeGreaterThan(0)

    const idle = fakeHelpers(() => {})
    await expect(runYtDlp(idle, 'x', { idleTimeoutMs: 20 })).rejects.toMatchObject({ providerError: { code: 'TIMEOUT' } })
    expect(idle.terminated).toBeGreaterThan(0)
  })
})
