import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeLiteLLM,
  authorizeOidc,
  parseOidcConfig,
  refreshSsoToken,
  ssoRoot,
  type SsoAuthorization,
  type SsoToken,
} from '../src/utils/sso'

const ROOT = 'https://llm.example.com'
const ISSUER = 'https://idp.example.com'
const realFetch = globalThis.fetch

type Handler = (request: { url: URL; body: string }) => Response | Promise<Response>
type Call = { key: string; url: URL; headers: Headers; body: string }

/** Routes fetch by `METHOD origin+path`; unrouted requests get a 404. */
function mockFetch(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`
    const body = init?.body === undefined ? '' : String(init.body)
    calls.push({ key, url, headers: new Headers(init?.headers), body })
    return handlers[key]?.({ url, body }) ?? new Response('not found', { status: 404 })
  }) as typeof fetch
  return calls
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.signature`
}

function autoCallback(authorization: SsoAuthorization): Promise<SsoToken> {
  if (authorization.mode !== 'auto')
    throw new Error(`expected an auto sign-in, got ${authorization.mode}`)
  return authorization.callback
}

/** What the browser does after sign-in: follow the redirect back to the loopback listener. */
async function redirectBack(
  authorization: SsoAuthorization,
  params: Record<string, string>,
): Promise<Response> {
  const authorizationUrl = new URL(authorization.url)
  const callback = new URL(authorizationUrl.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', authorizationUrl.searchParams.get('state')!)
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value)
  return realFetch(callback)
}

function cliAuthDiscovery(overrides: Record<string, unknown> = {}) {
  return json({
    contract_version: 1,
    issuer: ROOT,
    code_challenge_methods_supported: ['S256'],
    authorization_endpoint: `${ROOT}/cli/authorize`,
    token_endpoint: `${ROOT}/cli/token`,
    registration_endpoint: `${ROOT}/cli/register`,
    resource: `${ROOT}/`,
    ...overrides,
  })
}

const pkceToken = (overrides: Partial<SsoToken> = {}): SsoToken => ({
  access: 'example-access',
  refresh: 'example-refresh',
  expires: Date.now() + 60_000,
  metadata: {
    flow: 'litellm_cli_pkce',
    baseURL: ROOT,
    clientId: 'example-client',
    tokenEndpoint: `${ROOT}/cli/token`,
    resource: `${ROOT}/`,
  },
  ...overrides,
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('ssoRoot', () => {
  it('accepts https and loopback http, without the /v1 suffix', () => {
    expect(ssoRoot('https://llm.example.com/v1/')).toBe('https://llm.example.com')
    expect(ssoRoot('http://127.0.0.1:4000/v1')).toBe('http://127.0.0.1:4000')
    expect(ssoRoot('http://localhost:4000')).toBe('http://localhost:4000')
  })

  it('refuses plain http to other hosts and URLs carrying credentials', () => {
    expect(() => ssoRoot('http://llm.example.com')).toThrow(/https/)
    expect(() => ssoRoot('http://127.example.com')).toThrow(/https/)
    expect(() => ssoRoot('https://user:pass@llm.example.com')).toThrow(/credentials/)
  })
})

describe('LiteLLM CLI-auth (PKCE) sign-in', () => {
  it('registers a client, waits for the browser, and exchanges the code', async () => {
    const calls = mockFetch({
      [`GET ${ROOT}/.well-known/litellm-cli-auth`]: () => cliAuthDiscovery(),
      [`POST ${ROOT}/cli/register`]: ({ body }) =>
        json({ client_id: 'example-client', redirect_uris: JSON.parse(body).redirect_uris }),
      [`POST ${ROOT}/cli/token`]: () =>
        json({
          access_token: 'example-access',
          refresh_token: 'example-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
    })

    const authorization = await authorizeLiteLLM(`${ROOT}/v1`, { 'X-Gateway': 'example-gateway' })
    const url = new URL(authorization.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${ROOT}/cli/authorize`)
    expect(url.searchParams.get('client_id')).toBe('example-client')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    // A callback with another state is refused and the listener keeps waiting.
    const forged = new URL(url.searchParams.get('redirect_uri')!)
    forged.searchParams.set('state', 'forged')
    forged.searchParams.set('code', 'example-code')
    expect((await realFetch(forged)).status).toBe(400)

    expect((await redirectBack(authorization, { code: 'example-code' })).status).toBe(200)
    const token = await autoCallback(authorization)
    expect(token).toMatchObject({
      access: 'example-access',
      refresh: 'example-refresh',
      metadata: {
        flow: 'litellm_cli_pkce',
        baseURL: ROOT,
        clientId: 'example-client',
        tokenEndpoint: `${ROOT}/cli/token`,
        resource: `${ROOT}/`,
      },
    })
    expect(token.expires).toBeGreaterThan(Date.now() + 3_500_000)

    const exchange = new URLSearchParams(
      calls.find((call) => call.key === `POST ${ROOT}/cli/token`)!.body,
    )
    expect(exchange.get('code')).toBe('example-code')
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    )
    expect(calls.every((call) => call.headers.get('X-Gateway') === 'example-gateway')).toBe(true)
  })

  it('reports a denied sign-in', async () => {
    mockFetch({
      [`GET ${ROOT}/.well-known/litellm-cli-auth`]: () => cliAuthDiscovery(),
      [`POST ${ROOT}/cli/register`]: ({ body }) =>
        json({ client_id: 'example-client', redirect_uris: JSON.parse(body).redirect_uris }),
    })
    const authorization = await authorizeLiteLLM(ROOT)
    await redirectBack(authorization, { error: 'access_denied' })
    await expect(autoCallback(authorization)).rejects.toThrow(
      'LiteLLM sign-in was denied (access_denied)',
    )
  })

  it('stops at discovery that points outside the proxy', async () => {
    mockFetch({
      [`GET ${ROOT}/.well-known/litellm-cli-auth`]: () =>
        cliAuthDiscovery({ token_endpoint: 'https://elsewhere.example.net/token' }),
    })
    await expect(authorizeLiteLLM(ROOT)).rejects.toThrow('cross-origin token endpoint')
  })

  it('rotates tokens on refresh and keeps the refresh token the server does not replace', async () => {
    const calls = mockFetch({
      [`POST ${ROOT}/cli/token`]: () =>
        json({ access_token: 'example-access-2', token_type: 'bearer', expires_in: 60 }),
    })
    const refreshed = await refreshSsoToken(pkceToken(), { 'X-Gateway': 'example-gateway' })
    expect(refreshed).toMatchObject({ access: 'example-access-2', refresh: 'example-refresh' })
    const form = new URLSearchParams(calls[0].body)
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'example-refresh',
      client_id: 'example-client',
      resource: `${ROOT}/`,
    })
    expect(calls[0].headers.get('X-Gateway')).toBe('example-gateway')
  })

  it('keeps the token through a transient refresh failure until it expires', async () => {
    mockFetch({ [`POST ${ROOT}/cli/token`]: () => new Response('unavailable', { status: 503 }) })
    const token = pkceToken()
    await expect(refreshSsoToken(token)).resolves.toBe(token)
    await expect(refreshSsoToken(pkceToken({ expires: Date.now() - 1 }))).rejects.toThrow(
      'LiteLLM token exchange failed (HTTP 503)',
    )
  })

  it('asks for a new sign-in when the refresh token is rejected', async () => {
    mockFetch({ [`POST ${ROOT}/cli/token`]: () => json({ error: 'invalid_grant' }, 400) })
    await expect(refreshSsoToken(pkceToken())).rejects.toThrow(
      'LiteLLM token exchange rejected (invalid_grant); connect LiteLLM again',
    )
  })
})

describe('LiteLLM CLI SSO sign-in', () => {
  const start = () =>
    json({
      login_id: 'example-login',
      poll_secret: 'example-poll',
      user_code: 'ABCD-1234',
      expires_in: 60,
    })
  const teams = {
    status: 'ready',
    requires_team_selection: true,
    team_details: [
      { team_id: 'team-1', team_alias: 'Platform' },
      { team_id: 'team-2', team_alias: 'Research' },
    ],
  }

  it('polls with the confirmation code and signs in to the team the form names', async () => {
    let polls = 0
    const calls = mockFetch({
      [`POST ${ROOT}/sso/cli/start`]: start,
      [`GET ${ROOT}/sso/cli/poll/example-login`]: ({ url }) => {
        polls += 1
        if (polls === 1) return json({ status: 'pending' })
        if (!url.searchParams.has('team_id')) return json(teams)
        return json({ status: 'ready', key: 'example-cli-token', expires_in: 3600 })
      },
    })

    const authorization = await authorizeLiteLLM(ROOT, undefined, 'Research')
    expect(authorization.instructions).toContain('ABCD-1234')
    expect(authorization.url).toBe(`${ROOT}/sso/key/generate?source=litellm-cli&key=example-login`)
    const token = await autoCallback(authorization)

    expect(token).toMatchObject({
      access: 'example-cli-token',
      refresh: '',
      metadata: { baseURL: ROOT },
    })
    expect(token.expires).toBeGreaterThan(Date.now() + 3_500_000)
    const pollCalls = calls.filter((call) => call.key === `GET ${ROOT}/sso/cli/poll/example-login`)
    expect(pollCalls.map((call) => call.url.searchParams.get('team_id'))).toEqual([
      null,
      null,
      'team-2',
    ])
    expect(
      pollCalls.every((call) => call.headers.get('x-litellm-cli-poll-secret') === 'example-poll'),
    ).toBe(true)
  })

  it('lists the teams when sign-in needs one the form did not name', async () => {
    mockFetch({
      [`POST ${ROOT}/sso/cli/start`]: start,
      [`GET ${ROOT}/sso/cli/poll/example-login`]: () => json(teams),
    })
    const authorization = await authorizeLiteLLM(ROOT)
    await expect(autoCallback(authorization)).rejects.toThrow(
      'LiteLLM asks which team to sign in with; connect again with one of these as Team: Platform (team-1), Research (team-2)',
    )
  })

  it('takes the expiry from the token when the poll response has none', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    mockFetch({
      [`POST ${ROOT}/sso/cli/start`]: start,
      [`GET ${ROOT}/sso/cli/poll/example-login`]: () =>
        json({ status: 'ready', key: jwt({ exp }) }),
    })
    const token = await autoCallback(await authorizeLiteLLM(ROOT))
    expect(token.expires).toBe(exp * 1000)
  })
})

describe('LiteLLM UI token sign-in', () => {
  it('exchanges the pasted token for a virtual key', async () => {
    const calls = mockFetch({
      [`POST ${ROOT}/sso/cli/start`]: () => new Response('method not allowed', { status: 405 }),
      [`POST ${ROOT}/key/generate`]: () =>
        json({ key: 'example-virtual-key', expires: '2099-01-01T00:00:00Z' }),
    })
    const authorization = await authorizeLiteLLM(ROOT)
    expect(authorization).toMatchObject({ mode: 'code', url: `${ROOT}/sso/key/generate` })
    if (authorization.mode !== 'code') throw new Error('expected a code sign-in')

    const token = await authorization.callback('Bearer example-ui-token ')
    expect(token).toEqual({
      access: 'example-virtual-key',
      refresh: '',
      expires: Date.parse('2099-01-01T00:00:00Z'),
      metadata: { baseURL: ROOT },
    })
    expect(calls.at(-1)?.headers.get('Authorization')).toBe('Bearer example-ui-token')
  })

  it('uses the pasted token directly when the proxy cannot mint a virtual key', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const exp = Math.floor(Date.now() / 1000) + 600
    const pasted = jwt({ exp })
    mockFetch({
      [`POST ${ROOT}/key/generate`]: () => json({ error: 'no database' }, 500),
    })
    const authorization = await authorizeLiteLLM(ROOT)
    if (authorization.mode !== 'code') throw new Error('expected a code sign-in')
    await expect(authorization.callback(pasted)).resolves.toMatchObject({
      access: pasted,
      expires: exp * 1000,
    })
    await expect(authorization.callback('  ')).rejects.toThrow(
      'Paste the token from the LiteLLM UI',
    )
  })

  it('lasts until expiry, then asks for a new sign-in', async () => {
    const token: SsoToken = {
      access: 'example-ui-token',
      refresh: '',
      expires: Date.now() + 60_000,
      metadata: {},
    }
    await expect(refreshSsoToken(token)).resolves.toBe(token)
    await expect(refreshSsoToken({ ...token, expires: Date.now() - 1 })).rejects.toThrow(
      'LiteLLM sign-in expired; connect LiteLLM again',
    )
  })
})

describe('direct OIDC sign-in', () => {
  const config = () =>
    parseOidcConfig({ issuer: ISSUER, clientId: 'example-client', scope: 'openid offline_access' })
  const discovery = () =>
    json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      code_challenge_methods_supported: ['S256'],
    })
  const exp = Math.floor(Date.now() / 1000) + 3600
  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: 'example-client',
    sub: 'example-user',
    exp,
    ...overrides,
  })

  it('validates the form fields', () => {
    expect(
      parseOidcConfig({ issuer: ISSUER, clientId: 'example-client', redirectPorts: '8400, 8401' }),
    ).toEqual({
      issuer: ISSUER,
      clientId: 'example-client',
      scope: 'openid',
      redirectPorts: [8400, 8401],
    })
    expect(() =>
      parseOidcConfig({ issuer: 'http://idp.example.com', clientId: 'example-client' }),
    ).toThrow('Invalid OIDC issuer')
    expect(() => parseOidcConfig({ issuer: ISSUER })).toThrow('Invalid OIDC client ID')
    expect(() =>
      parseOidcConfig({ issuer: ISSUER, clientId: 'example-client', scope: 'profile' }),
    ).toThrow('Invalid OIDC scopes')
    expect(() =>
      parseOidcConfig({ issuer: ISSUER, clientId: 'example-client', redirectPorts: '80000' }),
    ).toThrow('Invalid OIDC redirect ports')
  })

  it('signs in with the identity provider and stores its id_token', async () => {
    let nonce = ''
    const idToken = () => jwt(claims({ nonce }))
    const calls = mockFetch({
      [`GET ${ISSUER}/.well-known/openid-configuration`]: discovery,
      [`POST ${ISSUER}/token`]: () =>
        json({ id_token: idToken(), refresh_token: 'example-refresh' }),
    })

    const authorization = await authorizeOidc(config())
    const url = new URL(authorization.url)
    nonce = url.searchParams.get('nonce')!
    expect(url.searchParams.get('scope')).toBe('openid offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')

    await redirectBack(authorization, { code: 'example-code' })
    const token = await autoCallback(authorization)
    expect(token).toMatchObject({
      access: idToken(),
      refresh: 'example-refresh',
      metadata: {
        flow: 'oidc_pkce',
        issuer: ISSUER,
        clientId: 'example-client',
        tokenEndpoint: `${ISSUER}/token`,
        subject: 'example-user',
        scope: 'openid offline_access',
      },
    })
    expect(new URLSearchParams(calls.at(-1)!.body).get('code_verifier')).toBeTruthy()
  })

  it('refuses an id_token issued to another client or for another login', async () => {
    let token = ''
    mockFetch({
      [`GET ${ISSUER}/.well-known/openid-configuration`]: discovery,
      [`POST ${ISSUER}/token`]: () => json({ id_token: token }),
    })

    const forOtherClient = await authorizeOidc(config())
    token = jwt(
      claims({ aud: 'other-client', nonce: new URL(forOtherClient.url).searchParams.get('nonce') }),
    )
    await redirectBack(forOtherClient, { code: 'example-code' })
    await expect(autoCallback(forOtherClient)).rejects.toThrow('OIDC id_token has invalid aud')

    const replayed = await authorizeOidc(config())
    token = jwt(claims({ nonce: 'another-login' }))
    await redirectBack(replayed, { code: 'example-code' })
    await expect(autoCallback(replayed)).rejects.toThrow('OIDC id_token has invalid nonce')
  })

  it('refreshes the id_token for the same subject only', async () => {
    let subject = 'example-user'
    mockFetch({ [`POST ${ISSUER}/token`]: () => json({ id_token: jwt(claims({ sub: subject })) }) })
    const token: SsoToken = {
      access: 'example-old-id-token',
      refresh: 'example-refresh',
      expires: Date.now() + 60_000,
      metadata: {
        flow: 'oidc_pkce',
        issuer: ISSUER,
        clientId: 'example-client',
        tokenEndpoint: `${ISSUER}/token`,
        subject: 'example-user',
      },
    }
    await expect(refreshSsoToken(token)).resolves.toMatchObject({
      access: jwt(claims({ sub: 'example-user' })),
      refresh: 'example-refresh',
    })
    subject = 'someone-else'
    await expect(refreshSsoToken(token)).rejects.toThrow(
      'OIDC id_token has invalid sub; connect LiteLLM again',
    )
  })
})
