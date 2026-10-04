import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyOggOpusEndTrim, oggCrc, readOggPages, readWebmOpusInfo, webmOpusDiscardSamples } from './opusTrim'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ytm-opus-'))
  roots.push(root)
  return root
}

function element(id: number[], payload: Buffer): Buffer {
  if (payload.length > 0x7f) throw new Error('fixture element too large')
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | payload.length]), payload])
}

function webm(discardNs: number | null): Buffer {
  const codec = element([0x86], Buffer.from('A_OPUS'))
  const tracks = element([0x16, 0x54, 0xae, 0x6b], element([0xae], codec))
  const discard = discardNs === null ? Buffer.alloc(0) : (() => {
    const value = Buffer.alloc(4)
    value.writeInt32BE(discardNs)
    return element([0x75, 0xa2], value)
  })()
  const blockGroup = element([0xa0], Buffer.concat([element([0xa1], Buffer.from([0x81, 0, 0, 0, 1, 2])), discard]))
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([element([0xe7], Buffer.from([0])), blockGroup]))
  const segment = element([0x18, 0x53, 0x80, 0x67], Buffer.concat([tracks, cluster]))
  return Buffer.concat([element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], Buffer.from('webm'))), segment])
}

function oggPage(granule: bigint, sequence: number, body: Buffer, headerType = 0): Buffer {
  const header = Buffer.alloc(27)
  header.write('OggS', 0, 'ascii')
  header[5] = headerType
  header.writeBigInt64LE(granule, 6)
  header.writeUInt32LE(1234, 14)
  header.writeUInt32LE(sequence, 18)
  header[26] = 1
  const page = Buffer.concat([header, Buffer.from([body.length]), body])
  page.writeUInt32LE(oggCrc(page), 22)
  return page
}

describe('WebM DiscardPadding', () => {
  it('reads the codec and the final discard padding', () => {
    expect(readWebmOpusInfo(webm(6_833_333))).toEqual({ codecId: 'A_OPUS', lastDiscardPaddingNs: 6_833_333 })
    expect(readWebmOpusInfo(webm(null)).lastDiscardPaddingNs).toBe(0)
  })

  it('converts nanoseconds to 48 kHz samples', async () => {
    const file = path.join(temp(), 'a.webm')
    fs.writeFileSync(file, webm(6_833_333))
    expect(await webmOpusDiscardSamples(file)).toBe(328)
  })
})

describe('Ogg Opus end trimming', () => {
  it('rewrites only the final granule and its CRC', async () => {
    const file = path.join(temp(), 'a.ogg')
    const pages = [oggPage(BigInt(0), 0, Buffer.from('OpusHead'), 2), oggPage(BigInt(960), 1, Buffer.from([1, 2, 3])), oggPage(BigInt(1920), 2, Buffer.from([4, 5, 6]), 4)]
    const original = Buffer.concat(pages)
    fs.writeFileSync(file, original)
    expect(await applyOggOpusEndTrim(file, 328)).toBe(328)
    const trimmed = fs.readFileSync(file)
    const parsed = readOggPages(trimmed)
    expect(parsed.map((page) => page.granule)).toEqual([BigInt(0), BigInt(960), BigInt(1592)])
    const last = trimmed.subarray(parsed[2].offset)
    const crc = last.readUInt32LE(22)
    const zeroed = Buffer.from(last)
    zeroed.writeUInt32LE(0, 22)
    expect(oggCrc(zeroed)).toBe(crc)
    // Packet bytes are untouched.
    expect(trimmed.subarray(0, parsed[2].offset)).toEqual(original.subarray(0, parsed[2].offset))
    expect(last.subarray(28)).toEqual(Buffer.from([4, 5, 6]))
  })

  it('refuses a trim that would cut into an earlier page', async () => {
    const file = path.join(temp(), 'b.ogg')
    fs.writeFileSync(file, Buffer.concat([oggPage(BigInt(960), 0, Buffer.from([1])), oggPage(BigInt(1000), 1, Buffer.from([2]), 4)]))
    expect(await applyOggOpusEndTrim(file, 328)).toBe(0)
    expect(readOggPages(fs.readFileSync(file))[1].granule).toBe(BigInt(1000))
  })
})
