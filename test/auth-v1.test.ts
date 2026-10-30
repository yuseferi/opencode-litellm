import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiteLLMPlugin } from '../src/plugin'
import { buildCacheKey, readModelCacheEntry } from '../src/utils/model-cache'
import { resetOpenCodeAuthCache } from '../src/utils/opencode-auth'

const BASE = 'http://127.0.0.1:44521'
const TOKEN_ENDPOINT = `${BASE}/cli/token`
const METADATA = {
  flow: 'litellm_cli_pkce',
  baseURL: BASE,
  clientId: 'example-client',
  tokenEndpoint: TOKEN_ENDPOINT,
  resource: `${BASE}/`,
}

interface Recorded {
  url: string
  method: string
  authorization: string | null
  headers: Headers
  body: string
}

interface ProviderConfig {
  npm?: string
  options: Record<string, any>
  models: Record<string, unknown>
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('OpenCode 1 LiteLLM sign-in', () => {
  const originalFetch = globalThis.fetch
  let originalCacheHome: string | undefined
  let originalHome: string | undefined
  let originalLiteLLMApiKey: string | undefined
  let originalLiteLLMBaseURL: string | undefined
  let originalLiteLLMMasterKey: string | undefined
  let cacheDirectory: string
  let homeDirectory: string
  let requests: Recorded[]

  beforeEach(() => {
    originalCacheHome = process.env.XDG_CACHE_HOME
    originalHome = process.env.HOME
    originalLiteLLMApiKey = process.env.LITELLM_API_KEY
    originalLiteLLMBaseURL = process.env.LITELLM_BASE_URL
    delete process.env.LITELLM_BASE_URL
    originalLiteLLMMasterKey = process.env.LITELLM_MASTER_KEY
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_MASTER_KEY
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-auth-cache-'))
    homeDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-auth-home-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    process.env.HOME = homeDirectory
    requests = []
    resetOpenCodeAuthCache()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv('XDG_CACHE_HOME', originalCacheHome)
    restoreEnv('HOME', originalHome)
    restoreEnv('LITELLM_API_KEY', originalLiteLLMApiKey)
    restoreEnv('LITELLM_BASE_URL', originalLiteLLMBaseURL)
    restoreEnv('LITELLM_MASTER_KEY', originalLiteLLMMasterKey)
    rmSync(cacheDirectory, { recursive: true, force: true })
    rmSync(homeDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function writeAuthFile(litellm: Record<string, unknown> | undefined): void {
    const path = join(homeDirectory, '.local', 'share', 'opencode', 'auth.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(litellm ? { litellm } : {}))
  }

  function pkceEntry(overrides: { access?: string; refresh?: string; expires?: number } = {}) {
    return {
      type: 'oauth',
      access: 'example-access',
      refresh: 'example-refresh',
      expires: Date.now() + 60 * 60 * 1000,
      accountId: JSON.stringify(METADATA),
      ...overrides,
    }
  }

  /** Records every request; `respond` may answer some, the rest get the proxy defaults. */
  function mockFetch(respond: (request: Recorded) => Response | undefined = () => undefined): void {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const request: Recorded = {
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('Authorization'),
        headers,
        body: init?.body === undefined ? '' : String(init.body),
      }
      requests.push(request)
      const answer = respond(request)
      if (answer) return answer
      if (request.url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      if (request.url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'example-model' }] }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch
  }

  function tokenSuccess(access: string, refresh: string): Response {
    return new Response(
      JSON.stringify({
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 3600,
      }),
      { status: 200 },
    )
  }

  function createInput() {
    const client = {
      app: { log: vi.fn(async () => {}) },
      auth: { set: vi.fn(async () => ({ data: true })) },
    }
    return { client, input: { client } as unknown as PluginInput }
  }

  function createConfig(options: Record<string, unknown>): {
    provider: { litellm: ProviderConfig }
  } {
    return {
      provider: {
        litellm: { npm: '@ai-sdk/openai-compatible', options, models: {} },
      },
    }
  }

  /** Moves past the 30 s in which a failed refresh is not retried. */
  function skipRetryWindow(): void {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 1000)
  }

  const discoveryRequests = () => requests.filter((request) => request.url.endsWith('/v1/models'))
  const tokenRequests = () => requests.filter((request) => request.url === TOKEN_ENDPOINT)

  it('exposes the LiteLLM auth hook with its three sign-in methods', async () => {
    mockFetch()
    const hooks = await LiteLLMPlugin(createInput().input)

    expect(hooks.auth?.provider).toBe('litellm')
    expect(hooks.auth?.methods.map((method) => method.label)).toEqual([
      'LiteLLM SSO',
      'Identity provider (OIDC)',
      'API key',
    ])
    expect(
      hooks.auth?.methods.map((method) =>
        'prompts' in method ? (method.prompts ?? []).map((prompt) => prompt.key) : [],
      ),
    ).toEqual([
      ['proxy', 'baseURL', 'teamChoice', 'team'],
      ['proxy', 'baseURL', 'issuer', 'clientId', 'scope', 'customScope', 'ports', 'redirectPorts'],
      [],
    ])
    // OpenCode Desktop cannot submit an empty text prompt: every optional text sits behind a select.
    for (const method of hooks.auth!.methods) {
      const prompts = 'prompts' in method ? (method.prompts ?? []) : []
      const optional = prompts.filter((prompt) => prompt.type === 'text' && prompt.when)
      for (const prompt of optional) {
        expect(prompts.find((gate) => gate.key === prompt.when!.key)?.type).toBe('select')
      }
    }
  })

  it('signs in to the configured proxy with its gateway headers', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mockFetch()
    const hooks = await LiteLLMPlugin(createInput().input)
    await hooks.config!(
      createConfig({
        baseURL: 'https://llm.example.com/v1',
        headers: { 'X-Gateway': 'example-gateway' },
      }) as never,
    )

    requests = []
    mockFetch((request) => {
      if (request.url === 'https://llm.example.com/sso/cli/start') {
        return new Response('', { status: 405 })
      }
      if (request.url === 'https://llm.example.com/key/generate') {
        return new Response('', { status: 403 })
      }
      return undefined
    })
    const method = hooks.auth!.methods[0] as Extract<
      NonNullable<typeof hooks.auth>['methods'][number],
      { type: 'oauth' }
    >

    const result = await method.authorize({})
    expect(result).toMatchObject({
      method: 'code',
      url: 'https://llm.example.com/sso/key/generate',
    })
    if (result.method !== 'code') throw new Error('expected the code method')
    await expect(result.callback('example-ui-token')).resolves.toEqual({
      type: 'success',
      access: 'example-ui-token',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
      accountId: JSON.stringify({ baseURL: 'https://llm.example.com' }),
    })

    const start = requests.find((request) => request.url.endsWith('/sso/cli/start'))
    expect(start?.method).toBe('POST')
    expect(start?.headers.get('X-Gateway')).toBe('example-gateway')
    await expect(
      method.authorize({ proxy: 'other', baseURL: 'https://other.example.com' }),
    ).rejects.toThrow('is configured for')
  })

  it('reconnects to the previous sign-in proxy when none is configured, and to another on request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    writeAuthFile(pkceEntry())
    mockFetch()
    const hooks = await LiteLLMPlugin(createInput().input)
    await hooks.config!(createConfig({}) as never)
    mockFetch((request) =>
      request.url.endsWith('/sso/cli/start') ? new Response('', { status: 405 }) : undefined,
    )
    const method = hooks.auth!.methods[0] as Extract<
      NonNullable<typeof hooks.auth>['methods'][number],
      { type: 'oauth' }
    >

    await expect(
      method.authorize({ proxy: 'known', teamChoice: 'default' }),
    ).resolves.toMatchObject({
      url: `${BASE}/sso/key/generate`,
    })
    await expect(
      method.authorize({
        proxy: 'other',
        baseURL: 'https://other.example.com',
        teamChoice: 'default',
      }),
    ).resolves.toMatchObject({ url: 'https://other.example.com/sso/key/generate' })
  })

  it('asks LiteLLM for a team only when one is chosen', async () => {
    const polls: string[] = []
    mockFetch((request) => {
      if (request.url.endsWith('/sso/cli/start')) {
        return Response.json({
          login_id: 'example-login',
          poll_secret: 'example-poll',
          user_code: 'EXAMPLE-1',
        })
      }
      if (request.url.includes('/sso/cli/poll/')) {
        const team = new URL(request.url).searchParams.get('team_id')
        polls.push(team ?? '')
        return team
          ? Response.json({ status: 'ready', key: 'example-cli-token', expires_in: 60 })
          : Response.json({
              status: 'ready',
              requires_team_selection: true,
              team_details: [{ team_id: 'team-1', team_alias: 'Research' }],
            })
      }
      return undefined
    })
    const hooks = await LiteLLMPlugin(createInput().input)
    await hooks.config!(createConfig({ baseURL: `${BASE}/v1` }) as never)
    const method = hooks.auth!.methods[0] as Extract<
      NonNullable<typeof hooks.auth>['methods'][number],
      { type: 'oauth' }
    >

    const withTeam = await method.authorize({
      proxy: 'known',
      teamChoice: 'other',
      team: 'Research',
    })
    if (withTeam.method !== 'auto') throw new Error('expected the auto method')
    await expect(withTeam.callback()).resolves.toMatchObject({ access: 'example-cli-token' })
    // A team typed earlier does not count once the user picks the default.
    const withoutTeam = await method.authorize({
      proxy: 'known',
      teamChoice: 'default',
      team: 'Research',
    })
    if (withoutTeam.method !== 'auto') throw new Error('expected the auto method')
    await expect(withoutTeam.callback()).rejects.toThrow('LiteLLM asks which team to sign in with')
    expect(polls).toEqual(['', 'team-1', ''])
  })

  it('maps the OIDC scope and port choices onto the sign-in', async () => {
    const issuer = 'https://idp.example.com'
    mockFetch((request) =>
      request.url === `${issuer}/.well-known/openid-configuration`
        ? Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
          })
        : undefined,
    )
    const hooks = await LiteLLMPlugin(createInput().input)
    const method = hooks.auth!.methods[1] as Extract<
      NonNullable<typeof hooks.auth>['methods'][number],
      { type: 'oauth' }
    >
    const signIn = async (inputs: Record<string, string>) => {
      const result = await method.authorize({
        proxy: 'known',
        issuer,
        clientId: 'example-client',
        ...inputs,
      })
      const url = new URL(result.url)
      // Settle the sign-in so its loopback listener closes.
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      callback.searchParams.set('error', 'access_denied')
      await originalFetch(callback)
      if (result.method === 'auto') await result.callback().catch(() => {})
      return { scope: url.searchParams.get('scope'), port: new URL(callback).port }
    }

    await expect(signIn({ scope: 'openid offline_access', ports: 'any' })).resolves.toMatchObject({
      scope: 'openid offline_access',
    })
    const custom = await signIn({
      scope: 'other',
      customScope: 'openid profile',
      ports: 'specific',
      redirectPorts: '45871',
    })
    expect(custom).toEqual({ scope: 'openid profile', port: '45871' })
    // Ports typed earlier do not count once the user picks any free port.
    const any = await signIn({ scope: 'openid', ports: 'any', redirectPorts: '45871' })
    expect(any.port).not.toBe('45871')
  })

  it('discovers from the stored sign-in when no baseURL is configured', async () => {
    writeAuthFile(pkceEntry())
    mockFetch()
    const hooks = await LiteLLMPlugin(createInput().input)
    const config = createConfig({})

    await hooks.config!(config as never)

    const options = config.provider.litellm.options
    expect(discoveryRequests().length).toBeGreaterThan(0)
    for (const request of discoveryRequests()) {
      expect(request.url).toBe(`${BASE}/v1/models`)
      expect(request.authorization).toBe('Bearer example-access')
    }
    expect(options.baseURL).toBe(`${BASE}/v1`)
    expect(options.apiKey).toBeUndefined()
    expect(typeof options.fetch).toBe('function')

    requests = []
    mockFetch()
    await options.fetch(`${BASE}/v1/chat/completions`, {
      headers: { Authorization: 'Bearer example-stale' },
    })
    expect(requests[0].authorization).toBe('Bearer example-access')

    const cacheKey = buildCacheKey('litellm', BASE, {}, {}, {}, 'litellm_cli_pkce example-client')
    expect(readModelCacheEntry(cacheKey)).not.toBeNull()
  })

  it('prefers a configured apiKey over a stored sign-in', async () => {
    writeAuthFile(pkceEntry())
    mockFetch()
    const hooks = await LiteLLMPlugin(createInput().input)
    const config = createConfig({ baseURL: `${BASE}/v1`, apiKey: 'example-configured-key' })

    await hooks.config!(config as never)

    expect(discoveryRequests().length).toBeGreaterThan(0)
    for (const request of discoveryRequests()) {
      expect(request.authorization).toBe('Bearer example-configured-key')
    }
    expect(config.provider.litellm.options.fetch).toBeUndefined()
  })

  it('refreshes a nearly expired sign-in at startup and saves it through OpenCode', async () => {
    writeAuthFile(pkceEntry({ expires: Date.now() + 60 * 1000 }))
    mockFetch((request) =>
      request.url === TOKEN_ENDPOINT
        ? tokenSuccess('example-access-2', 'example-refresh-2')
        : undefined,
    )
    const { client, input } = createInput()
    const hooks = await LiteLLMPlugin(input)

    await hooks.config!(createConfig({}) as never)

    expect(tokenRequests()).toHaveLength(1)
    expect(tokenRequests()[0].method).toBe('POST')
    const form = new URLSearchParams(tokenRequests()[0].body)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('example-refresh')
    expect(form.get('client_id')).toBe('example-client')
    expect(client.auth.set).toHaveBeenCalledTimes(1)
    expect(client.auth.set).toHaveBeenCalledWith({
      path: { id: 'litellm' },
      body: expect.objectContaining({
        type: 'oauth',
        access: 'example-access-2',
        refresh: 'example-refresh-2',
        expires: expect.any(Number),
        accountId: JSON.stringify(METADATA),
      }),
    })
    expect(discoveryRequests()[0].authorization).toBe('Bearer example-access-2')
  })

  it('re-resolves credentials when OpenCode reuses one config object across plugin instances', async () => {
    const envKey = 'example-env-key'
    process.env.LITELLM_API_KEY = envKey
    mockFetch()
    const { input } = createInput()
    const config = createConfig({ baseURL: `${BASE}/v1` })
    const options = config.provider.litellm.options

    const first = await LiteLLMPlugin(input)
    await first.config!(config as never)
    expect(options.apiKey).toBe(envKey)
    expect(options.fetch).toBeUndefined()

    writeAuthFile(pkceEntry())
    const second = await LiteLLMPlugin(input)
    await second.config!(config as never)
    expect(options.apiKey).toBeUndefined()
    expect(typeof options.fetch).toBe('function')

    writeAuthFile(undefined)
    const third = await LiteLLMPlugin(input)
    await third.config!(config as never)
    expect(options.fetch).toBeUndefined()
    expect(options.apiKey).toBe(envKey)
  })

  it('never overwrites a credential saved after the sign-in was read', async () => {
    writeAuthFile(pkceEntry({ expires: Date.now() + 60 * 1000 }))
    mockFetch((request) =>
      request.url === TOKEN_ENDPOINT ? new Response('{}', { status: 503 }) : undefined,
    )
    const { client, input } = createInput()
    const hooks = await LiteLLMPlugin(input)
    const config = createConfig({})
    await hooks.config!(config as never)
    expect(tokenRequests()).toHaveLength(1)

    writeAuthFile({ type: 'api', key: 'example-other-key' })
    skipRetryWindow()

    await expect(
      config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {}),
    ).rejects.toThrow('The LiteLLM sign-in was removed; connect LiteLLM again')
    expect(client.auth.set).not.toHaveBeenCalled()
  })

  it('adopts a refresh another OpenCode process saved', async () => {
    writeAuthFile(pkceEntry({ expires: Date.now() + 60 * 1000 }))
    mockFetch((request) =>
      request.url === TOKEN_ENDPOINT ? new Response('{}', { status: 503 }) : undefined,
    )
    const { client, input } = createInput()
    const hooks = await LiteLLMPlugin(input)
    const config = createConfig({})
    await hooks.config!(config as never)
    expect(tokenRequests()).toHaveLength(1)
    skipRetryWindow()

    writeAuthFile(
      pkceEntry({
        access: 'example-access-other',
        refresh: 'example-refresh-other',
        expires: Date.now() + 60 * 60 * 1000,
      }),
    )
    requests = []
    await config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {})

    expect(requests).toHaveLength(1)
    expect(requests[0].authorization).toBe('Bearer example-access-other')
    expect(tokenRequests()).toHaveLength(0)
    expect(client.auth.set).not.toHaveBeenCalled()
  })

  it('refreshes once for concurrent requests, since a rotated refresh token is spent', async () => {
    writeAuthFile(pkceEntry({ expires: Date.now() + 60 * 1000 }))
    let tokenStatus = 503
    mockFetch((request) => {
      if (request.url !== TOKEN_ENDPOINT) return undefined
      return tokenStatus === 503
        ? new Response('{}', { status: 503 })
        : tokenSuccess('example-access-2', 'example-refresh-2')
    })
    const { client, input } = createInput()
    const hooks = await LiteLLMPlugin(input)
    const config = createConfig({})
    await hooks.config!(config as never)

    tokenStatus = 200
    skipRetryWindow()
    requests = []
    const send = () => config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {})
    await Promise.all([send(), send()])

    expect(tokenRequests()).toHaveLength(1)
    const chat = requests.filter((request) => request.url.endsWith('/chat/completions'))
    expect(chat.map((request) => request.authorization)).toEqual([
      'Bearer example-access-2',
      'Bearer example-access-2',
    ])
    expect(client.auth.set).toHaveBeenCalledOnce()
  })

  it('reads a credential saved after an earlier plugin instance read auth.json', async () => {
    const { input } = createInput()
    mockFetch()
    const config = createConfig({ baseURL: `${BASE}/v1` })
    await (
      await LiteLLMPlugin(input)
    ).config!(config as never)
    expect(config.provider.litellm.options.apiKey).toBeUndefined()

    // OpenCode 1 rebuilds the plugin after a login saved a key.
    writeAuthFile({ type: 'api', key: 'example-stored-key' })
    requests = []
    await (
      await LiteLLMPlugin(input)
    ).config!(config as never)

    expect(config.provider.litellm.options.apiKey).toBe('example-stored-key')
    expect(discoveryRequests().length).toBeGreaterThan(0)
    expect(
      discoveryRequests().every((request) => request.authorization === 'Bearer example-stored-key'),
    ).toBe(true)
  })

  it('does not send a sign-in to a provider configured for another proxy', async () => {
    writeAuthFile(pkceEntry())
    mockFetch()
    const { client, input } = createInput()
    const hooks = await LiteLLMPlugin(input)
    const config = createConfig({ baseURL: 'http://127.0.0.1:44599/v1' })
    await hooks.config!(config as never)

    expect(config.provider.litellm.options.fetch).toBeUndefined()
    expect(requests.some((request) => request.authorization === 'Bearer example-access')).toBe(
      false,
    )
    expect(client.app.log).toHaveBeenCalledWith({
      body: expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('Not using the LiteLLM sign-in'),
      }),
    })
  })

  it('keeps an expired sign-in ahead of the environment key, so requests ask to connect again', async () => {
    process.env.LITELLM_API_KEY = ['example', 'env', 'key'].join('-')
    writeAuthFile({
      type: 'oauth',
      access: 'example-cli-token',
      refresh: '',
      expires: Date.now() - 1000,
      accountId: JSON.stringify({ baseURL: BASE }),
    })
    mockFetch()
    const hooks = await LiteLLMPlugin(createInput().input)
    const config = createConfig({})
    await hooks.config!(config as never)

    expect(discoveryRequests().length).toBeGreaterThan(0)
    expect(
      discoveryRequests().every((request) => request.authorization !== 'Bearer example-env-key'),
    ).toBe(true)
    await expect(
      config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {}),
    ).rejects.toThrow('LiteLLM sign-in expired; connect LiteLLM again')
  })

  it('gives the Responses sibling the sign-in fetch and a placeholder key its runtime requires', async () => {
    writeAuthFile(pkceEntry())
    mockFetch((request) => {
      if (request.url.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'example-chat' }, { id: 'example-responses' }] })
      }
      if (request.url.endsWith('/v1/model/info')) {
        return Response.json({
          data: [
            {
              model_name: 'example-responses',
              model_info: { key: 'example-responses', mode: 'responses' },
            },
          ],
        })
      }
      return undefined
    })
    const hooks = await LiteLLMPlugin(createInput().input)
    const config = createConfig({}) as { provider: Record<string, ProviderConfig> }
    await hooks.config!(config as never)

    const sibling = config.provider['litellm-responses']
    expect(Object.keys(sibling.models ?? {})).toEqual(['example-responses'])
    expect(sibling.options?.baseURL).toBe(`${BASE}/v1`)
    // A placeholder the runtime package insists on; the fetch replaces it with the real token.
    const placeholder = sibling.options?.apiKey
    expect(typeof placeholder === 'string' && placeholder.length > 0).toBe(true)
    requests = []
    await (sibling.options!.fetch as typeof fetch)(`${BASE}/v1/responses`, {
      headers: { Authorization: `Bearer ${placeholder}` },
    })
    expect(requests[0].authorization).toBe('Bearer example-access')
  })

  it('waits before retrying a refresh the token endpoint failed', async () => {
    writeAuthFile(pkceEntry({ expires: Date.now() + 60 * 1000 }))
    mockFetch((request) =>
      request.url === TOKEN_ENDPOINT ? new Response('{}', { status: 503 }) : undefined,
    )
    const hooks = await LiteLLMPlugin(createInput().input)
    const config = createConfig({})
    await hooks.config!(config as never)
    expect(tokenRequests()).toHaveLength(1)

    requests = []
    await config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {})
    expect(tokenRequests()).toHaveLength(0)
    expect(requests[0].authorization).toBe('Bearer example-access')

    skipRetryWindow()
    await config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {})
    expect(tokenRequests()).toHaveLength(1)
  })

  it('does not adopt a sign-in to another proxy that appeared in auth.json', async () => {
    writeAuthFile(pkceEntry({ expires: Date.now() + 60 * 1000 }))
    mockFetch((request) =>
      request.url === TOKEN_ENDPOINT ? new Response('{}', { status: 503 }) : undefined,
    )
    const hooks = await LiteLLMPlugin(createInput().input)
    const config = createConfig({})
    await hooks.config!(config as never)
    skipRetryWindow()

    writeAuthFile({
      ...pkceEntry({ access: 'example-access-elsewhere' }),
      accountId: JSON.stringify({ ...METADATA, baseURL: 'https://elsewhere.example.com' }),
    })
    requests = []
    await expect(
      config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {}),
    ).rejects.toThrow('The LiteLLM sign-in changed; connect LiteLLM again')
    expect(
      requests.some((request) => request.authorization === 'Bearer example-access-elsewhere'),
    ).toBe(false)
  })

  it('recognizes its own writes on a provider configured without options', async () => {
    process.env.LITELLM_API_KEY = ['example', 'env', 'key'].join('-')
    process.env.LITELLM_BASE_URL = `${BASE}/v1`
    mockFetch()
    const { input } = createInput()
    const config = { provider: { litellm: { npm: '@ai-sdk/openai-compatible' } as ProviderConfig } }
    await (
      await LiteLLMPlugin(input)
    ).config!(config as never)
    expect(config.provider.litellm.options).toMatchObject({ apiKey: 'example-env-key' })

    writeAuthFile(pkceEntry())
    await (
      await LiteLLMPlugin(input)
    ).config!(config as never)

    expect(config.provider.litellm.options?.apiKey).toBeUndefined()
    expect(typeof config.provider.litellm.options?.fetch).toBe('function')
  })

  function mockResponsesProxy(): void {
    mockFetch((request) => {
      if (request.url.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'example-chat' }, { id: 'example-responses' }] })
      }
      if (request.url.endsWith('/v1/model/info')) {
        return Response.json({
          data: [
            {
              model_name: 'example-responses',
              model_info: { key: 'example-responses', mode: 'responses' },
            },
          ],
        })
      }
      return undefined
    })
  }

  it('sends the current token through a Responses sibling an earlier instance set up', async () => {
    writeAuthFile(pkceEntry())
    mockResponsesProxy()
    const { input } = createInput()
    const config = createConfig({}) as { provider: Record<string, ProviderConfig> }
    await (
      await LiteLLMPlugin(input)
    ).config!(config as never)
    const siblingFetch = config.provider['litellm-responses'].options!.fetch as typeof fetch

    // Another process refreshed the same sign-in; OpenCode rebuilds the plugin on the cached config.
    writeAuthFile(pkceEntry({ access: 'example-access-2', refresh: 'example-refresh-2' }))
    await (
      await LiteLLMPlugin(input)
    ).config!(config as never)

    requests = []
    await siblingFetch(`${BASE}/v1/responses`, {})
    expect(requests[0].authorization).toBe('Bearer example-access-2')
  })

  it('never sends a sign-in to the local ports it probes for a proxy', async () => {
    writeAuthFile({
      type: 'oauth',
      access: 'example-oidc-token',
      refresh: '',
      expires: Date.now() + 60 * 60 * 1000,
      accountId: JSON.stringify({
        flow: 'oidc_pkce',
        issuer: 'https://idp.example.com',
        clientId: 'example-client',
        subject: 'example-user',
      }),
    })
    mockFetch((request) =>
      request.url.startsWith('http://localhost:') &&
      request.authorization !== 'Bearer example-oidc-token'
        ? new Response('unauthorized', { status: 401 })
        : undefined,
    )
    const hooks = await LiteLLMPlugin(createInput().input)
    await hooks.config!(createConfig({}) as never)

    expect(requests.some((request) => request.url.startsWith('http://localhost:'))).toBe(true)
    expect(requests.every((request) => request.authorization !== 'Bearer example-oidc-token')).toBe(
      true,
    )
  })

  it('refreshes the model list in the background only for the current sign-in', async () => {
    const other = 'http://127.0.0.1:44522'
    writeAuthFile(pkceEntry())
    mockFetch()
    const { input } = createInput()
    const config = createConfig({})
    await (
      await LiteLLMPlugin(input)
    ).config!(config as never)

    // Signed in again, to another proxy; OpenCode rebuilds the plugin.
    writeAuthFile({
      ...pkceEntry({ access: 'example-access-other' }),
      accountId: JSON.stringify({ ...METADATA, baseURL: other, clientId: 'example-client-other' }),
    })
    const hooks = await LiteLLMPlugin(input)
    await hooks.config!(config as never)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000)
    requests = []
    await hooks.event!({ event: { type: 'session.created' } } as never)
    await vi.waitFor(() =>
      expect(requests.some((request) => request.url.startsWith(other))).toBe(true),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requests.some((request) => request.url.startsWith(BASE))).toBe(false)
  })

  it('does not overwrite a credential saved while it refreshed', async () => {
    writeAuthFile(pkceEntry({ expires: Date.now() + 60 * 1000 }))
    mockFetch((request) => {
      if (request.url !== TOKEN_ENDPOINT) return undefined
      // Another process saves an API key while the token request is in flight.
      writeAuthFile({ type: 'api', key: 'example-saved-meanwhile' })
      return tokenSuccess('example-access-2', 'example-refresh-2')
    })
    const { client, input } = createInput()
    const hooks = await LiteLLMPlugin(input)
    const config = createConfig({})
    await hooks.config!(config as never)

    expect(tokenRequests()).toHaveLength(1)
    expect(client.auth.set).not.toHaveBeenCalled()
    requests = []
    await config.provider.litellm.options.fetch(`${BASE}/v1/chat/completions`, {})
    expect(requests[0].authorization).toBe('Bearer example-access-2')
  })
})
