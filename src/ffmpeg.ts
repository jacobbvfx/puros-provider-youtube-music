import { ProviderApiError, providerError, type ProviderHelpersHostV1 } from 'puros-provider-sdk'

/**
 * Exact argv of the manifest's ffmpeg helpers. Both remuxes are `-c:a copy`:
 * the encoded audio is moved into a container AudioToolbox opens, never
 * re-encoded, resampled or processed.
 */
export function remuxArguments(kind: 'ogg' | 'm4a', input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-c:a', 'copy', '-map_metadata', '-1',
    ...(kind === 'ogg' ? ['-f', 'ogg'] : ['-movflags', '+faststart', '-f', 'ipod']),
    output,
  ]
}

export function probeArguments(input: string): string[] {
  return ['-hide_banner', '-nostdin', '-threads', '1', '-i', input, '-map', '0:a:0', '-f', 'null', '-']
}

const MAX_STDERR = 64 * 1024

async function runFfmpeg(helpers: ProviderHelpersHostV1, binaryId: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { handleId } = await helpers.spawn({ binaryId, args })
  const onAbort = () => { void helpers.terminate(handleId).catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const decoder = new TextDecoder()
  let stderr = ''
  try {
    await helpers.closeStdin(handleId)
    while (true) {
      const event = await helpers.read(handleId)
      if (event.type === 'stderr') stderr = (stderr + decoder.decode(event.data, { stream: true })).slice(-MAX_STDERR)
      else if (event.type === 'error') throw new ProviderApiError(providerError('INTERNAL', 'The ffmpeg helper failed to run', { retryable: false }))
      else if (event.type === 'exit') {
        if (signal?.aborted) throw new ProviderApiError(providerError('CANCELLED', 'YouTube Music audio preparation cancelled', { retryable: true }))
        if (event.exitCode !== 0) {
          throw new ProviderApiError(providerError('INTERNAL', `ffmpeg ${binaryId} failed (exit ${event.exitCode ?? event.signal})`, { retryable: false }))
        }
        return stderr
      }
    }
  } catch (error) {
    await helpers.terminate(handleId).catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function remux(helpers: ProviderHelpersHostV1, kind: 'ogg' | 'm4a', input: string, output: string, signal?: AbortSignal): Promise<void> {
  await runFfmpeg(helpers, kind === 'ogg' ? 'remux-ogg' : 'remux-m4a', remuxArguments(kind, input, output), signal)
}

/** Last `time=HH:MM:SS.xx` ffmpeg printed while decoding the whole file. */
export function parseFfmpegDurationMs(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)]
  const last = matches[matches.length - 1]
  if (!last) return null
  return Math.round(((Number(last[1]) * 60 + Number(last[2])) * 60 + Number(last[3])) * 1000)
}

/** Decode the prepared file end to end; proves it is complete and returns its length. */
export async function probeDurationMs(helpers: ProviderHelpersHostV1, input: string, signal?: AbortSignal): Promise<number | null> {
  return parseFfmpegDurationMs(await runFfmpeg(helpers, 'probe', probeArguments(input), signal))
}
