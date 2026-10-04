import { ProviderApiError, providerError, type ProviderErrorCodeV1 } from 'puros-provider-sdk'
import { INNERTUBE_BASE_URL, USER_AGENT, WEB_REMIX_CLIENT, YTM_ORIGIN } from './constants'
import { sapisidAuthorization } from './cookies'
import type { Continuation } from './parsers'
import { responseLoggedIn, responseVisitorData } from './parsers'

export interface InnerTubeCredentials {
  /** `name=value; …` Cookie header for music.youtube.com. */
  cookieHeader: string
  cookies: Map<string, string>
  /** Index of the Google account inside the browser session (`authuser`). */
  authUser?: number
  /** Brand channel to act as; only valid together with the `authUser` that owns it. */
  pageId?: string | null
}

export type AuthMode = 'required' | 'optional' | 'none'

export interface InnerTubeRequest {
  endpoint: 'search' | 'browse' | 'next' | 'account/account_menu'
  body?: Record<string, unknown>
  auth: AuthMode
  continuation?: Continuation | null
  signal?: AbortSignal
  /** Override the session (import verification uses cookies that are not saved yet). */
  credentials?: InnerTubeCredentials
}

export interface InnerTubeOptions {
  fetch?: typeof fetch
  getCredentials(): InnerTubeCredentials | null
  /** Called when YouTube answered a signed request as signed out. */
  onSessionRejected?(): void
  /** `Set-Cookie` headers of a signed response (Google updates some session cookies as it answers). */
  onCookies?(setCookies: string[], url: URL, credentials: InnerTubeCredentials): void
  timeoutMs?: number
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

function apiError(code: ProviderErrorCodeV1, message: string, retryable: boolean, retryAfterMs?: number): ProviderApiError {
  return new ProviderApiError(providerError(code, message, { retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }))
}

export function notAuthenticated(): ProviderApiError {
  return apiError('NOT_AUTHENTICATED', 'Connect YouTube Music in Settings → Accounts', false)
}

function setCookiesOf(response: Response): string[] {
  return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
}

export function sessionExpired(): ProviderApiError {
  return apiError('AUTH_EXPIRED', 'Your YouTube Music session has expired or was signed out. Paste a new cookie in Settings → Accounts → YouTube Music.', false)
}

/**
 * Minimal InnerTube client for music.youtube.com (WEB_REMIX). Signed requests
 * carry the imported Cookie header plus a SAPISID*HASH Authorization, like the
 * web client; nothing about the session is ever logged or returned.
 */
export class InnerTubeClient {
  private visitorData: string | null = null
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: InnerTubeOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Forget per-session state (visitor ID) when the account changes. */
  reset(): void { this.visitorData = null }

  private identityHeaders(credentials: InnerTubeCredentials): Record<string, string> {
    const headers: Record<string, string> = {
      Cookie: credentials.cookieHeader,
      'X-Goog-AuthUser': String(credentials.authUser ?? 0),
    }
    if (credentials.pageId) headers['X-Goog-PageId'] = credentials.pageId
    const authorization = sapisidAuthorization(credentials.cookies)
    if (authorization) headers.Authorization = authorization
    return headers
  }

  /**
   * Identities of the signed-in session, from music.youtube.com's account
   * switcher (the request SimpMusic's `getAccountSwitcherEndpoint` makes).
   * Returns the raw `)]}'`-prefixed body for the parser.
   */
  async accountSwitcher(credentials: InnerTubeCredentials, signal?: AbortSignal): Promise<string> {
    const url = new URL('/getAccountSwitcherEndpoint', YTM_ORIGIN)
    url.searchParams.set('prettyPrint', 'false')
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          Origin: YTM_ORIGIN,
          Referer: `${YTM_ORIGIN}/`,
          'X-Origin': YTM_ORIGIN,
          'X-YouTube-Client-Name': String(WEB_REMIX_CLIENT.number),
          'X-YouTube-Client-Version': WEB_REMIX_CLIENT.version,
          ...this.identityHeaders({ ...credentials, pageId: null }),
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      })
    } catch {
      throw apiError('NETWORK', 'YouTube Music is unreachable', true)
    }
    this.options.onCookies?.(setCookiesOf(response), url, credentials)
    if (response.status === 401 || response.status === 403) throw sessionExpired()
    if (!response.ok) throw apiError('NETWORK', `YouTube Music account list failed (HTTP ${response.status})`, response.status >= 500)
    return response.text()
  }

  async request(request: InnerTubeRequest): Promise<unknown> {
    const credentials = request.auth === 'none' ? null : (request.credentials ?? this.options.getCredentials())
    if (request.auth === 'required' && !credentials) throw notAuthenticated()
    const url = new URL(request.endpoint, INNERTUBE_BASE_URL)
    url.searchParams.set('prettyPrint', 'false')
    const body: Record<string, unknown> = {
      context: {
        client: {
          clientName: WEB_REMIX_CLIENT.name,
          clientVersion: WEB_REMIX_CLIENT.version,
          hl: 'en',
          ...(this.visitorData ? { visitorData: this.visitorData } : {}),
        },
        user: {},
      },
      ...request.body,
    }
    if (request.continuation?.style === 'legacy') {
      url.searchParams.set('ctoken', request.continuation.token)
      url.searchParams.set('continuation', request.continuation.token)
      url.searchParams.set('type', 'next')
    } else if (request.continuation) {
      body.continuation = request.continuation.token
    }
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? 3)
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal?.aborted) throw apiError('CANCELLED', 'YouTube Music request cancelled', true)
      try {
        return await this.once(url, body, credentials, request.signal)
      } catch (error) {
        lastError = error
        const typed = error instanceof ProviderApiError ? error.providerError : null
        if (!typed?.retryable || typed.code === 'CANCELLED' || attempt === maxAttempts) throw error
        await this.sleep(typed.retryAfterMs ?? 500 * 2 ** (attempt - 1))
      }
    }
    throw lastError
  }

  private async once(url: URL, body: Record<string, unknown>, credentials: InnerTubeCredentials | null, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Origin: YTM_ORIGIN,
      Referer: `${YTM_ORIGIN}/`,
      'X-Origin': YTM_ORIGIN,
      'X-YouTube-Client-Name': String(WEB_REMIX_CLIENT.number),
      'X-YouTube-Client-Version': WEB_REMIX_CLIENT.version,
      'X-Goog-Api-Format-Version': '1',
    }
    if (this.visitorData) headers['X-Goog-Visitor-Id'] = this.visitorData
    if (credentials) Object.assign(headers, this.identityHeaders(credentials))
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined, redirect: 'error' })
    } catch (error) {
      if (signal?.aborted) throw apiError('CANCELLED', 'YouTube Music request cancelled', true)
      if (timeout.aborted) throw apiError('TIMEOUT', 'YouTube Music did not respond in time', true)
      throw apiError('NETWORK', `YouTube Music is unreachable (${error instanceof Error ? error.name : 'network error'})`, true)
    }
    if (credentials) this.options.onCookies?.(setCookiesOf(response), url, credentials)
    if (response.status === 401 || (response.status === 403 && credentials)) {
      this.options.onSessionRejected?.()
      throw sessionExpired()
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      throw apiError('RATE_LIMITED', 'YouTube Music is rate limiting requests; try again shortly', true, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000)
    }
    if (response.status === 404) throw apiError('NOT_FOUND', 'YouTube Music has no such item', false)
    if (response.status >= 500) throw apiError('NETWORK', `YouTube Music server error (HTTP ${response.status})`, true)
    if (!response.ok) throw apiError(response.status === 400 ? 'INVALID_ARGUMENT' : 'INTERNAL', `YouTube Music rejected the request (HTTP ${response.status})`, false)
    let json: unknown
    try {
      json = await response.json()
    } catch {
      throw apiError('INTERNAL', 'YouTube Music returned an unreadable response', true)
    }
    this.visitorData = responseVisitorData(json) ?? this.visitorData
    if (credentials && responseLoggedIn(json) === false) {
      this.options.onSessionRejected?.()
      throw sessionExpired()
    }
    return json
  }
}
