import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  applyCookieUpdates,
  cookieFileUpdates,
  cookiesForMusicOrigin,
  cookiesForOrigin,
  importCookieHeader,
  importCookies,
  parseCookieString,
  parseNetscapeCookies,
  parseSetCookie,
  sapisidAuthorization,
  serializeNetscape,
} from './cookies'

// Fixture values are fabricated; they only have the shape of a SimpMusic Utils export.
const NOW = 1_800_000_000
const FUTURE = '1893456000.123456'
const netscape = [
  '# Netscape HTTP Cookie File',
  '# This is a generated file by SimpMusic Utils! Do not edit.',
  '',
  `music.youtube.com\tFALSE\t/\tTRUE\t${FUTURE}\tYSC\tmusic-only`,
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tSAPISID\tsapisid-fixture/A`,
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\t__Secure-3PAPISID\tsapisid-fixture/A`,
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\t__Secure-1PAPISID\tsapisid-fixture/A`,
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tLOGIN_INFO\tlogin-fixture:QUQ3`,
  `.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tf6=40000000&tz=Europe.Warsaw`,
  `.youtube.com\tTRUE\t/\tTRUE\t1000\tEXPIRED\told`,
  `.google.com\tTRUE\t/\tTRUE\t${FUTURE}\tNID\tnot-youtube`,
].join('\n')
const string = 'YSC=music-only; SAPISID=sapisid-fixture/A; __Secure-3PAPISID=sapisid-fixture/A; __Secure-1PAPISID=sapisid-fixture/A; LOGIN_INFO=login-fixture:QUQ3; PREF=f6=40000000&tz=Europe.Warsaw'

describe('SimpMusic Utils exports', () => {
  it('parses the String format, keeping values that contain "="', () => {
    const cookies = parseCookieString(string)
    expect(cookies.get('PREF')).toBe('f6=40000000&tz=Europe.Warsaw')
    expect(cookies.get('LOGIN_INFO')).toBe('login-fixture:QUQ3')
  })

  it('parses the Netscape format with Chrome float expiries, dropping expired and foreign cookies', () => {
    const jar = parseNetscapeCookies(netscape, NOW)
    expect(jar.map((cookie) => cookie.name)).toEqual(['YSC', 'SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID', 'LOGIN_INFO', 'PREF'])
    expect(jar.find((cookie) => cookie.name === 'SAPISID')).toMatchObject({ domain: '.youtube.com', includeSubdomains: true, expires: 1_893_456_000 })
    expect(jar.find((cookie) => cookie.name === 'PREF')?.expires).toBe(0)
    expect(cookiesForMusicOrigin(jar).get('YSC')).toBe('music-only')
  })

  it('accepts the #HttpOnly_ prefix used by other exporters', () => {
    const jar = parseNetscapeCookies(`#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx`, NOW)
    expect(jar[0]).toMatchObject({ name: 'SID', domain: '.youtube.com' })
  })

  it('imports a matching pair and writes a normalized yt-dlp cookie file', () => {
    const imported = importCookies(string, netscape, NOW)
    expect(imported.header).toContain('SAPISID=sapisid-fixture/A')
    const file = serializeNetscape(imported.jar)
    expect(file.startsWith('# Netscape HTTP Cookie File\n')).toBe(true)
    expect(file).toContain('.youtube.com\tTRUE\t/\tTRUE\t1893456000\tLOGIN_INFO\tlogin-fixture:QUQ3')
    expect(file).not.toContain('google.com')
    expect(file).not.toMatch(/\.\d+\t/)
  })

  it('rejects swapped, malformed, signed-out and mismatched exports without echoing cookie values', () => {
    const attempts = [
      () => importCookies(netscape, netscape, NOW),
      () => importCookies(string, string, NOW),
      () => importCookies('garbage', netscape, NOW),
      () => importCookies(string, 'music.youtube.com\tFALSE\t/\tTRUE\t0\tYSC\tsecret-value-x', NOW),
      () => importCookies('YSC=secret-value-x', netscape, NOW),
      () => importCookies(string.replace('sapisid-fixture/A;', 'rotated-secret;'), netscape, NOW),
    ]
    for (const attempt of attempts) {
      let message = ''
      try { attempt() } catch (error) { message = (error as Error).message }
      expect(message).not.toBe('')
      expect(message).not.toMatch(/sapisid-fixture|secret-value-x|rotated-secret|login-fixture/)
    }
    expect(() => importCookies(string.replace('sapisid-fixture/A;', 'rotated-secret;'), netscape, NOW)).toThrow(/different sessions/)
  })
})

describe('pasted Cookie header', () => {
  it('keeps the header and puts every cookie on .youtube.com for yt-dlp', () => {
    const imported = importCookieHeader(`Cookie: ${string}`, NOW)
    expect(parseCookieString(imported.header)).toEqual(parseCookieString(string))
    expect(imported.jar).toHaveLength(6)
    expect(imported.jar[0]).toEqual({
      domain: '.youtube.com', includeSubdomains: true, path: '/', secure: true, expires: NOW + 400 * 86_400, name: 'YSC', value: 'music-only',
    })
    // yt-dlp's file sends the same cookies music.youtube.com received.
    expect(cookiesForMusicOrigin(imported.jar)).toEqual(parseCookieString(string))
    expect(parseNetscapeCookies(serializeNetscape(imported.jar), NOW)).toEqual(imported.jar)
  })

  it('accepts values browsers send that RFC 6265 leaves out, such as quotes', () => {
    const imported = importCookieHeader(`${string}; QUOTED="a\\b c"`, NOW)
    expect(parseCookieString(imported.header).get('QUOTED')).toBe('"a\\b c"')
  })

  it('names the cookie whose value the browser shortened, never its value', () => {
    const cut = `${string}; __Secure-3PSIDTS=sidts-secret\u2026`
    expect(() => importCookieHeader(cut, NOW)).toThrow(/__Secure-3PSIDTS ends in "…"/)
    expect(() => importCookieHeader(cut, NOW)).not.toThrow(/sidts-secret/)
    expect(() => importCookieHeader(`${string}; X=bad\u0001`, NOW)).toThrow(/value of X contains characters/)
  })

  it('rejects a signed-out header, without echoing values', () => {
    const signedOut = 'YSC=music-only; PREF=secret-pref'
    expect(() => importCookieHeader(signedOut, NOW)).toThrow(/__Secure-3PAPISID/)
    expect(() => importCookieHeader(signedOut, NOW)).not.toThrow(/secret-pref/)
    expect(() => importCookieHeader(netscape, NOW)).toThrow(/Cookie header/)
  })
})

describe('SAPISID authorization', () => {
  it('builds every SAPISID*HASH variant like yt-dlp', () => {
    const cookies = parseCookieString(string)
    const header = sapisidAuthorization(cookies, 1_700_000_000_400, 'https://music.youtube.com')!
    const expected = createHash('sha1').update('1700000000 sapisid-fixture/A https://music.youtube.com').digest('hex')
    expect(header).toBe([
      `SAPISIDHASH 1700000000_${expected}`,
      `SAPISID1PHASH 1700000000_${expected}`,
      `SAPISID3PHASH 1700000000_${expected}`,
    ].join(' '))
    expect(sapisidAuthorization(new Map([['YSC', 'x']]))).toBeNull()
  })
})

describe('rotated cookies', () => {
  const musicUrl = new URL('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false')
  const jar = () => parseNetscapeCookies([
    netscape,
    `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\t__Secure-1PSIDTS\tsidts-old`,
    `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tSID\tsid-fixture`,
  ].join('\n'), NOW)
  const session = () => ({ cookieHeader: `${string}; __Secure-1PSIDTS=sidts-old; SID=sid-fixture; ONLY_IN_STRING=kept`, jar: jar() })

  it('parses Set-Cookie headers with domain, path, Max-Age and Expires rules', () => {
    expect(parseSetCookie('__Secure-1PSIDTS=sidts-new; Domain=.youtube.com; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=None', musicUrl, NOW)).toEqual({
      deleted: false,
      cookie: { domain: '.youtube.com', includeSubdomains: true, path: '/', secure: true, expires: NOW + 31_536_000, name: '__Secure-1PSIDTS', value: 'sidts-new' },
    })
    // Host-only, with the request's directory as default path; a past Expires clears it.
    expect(parseSetCookie('YSC=x; Expires=Thu, 01 Jan 1970 00:00:01 GMT', musicUrl, NOW)).toMatchObject({
      deleted: true, cookie: { domain: 'music.youtube.com', includeSubdomains: false, path: '/youtubei/v1' },
    })
    // A cookie for a domain the response may not set, or outside youtube.com, is ignored.
    expect(parseSetCookie('NID=x; Domain=google.com', musicUrl, NOW)).toBeNull()
    expect(parseSetCookie('NID=x; Domain=.google.com', new URL('https://accounts.google.com/'), NOW)).toBeNull()
    expect(parseSetCookie('no-equals-sign', musicUrl, NOW)).toBeNull()
  })

  it('selects the cookies a browser sends to accounts.youtube.com', () => {
    const cookies = cookiesForOrigin(jar(), 'https://accounts.youtube.com')
    expect(cookies.get('__Secure-1PSIDTS')).toBe('sidts-old')
    expect(cookies.has('YSC')).toBe(false)
  })

  it('applies rotated values to the jar and the request header, keeping String-only cookies', () => {
    const rotated = parseSetCookie('__Secure-1PSIDTS=sidts-new; Domain=.youtube.com; Path=/; Max-Age=600; Secure', musicUrl, NOW)!
    const next = applyCookieUpdates(session(), [rotated], NOW)!
    const header = parseCookieString(next.cookieHeader)
    expect(header.get('__Secure-1PSIDTS')).toBe('sidts-new')
    expect(header.get('ONLY_IN_STRING')).toBe('kept')
    expect(header.get('LOGIN_INFO')).toBe('login-fixture:QUQ3')
    expect(next.jar.filter((cookie) => cookie.name === '__Secure-1PSIDTS')).toEqual([rotated.cookie])
    // The same value again changes nothing.
    expect(applyCookieUpdates(next, [rotated], NOW)).toBeNull()
  })

  it('removes cleared cookies but never the sign-in cookies', () => {
    const clear = (name: string) => parseSetCookie(`${name}=; Domain=.youtube.com; Path=/; Max-Age=0`, musicUrl, NOW)!
    const next = applyCookieUpdates(session(), [clear('PREF'), clear('SID'), clear('SAPISID')], NOW)!
    const header = parseCookieString(next.cookieHeader)
    expect(header.has('PREF')).toBe(false)
    expect(header.get('SID')).toBe('sid-fixture')
    expect(header.get('SAPISID')).toBe('sapisid-fixture/A')
    expect(next.jar.some((cookie) => cookie.name === 'PREF')).toBe(false)
  })

  it('reads back only the cookies yt-dlp changed in its cookie file', () => {
    const written = jar()
    const saved = [
      '# Netscape HTTP Cookie File',
      '# This file is generated by yt-dlp.  Do not edit.',
      '',
      // yt-dlp writes an empty expiry for a session cookie and keeps HttpOnly marks.
      '.youtube.com\tTRUE\t/\tFALSE\t\tPREF\tf6=40000000&tz=Europe.Warsaw',
      `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${Math.floor(Number(FUTURE))}\t__Secure-1PSIDTS\tsidts-new`,
      `.youtube.com\tTRUE\t/\tTRUE\t${Math.floor(Number(FUTURE))}\tSID\tsid-fixture`,
      `.google.com\tTRUE\t/\tTRUE\t${Math.floor(Number(FUTURE))}\tNID\tnot-youtube`,
      'not a cookie line',
      `.youtube.com\tTRUE\t/\tTRUE\t${Math.floor(Number(FUTURE))}\tNEW\tcut-of`,
    ].join('\n')
    // The last line has no newline: yt-dlp was stopped while writing it.
    expect(cookieFileUpdates(saved, written).map((update) => [update.cookie.name, update.cookie.value])).toEqual([['__Secure-1PSIDTS', 'sidts-new']])
    expect(cookieFileUpdates(serializeNetscape(written), written)).toEqual([])
  })
})
