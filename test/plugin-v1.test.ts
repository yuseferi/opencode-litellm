import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiteLLMPlugin } from '../src/plugin'
import {
  buildCacheKey,
  readModelCacheEntry,
  readModelCacheSavedAt,
  writeModelCache,
} from '../src/utils/model-cache'
import { resetOpenCodeAuthCache } from '../src/utils/opencode-auth'

interface ProviderConfig {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}

interface OpenCodeConfig {
  provider: Record<string, ProviderConfig>
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('OpenCode 1 config hook', () => {
  const originalFetch = globalThis.fetch
  let originalCacheHome: string | undefined
  let originalHome: string | undefined
  let originalLiteLLMApiKey: string | undefined
  let originalLiteLLMMasterKey: string | undefined
  let cacheDirectory: string
  let homeDirectory: string

  beforeEach(() => {
    originalCacheHome = process.env.XDG_CACHE_HOME
    originalHome = process.env.HOME
    originalLiteLLMApiKey = process.env.LITELLM_API_KEY
    originalLiteLLMMasterKey = process.env.LITELLM_MASTER_KEY
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_MASTER_KEY
    // Isolate the box auth store: tests must never read the developer's real
    // credentials, and stored-key fingerprints must be deterministic.
    homeDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-home-'))
    process.env.HOME = homeDirectory
    resetOpenCodeAuthCache()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv('XDG_CACHE_HOME', originalCacheHome)
    restoreEnv('HOME', originalHome)
    restoreEnv('LITELLM_API_KEY', originalLiteLLMApiKey)
    restoreEnv('LITELLM_MASTER_KEY', originalLiteLLMMasterKey)
    if (cacheDirectory) rmSync(cacheDirectory, { recursive: true, force: true })
    if (homeDirectory) rmSync(homeDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function useIsolatedState(): void {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-v1-cache-'))
    homeDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-v1-home-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    process.env.HOME = homeDirectory
  }

  function mockProxy(
    models: Array<{ id: string; mode?: string; params?: string[]; displayName?: unknown }>,
  ): void {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: models.map((model) => ({
              model_name: model.id,
              model_info: {
                key: model.id,
                mode: model.mode ?? 'chat',
                supported_openai_params: model.params,
                ...(model.displayName !== undefined
                  ? { display_name: model.displayName }
                  : {}),
              },
            })),
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          data: models.map((model) => ({ id: model.id, object: 'model' })),
        }),
        { status: 200 },
      )
    })
  }

  async function runConfigHook(baseURL: string): Promise<OpenCodeConfig> {
    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM (proxy)',
          options: { baseURL, apiKey: 'example-key' },
          models: {},
        },
      },
    }
    await plugin.config!(config as never)
    return config
  }

  it('applies modelNameTemplate to discovered models and leaves curated names alone', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45559/v1'
    mockProxy([{ id: 'claude-3-5-sonnet' }, { id: 'curated-model' }])

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        'litellm-team-a': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Team A',
          options: {
            baseURL,
            apiKey: 'example-key',
            modelNameTemplate: '{name} ({provider_id})',
          },
          models: { 'curated-model': { name: 'Hand-picked' } },
        },
      },
    }
    await plugin.config!(config as never)

    const models = config.provider['litellm-team-a'].models ?? {}
    expect(models['claude-3-5-sonnet']).toMatchObject({
      name: 'Claude 3.5 Sonnet (litellm-team-a)',
    })
    // An explicit `models.<id>.name` wins and is never templated.
    expect(models['curated-model']).toMatchObject({ name: 'Hand-picked' })
  })

  it('keys the model cache by the template, not by the previous names', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45560/v1'
    mockProxy([{ id: 'claude-3-5-sonnet' }])

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        'litellm-team-b': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Team B',
          options: {
            baseURL,
            apiKey: 'example-key',
            modelNameTemplate: '[B] {name}',
          },
          models: {},
        },
      },
    }
    await plugin.config!(config as never)

    const templatedKey = buildCacheKey(
      'litellm-team-b',
      'http://127.0.0.1:45560',
      {},
      {},
      { modelNameTemplate: '[B] {name}', providerName: 'Team B' },
      'example-key',
    )
    expect(readModelCacheEntry(templatedKey)?.models['claude-3-5-sonnet']).toMatchObject({
      name: '[B] Claude 3.5 Sonnet',
    })
    // The untemplated identity stays empty, so a template change cannot
    // resurrect the names discovered without it.
    const plainKey = buildCacheKey(
      'litellm-team-b',
      'http://127.0.0.1:45560',
      {},
      {},
      {},
      'example-key',
    )
    expect(readModelCacheEntry(plainKey)).toBeNull()
  })

  it('resolves provider placeholders against the Responses sibling that owns the model', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45561/v1'
    mockProxy([
      { id: 'chat-model', mode: 'chat' },
      { id: 'responses-model', mode: 'responses' },
    ])

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        'litellm-team-a': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Team A',
          options: {
            baseURL,
            apiKey: 'example-key',
            modelNameTemplate: '{name} ({provider_id} / {provider_name})',
          },
          models: {},
        },
      },
    }
    await plugin.config!(config as never)

    expect(config.provider['litellm-team-a'].models?.['chat-model']).toMatchObject({
      name: 'Chat Model (litellm-team-a / Team A)',
    })
    // Responses models are served by the sibling provider, so the template
    // must name the provider the user will actually select.
    expect(
      config.provider['litellm-team-a-responses'].models?.['responses-model'],
    ).toMatchObject({
      name: 'Responses Model (litellm-team-a-responses / Team A Responses)',
    })
  })

  it('labels the Responses sibling from the provider id when the base has no name', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45562/v1'
    mockProxy([{ id: 'responses-model', mode: 'responses' }])

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        'litellm-team-c': {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL,
            apiKey: 'example-key',
            modelNameTemplate: '{name} ({provider_name})',
          },
          models: {},
        },
      },
    }
    await plugin.config!(config as never)

    // Unnamed: the picker falls back to ids, so `{provider_name}` does too.
    expect(config.provider['litellm-team-c-responses'].name).toBe('litellm-team-c Responses')
    expect(
      config.provider['litellm-team-c-responses'].models?.['responses-model'],
    ).toMatchObject({
      name: 'Responses Model (litellm-team-c Responses)',
    })
  })

  it('uses display_name for display only, leaving ids, routing and curated names alone', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45563/v1'
    mockProxy([
      { id: 'chat-model', displayName: 'Chat Display' },
      { id: 'responses-model', mode: 'responses', displayName: 'Responses Display' },
      { id: 'curated-model', displayName: 'Should Not Win' },
    ])

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        'litellm-team-a': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Team A',
          options: { baseURL, apiKey: 'example-key' },
          models: { 'curated-model': { name: 'Hand-picked' } },
        },
      },
    }
    await plugin.config!(config as never)

    const models = config.provider['litellm-team-a'].models ?? {}
    // Display names change, ids and routing do not.
    expect(Object.keys(models).sort()).toEqual(['chat-model', 'curated-model'])
    expect(models['chat-model']).toMatchObject({ name: 'Chat Display' })
    // An explicit models.<id>.name still wins.
    expect(models['curated-model']).toMatchObject({ name: 'Hand-picked' })

    const sibling = config.provider['litellm-team-a-responses']
    expect(Object.keys(sibling.models ?? {})).toEqual(['responses-model'])
    expect(sibling.models?.['responses-model']).toMatchObject({ name: 'Responses Display' })

    const cacheKey = buildCacheKey('litellm-team-a', 'http://127.0.0.1:45563', {}, {}, {}, 'example-key')
    const cached = readModelCacheEntry(cacheKey)
    expect(cached?.responsesIds).toEqual(['responses-model'])
    // The upstream display name is cached even for a curated model: the
    // explicit `models.<id>.name` wins at merge time, not at discovery.
    expect(cached?.displayNames).toEqual({
      'chat-model': 'Chat Display',
      'responses-model': 'Responses Display',
      'curated-model': 'Should Not Win',
    })
  })

  it('keeps display_name when the Responses sibling re-renders the template', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45564/v1'
    mockProxy([
      { id: 'deepseek-v4.1-flash', mode: 'responses', displayName: '  DeepSeek V4.1 Flash Pro ' },
    ])

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        'litellm-team-a': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Team A',
          options: {
            baseURL,
            apiKey: 'example-key',
            modelNameTemplate: '{name} ({provider_id} / {provider_name})',
          },
          models: {},
        },
      },
    }
    await plugin.config!(config as never)

    expect(
      config.provider['litellm-team-a-responses'].models?.['deepseek-v4.1-flash'],
    ).toMatchObject({
      name: 'DeepSeek V4.1 Flash Pro (litellm-team-a-responses / Team A Responses)',
    })
  })

  it('keeps a cached display_name when re-rendering the Responses sibling', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45567/v1'
    const cacheKey = buildCacheKey(
      'litellm-team-a',
      'http://127.0.0.1:45567',
      {},
      {},
      {
        modelNameTemplate: '{name} ({provider_id} / {provider_name})',
        providerName: 'Team A',
      },
      'example-key',
    )
    writeModelCache(
      cacheKey,
      {
        'deepseek-v4.1-flash': {
          name: 'DeepSeek V4.1 Flash Pro (litellm-team-a / Team A)',
        },
      },
      ['deepseek-v4.1-flash'],
      {},
      { 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash Pro' },
    )
    // A cache miss would go to the network; fail fast so the test is offline.
    globalThis.fetch = vi.fn(
      async () => new Response('unexpected network call', { status: 500 }),
    )

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        'litellm-team-a': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Team A',
          options: {
            baseURL,
            apiKey: 'example-key',
            modelNameTemplate: '{name} ({provider_id} / {provider_name})',
          },
          models: {},
        },
      },
    }
    await plugin.config!(config as never)

    expect(
      config.provider['litellm-team-a-responses'].models?.['deepseek-v4.1-flash'],
    ).toMatchObject({
      name: 'DeepSeek V4.1 Flash Pro (litellm-team-a-responses / Team A Responses)',
    })
  })

  it('does not record display names when formatting is disabled', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45568/v1'
    mockProxy([{ id: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash Pro' }])

    const plugin = await LiteLLMPlugin({
      client: { app: { log: vi.fn(async () => {}) } },
    } as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM (proxy)',
          options: { baseURL, apiKey: 'example-key', formatModelNames: false },
          models: {},
        },
      },
    }
    await plugin.config!(config as never)

    expect(config.provider.litellm.models?.['deepseek-v4.1-flash']).toMatchObject({
      name: 'deepseek-v4.1-flash',
    })
    const cacheKey = buildCacheKey(
      'litellm',
      'http://127.0.0.1:45568',
      {},
      {},
      { formatModelNames: false },
      'example-key',
    )
    expect(readModelCacheEntry(cacheKey)?.displayNames).toEqual({})
  })

  it('falls back to id formatting when /v1/model/info is unavailable', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45565/v1'
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response('not available', { status: 404 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'claude-3-5-sonnet', object: 'model' }] }),
        { status: 200 },
      )
    })

    const config = await runConfigHook(baseURL)

    expect(config.provider.litellm.models?.['claude-3-5-sonnet']).toMatchObject({
      name: 'Claude 3.5 Sonnet',
    })
  })

  it('refreshes a changed display_name through the existing background refresh', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45566/v1'
    mockProxy([{ id: 'deepseek-v4.1-flash', displayName: 'Old Name' }])
    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM (proxy)',
          options: { baseURL, apiKey: 'example-key' },
          models: {},
        },
      },
    }
    // Cold start, backdated so the next session is allowed to refresh.
    const started = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(started - 10 * 60 * 1000)
    await plugin.config!(config as never)
    dateNow.mockRestore()

    const cacheKey = buildCacheKey('litellm', 'http://127.0.0.1:45566', {}, {}, {}, 'example-key')
    expect(readModelCacheEntry(cacheKey)?.models['deepseek-v4.1-flash']).toMatchObject({
      name: 'Old Name',
    })

    mockProxy([{ id: 'deepseek-v4.1-flash', displayName: 'New Name' }])
    await plugin.event!({ event: { type: 'session.created' } } as never)
    await vi.waitFor(() =>
      expect(readModelCacheEntry(cacheKey)?.models['deepseek-v4.1-flash']).toMatchObject({
        name: 'New Name',
      }),
    )
    expect(readModelCacheEntry(cacheKey)?.displayNames).toEqual({
      'deepseek-v4.1-flash': 'New Name',
    })
  })

  it('routes Responses models to a sibling provider, leaving chat models alone', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45551/v1'
    mockProxy([
      { id: 'chat-model', mode: 'chat' },
      { id: 'responses-model', mode: 'responses' },
    ])

    const config = await runConfigHook(baseURL)

    expect(Object.keys(config.provider.litellm.models ?? {})).toEqual(['chat-model'])
    expect(config.provider.litellm.npm).toBe('@ai-sdk/openai-compatible')

    const sibling = config.provider['litellm-responses']
    expect(sibling).toBeDefined()
    expect(sibling.npm).toBe('@ai-sdk/openai')
    expect(sibling.options).toMatchObject({
      baseURL,
      apiKey: 'example-key',
    })
    expect(Object.keys(sibling.models ?? {})).toEqual(['responses-model'])
  })

  it('persists model hints so an OpenCode 2 start can reuse the shared cache', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45557/v1'
    mockProxy([
      { id: 'claude', params: ['max_tokens', 'cache_control'] },
      { id: 'gpt', params: ['max_tokens'] },
    ])

    await runConfigHook(baseURL)

    const cacheKey = buildCacheKey('litellm', 'http://127.0.0.1:45557', {}, {}, {}, 'example-key')
    expect(readModelCacheEntry(cacheKey)?.hints).toEqual({
      claude: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
      gpt: { acceptsCacheControl: false, adaptiveThinking: false, thinkingAlwaysOn: false },
    })
  })

  it('keeps model hints in the shared cache across a background refresh', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45558/v1'
    mockProxy([{ id: 'claude', params: ['cache_control'] }])
    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM (proxy)',
          options: { baseURL, apiKey: 'example-key' },
          models: {},
        },
      },
    }
    // Cold start, backdated so the next session is allowed to refresh.
    const started = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(started - 10 * 60 * 1000)
    await plugin.config!(config as never)
    dateNow.mockRestore()
    const cacheKey = buildCacheKey('litellm', 'http://127.0.0.1:45558', {}, {}, {}, 'example-key')
    expect(readModelCacheEntry(cacheKey)?.hints).toEqual({
      claude: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
    })

    await plugin.event!({ event: { type: 'session.created' } } as never)
    await vi.waitFor(() => expect(readModelCacheSavedAt(cacheKey)).toBeGreaterThanOrEqual(started))
    expect(readModelCacheEntry(cacheKey)?.hints).toEqual({
      claude: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
    })
  })

  it('creates no sibling provider when no model needs the Responses API', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45552/v1'
    mockProxy([
      { id: 'chat-model', mode: 'chat' },
      { id: 'completion-model', mode: 'completion' },
    ])

    const config = await runConfigHook(baseURL)

    expect(Object.keys(config.provider.litellm.models ?? {}).sort()).toEqual([
      'chat-model',
      'completion-model',
    ])
    expect(config.provider['litellm-responses']).toBeUndefined()
  })

  it('does not treat the Responses sibling as a chat provider on later passes', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45553/v1'
    mockProxy([{ id: 'responses-model', mode: 'responses' }])

    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM (proxy)',
          options: { baseURL, apiKey: 'example-key' },
          models: {},
        },
      },
    }

    await plugin.config!(config as never)
    await plugin.config!(config as never)

    // A naive re-run would nest `litellm-responses-responses`.
    expect(Object.keys(config.provider).sort()).toEqual([
      'litellm',
      'litellm-responses',
    ])
    expect(Object.keys(config.provider['litellm-responses'].models ?? {})).toEqual([
      'responses-model',
    ])
  })

  it('does not duplicate a Responses model already curated on the chat side', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45554/v1'
    mockProxy([{ id: 'responses-model', mode: 'responses' }])

    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL, apiKey: 'example-key' },
          models: { 'responses-model': { name: 'Curated' } },
        },
      },
    }

    await plugin.config!(config as never)

    // The curated entry wins; the plugin leaves it where it is rather than
    // mirroring it into the sibling.
    expect(Object.keys(config.provider.litellm.models ?? {})).toContain('responses-model')
    expect(config.provider['litellm-responses']).toBeUndefined()
  })

  it('propagates gateway headers to the Responses sibling', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45555/v1'
    mockProxy([{ id: 'responses-model', mode: 'responses' }])

    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL,
            apiKey: 'example-key',
            headers: { 'CF-Access-Client-Id': 'id-from-base' },
            customHeaders: { 'X-Legacy': 'legacy' },
          },
          models: {},
        },
      },
    }

    await plugin.config!(config as never)

    // OpenCode 1 reads `options.headers`; both the chat provider's native
    // headers and the plugin's `customHeaders` must reach the sibling.
    expect(config.provider['litellm-responses'].options?.headers).toMatchObject({
      'CF-Access-Client-Id': 'id-from-base',
      'X-Legacy': 'legacy',
    })
  })

  it('sends the provider native headers on discovery too', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45557/v1'
    const seen: Array<Record<string, string>> = []
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      seen.push((init?.headers ?? {}) as Record<string, string>)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'chat-model', object: 'model' }] }),
        { status: 200 },
      )
    })

    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL,
            apiKey: 'example-key',
            headers: { 'CF-Access-Client-Id': 'id-from-base' },
          },
          models: {},
        },
      },
    }

    await plugin.config!(config as never)

    // A gateway configured only via the native `headers` map must still see
    // them on the plugin's own health/models fetches, not just the runtime.
    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) {
      expect(headers['CF-Access-Client-Id']).toBe('id-from-base')
    }
  })

  it('routes cached Responses models to the sibling on the fast path', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45556/v1'
    // The cached path must not touch the network at all.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network should not be hit on the cached path')
    })
    const cacheKey = buildCacheKey('litellm', 'http://127.0.0.1:45556', {}, {}, {
      formatModelNames: true,
    }, 'example-key')
    writeModelCache(
      cacheKey,
      { 'chat-model': { name: 'Chat' }, 'responses-model': { name: 'Resp' } },
      ['responses-model'],
    )

    const config = await runConfigHook(baseURL)

    expect(Object.keys(config.provider.litellm.models ?? {})).toEqual(['chat-model'])
    expect(Object.keys(config.provider['litellm-responses'].models ?? {})).toEqual([
      'responses-model',
    ])
  })

  it('creates no sibling when the only Responses model is filtered out', async () => {
    useIsolatedState()
    const baseURL = 'http://127.0.0.1:45558/v1'
    mockProxy([{ id: 'responses-model', mode: 'responses' }])

    const input = { client: { app: { log: vi.fn(async () => {}) } } }
    const plugin = await LiteLLMPlugin(input as never)
    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL,
            apiKey: 'example-key',
            excludeModels: ['responses-*'],
          },
          models: {},
        },
      },
    }

    await plugin.config!(config as never)

    expect(config.provider.litellm.models ?? {}).toEqual({})
    expect(config.provider['litellm-responses']).toBeUndefined()
  })
})
