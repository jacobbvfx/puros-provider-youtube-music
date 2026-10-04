import { describe, expect, it } from 'vitest'
import { el, opusHead, packet, readOgg, webm } from './fixtures/webm'
import { HOLDBACK_SAMPLES, WebmToOggOpus, opusPacketSamples } from './webmOgg'

const PACKETS = Array.from({ length: 400 }, (_, index) => packet(index)) // 8 s of 20 ms packets

describe('Opus TOC durations', () => {
  it('reads frame size and count', () => {
    expect(opusPacketSamples(Buffer.from([0xf8]))).toBe(960) // CELT 20 ms, 1 frame
    expect(opusPacketSamples(Buffer.from([0xf9]))).toBe(1920) // 2 frames
    expect(opusPacketSamples(Buffer.from([0xfb, 0x03]))).toBe(2880) // code 3, 3 frames
    expect(opusPacketSamples(Buffer.from([0x08]))).toBe(960) // SILK 20 ms
    expect(() => opusPacketSamples(Buffer.from([0xfb, 0x00]))).toThrow()
  })
})

describe('WebM → Ogg Opus stream copy', () => {
  it('copies every packet unchanged, keeps OpusHead and trims the end from DiscardPadding', () => {
    const remux = new WebmToOggOpus({ serial: 7 })
    const ogg = Buffer.concat([remux.push(webm(PACKETS, { discardNs: 6_833_333 })), remux.finish()])
    const { pages, packets } = readOgg(ogg)
    expect(packets[0]).toEqual(opusHead())
    expect(packets[1].subarray(0, 8).toString('ascii')).toBe('OpusTags')
    expect(packets.slice(2)).toEqual(PACKETS)
    expect(pages[0].headerType).toBe(2)
    expect(pages.at(-1)!.headerType).toBe(4)
    // 400 × 960 raw samples, minus 328 samples of end padding.
    expect(pages.at(-1)!.granule).toBe(BigInt(400 * 960 - 328))
    const granules = pages.map((page) => page.granule)
    expect([...granules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(granules)
  })

  it('produces identical bytes whatever the chunking, and supports an unknown-size segment', () => {
    const source = webm(PACKETS, { discardNs: 1_000_000, unknownSegment: true })
    const whole = new WebmToOggOpus({ serial: 9 })
    const expected = Buffer.concat([whole.push(source), whole.finish()])
    for (const chunk of [1, 7, 333, 4096]) {
      const remux = new WebmToOggOpus({ serial: 9 })
      const parts: Buffer[] = []
      for (let offset = 0; offset < source.length; offset += chunk) parts.push(remux.push(source.subarray(offset, offset + chunk)))
      parts.push(remux.finish())
      expect(Buffer.concat(parts)).toEqual(expected)
    }
  })

  it('undoes Xiph, EBML and fixed lacing', () => {
    for (const lacing of ['xiph', 'ebml', 'fixed'] as const) {
      const packets = lacing === 'fixed' ? PACKETS.map((_, index) => packet(index, 90)) : PACKETS
      const remux = new WebmToOggOpus({ serial: 3 })
      const ogg = Buffer.concat([remux.push(webm(packets, { lacing })), remux.finish()])
      expect(readOgg(ogg).packets.slice(2)).toEqual(packets)
    }
  })

  it('emits only complete pages while growing and holds back the tail for the end trim', () => {
    const source = webm(PACKETS)
    const remux = new WebmToOggOpus({ serial: 5 })
    const first = remux.push(source.subarray(0, Math.floor(source.length / 2)))
    const { pages } = readOgg(first)
    expect(pages.every((page) => page.headerType !== 4)).toBe(true)
    expect(remux.ready).toBe(true)
    // Samples on disk never reach into the held-back tail.
    const pushedPackets = remux.packetsSeen
    expect(remux.samplesWritten).toBeLessThanOrEqual(pushedPackets * 960 - HOLDBACK_SAMPLES)
    expect(remux.samplesWritten).toBeGreaterThan(0)
  })

  it('resumes into the same Ogg stream from a second download of the same WebM', () => {
    const source = webm(PACKETS, { discardNs: 2_000_000 })
    const single = new WebmToOggOpus({ serial: 11 })
    const reference = readOgg(Buffer.concat([single.push(source), single.finish()]))

    const first = new WebmToOggOpus({ serial: 11 })
    const head = first.push(source.subarray(0, Math.floor(source.length * 0.6)))
    const state = first.resumeState
    const second = new WebmToOggOpus({ skipPackets: state.packets, resume: state })
    const tail = Buffer.concat([second.push(source), second.finish()])
    const resumed = readOgg(Buffer.concat([head, tail]))
    expect(resumed.packets).toEqual(reference.packets)
    expect(resumed.pages.at(-1)!.granule).toBe(reference.pages.at(-1)!.granule)
    expect(resumed.pages.map((page, index) => index === 0 || page.granule >= resumed.pages[index - 1].granule).every(Boolean)).toBe(true)
  })

  it('refuses to finish a truncated download or a stream without Opus', () => {
    const truncated = new WebmToOggOpus()
    const source = webm(PACKETS)
    truncated.push(source.subarray(0, source.length - 10))
    expect(() => truncated.finish()).toThrow(/mid-element/)
    const noOpus = new WebmToOggOpus()
    noOpus.push(el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from('webm'))))
    expect(() => noOpus.finish()).toThrow(/no Opus/)
  })
})
