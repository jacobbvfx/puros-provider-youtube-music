import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSecretsHostV1 } from 'puros-provider-sdk'
import { InnerTubeClient } from './innertube'
import { COOKIE_DIR, YtmSessionService } from './session'

// Fabricated cookies in the SimpMusic Utils export shapes.
const FUTURE = '1893456000.5'
const netscape = [
  '# Netscape HTTP Cookie File',
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tSAPISID\tsid-fixture`,
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\t__Secure-3PAPISID\tsid-fixture`,
  `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tLOGIN_INFO\tlogin-fixture`,
].join('\n')
const string = 'SAPISID=sid-fixture; __Secure-3PAPISID=sid-fixture; LOGIN_INFO=login-fixture'
const values = { 'cookie-string': string, 'cookie-netscape': netscape }

const accountMenu = {
  responseContext: { serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'logged_in', value: '1' }] }] },
  actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { header: { activeAccountHeaderRenderer: {
    accountName: { runs: [{ text: 'Test Listener' }] }, channelHandle: { runs: [{ text: '@listener' }] },
  } } } } } }],
}

const stored = (store: Map<string, string>) => JSON.parse(store.get('session')!) as { cookieHeader: string; jar: Array<{ domain: string; name: string; value: string }> }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function setup(response: unknown = accountMenu) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ytm-session-'))
  roots.push(dataRoot)
  const store = new Map<string, string>()
  const secrets: ProviderSecretsHostV1 = {
    has: async (key) => store.has(key),
    get: async (key) => store.get(key),
    set: async (key, value) => { store.set(key, value) },
    delete: async (key) => { store.delete(key) },
  }
  const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
  let service!: YtmSessionService
  const client = new InnerTubeClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
    getCredentials: () => service.getCredentials(),
    onSessionRejected: () => service.markExpired(),
    onCookies: (setCookies, url, credentials) => service.absorbSetCookies(setCookies, url, credentials),
  })
  service = new YtmSessionService({ secrets, dataRoot: async () => dataRoot, client: () => client })
  return { service, store, secrets, fetch, dataRoot, client }
}

describe('YouTube Music session import', () => {
  it('verifies the session with account_menu before storing it only in host secrets', async () => {
    const { service, store, fetch, secrets, dataRoot, client } = setup()
    await service.load()
    expect(service.status().state).toBe('signed-out')
    await expect(service.importSession(values)).resolves.toEqual({ name: 'Test Listener', handle: '@listener' })
    const urls = fetch.mock.calls.map((call) => String((call as unknown as [URL])[0]))
    expect(urls[0]).toContain('/getAccountSwitcherEndpoint')
    expect(urls[1]).toContain('/account/account_menu')
    expect(service.status()).toEqual({ state: 'connected', account: { name: 'Test Listener', handle: '@listener' } })
    expect([...store.keys()]).toEqual(['session'])
    // Nothing else was written to disk.
    expect(fs.readdirSync(dataRoot)).toEqual([])

    // A restart restores it from the secret.
    const restored = new YtmSessionService({ secrets, dataRoot: async () => dataRoot, client: () => client })
    await restored.load()
    expect(restored.status().state).toBe('connected')
    expect(restored.getCredentials()?.cookieHeader).toBe(string)
  })

  it('imports a pasted Cookie header alone and builds the yt-dlp jar from it', async () => {
    const { service, store } = setup()
    await expect(service.importSession({ 'cookie-string': `cookie: ${string}`, 'cookie-netscape': '' })).resolves.toEqual({ name: 'Test Listener', handle: '@listener' })
    expect(service.status().state).toBe('connected')
    expect(service.getCredentials()?.cookieHeader).toBe(string)
    expect(stored(store).jar.map((cookie) => [cookie.domain, cookie.name])).toEqual([
      ['.youtube.com', 'SAPISID'], ['.youtube.com', '__Secure-3PAPISID'], ['.youtube.com', 'LOGIN_INFO'],
    ])
  })

  it('rejects a session YouTube answers as signed out and keeps the previous one', async () => {
    const { service, store } = setup({ actions: [] })
    await expect(service.importSession(values)).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    expect(store.size).toBe(0)
    expect(service.status().state).toBe('signed-out')
  })

  it('rejects malformed exports without storing or echoing them', async () => {
    const { service, store, fetch } = setup()
    await expect(service.importSession({ 'cookie-string': netscape, 'cookie-netscape': netscape })).rejects.toMatchObject({ providerError: { code: 'INVALID_ARGUMENT' } })
    await expect(service.importSession({ 'cookie-netscape': netscape })).rejects.toThrow(/Cookie header/)
    await expect(service.importSession({ 'cookie-string': 'PREF=f6=4' })).rejects.toThrow(/__Secure-3PAPISID/)
    expect(fetch).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
  })

  it('writes a 0600 Netscape file for yt-dlp and removes it after success, failure and logout', async () => {
    const { service, dataRoot, store } = setup()
    await service.importSession(values)
    let seen = ''
    await service.withCookieFile(async (file) => {
      seen = file
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
      expect(fs.readFileSync(file, 'utf8')).toContain('.youtube.com\tTRUE\t/\tTRUE\t1893456000\tLOGIN_INFO\tlogin-fixture')
    })
    expect(fs.existsSync(seen)).toBe(false)
    await expect(service.withCookieFile(async (file) => { seen = file; throw new Error('yt-dlp failed') })).rejects.toThrow('yt-dlp failed')
    expect(fs.existsSync(seen)).toBe(false)

    // A file left by a crashed run is removed on logout, together with the secret.
    fs.writeFileSync(path.join(dataRoot, COOKIE_DIR, 'stale.txt'), 'x')
    await service.logout()
    expect(fs.existsSync(path.join(dataRoot, COOKIE_DIR))).toBe(false)
    expect(store.size).toBe(0)
    expect(service.getCredentials()).toBeNull()
    await expect(service.withCookieFile(async () => 1)).rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
  })

  it('acts as the identity the browser had active and switches between identities', async () => {
    // Shape of music.youtube.com/getAccountSwitcherEndpoint (as parsed by SimpMusic), fabricated values.
    const identity = (name: string, handle: string, authuser: number, pageId: string | null, selected: boolean) => ({ accountItem: {
      accountName: { simpleText: name }, channelHandle: { simpleText: handle }, isSelected: selected, hasChannel: true,
      ...(pageId ? { onBehalfOfParameter: pageId } : {}),
      serviceEndpoint: { selectActiveIdentityEndpoint: { supportedTokens: [
        { accountSigninToken: { signinUrl: `/signin?action_handle_signin=true&authuser=${authuser}&next=%2F` } },
        ...(pageId ? [{ pageIdToken: { pageId } }] : []),
      ] } },
    } })
    const switcher = `)]}'\n${JSON.stringify({ code: 'SUCCESS', data: { actions: [{ getMultiPageMenuAction: { menu: { multiPageMenuRenderer: { sections: [
      { accountSectionListRenderer: { contents: [{ accountItemSectionRenderer: { contents: [
        identity('Personal', '@personal', 0, null, false),
        identity('Jacobb', '@jacobb', 0, '111222333', true),
      ] } }] } },
      { accountSectionListRenderer: { contents: [{ accountItemSectionRenderer: { contents: [identity('Second', '@second', 1, null, false)] } }] } },
    ] } } } }] } })}`
    const { service, fetch, store } = setup()
    fetch.mockImplementation(async (url: URL | string) => String(url).includes('getAccountSwitcherEndpoint')
      ? new Response(switcher, { status: 200 })
      : new Response(JSON.stringify(accountMenu), { status: 200 }))
    await service.importSession(values)
    const headersOf = (call: number) => (fetch.mock.calls[call] as unknown as [URL, RequestInit])[1].headers as Record<string, string>
    // The switcher itself is asked as the default identity; the check runs as the active one.
    expect(headersOf(0)['X-Goog-PageId']).toBeUndefined()
    expect(headersOf(1)).toMatchObject({ 'X-Goog-AuthUser': '0', 'X-Goog-PageId': '111222333' })
    expect(service.getCredentials()).toMatchObject({ authUser: 0, pageId: '111222333' })
    expect(service.status().identity).toEqual({ index: 2, count: 3 })

    await service.switchIdentity()
    expect(service.getCredentials()).toMatchObject({ authUser: 1, pageId: null })
    expect(headersOf(fetch.mock.calls.length - 1)).toMatchObject({ 'X-Goog-AuthUser': '1' })
    expect(JSON.parse(store.get('session')!)).toMatchObject({ selected: 2 })
    await service.switchIdentity()
    expect(service.status().identity).toEqual({ index: 1, count: 3 })
  })

  it('refuses to switch when the session has one identity', async () => {
    const { service } = setup()
    await service.importSession(values)
    await expect(service.switchIdentity()).rejects.toMatchObject({ providerError: { code: 'INVALID_ARGUMENT' } })
  })

  it('stops using a session YouTube rejected, and a new import replaces it', async () => {
    const { service } = setup()
    await service.importSession(values)
    const changes = vi.fn()
    service.onChange(changes)
    service.markExpired()
    expect(service.status().state).toBe('expired')
    expect(service.getCredentials()).toBeNull()
    await expect(service.withCookieFile(async () => 1)).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    await service.importSession(values)
    expect(service.status().state).toBe('connected')
    expect(changes).toHaveBeenCalledTimes(2)
  })
})

describe('YouTube Music cookies YouTube updates', () => {
  const withSetCookie = (body: unknown, ...setCookies: string[]) => {
    const headers = new Headers()
    for (const setCookie of setCookies) headers.append('set-cookie', setCookie)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers })
  }

  it('keeps cookies InnerTube rotates and saves them for the next start', async () => {
    const { service, store, secrets, dataRoot, client, fetch } = setup()
    await service.importSession(values)
    fetch.mockImplementation(async () => withSetCookie(accountMenu, '__Secure-1PSIDTS=sidts-new; Domain=.youtube.com; Path=/; Max-Age=63072000; Secure; HttpOnly'))
    await client.request({ endpoint: 'account/account_menu', auth: 'required' })
    expect(service.getCredentials()?.cookieHeader).toContain('__Secure-1PSIDTS=sidts-new')
    // The next request already sends the rotated value.
    await client.request({ endpoint: 'account/account_menu', auth: 'required' })
    const [, init] = fetch.mock.calls.at(-1) as unknown as [URL, RequestInit]
    expect((init.headers as Record<string, string>).Cookie).toContain('__Secure-1PSIDTS=sidts-new')

    await service.flush()
    expect(stored(store).jar).toContainEqual(expect.objectContaining({ name: '__Secure-1PSIDTS', value: 'sidts-new' }))
    const restored = new YtmSessionService({ secrets, dataRoot: async () => dataRoot, client: () => client })
    await restored.load()
    expect(restored.getCredentials()?.cookieHeader).toContain('__Secure-1PSIDTS=sidts-new')
  })

  it('saves rotated cookies on its own shortly after they arrive', async () => {
    vi.useFakeTimers()
    try {
      const { service, store, client, fetch } = setup()
      await service.importSession(values)
      fetch.mockImplementation(async () => withSetCookie(accountMenu, 'SIDCC=cc-new; Domain=.youtube.com; Path=/; Max-Age=600'))
      await client.request({ endpoint: 'account/account_menu', auth: 'required' })
      expect(stored(store).cookieHeader).not.toContain('SIDCC')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(stored(store).cookieHeader).toContain('SIDCC=cc-new')
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes cookies rotated while an import is verified into the saved session', async () => {
    const { service, store, fetch } = setup()
    fetch.mockImplementation(async () => withSetCookie(accountMenu, 'SIDCC=during-import; Domain=.youtube.com; Path=/'))
    await service.importSession(values)
    expect(stored(store).cookieHeader).toContain('SIDCC=during-import')
  })

  it('ignores cookies of another browser session', async () => {
    const { service, client, fetch } = setup()
    await service.importSession(values)
    fetch.mockImplementation(async () => withSetCookie(accountMenu, 'SIDCC=other; Domain=.youtube.com; Path=/'))
    const other = { cookieHeader: 'SAPISID=someone-else; LOGIN_INFO=x', cookies: new Map([['SAPISID', 'someone-else'], ['LOGIN_INFO', 'x']]) }
    await client.request({ endpoint: 'account/account_menu', auth: 'required', credentials: other })
    expect(service.getCredentials()?.cookieHeader).not.toContain('SIDCC')
  })

  it('reads back the cookies yt-dlp saved to its cookie file', async () => {
    const { service, store } = setup()
    await service.importSession(values)
    await service.withCookieFile(async (file) => {
      fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-3PSIDTS\tfrom-ytdlp\n`)
    })
    expect(service.getCredentials()?.cookieHeader).toContain('__Secure-3PSIDTS=from-ytdlp')
    await service.flush()
    expect(stored(store).jar).toContainEqual(expect.objectContaining({ name: '__Secure-3PSIDTS', value: 'from-ytdlp' }))
  })

  it('never writes rotated cookies back after logout', async () => {
    const { service, store, client, fetch } = setup()
    await service.importSession(values)
    fetch.mockImplementation(async () => withSetCookie(accountMenu, 'SIDCC=late; Domain=.youtube.com; Path=/'))
    await client.request({ endpoint: 'account/account_menu', auth: 'required' })
    await service.logout()
    await service.flush()
    expect(store.size).toBe(0)
  })
})
