import { randomInt } from 'node:crypto'
import { oggCrc } from './opusTrim'

/**
 * Incremental WebM (Matroska) → Ogg Opus remuxer for progressive playback.
 *
 * It is a stream copy: every Opus packet of the WebM audio track is written
 * unchanged into Ogg pages (RFC 7845); only the container changes. The OpusHead
 * comes verbatim from the WebM CodecPrivate (so pre-skip is kept), and the final
 * block's `DiscardPadding` becomes the end-trim granule of the last page.
 *
 * Bytes can be pushed in arbitrary chunks as the download grows. Complete pages
 * are emitted for everything except a short tail (`HOLDBACK_SAMPLES`) that is
 * kept back until `finish()`, so the end trim always falls inside the last page.
 */

const ID_SEGMENT = 0x18538067
const ID_CLUSTER = 0x1f43b675
const ID_TRACKS = 0x1654ae6b
const ID_TRACK_ENTRY = 0xae
const ID_TRACK_NUMBER = 0xd7
const ID_TRACK_TYPE = 0x83
const ID_CODEC_ID = 0x86
const ID_CODEC_PRIVATE = 0x63a2
const ID_SIMPLE_BLOCK = 0xa3
const ID_BLOCK_GROUP = 0xa0
const ID_BLOCK = 0xa1
const ID_DISCARD_PADDING = 0x75a2

/** Containers the parser steps into; their children arrive over time. */
const STREAMING_CONTAINERS = new Set([ID_SEGMENT, ID_CLUSTER])
/** Small elements parsed only once fully downloaded. */
const WHOLE_ELEMENTS = new Set([ID_TRACKS, ID_SIMPLE_BLOCK, ID_BLOCK_GROUP])

const SAMPLE_RATE = 48_000
/** Kept back until the end so the final page can carry the end trim (≥ any Opus packet). */
export const HOLDBACK_SAMPLES = 6 * 960
/** Target audio per page while streaming (~0.5 s): small pages keep the growing file fresh. */
const PAGE_TARGET_SAMPLES = 24_000
const MAX_PAGE_SEGMENTS = 255

export class WebmOggError extends Error {}

interface Vint { value: number; length: number; unknown: boolean }

function readVint(buffer: Buffer, offset: number, keepMarker: boolean): Vint | 'more' | null {
  if (offset >= buffer.length) return 'more'
  const first = buffer[offset]
  if (first === 0) return null
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1
  if (length > 8) return null
  if (offset + length > buffer.length) return 'more'
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = (first & (0xff >> length)) === (0xff >> length)
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index]
    if (buffer[offset + index] !== 0xff) allOnes = false
  }
  return { value, length, unknown: !keepMarker && allOnes }
}

function readUnsigned(buffer: Buffer, start: number, end: number): number {
  let value = 0
  for (let index = start; index < end; index += 1) value = value * 256 + buffer[index]
  return value
}

function readSigned(buffer: Buffer, start: number, end: number): number {
  const size = end - start
  if (size < 1 || size > 8) return 0
  let value = BigInt(0)
  for (let index = start; index < end; index += 1) value = (value << BigInt(8)) | BigInt(buffer[index])
  if (buffer[start] & 0x80) value -= BigInt(1) << BigInt(8 * size)
  return Number(value)
}

/** Children of a fully available element body. */
function* children(buffer: Buffer, start: number, end: number): Generator<{ id: number; start: number; end: number }> {
  let offset = start
  while (offset < end) {
    const id = readVint(buffer, offset, true)
    if (!id || id === 'more') throw new WebmOggError('Malformed WebM element')
    const size = readVint(buffer, offset + id.length, false)
    if (!size || size === 'more' || size.unknown) throw new WebmOggError('Malformed WebM element size')
    const bodyStart = offset + id.length + size.length
    const bodyEnd = bodyStart + size.value
    if (bodyEnd > end) throw new WebmOggError('WebM element overruns its parent')
    yield { id: id.value, start: bodyStart, end: bodyEnd }
    offset = bodyEnd
  }
}

/** Opus packet duration in 48 kHz samples, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Buffer): number {
  if (packet.length === 0) throw new WebmOggError('Empty Opus packet')
  const config = packet[0] >> 3
  const frameSize = config < 12 ? [480, 960, 1920, 2880][config & 3]
    : config < 16 ? [480, 960][config & 1]
      : [120, 240, 480, 960][config & 3]
  const code = packet[0] & 3
  const frames = code === 0 ? 1 : code === 3 ? (packet.length > 1 ? packet[1] & 0x3f : 0) : 2
  if (frames === 0 || frames * frameSize > 5760) throw new WebmOggError('Invalid Opus packet')
  return frames * frameSize
}

/** The frames of a Matroska block, undoing Xiph, fixed-size or EBML lacing. */
function blockFrames(buffer: Buffer, start: number, end: number, flags: number): Buffer[] {
  const lacing = (flags >> 1) & 3
  if (lacing === 0) return [buffer.subarray(start, end)]
  if (start >= end) throw new WebmOggError('Malformed laced block')
  const count = buffer[start] + 1
  let offset = start + 1
  const sizes: number[] = []
  if (lacing === 1) {
    for (let index = 0; index < count - 1; index += 1) {
      let size = 0
      let byte: number
      do {
        if (offset >= end) throw new WebmOggError('Malformed Xiph lacing')
        byte = buffer[offset++]
        size += byte
      } while (byte === 255)
      sizes.push(size)
    }
  } else if (lacing === 3) {
    const first = readVint(buffer, offset, false)
    if (!first || first === 'more') throw new WebmOggError('Malformed EBML lacing')
    offset += first.length
    sizes.push(first.value)
    for (let index = 1; index < count - 1; index += 1) {
      const delta = readVint(buffer, offset, false)
      if (!delta || delta === 'more') throw new WebmOggError('Malformed EBML lacing')
      offset += delta.length
      const bias = 2 ** (7 * delta.length - 1) - 1
      sizes.push(sizes[sizes.length - 1] + delta.value - bias)
    }
  }
  const total = end - offset
  if (lacing === 2) {
    if (total % count !== 0) throw new WebmOggError('Malformed fixed lacing')
    for (let index = 0; index < count - 1; index += 1) sizes.push(total / count)
  }
  const last = total - sizes.reduce((sum, size) => sum + size, 0)
  if (last < 0 || sizes.some((size) => size < 0)) throw new WebmOggError('Malformed lacing sizes')
  sizes.push(last)
  const frames: Buffer[] = []
  for (const size of sizes) {
    frames.push(buffer.subarray(offset, offset + size))
    offset += size
  }
  return frames
}

interface QueuedPacket { data: Buffer; samples: number }

export interface WebmOggOptions {
  /** Packets already delivered by an earlier run of the same stream; they are skipped (resume). */
  skipPackets?: number
  /** Ogg stream serial; random by default. */
  serial?: number
  /** Emit the OpusHead/OpusTags pages (false when resuming into an existing file). */
  writeHeaders?: boolean
  /** Continue page numbering and granules of an existing file (resume). */
  resume?: { pageSequence: number; granule: number; serial: number }
}

export class WebmToOggOpus {
  private pending: Buffer = Buffer.alloc(0)
  private skipBytes = 0
  private audioTrack: number | null = null
  private headerWritten = false
  private readonly writeHeaders: boolean
  private readonly serial: number
  private sequence: number
  private granule: number
  private readonly queue: QueuedPacket[] = []
  private queuedSamples = 0
  private toSkip: number
  private discardNs = 0
  private finished = false
  /** Packets taken from the WebM (including skipped ones). */
  packetsSeen = 0
  /** 48 kHz samples written into completed pages (raw, including pre-skip). */
  samplesWritten = 0
  preSkip = 0
  channels = 0

  constructor(options: WebmOggOptions = {}) {
    this.writeHeaders = options.writeHeaders ?? !options.resume
    this.serial = options.resume?.serial ?? options.serial ?? randomInt(1, 0x7fffffff)
    this.sequence = options.resume?.pageSequence ?? 0
    this.granule = options.resume?.granule ?? 0
    this.samplesWritten = this.granule
    this.toSkip = options.skipPackets ?? 0
  }

  /** State needed to continue this Ogg stream from another download of the same WebM. */
  get resumeState() { return { pageSequence: this.sequence, granule: this.granule, serial: this.serial, packets: this.packetsSeen - this.queue.length } }

  /** Whether the Opus stream headers have been found (and, if requested, written). */
  get ready(): boolean { return this.headerWritten }

  /** Feed the next downloaded bytes; returns Ogg bytes to append (possibly empty). */
  push(chunk: Buffer): Buffer {
    if (this.finished) throw new WebmOggError('Remuxer already finished')
    if (this.skipBytes > 0) {
      const skipped = Math.min(this.skipBytes, chunk.length)
      this.skipBytes -= skipped
      chunk = chunk.subarray(skipped)
    }
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const output: Buffer[] = []
    let offset = 0
    while (true) {
      const id = readVint(this.pending, offset, true)
      if (id === 'more') break
      if (!id) throw new WebmOggError('Malformed WebM element ID')
      const size = readVint(this.pending, offset + id.length, false)
      if (size === 'more') break
      if (!size) throw new WebmOggError('Malformed WebM element size')
      const bodyStart = offset + id.length + size.length
      if (STREAMING_CONTAINERS.has(id.value)) {
        offset = bodyStart
        continue
      }
      if (size.unknown) throw new WebmOggError('WebM element of unknown size')
      const bodyEnd = bodyStart + size.value
      if (WHOLE_ELEMENTS.has(id.value)) {
        if (bodyEnd > this.pending.length) break
        this.element(id.value, bodyStart, bodyEnd, output)
        offset = bodyEnd
        continue
      }
      // Anything else (EBML header, SeekHead, Info, Cues, Void, Cluster timecode…) is skipped.
      if (bodyEnd > this.pending.length) {
        this.skipBytes = bodyEnd - this.pending.length
        offset = this.pending.length
        break
      }
      offset = bodyEnd
    }
    this.pending = this.pending.subarray(offset)
    // Copy the remainder so the (large) consumed chunk can be released.
    if (this.pending.length > 0) this.pending = Buffer.from(this.pending)
    this.flushPages(false, output)
    return Buffer.concat(output)
  }

  /**
   * The download is complete: write every held-back packet and close the
   * stream with the end trim. Throws if the WebM ended mid-element.
   */
  finish(): Buffer {
    if (this.finished) return Buffer.alloc(0)
    if (this.pending.length > 0 || this.skipBytes > 0) throw new WebmOggError('The WebM stream ended mid-element')
    if (!this.headerWritten && this.writeHeaders) throw new WebmOggError('The WebM stream has no Opus track')
    this.finished = true
    const output: Buffer[] = []
    this.flushPages(true, output)
    return Buffer.concat(output)
  }

  private element(id: number, start: number, end: number, output: Buffer[]): void {
    const buffer = this.pending
    if (id === ID_TRACKS) {
      for (const entry of children(buffer, start, end)) {
        if (entry.id !== ID_TRACK_ENTRY) continue
        let number: number | null = null
        let type: number | null = null
        let codec: string | null = null
        let codecPrivate: Buffer | null = null
        for (const field of children(buffer, entry.start, entry.end)) {
          if (field.id === ID_TRACK_NUMBER) number = readUnsigned(buffer, field.start, field.end)
          else if (field.id === ID_TRACK_TYPE) type = readUnsigned(buffer, field.start, field.end)
          else if (field.id === ID_CODEC_ID) codec = buffer.toString('ascii', field.start, field.end).replace(/\0+$/, '')
          else if (field.id === ID_CODEC_PRIVATE) codecPrivate = Buffer.from(buffer.subarray(field.start, field.end))
        }
        if (codec !== 'A_OPUS' || number === null || (type !== null && type !== 2)) continue
        if (!codecPrivate || codecPrivate.length < 19 || codecPrivate.toString('ascii', 0, 8) !== 'OpusHead') {
          throw new WebmOggError('The WebM Opus track has no OpusHead')
        }
        this.audioTrack = number
        this.channels = codecPrivate[9]
        this.preSkip = codecPrivate.readUInt16LE(10)
        if (this.writeHeaders) {
          output.push(this.page([codecPrivate], 0x02, 0))
          output.push(this.page([opusTags()], 0x00, 0))
        }
        this.headerWritten = true
        return
      }
      throw new WebmOggError('The WebM stream has no Opus audio track')
    }
    let blockStart = start
    let blockEnd = end
    let discardNs = 0
    if (id === ID_BLOCK_GROUP) {
      let found = false
      for (const child of children(buffer, start, end)) {
        if (child.id === ID_BLOCK) { blockStart = child.start; blockEnd = child.end; found = true }
        else if (child.id === ID_DISCARD_PADDING) discardNs = readSigned(buffer, child.start, child.end)
      }
      if (!found) return
    }
    const track = readVint(buffer, blockStart, false)
    if (!track || track === 'more' || blockStart + track.length + 3 > blockEnd) throw new WebmOggError('Malformed WebM block')
    if (this.audioTrack === null || track.value !== this.audioTrack) return
    const flags = buffer[blockStart + track.length + 2]
    const frames = blockFrames(buffer, blockStart + track.length + 3, blockEnd, flags)
    // Only the stream's last block carries end padding; any later block cancels it.
    this.discardNs = discardNs > 0 ? discardNs : 0
    for (const frame of frames) {
      this.packetsSeen += 1
      if (this.toSkip > 0) { this.toSkip -= 1; continue }
      const data = Buffer.from(frame)
      const samples = opusPacketSamples(data)
      this.queue.push({ data, samples })
      this.queuedSamples += samples
    }
  }

  private flushPages(final: boolean, output: Buffer[]): void {
    if (!this.headerWritten && this.writeHeaders) return
    while (this.queue.length > 0) {
      const available = final ? this.queuedSamples : this.queuedSamples - HOLDBACK_SAMPLES
      if (!final && available < PAGE_TARGET_SAMPLES) return
      const packets: QueuedPacket[] = []
      let samples = 0
      let segments = 0
      while (this.queue.length > 0) {
        const next = this.queue[0]
        const nextSegments = Math.floor(next.data.length / 255) + 1
        if (packets.length > 0 && (segments + nextSegments > MAX_PAGE_SEGMENTS || samples >= PAGE_TARGET_SAMPLES)) break
        if (!final && this.queuedSamples - next.samples < HOLDBACK_SAMPLES) break
        this.queue.shift()
        this.queuedSamples -= next.samples
        packets.push(next)
        samples += next.samples
        segments += nextSegments
      }
      if (packets.length === 0) return
      this.granule += samples
      const last = final && this.queue.length === 0
      let granule = this.granule
      if (last) {
        const discard = Math.round(this.discardNs * SAMPLE_RATE / 1e9)
        // RFC 7845 §4.4: end trimming may only remove samples of the final page.
        if (discard > 0 && discard < samples) granule -= discard
      }
      output.push(this.page(packets.map((packet) => packet.data), last ? 0x04 : 0x00, granule))
      this.samplesWritten = granule
    }
    if (final && this.queue.length === 0 && this.sequence > 0 && !output.length) {
      // No audio arrived after the last flush: close the stream with an empty EOS page.
      output.push(this.page([], 0x04, this.granule))
    }
  }

  private page(packets: Buffer[], headerType: number, granule: number): Buffer {
    const lacing: number[] = []
    for (const packet of packets) {
      let length = packet.length
      while (length >= 255) { lacing.push(255); length -= 255 }
      lacing.push(length)
    }
    if (lacing.length > MAX_PAGE_SEGMENTS) throw new WebmOggError('Ogg page overflow')
    const header = Buffer.alloc(27 + lacing.length)
    header.write('OggS', 0, 'ascii')
    header[4] = 0
    header[5] = headerType
    header.writeBigInt64LE(BigInt(granule), 6)
    header.writeUInt32LE(this.serial, 14)
    header.writeUInt32LE(this.sequence++, 18)
    header[26] = lacing.length
    lacing.forEach((value, index) => { header[27 + index] = value })
    const page = Buffer.concat([header, ...packets])
    page.writeUInt32LE(oggCrc(page), 22)
    return page
  }
}

/** Minimal OpusTags (RFC 7845 §5.2): vendor string, no user comments. */
function opusTags(): Buffer {
  const vendor = Buffer.from('Puros (stream copy)', 'utf8')
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4)
  tags.write('OpusTags', 0, 'ascii')
  tags.writeUInt32LE(vendor.length, 8)
  vendor.copy(tags, 12)
  tags.writeUInt32LE(0, 12 + vendor.length)
  return tags
}

/** Exposed for tests of page timing. */
export const OGG_PAGE_TARGET_SAMPLES = PAGE_TARGET_SAMPLES
