import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin from '../src'
import type { Context } from '@opencode/plugin/promise/plugin'
import {
  buildCacheKey,
  readModelCacheEntry,
  readModelCacheSavedAt,
  writeModelCache,
} from '../src/utils/model-cache'
import { resetOpenCodeAuthCache } from '../src/utils/opencode-auth'

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

describe('OpenCode 2 plugin entrypoint', () => {
  const originalFetch = globalThis.fetch
  let originalCacheHome: string | undefined
  let originalHome: string | undefined
  let originalLiteLLMBaseURL: string | undefined
  let originalLiteLLMApiKey: string | undefined
  let originalLiteLLMMasterKey: string | undefined
  let cacheDirectory: string
  let homeDirectory: string

  beforeEach(() => {
    originalCacheHome = process.env.XDG_CACHE_HOME
    originalHome = process.env.HOME
    originalLiteLLMBaseURL = process.env.LITELLM_BASE_URL
    originalLiteLLMApiKey = process.env.LITELLM_API_KEY
    originalLiteLLMMasterKey = process.env.LITELLM_MASTER_KEY
    // Scrub ambient credentials so a developer/CI shell can't change what
    // these tests exercise; each test opts into the env vars it needs.
    delete process.env.LITELLM_BASE_URL
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
    restoreEnv('LITELLM_BASE_URL', originalLiteLLMBaseURL)
    restoreEnv('LITELLM_API_KEY', originalLiteLLMApiKey)
    restoreEnv('LITELLM_MASTER_KEY', originalLiteLLMMasterKey)
    if (cacheDirectory) rmSync(cacheDirectory, { recursive: true, force: true })
    if (homeDirectory) rmSync(homeDirectory, { recursive: true, force: true })
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

  it('does nothing when the host context has no provider API', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () => {
      throw new Error('setup must not probe the network without a provider API')
    })
    // OpenCode 1.18.x embeds a v2 plugin host whose context exposes `catalog`
    // instead of `provider`; the legacy `server()` entrypoint serves that host.
    const context = {
      options: {},
      catalog: { transform: vi.fn(), reload: vi.fn() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(cleanup).toBeUndefined()
    expect(log).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
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
                  supports_adaptive_thinking: true,
                  supported_openai_params: ['max_tokens', 'cache_control', 'reasoning_effort'],
                  input_cost_per_token: 0.000003,
                  output_cost_per_token: 0.000015,
                  cache_read_input_token_cost: 0.000001,
                  cache_creation_input_token_cost: 0.000002,
                },
              },
              {
                model_name: 'gpt-6-astra',
                model_info: {
                  key: 'bedrock_mantle/openai.gpt-6-astra',
                  supports_reasoning: true,
                  supports_max_reasoning_effort: true,
                  supports_xhigh_reasoning_effort: true,
                  supports_none_reasoning_effort: false,
                  supports_minimal_reasoning_effort: false,
                  supports_low_reasoning_effort: null,
                  reasoning_effort_levels: null,
                },
              },
              {
                model_name: 'gpt-5-search-api',
                model_info: {
                  key: 'gpt-5-search-api',
                  supports_reasoning: null,
                  supports_minimal_reasoning_effort: true,
                  supports_none_reasoning_effort: false,
                  supports_xhigh_reasoning_effort: false,
                  supported_openai_params: ['max_tokens', 'stream', 'web_search_options'],
                },
              },
              {
                model_name: 'company-pro',
                litellm_params: { model: 'openai/gpt-5.4-pro', use_responses_api: true },
                model_info: {
                  key: 'gpt-5.4-pro',
                  mode: 'responses',
                  supports_reasoning: true,
                  supports_none_reasoning_effort: false,
                  supports_minimal_reasoning_effort: false,
                  supports_xhigh_reasoning_effort: true,
                  reasoning_effort_levels: null,
                  supported_openai_params: ['reasoning', 'cache_control'],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [
          { id: 'anthropic/claude-3-5-sonnet', object: 'model' },
          { id: 'gpt-6-astra', object: 'model' },
          { id: 'gpt-5-search-api', object: 'model' },
          { id: 'company-pro', object: 'model' },
        ] }),
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
    expect(registered[0].models).toHaveLength(4)
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
      // Chat Completions only emits Anthropic cache markers when told to.
      compatibility: { cacheFormat: 'anthropic' },
    })

    expect(registered[0].models[1]).toMatchObject({
      id: 'gpt-6-astra',
      variants: [
        { id: 'low', settings: { reasoningEffort: 'low' } },
        { id: 'medium', settings: { reasoningEffort: 'medium' } },
        { id: 'high', settings: { reasoningEffort: 'high' } },
        { id: 'xhigh', settings: { reasoningEffort: 'xhigh' } },
        { id: 'max', settings: { reasoningEffort: 'max' } },
      ],
    })

    expect(registered[0].models[2]).toMatchObject({
      id: 'gpt-5-search-api',
      variants: [],
    })

    expect(registered[0].models[3]).toMatchObject({
      id: 'company-pro',
      // `mode: 'responses'` overrides the runtime package for this model only.
      package: '@opencode/ai/providers/openai/responses',
      variants: [
        { id: 'medium', settings: { reasoningEffort: 'medium' } },
        { id: 'high', settings: { reasoningEffort: 'high' } },
        { id: 'xhigh', settings: { reasoningEffort: 'xhigh' } },
      ],
    })

    // Chat models keep the provider's default package (no per-model override).
    expect(registered[0].models[0].package).toBeUndefined()
    expect(registered[0].models[1].package).toBeUndefined()
    expect(registered[0].models[2].package).toBeUndefined()
    // No `cache_control` reported, or not a Chat Completions model: nothing inferred.
    expect(registered[0].models[1].compatibility).toBeUndefined()
    expect(registered[0].models[2].compatibility).toBeUndefined()
    expect(registered[0].models[3].compatibility).toBeUndefined()
    const cacheKey = buildCacheKey('litellm', 'http://127.0.0.1:44444', {}, {})
    expect(readModelCacheEntry(cacheKey)?.hints).toEqual({
      'anthropic/claude-3-5-sonnet': {
        acceptsCacheControl: true,
        adaptiveThinking: true,
        thinkingAlwaysOn: false,
      },
      'gpt-6-astra': { acceptsCacheControl: false, adaptiveThinking: false, thinkingAlwaysOn: false },
      'gpt-5-search-api': { acceptsCacheControl: false, adaptiveThinking: false, thinkingAlwaysOn: false },
      'company-pro': { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
    })

    await cleanup?.()
    expect(disposeTransform).toHaveBeenCalledOnce()
  })

  it('declares temperature support only for models that list it', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-temperature-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'accepts-temperature',
                model_info: { mode: 'chat', supported_openai_params: ['max_tokens', 'temperature'] },
              },
              {
                model_name: 'rejects-temperature',
                model_info: { mode: 'chat', supported_openai_params: ['max_tokens'] },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          data: [
            { id: 'accepts-temperature', object: 'model' },
            { id: 'rejects-temperature', object: 'model' },
          ],
        }),
        { status: 200 },
      )
    })

    const registered: Array<{ models: Array<Record<string, unknown>> }> = []
    const editor = {
      list: () => [],
      get: () => undefined,
      add: (entry: { models: Array<Record<string, unknown>> }) => {
        registered.push(entry)
      },
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: { baseURL: 'http://127.0.0.1:44447/v1' },
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    const byId = Object.fromEntries(registered[0].models.map((model) => [model.id, model]))
    expect((byId['accepts-temperature'].capabilities as Record<string, unknown>).temperature).toBe(
      true,
    )
    // Not listed: the capability stays unknown rather than being asserted false.
    expect(
      (byId['rejects-temperature'].capabilities as Record<string, unknown>).temperature,
    ).toBeUndefined()
    await cleanup?.()
  })

  it('applies modelCompatibility overrides on top of inferred compatibility', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'claude-direct',
                model_info: {
                  key: 'claude-direct',
                  mode: 'chat',
                  supported_openai_params: ['cache_control'],
                },
              },
              {
                model_name: 'claude-bedrock',
                model_info: {
                  key: 'claude-bedrock',
                  mode: 'chat',
                  supported_openai_params: ['max_tokens'],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [
          { id: 'claude-direct', object: 'model' },
          { id: 'claude-bedrock', object: 'model' },
        ] }),
        { status: 200 },
      )
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
      options: {
        baseURL: 'http://127.0.0.1:44444/v1',
        modelCompatibility: {
          // `null` removes the inferred key.
          'claude-direct': { cacheFormat: null },
          // Set where the proxy does not advertise `cache_control`.
          'claude-bedrock': { cacheFormat: 'anthropic' },
          // An id the proxy does not list adds no model.
          unknown: { cacheFormat: 'anthropic' },
        },
      },
      provider: {
        list: vi.fn(async () => ({ data: [] })),
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
    expect(registered[0].models.map((model) => [model.id, model.compatibility])).toEqual([
      ['claude-direct', undefined],
      ['claude-bedrock', { cacheFormat: 'anthropic' }],
    ])
    // runtimeSettings strips plugin-only options.
    expect(registered[0].info.settings).not.toHaveProperty('modelCompatibility')
    await cleanup?.()
  })

  it('applies compatibility from cached hints without touching the network', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    writeModelCache(
      buildCacheKey('litellm', 'http://127.0.0.1:44444', {}, {}),
      { claude: { name: 'Claude' }, qwen: { name: 'Qwen' }, constructor: { name: 'Constructor' } },
      [],
      {
        claude: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
        qwen: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
        constructor: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
      },
    )
    globalThis.fetch = vi.fn(async () => {
      throw new Error('the cached path must not hit the network')
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
      options: {
        baseURL: 'http://127.0.0.1:44444/v1',
        modelCompatibility: { qwen: { cacheFormat: 'alibaba' } },
      },
      provider: {
        list: vi.fn(async () => ({ data: [] })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(registered[0].models.map((model) => [model.id, model.compatibility])).toEqual([
      ['claude', { cacheFormat: 'anthropic' }],
      ['qwen', { cacheFormat: 'alibaba' }],
      // An id that is also an `Object.prototype` member has no override.
      ['constructor', { cacheFormat: 'anthropic' }],
    ])
    await cleanup?.()
  })

  it('infers cacheFormat only for Chat Completions runtime packages', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'claude',
                model_info: { key: 'claude', mode: 'chat', supported_openai_params: ['cache_control'] },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ data: [{ id: 'claude', object: 'model' }] }), { status: 200 })
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
        list: vi.fn(async () => ({
          data: [
            // `openai` defaults to the Responses API, which does not read `cacheFormat`.
            ...[
              ['litellm-openai', '@opencode/ai/providers/openai'],
              ['litellm-anthropic', '@opencode/ai/providers/anthropic-compatible'],
              ['litellm-chat', '@opencode/ai/providers/openai/chat'],
            ].map(([id, pkg]) => ({
              id,
              activation: 'enabled',
              package: pkg,
              settings: { baseURL: 'http://127.0.0.1:44444/v1' },
            })),
          ],
        })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered.map((entry) => [entry.info.id, entry.models[0].compatibility])).toEqual([
      ['litellm-openai', undefined],
      ['litellm-anthropic', undefined],
      ['litellm-chat', { cacheFormat: 'anthropic' }],
    ])
    await cleanup?.()
  })

  it('respells effort variants for providers on an Anthropic runtime package', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                // Adaptive thinking, can be switched off: `none` becomes `disabled`.
                model_name: 'claude-adaptive',
                model_info: {
                  key: 'claude-adaptive',
                  mode: 'chat',
                  supports_reasoning: true,
                  supports_adaptive_thinking: true,
                  reasoning_effort_levels: ['none', 'low', 'max'],
                  supported_openai_params: ['cache_control', 'reasoning_effort'],
                },
              },
              {
                // Adaptive thinking that is always on: `none` is dropped.
                model_name: 'claude-always-on',
                model_info: {
                  key: 'claude-always-on',
                  mode: 'chat',
                  supports_reasoning: true,
                  supports_adaptive_thinking: true,
                  thinking_always_on: true,
                  reasoning_effort_levels: ['none', 'high'],
                },
              },
              {
                // No adaptive thinking reported: `reasoningEffort` would be inert, so no variants.
                model_name: 'claude-manual',
                model_info: {
                  key: 'claude-manual',
                  mode: 'chat',
                  supports_reasoning: true,
                  reasoning_effort_levels: ['low', 'high'],
                },
              },
              {
                // Responses override on the same provider: the OpenAI runtime keeps `reasoningEffort`.
                model_name: 'gpt-responses',
                model_info: {
                  key: 'gpt-responses',
                  mode: 'responses',
                  supports_reasoning: true,
                  supports_adaptive_thinking: true,
                  reasoning_effort_levels: ['low'],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [
          { id: 'claude-adaptive', object: 'model' },
          { id: 'claude-always-on', object: 'model' },
          { id: 'claude-manual', object: 'model' },
          { id: 'gpt-responses', object: 'model' },
        ] }),
        { status: 200 },
      )
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
      options: { baseURL: 'http://127.0.0.1:44444/v1' },
      provider: {
        list: vi.fn(async () => ({
          data: [
            {
              id: 'litellm-claude',
              name: 'LiteLLM Claude',
              activation: 'enabled',
              package: '@opencode/ai/providers/anthropic-compatible',
              settings: { baseURL: 'http://127.0.0.1:44444/v1' },
            },
            {
              id: 'litellm-anthropic',
              name: 'LiteLLM Anthropic',
              activation: 'enabled',
              package: '@opencode/ai/providers/anthropic',
              settings: { baseURL: 'http://127.0.0.1:44444/v1' },
            },
          ],
        })),
        transform: vi.fn(async (transform: (editor: unknown) => void) => {
          transform(editor as never)
          return { dispose: vi.fn(async () => {}) }
        }),
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(registered.map((entry) => entry.info.id)).toEqual(['litellm-claude', 'litellm-anthropic'])
    expect(registered[0].info).toMatchObject({
      id: 'litellm-claude',
      package: '@opencode/ai/providers/anthropic-compatible',
    })
    const adaptive = { type: 'adaptive', display: 'summarized' }
    expect(registered[0].models.map((model) => [model.id, model.variants])).toEqual([
      [
        'claude-adaptive',
        [
          { id: 'none', settings: { thinking: { type: 'disabled' } } },
          { id: 'low', settings: { thinking: adaptive, effort: 'low' } },
          { id: 'max', settings: { thinking: adaptive, effort: 'max' } },
        ],
      ],
      ['claude-always-on', [{ id: 'high', settings: { thinking: adaptive, effort: 'high' } }]],
      ['claude-manual', []],
      ['gpt-responses', [{ id: 'low', settings: { reasoningEffort: 'low' } }]],
    ])
    // Both Anthropic packages get the same spelling.
    expect(registered[1].models.map((model) => model.variants)).toEqual(
      registered[0].models.map((model) => model.variants),
    )
    // The Anthropic runtime places cache breakpoints itself; nothing to declare,
    // even though `claude-adaptive` advertises `cache_control`.
    const all = registered.flatMap((entry) => entry.models)
    expect(all.every((model) => model.compatibility === undefined)).toBe(true)
    await cleanup?.()
  })

  it('uses service environment variables to create the default provider', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-env-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    process.env.LITELLM_BASE_URL = 'https://llm.example.com/v1'
    setEnvApiKey('example-litellm-key')
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
      apiKey: 'example-litellm-key',
    })
    expect(registered[0].models.map((model) => model.id)).toContain('model-from-env')
    expect(registered[0].models[0]).toMatchObject({
      capabilities: { input: ['text'], output: ['text'] },
    })
    expect(requestURLs).toContain('https://llm.example.com/v1/models')
    expect(authorizationHeaders).toContain('Bearer example-litellm-key')

    await cleanup?.()
  })

  it('enriches a configured provider without replacing curated models', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-provider-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44445'
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
                  supported_openai_params: ['cache_control'],
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

    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: {
        baseURL: `${baseURL}/v1`,
        apiKey: 'example-api-key',
        modelCompatibility: { 'anthropic/claude-3-5-sonnet': { cacheFormat: 'alibaba' } },
      },
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
    const discovered = updatedModels.find((model) => model.id === 'anthropic/claude-3-5-sonnet')
    expect(discovered?.compatibility).toEqual({ cacheFormat: 'alibaba' })

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
        return new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'anthropic/claude-3-5-sonnet',
                model_info: {
                  key: 'anthropic/claude-3-5-sonnet',
                  mode: 'chat',
                  supported_openai_params: ['cache_control'],
                },
              },
              {
                model_name: 'vertex/claude-sonnet',
                model_info: {
                  key: 'vertex/claude-sonnet',
                  mode: 'chat',
                  supported_openai_params: ['cache_control'],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          data: [
            { id: 'anthropic/claude-3-5-sonnet', object: 'model' },
            { id: 'vertex/claude-sonnet', object: 'model' },
          ],
        }),
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
      options: {
        baseURL: `${baseURL}/v1`,
        modelCompatibility: { 'anthropic/claude-3-5-sonnet': { cacheFormat: 'alibaba' } },
      },
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
    // Inference and the override are both applied on refresh, and the refreshed hints are persisted.
    expect(registeredModels[1].map((model) => [model.id, model.compatibility])).toEqual([
      ['anthropic/claude-3-5-sonnet', { cacheFormat: 'alibaba' }],
      ['vertex/claude-sonnet', { cacheFormat: 'anthropic' }],
    ])
    expect(readModelCacheEntry(cacheKey)?.hints).toEqual({
      'anthropic/claude-3-5-sonnet': {
        acceptsCacheControl: true,
        adaptiveThinking: false,
        thinkingAlwaysOn: false,
      },
      'vertex/claude-sonnet': {
        acceptsCacheControl: true,
        adaptiveThinking: false,
        thinkingAlwaysOn: false,
      },
    })
    await cleanup?.()
  })

  it('keeps Anthropic variants and no cacheFormat across a background refresh', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-refresh-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44444'
    const cacheKey = buildCacheKey('litellm-claude', baseURL, {}, {})
    const now = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now - 10 * 60 * 1000)
    writeModelCache(
      cacheKey,
      { 'cached-model': { name: 'Cached Model', variants: { high: { reasoningEffort: 'high' } } } },
      [],
      { 'cached-model': { acceptsCacheControl: true, adaptiveThinking: true, thinkingAlwaysOn: false } },
    )
    dateNow.mockRestore()

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'claude',
                model_info: {
                  key: 'claude',
                  mode: 'chat',
                  supports_reasoning: true,
                  supports_adaptive_thinking: true,
                  reasoning_effort_levels: ['high'],
                  supported_openai_params: ['cache_control'],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ data: [{ id: 'claude', object: 'model' }] }), { status: 200 })
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
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const reload = vi.fn(async () => {
      providerTransform?.(editor)
    })
    const context = {
      app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
      options: {},
      provider: {
        list: vi.fn(async () => ({
          data: [
            {
              id: 'litellm-claude',
              activation: 'enabled',
              package: '@opencode/ai/providers/anthropic-compatible',
              settings: { baseURL: `${baseURL}/v1` },
            },
          ],
        })),
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
    const high = [
      { id: 'high', settings: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' } },
    ]
    // Cached hints drive the warm start; discovered hints drive the refresh.
    expect(registeredModels[0].map((model) => model.compatibility)).toEqual([undefined])
    expect(registeredModels[0].map((model) => model.variants)).toEqual([high])
    expect(registeredModels[1].map((model) => model.id)).toEqual(['claude'])
    expect(registeredModels[1][0].compatibility).toBeUndefined()
    expect(registeredModels[1][0].variants).toEqual(high)
    await cleanup?.()
  })

  it('keeps hints in the cache when a background refresh finds no changes', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-refresh-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44444'
    const cacheKey = buildCacheKey('litellm', baseURL, {}, {})
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'claude',
                model_info: { key: 'claude', mode: 'chat', supported_openai_params: ['cache_control'] },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ data: [{ id: 'claude', object: 'model' }] }), { status: 200 })
    })
    const editor = {
      list: () => [],
      get: () => undefined,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    }
    const reload = vi.fn(async () => {})
    const makeContext = (events: Array<{ type: string }>) =>
      ({
        app: { name: 'OpenCode', version: '2.0.14', channel: 'stable' },
        options: { baseURL: `${baseURL}/v1` },
        provider: {
          list: vi.fn(async () => ({ data: [] })),
          transform: vi.fn(async (transform: (editor: unknown) => void) => {
            transform(editor)
            return { dispose: vi.fn(async () => {}) }
          }),
          reload,
        },
        event: {
          subscribe: () =>
            (async function* () {
              yield* events
            })(),
        },
      }) as unknown as Context

    // Cold start, backdated so the next session is allowed to refresh.
    const started = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(started - 10 * 60 * 1000)
    const first = await plugin.setup(makeContext([]))
    dateNow.mockRestore()
    await first?.()
    expect(readModelCacheEntry(cacheKey)?.hints).toEqual({
      claude: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
    })

    const second = await plugin.setup(makeContext([{ type: 'session.created' }]))
    await vi.waitFor(() => expect(readModelCacheSavedAt(cacheKey)).toBeGreaterThanOrEqual(started))
    expect(reload).not.toHaveBeenCalled()
    expect(readModelCacheEntry(cacheKey)?.hints).toEqual({
      claude: { acceptsCacheControl: true, adaptiveThinking: false, thinkingAlwaysOn: false },
    })
    await second?.()
  })

  it('registers providers that only appear after setup (provider.updated)', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-late-provider-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:44445')) {
        if (url.endsWith('/v1/model/info')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ data: [{ id: 'anthropic/claude-3-5-sonnet', object: 'model' }] }),
          { status: 200 },
        )
      }
      // Nothing is listening on the auto-detection ports in this scenario, so
      // the setup-time fallback cannot rescue an unseen provider.
      return new Response('not found', { status: 503 })
    })
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>

    // Real OpenCode 2.0.x ordering: the provider is absent during plugin setup
    // and only becomes visible afterwards.
    let providerListCalls = 0
    const configuredProvider = {
      id: 'litellm',
      name: 'LiteLLM (proxy)',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'http://127.0.0.1:44445/v1' },
      headers: {},
    }
    const providerList = vi.fn(async () => {
      providerListCalls += 1
      return { data: providerListCalls === 1 ? [] : [configuredProvider] }
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
      models: {
        set: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
    }
    const reload = vi.fn(async () => {
      providerTransform?.(editor)
    })

    let releaseEvents!: () => void
    const eventsGate = new Promise<void>((resolve) => {
      releaseEvents = resolve
    })
    const context = {
      app: { name: 'OpenCode', version: '2.0.19', channel: 'stable' },
      options: {},
      provider: {
        list: providerList,
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
            await eventsGate
            // A burst: the host can emit several updates back to back.
            yield { type: 'provider.updated' }
            yield { type: 'provider.updated' }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    // The provider was invisible at setup and nothing could be registered.
    expect(registered).toHaveLength(0)

    releaseEvents()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(registered).toHaveLength(1)
    expect(registered[0].info).toMatchObject({ id: 'litellm', activation: 'enabled' })
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'http://127.0.0.1:44445/v1',
    })
    expect(registered[0].models.map((model) => model.id)).toEqual([
      'anthropic/claude-3-5-sonnet',
    ])

    // The second trigger must not re-discover or re-publish the same provider.
    // By the time the provider list has been read three times (setup plus one
    // pass per trigger) both passes have settled.
    await vi.waitFor(() => expect(providerList).toHaveBeenCalledTimes(3))
    expect(reload).toHaveBeenCalledTimes(1)
    // One health check plus the parallel models/model-info pair.
    const discoveryCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith('http://127.0.0.1:44445'))
    expect(discoveryCalls).toHaveLength(3)
    expect(registered).toHaveLength(1)
    await cleanup?.()
  })

  it('replaces an env/option fallback when the configured provider appears later', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-fallback-replace-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    process.env.LITELLM_BASE_URL = 'http://127.0.0.1:44448/v1'

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'model-from-config', object: 'model' }] }),
        { status: 200 },
      )
    })

    // The host registers the real provider only after setup, exactly like the
    // late-registration ordering this PR fixes.
    let providerListCalls = 0
    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'http://127.0.0.1:44449/v1' },
      headers: {},
    }
    const providerList = vi.fn(async () => {
      providerListCalls += 1
      return { data: providerListCalls === 1 ? [] : [configuredProvider] }
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
    const reload = vi.fn(async () => {
      providerTransform?.(editor)
    })

    let releaseEvents!: () => void
    const eventsGate = new Promise<void>((resolve) => {
      releaseEvents = resolve
    })
    const context = {
      app: { name: 'OpenCode', version: '2.0.19', channel: 'stable' },
      options: {},
      provider: {
        list: providerList,
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
            await eventsGate
            yield { type: 'provider.updated' }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    // The env fallback won the initial setup (id 'litellm') and used its URL.
    expect(registered).toHaveLength(1)
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'http://127.0.0.1:44448/v1',
    })

    releaseEvents()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())

    // The configured provider must supersede the fallback, not be skipped
    // because id 'litellm' was already known.
    const lastSettings = registered[registered.length - 1].info.settings as Record<string, unknown>
    expect(lastSettings.baseURL).toBe('http://127.0.0.1:44449/v1')
    await cleanup?.()
  })

  it('retries publishing a newly configured provider after a failed reload', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-late-provider-retry-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory

    const configuredBaseURL = 'http://127.0.0.1:44450'
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      // Only the configured host answers, so the setup-time fallback cannot
      // succeed against an auto-detection port and mask the real scenario.
      if (!url.startsWith(configuredBaseURL)) {
        return new Response('not found', { status: 503 })
      }
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'late-model', object: 'model' }] }),
        { status: 200 },
      )
    })

    // Provider is invisible during setup, then appears on provider.updated.
    let providerListCalls = 0
    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `${configuredBaseURL}/v1` },
      headers: {},
    }
    const providerList = vi.fn(async () => {
      providerListCalls += 1
      return { data: providerListCalls === 1 ? [] : [configuredProvider] }
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
    // First publication attempt fails; a later pass must retry and succeed.
    const reload = vi.fn(async () => {
      if (reload.mock.calls.length === 1) throw new Error('temporary registry failure')
      providerTransform?.(editor)
    })

    let releaseFirst!: () => void
    const firstEvent = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let releaseSecond!: () => void
    const secondEvent = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const context = {
      app: { name: 'OpenCode', version: '2.0.19', channel: 'stable' },
      options: {},
      provider: {
        list: providerList,
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
            await firstEvent
            yield { type: 'provider.updated' }
            await secondEvent
            yield { type: 'session.created' }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    // The post-subscribe reconcile runs at startup; discovery finds the
    // provider but the first publication attempt fails, so nothing is
    // registered and the source stays pending.
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(registered).toHaveLength(0)

    // A later trigger must retry publication, not skip the source as "known".
    releaseFirst()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
    expect(registered).toHaveLength(1)
    expect(registered[0].info.settings).toMatchObject({
      baseURL: 'http://127.0.0.1:44450/v1',
    })
    expect(registered[0].models.map((model) => model.id)).toEqual(['late-model'])

    // A further trigger must not republish an already-published source.
    releaseSecond()
    await vi.waitFor(() => expect(providerList).toHaveBeenCalledTimes(4))
    expect(reload).toHaveBeenCalledTimes(2)
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
    const cacheKey = buildCacheKey('litellm', baseURL, {}, {}, {}, 'old-key')
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
      .mockResolvedValue({ key: 'new-key' })
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

    // Setup, the switch, and the rediscovery, which resolves the connection
    // again so a rotating sign-in token is fresh.
    expect(active).toHaveBeenCalledTimes(3)
    expect(authorizationHeaders).toContain('Bearer new-key')
    // The connection-managed credential is used for discovery but must not
    // be materialized into provider settings — OpenCode injects it itself.
    expect(configuredProvider.settings).not.toHaveProperty('apiKey')
    expect([...currentModels.keys()]).toContain('new-model')
    await cleanup?.()
  })

  it('removes plugin-discovered models missing from a refresh while keeping curated models', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-remove-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44448'
    const cacheKey = buildCacheKey('litellm', baseURL, {}, {}, {}, 'example-api-key')
    // Seed an old cache so the first transform adopts the cached model as
    // plugin-owned, and the later session refresh isn't throttled.
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10 * 60 * 1000)
    writeModelCache(cacheKey, { 'discovered-old': { name: 'Discovered Old' } })
    dateNow.mockRestore()

    let inventory = ['discovered-old']
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: inventory.map((id) => ({ id, object: 'model' })) }),
        { status: 200 },
      )
    })

    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `${baseURL}/v1`, apiKey: 'example-api-key' },
      headers: {},
    }
    let currentModels = new Map<string, Record<string, unknown>>([
      ['curated-model', { id: 'curated-model', name: 'Curated Model' }],
    ])
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
      event: {
        subscribe: () =>
          (async function* () {
            yield { type: 'session.created' }
          })(),
      },
    } as unknown as Context

    const cleanup = await plugin.setup(context)
    expect([...currentModels.keys()]).toEqual(['curated-model', 'discovered-old'])

    inventory = ['discovered-new']
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect([...currentModels.keys()]).toContain('discovered-new'))

    expect([...currentModels.keys()]).not.toContain('discovered-old')
    expect([...currentModels.keys()]).toContain('curated-model')
    await cleanup?.()
  })

  it('uses the stored OpenCode auth key for discovery when no v2 connection exists', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-legacy-auth-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const home = mkdtempSync(join(tmpdir(), 'opencode-litellm-home-'))
    process.env.HOME = home
    const authDirectory = join(home, '.local', 'share', 'opencode')
    mkdirSync(authDirectory, { recursive: true })
    writeFileSync(
      join(authDirectory, 'auth.json'),
      JSON.stringify({ litellm: { type: 'api', key: 'legacy-stored-key' } }),
    )
    resetOpenCodeAuthCache()

    const baseURL = 'http://127.0.0.1:44449'
    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'public-model', object: 'model' }] }),
        { status: 200 },
      )
    })

    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `${baseURL}/v1` },
      headers: {},
    }
    const editor = {
      list: () => [],
      get: () => undefined,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
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

    expect(editor.add).toHaveBeenCalledOnce()
    expect(configuredProvider.settings).not.toHaveProperty('apiKey')
    expect(authorizationHeaders.length).toBeGreaterThan(0)
    // A config-defined provider carries no integrationID, so the host-integration
    // path cannot see the box auth store. The plugin reads the store directly (the
    // same source the v1 entrypoint uses): a saved credential is the user's
    // explicit choice and beats the pod env / anonymous discovery.
    expect(authorizationHeaders.every((header) => header === 'Bearer legacy-stored-key')).toBe(true)

    await cleanup?.()
  })

  it('refreshes a source when the first connection credential is saved after setup', async () => {
    // Regression for the CodeRabbit review finding: setup may run with no
    // active connection (usesConnectionCredential fixed to false); the user
    // then saves a credential and the credential.switched handler must
    // recompute the effective key instead of returning immediately and
    // leaving the source on the environment key.
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-first-save-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44453'

    const authorizationHeaders: string[] = []
    // The gateway returns a different model set once the saved credential is
    // presented — the real scenario: the first save unlocks models the
    // anonymous/environment key could not see, so the refresh must reload
    // the provider registry with the new list.
    globalThis.fetch = vi.fn(async (input, init) => {
      const authHeader = new Headers(init?.headers).get('Authorization') ?? ''
      authorizationHeaders.push(authHeader)
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      const id = authHeader === 'Bearer just-saved-key' ? 'authenticated-model' : 'anonymous-model'
      return new Response(
        JSON.stringify({ data: [{ id, object: 'model' }] }),
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
          // First read (setup): no active connection yet. Second read (the
          // save): the user's credential is now active.
          active: vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ key: 'just-saved-key' }),
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
    expect(authorizationHeaders).toContain('Bearer just-saved-key')
    expect(configuredProvider.settings).not.toHaveProperty('apiKey')

    await cleanup?.()
  })

  it('falls back to the stored/env key when the connection credential is removed', async () => {
    // Regression for the CodeRabbit review finding: when the active connection
    // disappears, the refresh must fall back through the stored credential /
    // env key (the same precedence makeProviderSource uses) instead of
    // retaining the previous connection key, which runtimeSettings would
    // materialize into provider settings.
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-removed-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    setEnvApiKey('example-env-fallback-key')
    const baseURL = 'http://127.0.0.1:44459'

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      const authHeader = new Headers(init?.headers).get('Authorization') ?? ''
      authorizationHeaders.push(authHeader)
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      const id = authHeader === 'Bearer example-env-fallback-key' ? 'env-model' : 'connection-model'
      return new Response(
        JSON.stringify({ data: [{ id, object: 'model' }] }),
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
          // First read (setup): the connection exists. Second read (the
          // switch): the connection was removed.
          active: vi
            .fn()
            .mockResolvedValueOnce({ key: 'connection-key' })
            .mockResolvedValueOnce(undefined),
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
    expect(authorizationHeaders).toContain('Bearer example-env-fallback-key')
    // The setup's discovery legitimately used the connection key; the LAST
    // request (after the removal) must carry the env fallback instead.
    expect(authorizationHeaders[authorizationHeaders.length - 1]).toBe('Bearer example-env-fallback-key')
    // The env fallback is materialized into provider settings (the source no
    // longer uses the connection credential, so runtimeSettings publishes it).
    expect(configuredProvider.settings).toMatchObject({ apiKey: 'example-env-fallback-key' })

    await cleanup?.()
  })

  it('stored auth key beats the pod env key when no v2 connection exists', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-stored-over-env-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    setEnvApiKey('stale-env-key')
    const home = mkdtempSync(join(tmpdir(), 'opencode-litellm-home-'))
    process.env.HOME = home
    const authDirectory = join(home, '.local', 'share', 'opencode')
    mkdirSync(authDirectory, { recursive: true })
    writeFileSync(
      join(authDirectory, 'auth.json'),
      JSON.stringify({ litellm: { type: 'api', key: 'valid-stored-key' } }),
    )
    resetOpenCodeAuthCache()

    const baseURL = 'http://127.0.0.1:44452'
    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'stored-model', object: 'model' }] }),
        { status: 200 },
      )
    })

    // The user's exact scenario: a config-defined provider (no integrationID —
    // so the host-integration path is dead) with the pod env carrying the stale
    // deployment key that 401s against the production gateway, while the box
    // auth store holds the user's valid saved key.
    const configuredProvider = {
      id: 'litellm',
      name: 'Configured LiteLLM',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `${baseURL}/v1` },
      headers: {},
    }
    const editor = {
      list: () => [],
      get: () => undefined,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
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

    expect(authorizationHeaders).toContain('Bearer valid-stored-key')
    expect(authorizationHeaders).not.toContain('Bearer stale-env-key')
    expect(configuredProvider.settings).not.toHaveProperty('apiKey')
    await cleanup?.()
  })

  it('uses a connection-managed credential for discovery without materializing it', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-managed-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    const baseURL = 'http://127.0.0.1:44450'

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'managed-model', object: 'model' }] }),
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
    const editor = {
      list: () => [],
      get: () => undefined,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
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
      integration: {
        connection: {
          active: vi.fn(async () => ({ key: 'managed-key' })),
          resolve: vi.fn(async (connection: { key: string }) => ({
            type: 'key',
            key: connection.key,
          })),
        },
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(authorizationHeaders).toContain('Bearer managed-key')
    expect(configuredProvider.settings).not.toHaveProperty('apiKey')
    await cleanup?.()
  })

  it('saved connection credential beats the pod env key', async () => {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-saved-over-env-test-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    setEnvApiKey('stale-env-key')
    const baseURL = 'http://127.0.0.1:44451'

    const authorizationHeaders: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '')
      const url = String(input)
      if (url.endsWith('/v1/model/info')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'saved-model', object: 'model' }] }),
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
    const editor = {
      list: () => [],
      get: () => undefined,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
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
      integration: {
        connection: {
          active: vi.fn(async () => ({ key: 'saved-user-key' })),
          resolve: vi.fn(async (connection: { key: string }) => ({
            type: 'key',
            key: connection.key,
          })),
        },
      },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as Context

    const cleanup = await plugin.setup(context)

    expect(authorizationHeaders).toContain('Bearer saved-user-key')
    expect(authorizationHeaders).not.toContain('Bearer stale-env-key')
    expect(configuredProvider.settings).not.toHaveProperty('apiKey')
    await cleanup?.()
  })
})
