import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin from '../src'
import type { Context } from '@opencode/plugin/promise/plugin'
import { buildCacheKey, writeModelCache } from '../src/utils/model-cache'

describe('OpenCode 2 plugin entrypoint', () => {
  const originalFetch = globalThis.fetch
  const originalCacheHome = process.env.XDG_CACHE_HOME
  const originalLiteLLMBaseURL = process.env.LITELLM_BASE_URL
  const originalLiteLLMApiKey = process.env.LITELLM_API_KEY
  const originalLiteLLMMasterKey = process.env.LITELLM_MASTER_KEY
  let cacheDirectory: string

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = originalCacheHome
    if (originalLiteLLMBaseURL === undefined) delete process.env.LITELLM_BASE_URL
    else process.env.LITELLM_BASE_URL = originalLiteLLMBaseURL
    if (originalLiteLLMApiKey === undefined) delete process.env.LITELLM_API_KEY
    else process.env.LITELLM_API_KEY = originalLiteLLMApiKey
    if (originalLiteLLMMasterKey === undefined) delete process.env.LITELLM_MASTER_KEY
    else process.env.LITELLM_MASTER_KEY = originalLiteLLMMasterKey
    if (cacheDirectory) rmSync(cacheDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('exports an OpenCode 2 definition and a compatible OpenCode 1 server', async () => {
    expect(plugin.id).toBe('opencode-litellm')
    expect(plugin.setup).toEqual(expect.any(Function))
    expect(plugin.server).toEqual(expect.any(Function))

    const legacy = await plugin.server({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    expect(legacy.config).toEqual(expect.any(Function))
    expect(legacy.event).toEqual(expect.any(Function))
  })

  it('registers discovered LiteLLM models through the provider transform', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'anthropic/claude-3-5-sonnet',
                model_info: {
                  key: 'anthropic/claude-3-5-sonnet',
                  mode: 'chat',
                  max_input_tokens: 200000,
                  max_output_tokens: 8192,
                  supports_function_calling: true,
                  supports_vision: true,
                  supports_reasoning: true,
                  supports_reasoning_efforts: ['low', 'high'],
                  input_cost_per_token: 0.000003,
                  output_cost_per_token: 0.000015,
                  cache_read_input_token_cost: 0.000001,
                  cache_creation_input_token_cost: 0.000002,
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'anthropic/claude-3-5-sonnet', object: 'model' }] }),
        { status: 200 },
      )
    })

    const registered: Array<{ info: Record<string, unknown>; models: Array<Record<string, unknown>> }> = []
    interface TestEditor {
      list: () => never[]
      get: () => undefined
      add: (entry: { info: Record<string, unknown>; models: Array<Record<string, unknown>> }) => void
      update: ReturnType<typeof vi.fn>
      remove: ReturnType<typeof vi.fn>
      models: {
        set: ReturnType<typeof vi.fn>
        update: ReturnType<typeof vi.fn>
        remove: ReturnType<typeof vi.fn>
      }
    }
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { info: Record<string, unknown>; models: Array<Record<string, unknown>> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: {
        set: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
    }
    const disposeTransform = vi.fn(async () => {})
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: { baseURL: 'http://127.0.0.1:44444/v1' },
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: disposeTransform }
        }),
        reload: vi.fn(async () => {}),
      },
      event: {
        subscribe: () => (async function* () {})(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({
      id: 'litellm',
      package: '@opencode/ai/providers/openai-compatible',
      activation: 'enabled',
    })
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'http://127.0.0.1:44444/v1',
    })
    expect(registered[0].models).toHaveLength(1)
    expect(registered[0].models[0]).toMatchObject({
      id: 'anthropic/claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      limit: { context: 200000, output: 8192 },
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      cost: [
        {
          input: 3,
          output: 15,
          cache: { read: 1, write: 2 },
        },
      ],
      variants: [
        { id: 'low', settings: { reasoningEffort: 'low' } },
        { id: 'high', settings: { reasoningEffort: 'high' } },
      ],
    })

    await cleanup?.()
    expect(disposeTransform).toHaveBeenCalledOnce()
  })

  it('uses service environment variables to create the default provider', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-env-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    process.env.LITELLM_BASE_URL = 'https://llm.example.com/v1'
    process.env.LITELLM_API_KEY = 'test-env-key'
    delete process.env.LITELLM_MASTER_KEY

    const requestURLs: string[] = []
    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      requestURLs.push(String(input))
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      if (String(input).endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'model-from-env', object: 'model' }] }),
        { status: 200 },
      )
    })

    const unmarkedProvider = {
      id: 'llm.ciss.de',
      name: 'CISS provider',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'https://llm.example.com/v1' },
    }
    const registered: Array<{ info: Record<string, unknown>; models: Array<Record<string, unknown>> }> = []
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { info: Record<string, unknown>; models: Array<Record<string, unknown>> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: {
        set: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.0.15', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [unmarkedProvider] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({ id: 'litellm' })
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'https://llm.example.com/v1',
      apiKey: 'test-env-key',
    })
    expect(registered[0].models.map((model) => model.id)).toContain('model-from-env')
    expect(registered[0].models[0]).toMatchObject({
      capabilities: { input: ['text'], output: ['text'] },
    })
    expect(requestURLs).toContain('https://llm.example.com/v1/models')
    expect(authorizationHeaders).toContain('Bearer test-env-key')

    await cleanup?.()
  })

  it('enriches a configured provider without replacing curated models', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-provider-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44445'
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'anthropic/claude-3-5-sonnet', object: 'model' }] }),
        { status: 200 },
      )
    })

    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `${baseURL}/v1`, apiKey: 'test-key' },
      headers: { 'X-Gateway': 'test' },
    }
    const curatedModel = { id: 'curated-model', name: 'Curated model' }
    const configuredRecord = {
      provider: configuredProvider,
      models: new Map([['curated-model', curatedModel]]),
    }
    let updatedModels: Array<Record<string, unknown>> = []
    const editor = {
      list: () => [configuredRecord],
      get: () => configuredRecord,
      add: vi.fn(),
      update: vi.fn((_id, update) => update(configuredProvider)),
      remove: vi.fn(),
      models: {
        set: vi.fn((_id, models: Array<Record<string, unknown>>) => {
          updatedModels = models
        }),
        update: vi.fn(),
        remove: vi.fn(),
      },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [configuredProvider] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(editor.update).toHaveBeenCalledOnce()
    expect(editor.add).not.toHaveBeenCalled()
    expect(configuredProvider.settings).toMatchObject({ baseURL: `${baseURL}/v1` })
    expect(configuredProvider.headers).toMatchObject({ 'X-Gateway': 'test' })
    expect(updatedModels.map((model) => model.id)).toContain('curated-model')
    expect(updatedModels.map((model) => model.id)).toContain('anthropic/claude-3-5-sonnet')

    await cleanup?.()
  })

  it('reloads the provider registry when a background discovery changes models', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-refresh-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44444'
    const cacheKey = buildCacheKey('litellm', baseURL, {}, {})
    const now = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now - 10 * 60 * 1000)
    writeModelCache(cacheKey, { 'cached-model': { name: 'Cached Model' } })
    dateNow.mockRestore()

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'anthropic/claude-3-5-sonnet', object: 'model' }] }),
        { status: 200 },
      )
    })

    const registeredModels: Array<Array<Record<string, unknown>>> = []
    let providerTransform: ((editor: unknown) => void) | undefined
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { models: Array<Record<string, unknown>> }) => {
        registeredModels.push(entry.models)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: {
        set: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
    }
    const reload = vi.fn(async () => {
      providerTransform?.(editor)
    })
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: { baseURL: `${baseURL}/v1` },
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          providerTransform = transform
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload,
      },
      event: {
        subscribe: () =>
          (async function* () {
            yield { type: 'session.created' }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(registeredModels).toHaveLength(2)
    expect(registeredModels[0].map((model) => model.id)).toEqual(['cached-model'])
    expect(registeredModels[1].map((model) => model.id)).toEqual([
      'anthropic/claude-3-5-sonnet',
    ])
    await cleanup?.()
  })

  it('retries discovery and provider reload after a failed registry reload', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-retry-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44446'
    const cacheKey = buildCacheKey('litellm', baseURL, {}, {})
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10 * 60 * 1000)
    writeModelCache(cacheKey, { 'cached-model': { name: 'Cached Model' } })
    dateNow.mockRestore()

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'anthropic/claude-3-5-sonnet', object: 'model' }] }),
        { status: 200 },
      )
    })

    const registeredModels: Array<Array<Record<string, unknown>>> = []
    let providerTransform: ((editor: unknown) => void) | undefined
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { models: Array<Record<string, unknown>> }) => {
        registeredModels.push(entry.models)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: {
        set: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
    }
    let releaseSecondSession!: () => void
    const secondSession = new Promise<void>((resolve) => {
      releaseSecondSession = resolve
    })
    const reload = vi.fn(async () => {
      if (reload.mock.calls.length === 1) throw new Error('temporary registry failure')
      providerTransform?.(editor)
    })
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: { baseURL: `${baseURL}/v1` },
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          providerTransform = transform
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload,
      },
      event: {
        subscribe: () =>
          (async function* () {
            yield { type: 'session.created' }
            await secondSession
            yield { type: 'session.created' }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(registeredModels).toHaveLength(1)

    releaseSecondSession()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
    expect(registeredModels).toHaveLength(2)
    expect(registeredModels[1].map((model) => model.id)).toEqual([
      'anthropic/claude-3-5-sonnet',
    ])
    await cleanup?.()
  })

  it('rediscovers models with the new credential after a credential switch', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-credential-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44447'
    const cacheKey = buildCacheKey('litellm', baseURL, {}, {})
    writeModelCache(cacheKey, { 'cached-model': { name: 'Cached Model' } })

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'new-model', object: 'model' }] }),
        { status: 200 },
      )
    })

    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      integrationID: 'litellm-auth',
      settings: { baseURL: `${baseURL}/v1` },
      headers: {},
    }
    let currentModels = new Map<string, Record<string, unknown>>()
    const record = () => ({ provider: configuredProvider, models: currentModels })
    const editor = {
      list: () => [record()],
      get: () => record(),
      add: vi.fn(),
      update: vi.fn((_id, update) => update(configuredProvider)),
      remove: vi.fn(),
      models: {
        set: vi.fn((_id, models: Array<Record<string, unknown>>) => {
          currentModels = new Map(models.map((model) => [String(model.id), model]))
        }),
        update: vi.fn(),
        remove: vi.fn(),
      },
    }
    let providerTransform: ((editor: unknown) => void) | undefined
    const active = vi
      .fn()
      .mockResolvedValueOnce({ key: 'old-key' })
      .mockResolvedValueOnce({ key: 'new-key' })
    const reload = vi.fn(async () => providerTransform?.(editor))
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({ data: [configuredProvider] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          providerTransform = transform
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload,
      },
      integration: {
        connection: {
          active,
          resolve: vi.fn(async (connection: { key: string }) => ({
            type: 'key',
            key: connection.key,
          })),
        },
      },
      event: {
        subscribe: () =>
          (async function* () {
            yield {
              type: 'credential.switched',
              data: { integrationID: 'litellm-auth' },
            }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))

    expect(active).toHaveBeenCalledTimes(2)
    expect(authorizationHeaders).toContain('Bearer new-key')
    expect(configuredProvider.settings).toMatchObject({ apiKey: 'new-key' })
    expect([...currentModels.keys()]).toContain('new-model')
    await cleanup?.()
  })
})
