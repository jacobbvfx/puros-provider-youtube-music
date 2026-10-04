import fs from 'node:fs/promises'

/**
 * FFmpeg's stream-copy WebM → Ogg remux keeps every Opus packet and the
 * OpusHead pre-skip, but drops the WebM `DiscardPadding` of the last block, so
 * the Ogg file would decode that many samples of encoder padding past the real
 * end. Ogg Opus expresses end trimming through the final page's granule
 * position (RFC 7845 §4.4); this module reads the WebM value and writes that
 * granule. Only container metadata changes; no audio byte is touched.
 */

const EBML_SEGMENT = 0x18538067
const EBML_CLUSTER = 0x1f43b675
const EBML_BLOCK_GROUP = 0xa0
const EBML_DISCARD_PADDING = 0x75a2
const EBML_TRACKS = 0x1654ae6b
const EBML_TRACK_ENTRY = 0xae
const EBML_CODEC_ID = 0x86

function readVint(buffer: Buffer, offset: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = buffer[offset]
  if (first === undefined || first === 0) return null
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1
  if (length > 8 || offset + length > buffer.length) return null
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = (first & (0xff >> length)) === (0xff >> length)
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index]
    if (buffer[offset + index] !== 0xff) allOnes = false
  }
  return { value, length, unknown: !keepMarker && allOnes }
}

function readSignedInt(buffer: Buffer, offset: number, size: number): number {
  if (size < 1 || size > 8) return 0
  let value = BigInt(0)
  for (let index = 0; index < size; index += 1) value = (value << BigInt(8)) | BigInt(buffer[offset + index])
  if (buffer[offset] & 0x80) value -= BigInt(1) << BigInt(8 * size)
  return Number(value)
}

interface WebmOpusInfo {
  codecId: string | null
  /** DiscardPadding of the last block that has one, in nanoseconds. */
  lastDiscardPaddingNs: number
}

/** Walk the EBML tree far enough to find the codec and the final DiscardPadding. */
export function readWebmOpusInfo(buffer: Buffer): WebmOpusInfo {
  const info: WebmOpusInfo = { codecId: null, lastDiscardPaddingNs: 0 }
  const containers = new Set([EBML_SEGMENT, EBML_CLUSTER, EBML_BLOCK_GROUP, EBML_TRACKS, EBML_TRACK_ENTRY])
  const walk = (start: number, end: number) => {
    let offset = start
    while (offset < end) {
      const id = readVint(buffer, offset, true)
      if (!id) return
      const size = readVint(buffer, offset + id.length, false)
      if (!size) return
      const dataStart = offset + id.length + size.length
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value)
      if (containers.has(id.value)) walk(dataStart, dataEnd)
      else if (id.value === EBML_CODEC_ID) info.codecId = buffer.toString('ascii', dataStart, dataEnd)
      else if (id.value === EBML_DISCARD_PADDING) info.lastDiscardPaddingNs = readSignedInt(buffer, dataStart, dataEnd - dataStart)
      offset = dataEnd
    }
  }
  // The file begins with the EBML header element, then the Segment.
  walk(0, buffer.length)
  return info
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let crc = index << 24
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) : crc << 1
    table[index] = crc >>> 0
  }
  return table
})()

/** Ogg's CRC-32 (polynomial 0x04C11DB7, no reflection, zero init). */
export function oggCrc(data: Buffer): number {
  let crc = 0
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  return crc
}

interface OggPage { offset: number; length: number; granule: bigint; headerType: number }

export function readOggPages(buffer: Buffer): OggPage[] {
  const pages: OggPage[] = []
  let offset = 0
  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error('Not a contiguous Ogg stream')
    const segments = buffer[offset + 26]
    if (offset + 27 + segments > buffer.length) throw new Error('Truncated Ogg page')
    let body = 0
    for (let index = 0; index < segments; index += 1) body += buffer[offset + 27 + index]
    const length = 27 + segments + body
    if (offset + length > buffer.length) throw new Error('Truncated Ogg page')
    pages.push({ offset, length, granule: buffer.readBigInt64LE(offset + 6), headerType: buffer[offset + 5] })
    offset += length
  }
  if (offset !== buffer.length) throw new Error('Trailing bytes after the last Ogg page')
  return pages
}

/**
 * Apply `discardSamples` (48 kHz) of end trimming to the last page of an Ogg
 * Opus file in place. Returns the samples actually trimmed (0 when there is
 * nothing to do or the value would cut into an earlier page).
 */
export async function applyOggOpusEndTrim(oggPath: string, discardSamples: number): Promise<number> {
  if (!Number.isSafeInteger(discardSamples) || discardSamples <= 0) return 0
  const buffer = await fs.readFile(oggPath)
  const pages = readOggPages(buffer)
  const last = pages[pages.length - 1]
  const previous = pages.slice(0, -1).reverse().find((page) => page.granule >= BigInt(0))
  if (!last || !previous || last.granule < BigInt(0)) return 0
  const trimmed = last.granule - BigInt(discardSamples)
  // RFC 7845: end trimming may only remove samples of the final page.
  if (trimmed < previous.granule) return 0
  buffer.writeBigInt64LE(trimmed, last.offset + 6)
  buffer.writeUInt32LE(0, last.offset + 22)
  buffer.writeUInt32LE(oggCrc(buffer.subarray(last.offset, last.offset + last.length)), last.offset + 22)
  const temporary = `${oggPath}.trim`
  await fs.writeFile(temporary, buffer)
  await fs.rename(temporary, oggPath)
  return discardSamples
}

/** 48 kHz samples of the final WebM DiscardPadding (0 when the stream has none or is not Opus). */
export async function webmOpusDiscardSamples(webmPath: string): Promise<number> {
  const info = readWebmOpusInfo(await fs.readFile(webmPath))
  if (info.codecId !== 'A_OPUS' || info.lastDiscardPaddingNs <= 0) return 0
  return Math.round(info.lastDiscardPaddingNs * 48_000 / 1e9)
}
