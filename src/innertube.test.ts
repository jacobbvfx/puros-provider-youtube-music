import { describe, expect, it, vi } from 'vitest'
import { InnerTubeClient } from './innertube'

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } })
}

const loggedIn = (value: '0' | '1', extra: Record<string, unknown> = {}) => ({
  responseContext: { visitorData: 'visitor-1', serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'logged_in', value }] }] },
  ...extra,
})

const credentials = { cookieHeader: 'SAPISID=sid-fixture; LOGIN_INFO=login-fixture', cookies: new Map([['SAPISID', 'sid-fixture'], ['LOGIN_INFO', 'login-fixture']]) }

describe('InnerTube client', () => {
  it('sends the WEB_REMIX context, the imported cookies and a SAPISIDHASH only on signed requests', async () => {
    const fetch = vi.fn(async () => reply(loggedIn('1')))
    const client = new InnerTubeClient({ fetch: fetch as unknown as typeof globalThis.fetch, getCredentials: () => credentials })
    await client.request({ endpoint: 'browse', body: { browseId: 'FEmusic_home' }, auth: 'optional' })
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false')
    const headers = init.headers as Record<string, string>
    expect(headers.Cookie).toBe(credentials.cookieHeader)
    expect(headers.Authorization).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/)
    expect(headers['X-YouTube-Client-Name']).toBe('67')
    expect(headers.Origin).toBe('https://music.youtube.com')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ browseId: 'FEmusic_home', context: { client: { clientName: 'WEB_REMIX', hl: 'en' } } })

    await client.request({ endpoint: 'search', body: { query: 'x' }, auth: 'none' })
    const second = fetch.mock.calls[1] as unknown as [URL, RequestInit]
    const secondHeaders = second[1].headers as Record<string, string>
    expect(secondHeaders.Cookie).toBeUndefined()
    expect(secondHeaders.Authorization).toBeUndefined()
    // The visitor ID from the first response is reused, as the web client does.
    expect(secondHeaders['X-Goog-Visitor-Id']).toBe('visitor-1')
  })

  it('sends legacy and command continuations the way each was issued', async () => {
    const fetch = vi.fn(async () => reply(loggedIn('0')))
    const client = new InnerTubeClient({ fetch: fetch as unknown as typeof globalThis.fetch, getCredentials: () => null })
    await client.request({ endpoint: 'browse', auth: 'optional', continuation: { token: 'legacy-token', style: 'legacy' } })
    await client.request({ endpoint: 'browse', auth: 'optional', continuation: { token: 'command-token', style: 'command' } })
    const [legacyUrl] = fetch.mock.calls[0] as unknown as [URL]
    expect(legacyUrl.searchParams.get('ctoken')).toBe('legacy-token')
    expect(legacyUrl.searchParams.get('type')).toBe('next')
    const [, commandInit] = fetch.mock.calls[1] as unknown as [URL, RequestInit]
    expect(JSON.parse(String(commandInit.body)).continuation).toBe('command-token')
  })

  it('treats a signed request answered as signed out as an expired session', async () => {
    const rejected = vi.fn()
    const client = new InnerTubeClient({ fetch: (async () => reply(loggedIn('0'))) as typeof fetch, getCredentials: () => credentials, onSessionRejected: rejected })
    await expect(client.request({ endpoint: 'browse', auth: 'required' })).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    expect(rejected).toHaveBeenCalledOnce()
    const unauthorized = new InnerTubeClient({ fetch: (async () => reply({}, { status: 401 })) as typeof fetch, getCredentials: () => credentials, onSessionRejected: rejected })
    await expect(unauthorized.request({ endpoint: 'browse', auth: 'required' })).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
  })

  it('requires a session for account requests', async () => {
    const client = new InnerTubeClient({ fetch: vi.fn() as unknown as typeof fetch, getCredentials: () => null })
    await expect(client.request({ endpoint: 'browse', auth: 'required' })).rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
  })

  it('retries transient failures a bounded number of times and honors Retry-After', async () => {
    const sleep = vi.fn(async () => {})
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply({}, { status: 503 }))
      .mockResolvedValueOnce(reply({}, { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(reply(loggedIn('0', { ok: true })))
    const client = new InnerTubeClient({ fetch: fetch as unknown as typeof globalThis.fetch, getCredentials: () => null, sleep })
    await expect(client.request({ endpoint: 'browse', auth: 'optional' })).resolves.toMatchObject({ ok: true })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 2_000])
    const failing = new InnerTubeClient({ fetch: (async () => reply({}, { status: 500 })) as typeof fetch, getCredentials: () => null, sleep, maxAttempts: 2 })
    await expect(failing.request({ endpoint: 'browse', auth: 'optional' })).rejects.toMatchObject({ providerError: { code: 'NETWORK' } })
  })

  it('maps missing items without retrying', async () => {
    const fetch = vi.fn(async () => reply({}, { status: 404 }))
    const client = new InnerTubeClient({ fetch: fetch as unknown as typeof globalThis.fetch, getCredentials: () => null })
    await expect(client.request({ endpoint: 'browse', auth: 'optional' })).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('cookie rotation', () => {
  it('reports the Set-Cookie headers of signed answers only', async () => {
    const fetch = vi.fn(async () => {
      const headers = new Headers({ 'content-type': 'application/json' })
      headers.append('set-cookie', '__Secure-1PSIDTS=new; Domain=.youtube.com; Path=/; Secure')
      headers.append('set-cookie', 'SIDCC=new; Domain=.youtube.com; Path=/')
      return new Response(JSON.stringify(loggedIn('1')), { status: 200, headers })
    })
    const onCookies = vi.fn()
    const client = new InnerTubeClient({ fetch: fetch as unknown as typeof globalThis.fetch, getCredentials: () => credentials, onCookies })
    await client.request({ endpoint: 'browse', auth: 'required' })
    expect(onCookies).toHaveBeenCalledWith(
      ['__Secure-1PSIDTS=new; Domain=.youtube.com; Path=/; Secure', 'SIDCC=new; Domain=.youtube.com; Path=/'],
      expect.any(URL),
      credentials,
    )
    await client.request({ endpoint: 'search', auth: 'none' })
    expect(onCookies).toHaveBeenCalledTimes(1)
  })
})
