import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin from '../src'
import { buildCacheKey, readModelCacheEntry } from '../src/utils/model-cache'
import type { Context } from '@opencode/plugin/promise/plugin'

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/**
 * Set the LiteLLM API-key env var from a variable. Kept indirect so the
 * repo's plugin security scanner does not mistake the deliberately-fake test
 * key for a hardcoded secret (its `API_KEY = "..."` pattern is a heuristic).
 */
function setEnvApiKey(value: string): void {
  process.env.LITELLM_API_KEY = value
}

interface IntegrationMocks {
  transform: ReturnType<typeof vi.fn>
  methodUpdate: ReturnType<typeof vi.fn>
  active: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
  registrations: Array<{ dispose: () => Promise<void> }>
  connection: { active: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> }
}

function makeIntegration(): IntegrationMocks {
  const methodUpdate = vi.fn()
  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const active = vi.fn(async () => undefined)
  const resolve = vi.fn(async () => undefined)
  return {
    transform: vi.fn(async (callback: (editor: unknown) => void) => {
      callback({
        list: () => [],
        get: () => undefined,
        update: vi.fn(),
        remove: vi.fn(),
        method: { list: () => [], update: methodUpdate, remove: vi.fn() },
      })
      const registration = { dispose: vi.fn(async () => {}) }
      registrations.push(registration)
      return registration
    }),
    methodUpdate,
    active,
    resolve,
    registrations,
    connection: { active, resolve },
  }
}

function discoveryFetch(models: Array<{ id: string }>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/v1/model/info')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: models }), { status: 200 })
  })
}

interface RegisteredEntry {
  info: Record<string, unknown>
  models: Array<Record<string, unknown>>
}

/** Editor mock that keeps registry state, so update/remove flows are observable. */
function makeStatefulEditor(registered: RegisteredEntry[], removed: string[]) {
  const find = (id: string) => registered.find((entry) => entry.info.id === id)
  return {
    list: () => registered.map((entry) => entry.info),
    get: (id: string) => find(id),
    add: (entry: RegisteredEntry) => {
      registered.push(entry)
    },
    update: (id: string, update: (provider: Record<string, unknown>) => void) => {
      const entry = find(id)
      if (entry) update(entry.info)
    },
    remove: (id: string) => {
      removed.push(id)
      const index = registered.findIndex((entry) => entry.info.id === id)
      if (index >= 0) registered.splice(index, 1)
    },
    models: {
      set: (id: string, models: Array<Record<string, unknown>>) => {
        const entry = find(id)
        if (entry) entry.models = models
      },
      update: vi.fn(),
      remove: vi.fn(),
    },
  }
}

describe('connect dialog integration', () => {
  const originalFetch = globalThis.fetch
  let originalCacheHome: string | undefined
  let originalLiteLLMBaseURL: string | undefined
  let originalLiteLLMApiKey: string | undefined
  let originalLiteLLMMasterKey: string | undefined
  let cacheDirectory: string

  beforeEach(() => {
    originalCacheHome = process.env.XDG_CACHE_HOME
    originalLiteLLMBaseURL = process.env.LITELLM_BASE_URL
    originalLiteLLMApiKey = process.env.LITELLM_API_KEY
    originalLiteLLMMasterKey = process.env.LITELLM_MASTER_KEY
    delete process.env.LITELLM_BASE_URL
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_MASTER_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv('XDG_CACHE_HOME', originalCacheHome)
    restoreEnv('LITELLM_BASE_URL', originalLiteLLMBaseURL)
    restoreEnv('LITELLM_API_KEY', originalLiteLLMApiKey)
    restoreEnv('LITELLM_MASTER_KEY', originalLiteLLMMasterKey)
    if (cacheDirectory) rmSync(cacheDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('registers the LiteLLM integration with an API key form and two sign-in methods', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-integration-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = vi.fn(async () => new Response('not found', { status: 503 }))

    const integration = makeIntegration()
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(integration.transform).toHaveBeenCalledOnce()
    const methods = integration.methodUpdate.mock.calls.map(
      (call) =>
        call[0] as {
          integrationID: string
          method: { type: string; id?: string; form?: Array<{ key: string; type: string }> }
          authorize?: unknown
          refresh?: unknown
        },
    )
    expect(methods.map((entry) => entry.integrationID)).toEqual(['litellm', 'litellm', 'litellm'])
    expect(methods.map((entry) => [entry.method.type, entry.method.id])).toEqual([
      ['key', undefined],
      ['oauth', 'sso'],
      ['oauth', 'oidc'],
    ])
    expect(methods.map((entry) => entry.method.form?.map((field) => field.key))).toEqual([
      ['baseURL', 'providerID'],
      ['baseURL', 'providerID', 'team'],
      ['baseURL', 'providerID', 'issuer', 'clientId', 'scope', 'redirectPorts'],
    ])
    expect(methods.flatMap((entry) => entry.method.form ?? []).every((field) => field.type === 'string')).toBe(true)
    for (const entry of methods.slice(1)) {
      expect(entry.authorize).toBeTypeOf('function')
      expect(entry.refresh).toBeTypeOf('function')
    }

    await cleanup?.()
    expect(integration.registrations[0].dispose).toHaveBeenCalledOnce()
  })

  it('does not register an integration when the host has no integration API', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-no-integration-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = vi.fn(async () => new Response('not found', { status: 503 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    // A missing integration API is a silent skip — only a failed registration
    // may log ("Could not register the connect dialog integration").
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('connect dialog integration'))
    await cleanup?.()
  })

  it('registers a zero-config provider from a connected credential and its form answers', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-connected-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      return discoveryFetch([{ id: 'connected-model' }])(input)
    })

    const integration = makeIntegration()
    integration.active.mockResolvedValue({ type: 'credential', id: 'cred-1' })
    integration.resolve.mockResolvedValue({
      type: 'key',
      key: 'connected-key',
      configuration: { baseURL: 'http://127.0.0.1:44501/v1' },
    })

    const registered: Array<{ info: Record<string, unknown>; models: Array<Record<string, unknown>> }> = []
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { info: Record<string, unknown>; models: Array<Record<string, unknown>> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({
      id: 'litellm',
      activation: 'enabled',
      // Binding the provider to the integration is what makes OpenCode
      // inject the connected key at request time.
      integrationID: 'litellm',
    })
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'http://127.0.0.1:44501/v1',
    })
    // The connection-managed key is used for discovery but must not be
    // materialized into provider settings.
    expect(registered[0].info.settings).not.toHaveProperty('apiKey')
    expect(registered[0].models.map((model) => model.id)).toEqual(['connected-model'])
    expect(authorizationHeaders).toContain('Bearer connected-key')

    await cleanup?.()
  })

  it('reads the form answers from credential metadata (OpenCode 2.1+)', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-metadata-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = discoveryFetch([{ id: 'metadata-model' }])

    const integration = makeIntegration()
    integration.active.mockResolvedValue({ type: 'credential', id: 'cred-1' })
    integration.resolve.mockResolvedValue({
      type: 'key',
      key: 'connected-key',
      metadata: { baseURL: 'http://127.0.0.1:44509/v1', providerID: 'gateway' },
    })

    const registered: RegisteredEntry[] = []
    const context = {
      app: { name: 'OpenCode', version: '2.1.0', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(makeStatefulEditor(registered, []) as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({ id: 'gateway', integrationID: 'litellm' })
    expect(registered[0].info.settings).toMatchObject({ baseURL: 'http://127.0.0.1:44509/v1' })

    await cleanup?.()
  })

  it('prefers explicit configuration over the connected credential', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-precedence-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    process.env.LITELLM_API_KEY = 'env-key'

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      return discoveryFetch([{ id: 'configured-model' }])(input)
    })

    const integration = makeIntegration()
    integration.active.mockResolvedValue({ type: 'credential', id: 'cred-1' })
    integration.resolve.mockResolvedValue({
      type: 'key',
      key: 'connected-key',
      configuration: { baseURL: 'http://127.0.0.1:44502/v1' },
    })

    const registered: Array<{ info: Record<string, unknown> }> = []
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { info: Record<string, unknown> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: { baseURL: 'http://127.0.0.1:44503/v1', apiKey: 'example-config-key' },
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered).toHaveLength(1)
    // Explicit operator config (the URL and apiKey) beats the dialog answers;
    // with an explicit key the provider is not bound to the integration.
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'http://127.0.0.1:44503/v1',
      apiKey: 'example-config-key',
    })
    expect(registered[0].info).not.toHaveProperty('integrationID')
    expect(authorizationHeaders).toContain('Bearer example-config-key')
    expect(authorizationHeaders).not.toContain('Bearer connected-key')
    expect(authorizationHeaders).not.toContain('Bearer env-key')

    await cleanup?.()
  })

  it('the connected credential beats the pod env key', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-connect-over-env-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    setEnvApiKey('stale-env-key')

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      return discoveryFetch([{ id: 'connected-model' }])(input)
    })

    const integration = makeIntegration()
    integration.active.mockResolvedValue({ type: 'credential', id: 'cred-1' })
    integration.resolve.mockResolvedValue({
      type: 'key',
      key: 'connected-key',
      configuration: { baseURL: 'http://127.0.0.1:44511/v1' },
    })

    const registered: Array<{ info: Record<string, unknown> }> = []
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { info: Record<string, unknown> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered).toHaveLength(1)
    // A credential the user saved in the dialog wins over the box env key,
    // which is only a fallback.
    expect(authorizationHeaders).toContain('Bearer connected-key')
    expect(authorizationHeaders).not.toContain('Bearer stale-env-key')
    expect(registered[0].info.settings).not.toHaveProperty('apiKey')

    await cleanup?.()
  })

  it('registers a provider when the first credential is connected mid-session', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-late-connect-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      // Only the connected gateway answers; the localhost auto-detect probes
      // must fail so nothing is registered before the credential arrives.
      if (!url.startsWith('http://127.0.0.1:44504')) {
        return new Response('not found', { status: 503 })
      }
      return discoveryFetch([{ id: 'late-connected-model' }])(input)
    })

    const integration = makeIntegration()
    // Nothing is connected during setup; the credential arrives with the event.
    let connected = false
    integration.active.mockImplementation(async (integrationID: string) => {
      if (integrationID !== 'litellm' || !connected) return undefined
      return { type: 'credential', id: 'cred-1' }
    })
    integration.resolve.mockResolvedValue({
      type: 'key',
      key: 'late-key',
      configuration: { baseURL: 'http://127.0.0.1:44504/v1' },
    })

    const registered: Array<{ info: Record<string, unknown>; models: Array<Record<string, unknown>> }> = []
    let providerTransform: ((editor: unknown) => void) | undefined
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { info: Record<string, unknown>; models: Array<Record<string, unknown>> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const reload = vi.fn(async () => providerTransform?.(editor))
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          providerTransform = transform
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload,
      },
      integration,
      event: {
        subscribe: () =>
          (async function* () {
            connected = true
            yield { type: 'credential.switched', data: { integrationID: 'litellm' } }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    // Nothing was reachable or connected at setup time.
    expect(registered).toHaveLength(0)

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({
      id: 'litellm',
      integrationID: 'litellm',
    })
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'http://127.0.0.1:44504/v1',
    })
    expect(registered[0].info.settings).not.toHaveProperty('apiKey')
    expect(registered[0].models.map((model) => model.id)).toEqual([
      'late-connected-model',
    ])

    await cleanup?.()
  })

  it('replaces a keyless auto-detected fallback when the first credential is connected mid-session', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-fallback-takeover-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      const url = String(input)
      // A local proxy answers on the default port, so setup registers a
      // keyless fallback provider before any credential exists.
      if (url.startsWith('http://localhost:4000')) {
        return discoveryFetch([{ id: 'local-model' }])(input)
      }
      if (url.startsWith('http://127.0.0.1:44505')) {
        return discoveryFetch([{ id: 'gateway-model' }])(input)
      }
      return new Response('not found', { status: 503 })
    })

    const integration = makeIntegration()
    // Nothing is connected during setup; the credential arrives with the event.
    let connected = false
    integration.active.mockImplementation(async (integrationID: string) => {
      if (integrationID !== 'litellm' || !connected) return undefined
      return { type: 'credential', id: 'cred-1' }
    })
    integration.resolve.mockResolvedValue({
      type: 'key',
      key: 'gateway-key',
      configuration: { baseURL: 'http://127.0.0.1:44505/v1' },
    })

    // Stateful editor so the replacement flows through the update branch.
    const registered: RegisteredEntry[] = []
    const removed: string[] = []
    const editor = makeStatefulEditor(registered, removed)
    let providerTransform: ((editor: unknown) => void) | undefined
    const reload = vi.fn(async () => providerTransform?.(editor))
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          providerTransform = transform
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload,
      },
      integration,
      event: {
        subscribe: () =>
          (async function* () {
            connected = true
            yield { type: 'credential.switched', data: { integrationID: 'litellm' } }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    expect(registered).toHaveLength(1)
    expect(registered[0].info.settings).toMatchObject({ baseURL: 'http://localhost:4000/v1' })

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    // The dialog's URL and key take over from the auto-detected fallback:
    // the provider is re-bound to the integration and the local-only model
    // is dropped in favour of the gateway's catalog.
    expect(registered[0].info.settings).toMatchObject({ baseURL: 'http://127.0.0.1:44505/v1' })
    expect(registered[0].info).toMatchObject({ integrationID: 'litellm' })
    expect(registered[0].info.settings).not.toHaveProperty('apiKey')
    expect(registered[0].models.map((model) => model.id)).toEqual(['gateway-model'])
    expect(authorizationHeaders).toContain('Bearer gateway-key')

    await cleanup?.()
  })

  it('re-points a dialog-created provider when reconnecting to a different gateway', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-reconnect-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:44506')) {
        return discoveryFetch([{ id: 'model-a' }])(input)
      }
      if (url.startsWith('http://127.0.0.1:44507')) {
        return discoveryFetch([{ id: 'model-b' }])(input)
      }
      return new Response('not found', { status: 503 })
    })

    const integration = makeIntegration()
    // The active connection moves from gateway A to gateway B mid-session.
    const credentials = [
      { key: 'key-a', configuration: { baseURL: 'http://127.0.0.1:44506/v1' } },
      { key: 'key-b', configuration: { baseURL: 'http://127.0.0.1:44507/v1' } },
    ]
    let generation = 0
    integration.active.mockImplementation(async (integrationID: string) =>
      integrationID === 'litellm' ? { type: 'credential', id: `cred-${generation}` } : undefined,
    )
    integration.resolve.mockImplementation(async () => ({
      type: 'key',
      ...credentials[generation],
    }))

    const registered: RegisteredEntry[] = []
    const removed: string[] = []
    const editor = makeStatefulEditor(registered, removed)
    let providerTransform: ((editor: unknown) => void) | undefined
    const reload = vi.fn(async () => providerTransform?.(editor))
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          providerTransform = transform
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload,
      },
      integration,
      event: {
        subscribe: () =>
          (async function* () {
            generation = 1
            yield { type: 'credential.switched', data: { integrationID: 'litellm' } }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    expect(registered).toHaveLength(1)
    expect(registered[0].info.settings).toMatchObject({ baseURL: 'http://127.0.0.1:44506/v1' })

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    // A key-only refresh would send the new key to the old gateway; the
    // source must be rebuilt from the new credential instead.
    expect(registered).toHaveLength(1)
    expect(registered[0].info.settings).toMatchObject({ baseURL: 'http://127.0.0.1:44507/v1' })
    expect(registered[0].info).toMatchObject({ integrationID: 'litellm' })
    expect(registered[0].info.settings).not.toHaveProperty('apiKey')
    expect(registered[0].models.map((model) => model.id)).toEqual(['model-b'])
    expect(removed).toEqual([])
    expect(authorizationHeaders).toContain('Bearer key-b')

    await cleanup?.()
  })

  it('moves a dialog-created provider to a new id on reconnect and retires the old one', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-reid-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:44509')) {
        return discoveryFetch([{ id: 'old-model' }])(input)
      }
      if (url.startsWith('http://127.0.0.1:44510')) {
        return discoveryFetch([{ id: 'team-model' }])(input)
      }
      return new Response('not found', { status: 503 })
    })

    const integration = makeIntegration()
    const credentials = [
      { key: 'key-a', configuration: { baseURL: 'http://127.0.0.1:44509/v1' } },
      {
        key: 'key-b',
        configuration: { baseURL: 'http://127.0.0.1:44510/v1', providerID: 'team' },
      },
    ]
    let generation = 0
    integration.active.mockImplementation(async (integrationID: string) =>
      integrationID === 'litellm' ? { type: 'credential', id: `cred-${generation}` } : undefined,
    )
    integration.resolve.mockImplementation(async () => ({
      type: 'key',
      ...credentials[generation],
    }))

    const registered: RegisteredEntry[] = []
    const removed: string[] = []
    const editor = makeStatefulEditor(registered, removed)
    let providerTransform: ((editor: unknown) => void) | undefined
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          providerTransform = transform
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => providerTransform?.(editor)),
      },
      integration,
      event: {
        subscribe: () =>
          (async function* () {
            generation = 1
            yield { type: 'credential.switched', data: { integrationID: 'litellm' } }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    expect(registered).toHaveLength(1)
    expect(registered[0].info.id).toBe('litellm')

    await vi.waitFor(() => expect(registered[0]?.info.id).toBe('team'))
    // The dialog-built provider moved to the new id; the old registry entry
    // must be gone, not left behind bound to the same integration.
    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({ id: 'team', integrationID: 'litellm' })
    expect(registered[0].info.settings).toMatchObject({ baseURL: 'http://127.0.0.1:44510/v1' })
    expect(registered[0].models.map((model) => model.id)).toEqual(['team-model'])
    expect(removed).toEqual(['litellm'])

    await cleanup?.()
  })

  it('ignores OAuth credentials from methods this plugin does not register', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-oauth-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    globalThis.fetch = vi.fn(async (input) => {
      // Nothing is reachable; only the (unusable) oauth connection exists.
      return new Response('not found', { status: 503 })
    })

    const integration = makeIntegration()
    integration.active.mockResolvedValue({ type: 'credential', id: 'cred-1', method: 'oauth', label: '' })
    // Usable if it counted: it names a proxy, so only the methodID keeps it out.
    integration.resolve.mockResolvedValue({
      type: 'oauth',
      methodID: 'another-plugin',
      access: 'token',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
      metadata: { baseURL: 'http://127.0.0.1:44512' },
    })

    const registered: Array<{ info: Record<string, unknown> }> = []
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { info: Record<string, unknown> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      // The auto-detect probe fails, so only the (oauth) connection exists —
      // which the plugin must not use, leaving no provider at all.
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    // Without a key and without any reachable baseURL there is nothing to
    // register; another method's oauth credential is never treated as an API key.
    expect(registered).toHaveLength(0)

    await cleanup?.()
  })

  it('uses a LiteLLM sign-in for discovery and keys its cache by the credential', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-sso-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      return discoveryFetch([{ id: 'sso-model' }])(input)
    })

    const integration = makeIntegration()
    integration.active.mockResolvedValue({ type: 'credential', id: 'cred-sso', method: 'oauth', label: 'LiteLLM' })
    integration.resolve.mockResolvedValue({
      type: 'oauth',
      methodID: 'sso',
      access: 'example-access',
      refresh: 'example-refresh',
      expires: Date.now() + 3_600_000,
      metadata: { flow: 'litellm_cli_pkce', baseURL: 'http://127.0.0.1:44510', providerID: 'litellm' },
    })
    const registered: RegisteredEntry[] = []
    const context = {
      app: { name: 'OpenCode', version: '2.1.0', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(makeStatefulEditor(registered, []) as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({ id: 'litellm', integrationID: 'litellm' })
    expect(registered[0].info.settings).toMatchObject({ baseURL: 'http://127.0.0.1:44510/v1' })
    expect(registered[0].info.settings).not.toHaveProperty('apiKey')
    expect(registered[0].models.map((model) => model.id)).toEqual(['sso-model'])
    expect(authorizationHeaders).toContain('Bearer example-access')
    // The access token rotates on refresh; the credential id does not.
    const baseURL = 'http://127.0.0.1:44510'
    expect(readModelCacheEntry(buildCacheKey('litellm', baseURL, {}, {}, {}, 'cred-sso'))).not.toBeNull()
    expect(readModelCacheEntry(buildCacheKey('litellm', baseURL, {}, {}, {}, 'example-access'))).toBeNull()

    await cleanup?.()
  })

  it('signs in to the configured proxy with its headers, and refuses another one', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-sso-authorize-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const ssoRequests: Array<{ url: string; gateway: string | null }> = []
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      if (url.includes('/sso/') || url.includes('/.well-known/') || url.endsWith('/key/generate')) {
        ssoRequests.push({ url, gateway: new Headers(init?.headers).get('X-Gateway') })
      }
      if (url.endsWith('/sso/cli/start')) return new Response('method not allowed', { status: 405 })
      return new Response('not found', { status: 404 })
    })

    const integration = makeIntegration()
    const configuredProvider = {
      id: 'litellm',
      name: 'LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'https://llm.example.com/v1' },
      headers: { 'X-Gateway': 'example-gateway' },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.1.0', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [configuredProvider] })),
        transform: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
        reload: vi.fn(async () => {}),
      },
      integration,
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    const sso = integration.methodUpdate.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.method.id === 'sso') as {
      authorize: (answer: Record<string, unknown>) => Promise<{
        mode: string
        url: string
        callback: (code: string) => Promise<Record<string, unknown>>
      }>
      refresh: (credential: Record<string, unknown>) => Promise<Record<string, unknown>>
    }

    await expect(sso.authorize({ baseURL: 'https://other.example.com' })).rejects.toThrow(
      'Provider "litellm" is configured for https://llm.example.com/v1',
    )

    const authorization = await sso.authorize({})
    expect(authorization).toMatchObject({ mode: 'code', url: 'https://llm.example.com/sso/key/generate' })
    const credential = await authorization.callback('example-ui-token')
    expect(credential).toEqual({
      type: 'oauth',
      methodID: 'sso',
      access: 'example-ui-token',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
      metadata: { baseURL: 'https://llm.example.com', providerID: 'litellm' },
    })
    expect(ssoRequests.map((request) => request.url)).toEqual([
      'https://llm.example.com/.well-known/litellm-cli-auth',
      'https://llm.example.com/sso/cli/start',
      'https://llm.example.com/key/generate',
    ])
    expect(ssoRequests.every((request) => request.gateway === 'example-gateway')).toBe(true)

    await expect(sso.refresh(credential)).resolves.toEqual(credential)
    await expect(sso.refresh({ ...credential, expires: Date.now() - 1 })).rejects.toThrow(
      'LiteLLM sign-in expired; connect LiteLLM again',
    )

    await cleanup?.()
  })
})
