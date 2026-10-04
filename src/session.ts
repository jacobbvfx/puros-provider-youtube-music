import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ProviderApiError, providerError, type ProviderSecretsHostV1 } from 'puros-provider-sdk'
import {
  accountKey,
  applyCookieUpdates,
  cookieFileUpdates,
  cookieMapFromHeader,
  type CookieUpdate,
  importCookieHeader,
  importCookies,
  invalidExport,
  type ImportedCookies,
  parseSetCookie,
  serializeNetscape,
  type NetscapeCookie,
} from './cookies'
import { InnerTubeClient, notAuthenticated, sessionExpired, type InnerTubeCredentials } from './innertube'
import { parseAccountName, parseAccountSwitcher, type YtmIdentity } from './parsers'

const SECRET_KEY = 'session'
const SESSION_VERSION = 1
/** Private directory for yt-dlp cookie files, inside the provider data root. */
export const COOKIE_DIR = 'session-tmp'
/** Rotated cookies arrive with nearly every response; they reach `host.secrets` at most this often. */
const PERSIST_DELAY_MS = 2_000

export interface YtmAccount {
  name: string
  handle: string | null
}

interface StoredSession {
  version: typeof SESSION_VERSION
  cookieHeader: string
  jar: NetscapeCookie[]
  account: YtmAccount
  importedAt: number
  /** Identities of the session (account switcher); absent in sessions saved before it was read. */
  identities?: YtmIdentity[]
  /** Index into `identities` of the one requests act as. */
  selected?: number
}

export type SessionState = 'signed-out' | 'connected' | 'expired'

export interface SessionStatus {
  state: SessionState
  account: YtmAccount | null
  /** 1-based position of the active identity and how many the session has. */
  identity?: { index: number; count: number }
}

function isStoredSession(value: unknown): value is StoredSession {
  const record = value as Partial<StoredSession> | null
  return !!record && record.version === SESSION_VERSION && typeof record.cookieHeader === 'string'
    && Array.isArray(record.jar) && !!record.account && typeof record.account.name === 'string'
}

function credentialsFor(session: StoredSession): InnerTubeCredentials {
  const identity = session.identities?.[session.selected ?? 0]
  return {
    cookieHeader: session.cookieHeader,
    cookies: cookieMapFromHeader(session.cookieHeader),
    authUser: identity?.authUser ?? 0,
    pageId: identity?.pageId ?? null,
  }
}

/** Which browser session cookies belong to; rotation never changes SAPISID. */
function sessionKeyOf(cookies: Map<string, string>): string | undefined {
  return cookies.get('SAPISID') ?? cookies.get('__Secure-3PAPISID')
}

const rejected = () => new ProviderApiError(providerError('AUTH_EXPIRED', 'YouTube Music did not accept this cookie. Copy a fresh one from a signed-in private window.', { retryable: false }))

/**
 * The imported browser session. Cookies live only in `host.secrets` and in this
 * object's memory; yt-dlp gets a short-lived 0600 file that is removed when the
 * run ends, fails, is cancelled, or the user signs out.
 *
 * The session is kept frozen, as Music Assistant and yt-dlp recommend: an open
 * YouTube tab makes Google rotate `__Secure-*PSIDTS` about every ten minutes
 * and soon reject the old values, but a session no browser opens again keeps
 * working for weeks. So the provider never asks Google to rotate. Cookies that
 * YouTube sets anyway (`*SIDCC` with most InnerTube answers, and whatever yt-dlp
 * writes back to its cookie file) are taken and saved, so the stored copy is
 * never older than what Google last handed out.
 *
 * One browser session can act as several identities (each signed-in Google
 * account and its brand channels). Like SimpMusic, requests name the active one
 * with `X-Goog-AuthUser` and `X-Goog-PageId`; without that YouTube answers for
 * the first account's default identity, whose library may be empty.
 */
export class YtmSessionService {
  private session: StoredSession | null = null
  private credentials: InnerTubeCredentials | null = null
  private expired = false
  private loaded = false
  private readonly liveCookieFiles = new Set<string>()
  private readonly listeners = new Set<() => void>()
  /** A session being imported: verification answers rotate its cookies too. */
  private pending: StoredSession | null = null
  /** Rotated cookies not yet in `host.secrets`. */
  private dirty = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  /** Secret writes and deletes, in order, so a late save never revives a signed-out session. */
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    secrets: ProviderSecretsHostV1
    dataRoot: () => Promise<string>
    client: () => InnerTubeClient
  }) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* status listeners never break auth */ }
    }
  }

  /** Restore the saved session after a restart. A corrupt secret counts as signed out. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const raw = await this.options.secrets.get(SECRET_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isStoredSession(parsed)) return
      this.session = parsed
      this.credentials = credentialsFor(parsed)
    } catch {
      this.session = null
      this.credentials = null
    }
  }

  getCredentials(): InnerTubeCredentials | null {
    return this.expired ? null : this.credentials
  }

  status(): SessionStatus {
    if (!this.session) return { state: 'signed-out', account: null }
    const count = this.session.identities?.length ?? 0
    return {
      state: this.expired ? 'expired' : 'connected',
      account: this.session.account,
      ...(count > 1 ? { identity: { index: (this.session.selected ?? 0) + 1, count } } : {}),
    }
  }

  accountKey(): string | null {
    return this.session && !this.expired ? accountKey(`${this.session.account.name}\0${this.session.account.handle ?? ''}`) : null
  }

  /** YouTube answered a signed request as signed out: keep the secret for inspection, stop using it. */
  markExpired(): void {
    if (!this.session || this.expired) return
    this.expired = true
    this.changed()
  }

  /** `account/account_menu` as this identity: the account YouTube answers for, or a typed rejection. */
  private async verify(credentials: InnerTubeCredentials, signal?: AbortSignal): Promise<YtmAccount> {
    const client = this.options.client()
    client.reset()
    let response: unknown
    try {
      response = await client.request({ endpoint: 'account/account_menu', auth: 'required', credentials, signal })
    } catch (error) {
      if (error instanceof ProviderApiError && (error.providerError.code === 'AUTH_EXPIRED' || error.providerError.code === 'NOT_AUTHENTICATED')) throw rejected()
      throw error
    } finally {
      // Verification must not leave a visitor ID of another identity behind.
      client.reset()
    }
    const account = parseAccountName(response)
    if (!account) {
      throw new ProviderApiError(providerError('AUTH_EXPIRED', 'YouTube Music answered as signed out. Copy the cookie from a signed-in request (for example /browse on your library page).', { retryable: false }))
    }
    return account
  }

  /** Identities from the account switcher; an unreadable list means "only the default". */
  private async identities(credentials: InnerTubeCredentials, signal?: AbortSignal): Promise<YtmIdentity[]> {
    try {
      return parseAccountSwitcher(await this.options.client().accountSwitcher(credentials, signal))
    } catch (error) {
      if (error instanceof ProviderApiError && error.providerError.code === 'AUTH_EXPIRED') throw rejected()
      return []
    }
  }

  private enqueueWrite(write: () => Promise<void>): Promise<void> {
    const next = this.writes.then(write)
    this.writes = next.catch(() => {})
    return next
  }

  private async save(session: StoredSession): Promise<void> {
    await this.enqueueWrite(() => this.options.secrets.set(SECRET_KEY, JSON.stringify(session)))
    this.cancelPersist()
    this.dirty = false
    this.session = session
    this.credentials = credentialsFor(session)
    this.expired = false
    this.loaded = true
    this.changed()
  }

  /**
   * Validate the pasted `Cookie` header (plus the Netscape export, when a
   * SimpMusic Utils user pastes one), list the session's identities, confirm
   * the chosen one with a real `account/account_menu` request, and only then
   * persist. A failed import leaves any existing session untouched.
   */
  async importSession(values: Record<string, unknown>, signal?: AbortSignal): Promise<YtmAccount> {
    const header = typeof values['cookie-string'] === 'string' ? values['cookie-string'] : ''
    const netscapeExport = typeof values['cookie-netscape'] === 'string' ? values['cookie-netscape'] : ''
    if (!header.trim()) throw invalidExport('Paste the Cookie header of a signed-in music.youtube.com request')
    return this.adopt(netscapeExport.trim() ? importCookies(header, netscapeExport) : importCookieHeader(header), signal)
  }

  private async adopt(imported: ImportedCookies, signal?: AbortSignal): Promise<YtmAccount> {
    const base: InnerTubeCredentials = { cookieHeader: imported.header, cookies: cookieMapFromHeader(imported.header) }
    const identities = await this.identities(base, signal)
    // The identity the browser had active; SimpMusic otherwise takes the first.
    const selected = Math.max(0, identities.findIndex((identity) => identity.selected))
    const draft: StoredSession = {
      version: SESSION_VERSION, cookieHeader: imported.header, jar: imported.jar,
      account: { name: '', handle: null }, importedAt: Date.now(),
      ...(identities.length > 0 ? { identities, selected } : {}),
    }
    this.pending = draft
    try {
      const account = await this.verify(credentialsFor(draft), signal)
      await this.save({ ...(this.pending ?? draft), account })
      return account
    } finally {
      this.pending = null
    }
  }

  /** Act as the next identity of the session (brand channel or other Google account), verified first. */
  async switchIdentity(signal?: AbortSignal): Promise<YtmAccount> {
    const session = this.session
    if (!session) throw notAuthenticated()
    const identities = session.identities?.length ? session.identities : await this.identities(credentialsFor(session), signal)
    if (identities.length < 2) {
      throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'This session has only one YouTube Music account or channel', { retryable: false }))
    }
    const current = session.identities?.length ? (session.selected ?? 0) : Math.max(0, identities.findIndex((identity) => identity.selected))
    const selected = (current + 1) % identities.length
    const account = await this.verify(credentialsFor({ ...session, identities, selected }), signal)
    // Cookies rotated while verifying are in the live session, not in `session`.
    if (!this.session) throw notAuthenticated()
    await this.save({ ...this.session, identities, selected, account })
    return account
  }

  /** Delete the secret, the in-memory session and every yt-dlp cookie file. */
  async logout(): Promise<void> {
    this.session = null
    this.credentials = null
    this.expired = false
    this.loaded = true
    this.cancelPersist()
    this.dirty = false
    await this.enqueueWrite(() => this.options.secrets.delete(SECRET_KEY))
    await this.removeCookieFiles()
    this.options.client().reset()
    this.changed()
  }

  /**
   * Run `task` with a private Netscape cookie file for yt-dlp. The file is
   * created 0600 inside a 0700 directory and removed afterwards, whatever
   * happens. Without a session, `task` runs with `null` (anonymous playback is
   * not offered; callers reject first).
   */
  async withCookieFile<T>(task: (cookiePath: string) => Promise<T>): Promise<T> {
    const session = this.session
    if (!session) throw notAuthenticated()
    if (this.expired) throw sessionExpired()
    const directory = path.join(await this.options.dataRoot(), COOKIE_DIR)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700)
    const file = path.join(directory, `${randomUUID()}.txt`)
    this.liveCookieFiles.add(file)
    let written = false
    try {
      const handle = await fs.open(file, 'wx', 0o600)
      try { await handle.writeFile(serializeNetscape(session.jar)) } finally { await handle.close() }
      written = true
      return await task(file)
    } finally {
      // yt-dlp saves its cookie jar back to the file on exit, rotated cookies included.
      if (written) {
        const text = await fs.readFile(file, 'utf8').catch(() => '')
        this.absorb(cookieFileUpdates(text, session.jar), session)
      }
      this.liveCookieFiles.delete(file)
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  /** `Set-Cookie` headers of an InnerTube answer made with `credentials`. */
  absorbSetCookies(setCookies: string[], url: URL, credentials: InnerTubeCredentials): void {
    if (setCookies.length === 0) return
    const key = sessionKeyOf(credentials.cookies)
    const updates = () => setCookies.flatMap((header) => parseSetCookie(header, url) ?? [])
    if (this.pending && key === sessionKeyOf(cookieMapFromHeader(this.pending.cookieHeader))) {
      const next = applyCookieUpdates(this.pending, updates())
      if (next) this.pending = { ...this.pending, ...next }
    } else if (this.session && key === sessionKeyOf(cookieMapFromHeader(this.session.cookieHeader))) {
      this.absorb(updates(), this.session)
    }
  }

  /**
   * Take rotated cookies into the live session when they belong to it (the
   * same browser session as `source`, not signed out or replaced meanwhile).
   */
  private absorb(updates: CookieUpdate[], source: StoredSession): void {
    const session = this.session
    if (!session || this.expired || updates.length === 0) return
    if (session !== source && sessionKeyOf(cookieMapFromHeader(session.cookieHeader)) !== sessionKeyOf(cookieMapFromHeader(source.cookieHeader))) return
    const next = applyCookieUpdates(session, updates)
    if (!next) return
    this.session = { ...session, ...next }
    this.credentials = credentialsFor(this.session)
    this.dirty = true
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.flush().catch(() => {})
    }, PERSIST_DELAY_MS)
    this.persistTimer.unref?.()
  }

  private cancelPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
  }

  /** Save rotated cookies now (also on deactivation). A failed write is retried with the next change. */
  async flush(): Promise<void> {
    this.cancelPersist()
    if (!this.dirty) return
    this.dirty = false
    await this.enqueueWrite(async () => {
      const session = this.session
      if (!session) return
      await this.options.secrets.set(SECRET_KEY, JSON.stringify(session))
    }).catch((error: unknown) => {
      this.dirty = true
      throw error
    })
  }

  /** Remove cookie files, including ones a crashed run left behind. */
  async removeCookieFiles(): Promise<void> {
    for (const file of this.liveCookieFiles) await fs.rm(file, { force: true }).catch(() => {})
    this.liveCookieFiles.clear()
    const directory = path.join(await this.options.dataRoot(), COOKIE_DIR)
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
