import fs from 'node:fs/promises'
import path from 'node:path'
import { WebmToOggOpus, WebmOggError } from './webmOgg'

/**
 * Audio that must be on disk (after pre-skip) before core gets the growing
 * file. YouTube delivers far faster than real time, so a short head start is
 * enough; core's starvation recovery covers a download that falls behind.
 */
export const READY_SAMPLES = 2 * 48_000
/**
 * Core resumes a starved growing track after two more "segments" (or 8 MiB).
 * At Opus bitrates 8 MiB is minutes of audio, so progress counts virtual
 * segments of this many Ogg bytes (~1.5 s at 160 kb/s).
 */
export const PROGRESS_SEGMENT_BYTES = 32 * 1024
const READ_CHUNK = 256 * 1024

/**
 * Follows the WebM file yt-dlp is writing (`--no-part` writes it in order) and
 * appends the equivalent Ogg Opus pages to `growingPath`. Every append is one
 * `write` of whole pages; AudioToolbox reads a truncated Ogg up to its last
 * complete page, so the file is playable at every moment.
 */
export class GrowingOpusFile {
  private handle: fs.FileHandle | null = null
  private remux: WebmToOggOpus | null = null
  private source: { path: string; formatId: string; offset: number } | null = null
  private pumping: Promise<void> = Promise.resolve()
  private closed = false
  /** Ogg bytes written so far. */
  bytes = 0

  constructor(readonly growingPath: string) {}

  /** Whether enough audio is on disk to hand the file to core. */
  get ready(): boolean {
    return !!this.remux && this.remux.ready && this.remux.samplesWritten - this.remux.preSkip >= READY_SAMPLES
  }

  get channels(): number { return this.remux?.channels ?? 0 }
  get formatId(): string | null { return this.source?.formatId ?? null }
  get attached(): boolean { return this.source !== null }

  /**
   * Start (or, after a retried download, continue) from a WebM file. A second
   * source must be the same format; its already-copied packets are skipped so
   * the Ogg stream continues seamlessly.
   */
  async attach(webmPath: string, formatId: string): Promise<void> {
    if (this.closed) throw new WebmOggError('The growing file is closed')
    if (this.source?.path === webmPath) return
    await this.pumping
    if (this.source && this.source.formatId !== formatId) {
      throw new WebmOggError('The retried download delivered a different format')
    }
    if (!this.handle) this.handle = await fs.open(this.growingPath, 'wx', 0o644)
    const state = this.remux?.resumeState
    this.remux = state
      ? new WebmToOggOpus({ skipPackets: state.packets, resume: state })
      : new WebmToOggOpus()
    this.source = { path: webmPath, formatId, offset: 0 }
  }

  /** Copy whatever the download has added since the last call. Serialized. */
  pump(): Promise<void> {
    this.pumping = this.pumping.then(() => this.pumpOnce())
    return this.pumping
  }

  private async pumpOnce(): Promise<void> {
    if (this.closed || !this.source || !this.remux || !this.handle) return
    let input: fs.FileHandle
    try { input = await fs.open(this.source.path, 'r') } catch { return }
    try {
      const buffer = Buffer.alloc(READ_CHUNK)
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, READ_CHUNK, this.source.offset)
        if (bytesRead === 0) break
        this.source.offset += bytesRead
        await this.append(this.remux.push(buffer.subarray(0, bytesRead)))
      }
    } finally {
      await input.close()
    }
  }

  private async append(pages: Buffer): Promise<void> {
    if (pages.length === 0 || !this.handle) return
    await this.handle.write(pages, 0, pages.length, this.bytes)
    this.bytes += pages.length
  }

  /** The download finished: copy the rest, write the final page with the end trim, and close. */
  async complete(): Promise<void> {
    await this.pump()
    if (!this.remux || !this.handle) throw new WebmOggError('No WebM stream was attached')
    await this.append(this.remux.finish())
    await this.handle.sync()
    await this.close()
  }

  async close(): Promise<void> {
    this.closed = true
    const handle = this.handle
    this.handle = null
    await handle?.close().catch(() => {})
  }

  /** Close and delete the growing file (a reader that opened it keeps its inode). */
  async discard(): Promise<void> {
    await this.pumping.catch(() => {})
    await this.close()
    await fs.rm(this.growingPath, { force: true }).catch(() => {})
  }
}

/** The WebM file yt-dlp is writing in `directory`, named `<videoId>.<formatId>.webm`. */
export async function findDownloadingWebm(directory: string, videoId: string): Promise<{ path: string; formatId: string } | null> {
  const entries = await fs.readdir(directory).catch(() => [] as string[])
  for (const name of entries) {
    const match = name.match(/^(.+)\.([^.]+)\.webm$/)
    if (match && match[1] === videoId) return { path: path.join(directory, name), formatId: match[2] }
  }
  return null
}
