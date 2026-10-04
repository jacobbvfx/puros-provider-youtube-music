import { expect } from 'vitest'
import { oggCrc, readOggPages } from '../opusTrim'

/** Test-only Matroska/Ogg helpers; never imported by provider code. */

export function sizeVint(size: number): Buffer {
  if (size < 0x7f) return Buffer.from([0x80 | size])
  if (size < 0x3fff) return Buffer.from([0x40 | (size >> 8), size & 0xff])
  return Buffer.from([0x10, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff])
}
export const el = (id: number[], ...payload: Buffer[]) => {
  const body = Buffer.concat(payload)
  return Buffer.concat([Buffer.from(id), sizeVint(body.length), body])
}
export const unknownSize = (id: number[], ...payload: Buffer[]) => Buffer.concat([Buffer.from(id), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...payload])
export const uint = (value: number) => Buffer.from([value])

export function opusHead(preSkip = 312): Buffer {
  const head = Buffer.alloc(19)
  head.write('OpusHead', 0, 'ascii')
  head[8] = 1
  head[9] = 2
  head.writeUInt16LE(preSkip, 10)
  head.writeUInt32LE(48_000, 12)
  return head
}

/** A 20 ms CELT packet (TOC 0xF8) with a recognizable payload. */
export const packet = (index: number, length = 40 + (index % 7) * 30) => Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(length - 1, index & 0xff)])

export function simpleBlock(frames: Buffer[], lacing: 'none' | 'xiph' | 'ebml' | 'fixed' = 'none'): Buffer {
  const header = Buffer.from([0x81, 0x00, 0x00])
  if (lacing === 'none') return el([0xa3], header, Buffer.from([0x80]), frames[0])
  const flags = 0x80 | ({ xiph: 1, fixed: 2, ebml: 3 }[lacing] << 1)
  const sizes: number[] = []
  if (lacing === 'xiph') {
    for (const frame of frames.slice(0, -1)) {
      let length = frame.length
      while (length >= 255) { sizes.push(255); length -= 255 }
      sizes.push(length)
    }
  }
  let ebml = Buffer.alloc(0)
  if (lacing === 'ebml') {
    const parts = [sizeVint(frames[0].length)]
    for (let index = 1; index < frames.length - 1; index += 1) {
      const delta = frames[index].length - frames[index - 1].length
      // Signed EBML lacing delta: two-byte vint with a bias of 2^13 - 1.
      const raw = delta + 8191
      parts.push(Buffer.from([0x40 | (raw >> 8), raw & 0xff]))
    }
    ebml = Buffer.concat(parts)
  }
  return el([0xa3], header, Buffer.from([flags, frames.length - 1]), Buffer.from(sizes), ebml, ...frames)
}

export function webm(packets: Buffer[], options: { discardNs?: number; lacing?: 'none' | 'xiph' | 'ebml' | 'fixed'; unknownSegment?: boolean } = {}): Buffer {
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae],
    el([0xd7], uint(1)), el([0x83], uint(2)), el([0x86], Buffer.from('A_OPUS')), el([0x63, 0xa2], opusHead()),
  ))
  const blocks: Buffer[] = []
  const lacing = options.lacing ?? 'none'
  const body = packets.slice(0, -1)
  for (let index = 0; index < body.length; index += lacing === 'none' ? 1 : 3) {
    blocks.push(lacing === 'none' ? simpleBlock([body[index]]) : simpleBlock(body.slice(index, index + 3), lacing))
  }
  const lastBlock = el([0xa1], Buffer.from([0x81, 0x00, 0x00, 0x00]), packets[packets.length - 1])
  const discard = options.discardNs ? el([0x75, 0xa2], Buffer.from([0, (options.discardNs >> 16) & 0xff, (options.discardNs >> 8) & 0xff, options.discardNs & 0xff])) : Buffer.alloc(0)
  blocks.push(el([0xa0], lastBlock, discard))
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], uint(0)), ...blocks)
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from('webm')))
  const cues = el([0x1c, 0x53, 0xbb, 0x6b], Buffer.alloc(20))
  const segmentBody = [el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40]))), tracks, cues, cluster]
  return Buffer.concat([header, options.unknownSegment ? unknownSize([0x18, 0x53, 0x80, 0x67], ...segmentBody) : el([0x18, 0x53, 0x80, 0x67], ...segmentBody)])
}

/** Packets and granules of an Ogg stream, with CRC checks. */
export function readOgg(ogg: Buffer) {
  const pages = readOggPages(ogg)
  const packets: Buffer[] = []
  let partial: Buffer[] = []
  for (const page of pages) {
    const bytes = ogg.subarray(page.offset, page.offset + page.length)
    const zeroed = Buffer.from(bytes)
    zeroed.writeUInt32LE(0, 22)
    expect(oggCrc(zeroed)).toBe(bytes.readUInt32LE(22))
    const segments = bytes[26]
    let offset = 27 + segments
    for (let index = 0; index < segments; index += 1) {
      const length = bytes[27 + index]
      partial.push(bytes.subarray(offset, offset + length))
      offset += length
      if (length < 255) { packets.push(Buffer.concat(partial)); partial = [] }
    }
  }
  return { pages, packets }
}

