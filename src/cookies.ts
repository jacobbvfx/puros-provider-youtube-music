import { createHash } from 'node:crypto'
import { ProviderApiError, providerError } from 'puros-provider-sdk'
import { YTM_ORIGIN } from './constants'

/**
 * What a user can paste:
 *
 * - The `Cookie` request header of a signed-in music.youtube.com request, copied
 *   from the browser's developer tools (the Music Assistant flow). It has no
 *   domains or expiries, so the jar for yt-dlp is built from it.
 * - The two exports of SimpMusic Utils (github.com/maxrave-dev/utils, `src/background.ts`
 *   at c6934fccf7f3532fda3e5553748c304870bf71ec):
 *   - String: `name=value; name=value` of every cookie `chrome.cookies.getAll` returns
 *     for `music.youtube.com` and `.youtube.com` (later duplicates win); the same
 *     shape as the header.
 *   - Netscape: `# Netscape HTTP Cookie File` then one line per cookie,
 *     `domain\tincludeSubdomains\tpath\tsecure\texpirationDate\tname\tvalue`, where
 *     `expirationDate` is Chrome's float seconds (or `0` for session cookies).
 *
 * The header (or String export) authenticates InnerTube requests and the jar
 * becomes yt-dlp's cookie file. Values are secrets: nothing here may put them
 * into an error message.
 */

export interface NetscapeCookie {
  domain: string
  includeSubdomains: boolean
  path: string
  secure: boolean
  /** Whole seconds since the epoch; 0 for a session cookie. */
  expires: number
  name: string
  value: string
}

export interface ImportedCookies {
  /** Normalized `name=value; …` header value from the pasted header or String export. */
  header: string
  jar: NetscapeCookie[]
}

/** Cookies that must be present and identical in both exports. */
const SESSION_COOKIES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID', 'LOGIN_INFO', 'SID', '__Secure-3PSID'] as const
const MAX_EXPORT_LENGTH = 64 * 1024
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// What browsers actually store and send: any printable ASCII but `;` (quotes and
// backslashes included, which RFC 6265 cookie-octets leave out).
const COOKIE_VALUE = /^[\x20-\x3A\x3C-\x7E]*$/

export function invalidExport(message: string): ProviderApiError {
  return new ProviderApiError(providerError('INVALID_ARGUMENT', message, { retryable: false }))
}

function isYouTubeDomain(domain: string): boolean {
  const host = domain.replace(/^\./, '').toLowerCase()
  return host === 'youtube.com' || host.endsWith('.youtube.com')
}

/** A cookie name is not secret, so errors may show it; a value never. */
function malformedName(name: string): string {
  return COOKIE_NAME.test(name.replace(/[^\x21-\x7E]/g, ''))
    ? 'A cookie name contains spaces or non-ASCII text: copy the header value with right-click → Copy value, not by selecting it'
    : 'The cookie is not a list of name=value pairs: paste only the value of the Cookie request header'
}

function malformedValue(name: string, value: string): string {
  if (value.includes('\u2026')) return `The value of ${name} ends in "…": the browser shortened it. Copy the header with right-click → Copy value (or "Show more" first)`
  if (/[\u2018\u2019\u201C\u201D]/.test(value)) return `The value of ${name} contains curly quotes: paste the header directly, not through an app that changes quotes`
  return `The value of ${name} contains characters a cookie cannot have: copy the header value again with right-click → Copy value`
}

/** Parse a `Cookie` header or the String export. Throws without echoing any cookie content. */
export function parseCookieString(input: string): Map<string, string> {
  const text = input.trim().replace(/^cookie:\s*/i, '')
  if (!text) throw invalidExport('The cookie is empty')
  if (text.length > MAX_EXPORT_LENGTH) throw invalidExport('The cookie is too long')
  if (text.startsWith('#') || text.includes('\t')) throw invalidExport('The first field needs the Cookie header (or the String export), not a Netscape export')
  if (/[\r\n]/.test(text)) throw invalidExport('The cookie must be a single line')
  const cookies = new Map<string, string>()
  for (const part of text.split(';')) {
    const pair = part.trim()
    if (!pair) continue
    const separator = pair.indexOf('=')
    if (separator <= 0) throw invalidExport('The cookie is not a list of name=value pairs')
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!COOKIE_NAME.test(name)) throw invalidExport(malformedName(name))
    if (!COOKIE_VALUE.test(value)) throw invalidExport(malformedValue(name, value))
    cookies.set(name, value)
  }
  if (cookies.size === 0) throw invalidExport('The cookie contains no name=value pairs')
  return cookies
}

type NetscapeLine = { cookie: NetscapeCookie } | 'blank' | 'columns' | 'malformed'

/**
 * One Netscape cookie line. `lenient` also takes yt-dlp's own writing, which
 * leaves the expiry empty for a session cookie.
 */
function parseNetscapeLine(raw: string, lenient = false): NetscapeLine {
  if (raw.startsWith('#HttpOnly_')) raw = raw.slice('#HttpOnly_'.length)
  else if (raw.startsWith('#') || !raw.trim()) return 'blank'
  const fields = raw.split('\t')
  if (fields.length !== 7) return 'columns'
  const [domain, includeSubdomains, cookiePath, secure, expiresText, name, value] = fields
  const expiresValid = /^\d+(?:\.\d+)?$/.test(expiresText) || (lenient && expiresText === '')
  if (!/^[A-Za-z0-9.-]+$/.test(domain) || !cookiePath.startsWith('/')
    || !['TRUE', 'FALSE'].includes(includeSubdomains) || !['TRUE', 'FALSE'].includes(secure)
    || !expiresValid || !COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
    return 'malformed'
  }
  return { cookie: {
    domain: domain.toLowerCase(),
    includeSubdomains: includeSubdomains === 'TRUE',
    path: cookiePath,
    secure: secure === 'TRUE',
    expires: expiresText === '' ? 0 : Math.floor(Number(expiresText)),
    name,
    value,
  } }
}

/** Parse the Netscape export, keeping only youtube.com cookies. */
export function parseNetscapeCookies(input: string, nowSeconds = Math.floor(Date.now() / 1000)): NetscapeCookie[] {
  const text = input.replace(/^\uFEFF/, '')
  if (!text.trim()) throw invalidExport('The Netscape export is empty')
  if (text.length > MAX_EXPORT_LENGTH) throw invalidExport('The Netscape export is too long')
  const cookies: NetscapeCookie[] = []
  let sawEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = parseNetscapeLine(raw)
    if (line === 'blank') continue
    if (line === 'columns') throw invalidExport('The second field needs the Netscape export (7 tab-separated columns per cookie)')
    if (line === 'malformed') throw invalidExport('The Netscape export contains a malformed cookie line')
    sawEntry = true
    const { cookie } = line
    if (!isYouTubeDomain(cookie.domain)) continue
    if (cookie.expires !== 0 && cookie.expires <= nowSeconds) continue
    cookies.push(cookie)
  }
  if (!sawEntry) throw invalidExport('The Netscape export contains no cookies')
  if (cookies.length === 0) throw invalidExport('The Netscape export has no unexpired youtube.com cookies')
  return cookies
}

/** Cookies a browser would send to `origin` at path `/` (domain and path rules). */
export function cookiesForOrigin(jar: NetscapeCookie[], origin: string): Map<string, string> {
  const host = new URL(origin).hostname
  const matching = jar.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '')
    return (host === domain || (host.endsWith(`.${domain}`) && (cookie.includeSubdomains || cookie.domain.startsWith('.'))))
      && cookie.path === '/'
  })
  // More specific domains win, as in a browser's cookie ordering.
  matching.sort((a, b) => a.domain.replace(/^\./, '').length - b.domain.replace(/^\./, '').length)
  return new Map(matching.map((cookie) => [cookie.name, cookie.value]))
}

/** Cookies a browser would send to https://music.youtube.com/. */
export function cookiesForMusicOrigin(jar: NetscapeCookie[]): Map<string, string> {
  return cookiesForOrigin(jar, YTM_ORIGIN)
}

/** A cookie YouTube set or cleared since the session was saved. */
export interface CookieUpdate {
  cookie: NetscapeCookie
  deleted: boolean
}

/**
 * One `Set-Cookie` response header of a request to `url`, as a Netscape cookie
 * (RFC 6265 domain and default-path rules). Only youtube.com cookies count;
 * anything malformed is ignored.
 */
export function parseSetCookie(header: string, url: URL, nowSeconds = Math.floor(Date.now() / 1000)): CookieUpdate | null {
  const [pair, ...attributes] = header.split(';')
  const separator = pair.indexOf('=')
  if (separator <= 0) return null
  const name = pair.slice(0, separator).trim()
  const value = pair.slice(separator + 1).trim()
  if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) return null
  const host = url.hostname.toLowerCase()
  const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/'))
  const cookie: NetscapeCookie = { domain: host, includeSubdomains: false, path: directory || '/', secure: false, expires: 0, name, value }
  let maxAge: number | null = null
  for (const attribute of attributes) {
    const equals = attribute.indexOf('=')
    const key = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase()
    const argument = equals < 0 ? '' : attribute.slice(equals + 1).trim()
    if (key === 'domain' && argument) {
      const domain = argument.replace(/^\./, '').toLowerCase()
      if (host !== domain && !host.endsWith(`.${domain}`)) return null
      cookie.domain = `.${domain}`
      cookie.includeSubdomains = true
    } else if (key === 'path' && argument.startsWith('/')) {
      cookie.path = argument
    } else if (key === 'secure') {
      cookie.secure = true
    } else if (key === 'max-age' && /^-?\d+$/.test(argument)) {
      maxAge = Number(argument)
    } else if (key === 'expires') {
      const time = Date.parse(argument)
      if (Number.isFinite(time)) cookie.expires = Math.max(1, Math.floor(time / 1000))
    }
  }
  // Max-Age wins over Expires.
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? 1 : nowSeconds + maxAge
  if (!isYouTubeDomain(cookie.domain)) return null
  return { cookie, deleted: cookie.expires !== 0 && cookie.expires <= nowSeconds }
}

const cookieKey = (cookie: NetscapeCookie) => `${cookie.domain}\t${cookie.path}\t${cookie.name}`

const sameCookie = (a: NetscapeCookie, b: NetscapeCookie) => a.value === b.value && a.expires === b.expires
  && a.secure === b.secure && a.includeSubdomains === b.includeSubdomains

/**
 * The cookies yt-dlp changed in its cookie file (it saves the jar back when it
 * exits): every youtube.com cookie that differs from what was `written`.
 * Malformed or cut-off lines are skipped, and a cookie missing from the file is
 * not taken as deleted.
 */
export function cookieFileUpdates(text: string, written: NetscapeCookie[]): CookieUpdate[] {
  if (text.length > MAX_EXPORT_LENGTH * 4) return []
  const before = new Map(written.map((cookie) => [cookieKey(cookie), cookie]))
  const updates: CookieUpdate[] = []
  const lines = text.split(/\r?\n/)
  // Every complete line ends in a newline; what follows the last one was cut off.
  lines.pop()
  for (const raw of lines) {
    const line = parseNetscapeLine(raw, true)
    if (typeof line === 'string' || !isYouTubeDomain(line.cookie.domain)) continue
    const previous = before.get(cookieKey(line.cookie))
    if (!previous || !sameCookie(previous, line.cookie)) updates.push({ cookie: line.cookie, deleted: false })
  }
  return updates
}

export interface CookieSession {
  cookieHeader: string
  jar: NetscapeCookie[]
}

/**
 * Apply rotated cookies to a stored session, as a browser's cookie store would:
 * the jar takes every change, and the request header follows the jar for the
 * cookies music.youtube.com receives (cookies only the header had are
 * kept). Google clearing a sign-in cookie is left to the signed-out check, so
 * the session never loses them here. Returns null when nothing changed.
 */
export function applyCookieUpdates(session: CookieSession, updates: CookieUpdate[], nowSeconds = Math.floor(Date.now() / 1000)): CookieSession | null {
  const merged = new Map(session.jar.map((cookie) => [cookieKey(cookie), cookie]))
  let changed = false
  for (const { cookie, deleted } of updates) {
    const key = cookieKey(cookie)
    const current = merged.get(key)
    if (deleted) {
      if (current && !(SESSION_COOKIES as readonly string[]).includes(cookie.name)) {
        merged.delete(key)
        changed = true
      }
    } else if (!current || !sameCookie(current, cookie)) {
      merged.set(key, cookie)
      changed = true
    }
  }
  if (!changed) return null
  const jar = [...merged.values()].filter((cookie) => cookie.expires === 0 || cookie.expires > nowSeconds)
  const before = cookiesForMusicOrigin(session.jar)
  const after = cookiesForMusicOrigin(jar)
  const header = cookieMapFromHeader(session.cookieHeader)
  for (const name of before.keys()) if (!after.has(name)) header.delete(name)
  for (const [name, value] of after) header.set(name, value)
  if (header.size === 0) return null
  return { cookieHeader: serializeCookieHeader(header), jar }
}

/**
 * Validate one import: both exports must come from the same signed-in session,
 * so every session cookie present in either must match exactly.
 */
export function importCookies(stringExport: string, netscapeExport: string, nowSeconds?: number): ImportedCookies {
  const fromString = parseCookieString(stringExport)
  const jar = parseNetscapeCookies(netscapeExport, nowSeconds)
  const fromJar = cookiesForMusicOrigin(jar)
  if (!fromString.has('SAPISID') && !fromString.has('__Secure-3PAPISID')) {
    throw invalidExport('The String export has no SAPISID or __Secure-3PAPISID cookie: sign in on music.youtube.com and export again')
  }
  if (!fromJar.has('LOGIN_INFO') || (!fromJar.has('SAPISID') && !fromJar.has('__Secure-3PAPISID'))) {
    throw invalidExport('The Netscape export is missing the signed-in cookies (LOGIN_INFO, SAPISID): sign in on music.youtube.com and export again')
  }
  for (const name of SESSION_COOKIES) {
    const a = fromString.get(name)
    const b = fromJar.get(name)
    if (a !== undefined && b !== undefined && a !== b) {
      throw invalidExport('The two exports come from different sessions; export both formats again, one right after the other')
    }
  }
  return { header: serializeCookieHeader(fromString), jar }
}

/** Chrome caps cookie lifetimes at 400 days; a header carries no expiry, so its cookies get that. */
const HEADER_COOKIE_LIFETIME_SECONDS = 400 * 24 * 60 * 60

/**
 * Validate a pasted `Cookie` request header (Music Assistant's flow). Every
 * cookie becomes a `.youtube.com` cookie in the jar for yt-dlp: music.youtube.com
 * received it, so each is one yt-dlp may send to YouTube. Google decides when
 * the session actually ends.
 */
export function importCookieHeader(header: string, nowSeconds = Math.floor(Date.now() / 1000)): ImportedCookies {
  const cookies = parseCookieString(header)
  if (!cookies.has('SAPISID') && !cookies.has('__Secure-3PAPISID')) {
    throw invalidExport('The cookie has no __Secure-3PAPISID: copy it from a signed-in request (for example /browse on your library page) and try again')
  }
  const expires = nowSeconds + HEADER_COOKIE_LIFETIME_SECONDS
  const jar = [...cookies].map(([name, value]): NetscapeCookie => ({
    domain: '.youtube.com', includeSubdomains: true, path: '/', secure: true, expires, name, value,
  }))
  return { header: serializeCookieHeader(cookies), jar }
}

export function serializeCookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

export function cookieMapFromHeader(header: string): Map<string, string> {
  return parseCookieString(header)
}

/** yt-dlp's cookie file: Netscape header, integer expiries, youtube.com cookies only. */
export function serializeNetscape(jar: NetscapeCookie[]): string {
  const lines = jar.map((cookie) => [
    cookie.domain,
    cookie.includeSubdomains ? 'TRUE' : 'FALSE',
    cookie.path,
    cookie.secure ? 'TRUE' : 'FALSE',
    String(cookie.expires),
    cookie.name,
    cookie.value,
  ].join('\t'))
  return `# Netscape HTTP Cookie File\n# Written by Puros for yt-dlp; deleted after use.\n\n${lines.join('\n')}\n`
}

/**
 * `Authorization` for InnerTube requests, as yt-dlp's `_get_sid_authorization_header`:
 * one `SCHEME <ts>_<sha1("<ts> <sid> <origin>")>` per available SAPISID variant.
 */
export function sapisidAuthorization(cookies: Map<string, string>, nowMs = Date.now(), origin = YTM_ORIGIN): string | null {
  const timestamp = String(Math.round(nowMs / 1000))
  const sapisid = cookies.get('SAPISID') ?? cookies.get('__Secure-3PAPISID')
  const variants: Array<[string, string | undefined]> = [
    ['SAPISIDHASH', sapisid],
    ['SAPISID1PHASH', cookies.get('__Secure-1PAPISID')],
    ['SAPISID3PHASH', cookies.get('__Secure-3PAPISID')],
  ]
  const parts = variants.flatMap(([scheme, sid]) => sid
    ? [`${scheme} ${timestamp}_${createHash('sha1').update(`${timestamp} ${sid} ${origin}`).digest('hex')}`]
    : [])
  return parts.length > 0 ? parts.join(' ') : null
}

/** Stable, non-reversible account key for cache partitioning; derived from the account label, never a cookie. */
export function accountKey(accountLabel: string): string {
  return createHash('sha256').update(`ytm\0${accountLabel}`).digest('hex').slice(0, 12)
}
