import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin from '../src'
import type { Context } from '@opencode/plugin/promise/plugin'
import { __resetOpenCodeAuthCacheForTests } from '../src/utils/opencode-auth'

const BASE_URL = 'http://127.0.0.1:44470'

type Published = { info: Record<string, any>; models: Array<Record<string, any>> }

/** `/v1/models` answers with these ids; `/v1/model/info` has nothing to add. */
type Seen = { url: string; authorization?: string; headers: Record<string, string> }

function gatewayServing(ids: string[], seen: Seen[] = []) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    seen.push({
      url,
      authorization: headers.get('authorization') ?? undefined,
      headers: Object.fromEntries(headers.entries()),
    })
    if (!url.startsWith(BASE_URL)) return new Response('not found', { status: 503 })
    if (url.endsWith('/v1/model/info')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }
    return new Response(
      JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }),
      { status: 200 },
    )
  }
}

/**
 * A host whose provider registry reflects what the plugin publishes, the way a
 * real OpenCode 2 host does: `provider.list()` returns the published providers
 * (plus any the host declares itself), and `reload()` re-runs the transform.
 */
function createHost(options: Record<string, unknown>, hostDeclared: () => Array<Record<string, any>> = () => []) {
  const registry = new Map<string, Published>()
  const queue: Array<{ type: string }> = []
  let wake: (() => void) | undefined
  let transform: ((editor: unknown) => void) | undefined
  /** What the registry held right after the first transform, i.e. what a one-shot command sees. */
  let firstPublication: Map<string, Published> | undefined

  const editor = {
    list: () => [],
    get: (id: string) => {
      const entry = registry.get(id)
      return entry
        ? { provider: entry.info, models: new Map(entry.models.map((model) => [model.id, model])) }
        : undefined
    },
    add: (entry: Published) => {
      registry.set(String(entry.info.id), { info: { ...entry.info }, models: [...entry.models] })
    },
    update: (id: string, change: (provider: Record<string, any>) => void) => {
      const entry = registry.get(id)
      if (entry) change(entry.info)
    },
    remove: (id: string) => {
      registry.delete(id)
    },
    models: {
      set: (id: string, models: Array<Record<string, any>>) => {
        const entry = registry.get(id)
        if (entry) entry.models = [...models]
      },
      update: vi.fn(),
      remove: vi.fn(),
    },
  }

  const list = vi.fn(async () => {
    const declared = hostDeclared()
    const declaredIds = new Set(declared.map((provider) => provider.id))
    const published = [...registry.values()]
      .map((entry) => entry.info)
      .filter((info) => !declaredIds.has(info.id))
    return { data: [...published, ...declared] }
  })
  const reload = vi.fn(async () => {
    transform?.(editor)
  })

  const context = {
    app: { name: 'OpenCode', version: '2.1.0', channel: 'stable' },
    options,
    provider: {
      list,
      transform: vi.fn(async (callback: (editor: unknown) => void) => {
        transform = callback
        callback(editor)
        firstPublication = new Map(
          [...registry].map(([id, entry]) => [
            id,
            { info: { ...entry.info, settings: { ...entry.info.settings } }, models: [...entry.models] },
          ]),
        )
        return { dispose: vi.fn(async () => {}) }
      }),
      reload,
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) =>
        (async function* () {
          while (!signal?.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve
                signal?.addEventListener('abort', () => resolve(), { once: true })
              })
            }
            while (queue.length > 0) yield queue.shift()!
          }
        })(),
    },
  } as unknown as Context

  return {
    context,
    list,
    reload,
    registry,
    get firstPublication() {
      return firstPublication
    },
    emit(type: string) {
      queue.push({ type })
      wake?.()
    },
    models(id: string): string[] {
      return (registry.get(id)?.models ?? []).map((model) => String(model.id)).sort()
    },
  }
}

/** Lets the startup reconciliation (one idempotent pass after subscribing) finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

describe('OpenCode 2 plugin options: providers declared like the config does', () => {
  const originalFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  let cacheDirectory: string
  let homeDirectory: string

  beforeEach(() => {
    for (const name of ['XDG_CACHE_HOME', 'HOME', 'LITELLM_BASE_URL', 'LITELLM_API_KEY', 'LITELLM_MASTER_KEY']) {
      saved[name] = process.env[name]
    }
    delete process.env.LITELLM_BASE_URL
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_MASTER_KEY
    cacheDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-declared-cache-'))
    homeDirectory = mkdtempSync(join(tmpdir(), 'opencode-litellm-declared-home-'))
    process.env.XDG_CACHE_HOME = cacheDirectory
    process.env.HOME = homeDirectory
    __resetOpenCodeAuthCacheForTests()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(cacheDirectory, { recursive: true, force: true })
    rmSync(homeDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const catalog = ['serpro/alpha', 'serpro/beta', 'serpro-x/gamma']
  const split = {
    providers: {
      litellm: {
        name: 'Serpro',
        settings: { baseURL: `${BASE_URL}/v1`, apiKey: 'example-key', excludeModels: ['serpro-x/*'] },
      },
      'litellm-exp': {
        name: 'Serpro X',
        settings: { baseURL: `${BASE_URL}/v1`, apiKey: 'example-key', includeModels: ['serpro-x/*'] },
      },
    },
  }

  it('publishes one provider per declared id on the first publication, with its label and slice', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const host = createHost(split)

    const cleanup = await plugin.setup(host.context)

    const first = host.firstPublication
    expect([...(first?.keys() ?? [])].sort()).toEqual(['litellm', 'litellm-exp'])
    expect(first?.get('litellm')?.info.name).toBe('Serpro')
    expect(first?.get('litellm-exp')?.info.name).toBe('Serpro X')
    expect(first?.get('litellm')?.models.map((m) => m.id).sort()).toEqual(['serpro/alpha', 'serpro/beta'])
    expect(first?.get('litellm-exp')?.models.map((m) => m.id)).toEqual(['serpro-x/gamma'])
    for (const id of ['litellm', 'litellm-exp']) {
      const settings = first?.get(id)?.info.settings ?? {}
      expect(settings).not.toHaveProperty('includeModels')
      expect(settings).not.toHaveProperty('excludeModels')
      expect(settings.baseURL).toBe(`${BASE_URL}/v1`)
    }
    expect(first?.get('litellm')?.info.activation).toBe('enabled')
    await cleanup?.()
  })

  it('works with ids that do not look like LiteLLM ones', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const host = createHost({
      providers: {
        serpro: { name: 'Serpro', settings: { baseURL: `${BASE_URL}/v1`, excludeModels: ['serpro-x/*'] } },
        'serpro-x': { name: 'Serpro X', settings: { baseURL: `${BASE_URL}/v1`, includeModels: ['serpro-x/*'] } },
      },
    })

    const cleanup = await plugin.setup(host.context)
    host.emit('provider.updated')
    await vi.waitFor(() => expect(host.list.mock.calls.length).toBeGreaterThanOrEqual(3))
    await settle()

    expect(host.firstPublication?.get('serpro')?.models.map((m) => m.id).sort()).toEqual(['serpro/alpha', 'serpro/beta'])
    expect(host.models('serpro')).toEqual(['serpro/alpha', 'serpro/beta'])
    expect(host.models('serpro-x')).toEqual(['serpro-x/gamma'])
    expect(host.registry.get('serpro-x')?.info.name).toBe('Serpro X')
    await cleanup?.()
  })

  it('keeps each slice and label after the host reflects the published providers back', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const host = createHost(split)

    const cleanup = await plugin.setup(host.context)
    host.emit('provider.updated')
    host.emit('provider.updated')
    await vi.waitFor(() => expect(host.list.mock.calls.length).toBeGreaterThanOrEqual(3))
    await settle()

    expect(host.models('litellm')).toEqual(['serpro/alpha', 'serpro/beta'])
    expect(host.models('litellm-exp')).toEqual(['serpro-x/gamma'])
    expect(host.registry.get('litellm')?.info.name).toBe('Serpro')
    expect(host.registry.get('litellm-exp')?.info.name).toBe('Serpro X')
    await cleanup?.()
  })

  it('lets every provider use its own gateway, key and headers', async () => {
    const gatewayA = 'http://127.0.0.1:44474'
    const gatewayB = 'http://127.0.0.1:44475'
    const seen: Seen[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      seen.push({ url, authorization: headers.get('authorization') ?? undefined, headers: Object.fromEntries(headers.entries()) })
      if (url.endsWith('/v1/model/info')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const ids = url.startsWith(gatewayA) ? ['a/one', 'a/two'] : ['b/one']
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }), { status: 200 })
    })
    const host = createHost({
      providers: {
        'litellm-a': { name: 'Gateway A', settings: { baseURL: `${gatewayA}/v1`, apiKey: 'example-key-a' } },
        'litellm-b': {
          name: 'Gateway B',
          settings: { baseURL: `${gatewayB}/v1`, apiKey: 'example-key-b', customHeaders: { 'x-team': 'example-team-b' } },
        },
      },
    })

    const cleanup = await plugin.setup(host.context)
    host.emit('provider.updated')
    await vi.waitFor(() => expect(host.list.mock.calls.length).toBeGreaterThanOrEqual(3))
    await settle()

    expect(host.models('litellm-a')).toEqual(['a/one', 'a/two'])
    expect(host.models('litellm-b')).toEqual(['b/one'])
    expect(host.registry.get('litellm-a')?.info.settings).toMatchObject({ baseURL: `${gatewayA}/v1`, apiKey: 'example-key-a' })
    expect(host.registry.get('litellm-b')?.info.settings).toMatchObject({ baseURL: `${gatewayB}/v1`, apiKey: 'example-key-b' })
    const toA = seen.filter((c) => c.url.startsWith(gatewayA))
    const toB = seen.filter((c) => c.url.startsWith(gatewayB))
    expect(toA.length).toBeGreaterThan(0)
    expect(toB.length).toBeGreaterThan(0)
    expect(toA.every((c) => c.authorization === 'Bearer example-key-a')).toBe(true)
    expect(toB.every((c) => c.authorization === 'Bearer example-key-b')).toBe(true)
    expect(toA.some((c) => 'x-team' in c.headers)).toBe(false)
    expect(toB.every((c) => c.headers['x-team'] === 'example-team-b')).toBe(true)
    await cleanup?.()
  })

  it('never lends one provider the key or address of another, or of the top-level options', async () => {
    const gatewayA = 'http://127.0.0.1:44476'
    const gatewayB = 'http://127.0.0.1:44477'
    const seen: Seen[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') ?? undefined, headers: {} })
      if (url.endsWith('/v1/model/info')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: url.startsWith(gatewayA) ? 'a/one' : 'b/one', object: 'model' }] }), { status: 200 })
    })
    const host = createHost({
      // Top-level options belong to the plugin's own single-provider fallback, not to declared providers.
      baseURL: 'http://127.0.0.1:44478/v1',
      apiKey: 'example-top-level-key',
      providers: {
        'litellm-a': { settings: { baseURL: `${gatewayA}/v1`, apiKey: 'example-key-a' } },
        'litellm-b': { settings: { baseURL: `${gatewayB}/v1` } },
      },
    })

    const cleanup = await plugin.setup(host.context)

    // B declares no key: it gets none, neither A's nor the top-level one.
    const toB = seen.filter((c) => c.url.startsWith(gatewayB))
    expect(toB.length).toBeGreaterThan(0)
    expect(toB.every((c) => c.authorization === undefined)).toBe(true)
    expect(host.registry.get('litellm-b')?.info.settings).not.toHaveProperty('apiKey')
    // The top-level gateway is not asked for anything on behalf of a declared provider.
    expect(seen.some((c) => c.url.startsWith('http://127.0.0.1:44478') && c.authorization === 'Bearer example-key-a')).toBe(false)
    await cleanup?.()
  })

  it('starts every provider discovery before any of them finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const otherGateway = 'http://127.0.0.1:44472'
    const fetchMock = vi.fn(async (input: unknown) => {
      await gate
      const url = String(input)
      if (url.endsWith('/v1/model/info')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const ids = url.startsWith(otherGateway) ? ['other/delta'] : catalog
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }), { status: 200 })
    })
    globalThis.fetch = fetchMock
    const host = createHost({
      providers: {
        litellm: { settings: { baseURL: `${BASE_URL}/v1` } },
        'litellm-other': { settings: { baseURL: `${otherGateway}/v1` } },
      },
    })

    const done = plugin.setup(host.context)

    await vi.waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]))
      expect(urls.some((url) => url.startsWith(BASE_URL))).toBe(true)
      expect(urls.some((url) => url.startsWith(otherGateway))).toBe(true)
    })
    release()
    const cleanup = await done
    expect([...host.registry.keys()].sort()).toEqual(['litellm', 'litellm-other'])
    await cleanup?.()
  })

  it('honours a per-provider package and defaults to the openai-compatible runtime', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const host = createHost({
      providers: {
        litellm: { settings: { baseURL: `${BASE_URL}/v1` } },
        'litellm-claude': {
          package: '@opencode/ai/providers/anthropic-compatible',
          settings: { baseURL: `${BASE_URL}/v1`, includeModels: ['serpro-x/*'] },
        },
      },
    })

    const cleanup = await plugin.setup(host.context)

    expect(host.firstPublication?.get('litellm')?.info.package).toBe('@opencode/ai/providers/openai-compatible')
    expect(host.firstPublication?.get('litellm-claude')?.info.package).toBe('@opencode/ai/providers/anthropic-compatible')
    await cleanup?.()
  })

  it('uses the id as the label when a provider declares no name', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const host = createHost({ providers: { 'litellm-plain': { settings: { baseURL: `${BASE_URL}/v1` } } } })

    const cleanup = await plugin.setup(host.context)

    expect(host.registry.get('litellm-plain')?.info.name).toBe('litellm-plain')
    await cleanup?.()
  })

  it('ignores entries that are not objects and does not throw when a gateway is unreachable', async () => {
    const brokenGateway = 'http://127.0.0.1:44473'
    const answer = gatewayServing(catalog)
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith(brokenGateway)) throw new TypeError('fetch failed')
      return answer(input, init)
    })
    const host = createHost({
      providers: {
        'litellm-null': null,
        'litellm-number': 42,
        'litellm-list': ['x'],
        'litellm-broken': { settings: { baseURL: `${brokenGateway}/v1` } },
        litellm: { name: 'Serpro', settings: { baseURL: `${BASE_URL}/v1` } },
      },
    })

    const cleanup = await plugin.setup(host.context)

    expect(host.models('litellm')).toEqual(['serpro-x/gamma', 'serpro/alpha', 'serpro/beta'])
    expect(host.registry.has('litellm-null')).toBe(false)
    expect(host.registry.has('litellm-number')).toBe(false)
    expect(host.registry.has('litellm-list')).toBe(false)
    await cleanup?.()
  })

  it('does not throw when no declared provider resolves to a gateway', async () => {
    globalThis.fetch = vi.fn(async () => new Response('unavailable', { status: 503 }))
    const host = createHost({ providers: { litellm: {}, 'litellm-exp': {} } })

    const cleanup = await plugin.setup(host.context)

    expect(host.registry.size).toBe(0)
    await cleanup?.()
  })

  it('lets the declared provider win when the host declares the same id', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/v1/model/info')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const ids = url.startsWith('http://127.0.0.1:44471') ? ['from-host-config'] : catalog
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }), { status: 200 })
    })
    const declaredByHost = {
      id: 'litellm',
      name: 'From host config',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'http://127.0.0.1:44471/v1' },
      headers: {},
    }
    const host: ReturnType<typeof createHost> = createHost(
      { providers: { litellm: { name: 'From options', settings: { baseURL: `${BASE_URL}/v1` } } } },
      () => (host.list.mock.calls.length >= 2 ? [declaredByHost] : []),
    )

    const cleanup = await plugin.setup(host.context)
    host.emit('provider.updated')
    await settle()

    // Declaring one id in both places is a conflict; the plugin options win, deterministically.
    expect(host.registry.get('litellm')?.info.name).toBe('From options')
    expect(host.registry.get('litellm')?.info.settings.baseURL).toBe(`${BASE_URL}/v1`)
    expect(host.models('litellm')).toEqual(['serpro-x/gamma', 'serpro/alpha', 'serpro/beta'])
    await cleanup?.()
  })

  it('lets the declared provider win when the host already shows the same id during setup', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const declaredByHost = {
      id: 'litellm',
      name: 'From host config',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'http://127.0.0.1:44471/v1' },
      headers: {},
    }
    const host = createHost(
      { providers: { litellm: { name: 'From options', settings: { baseURL: `${BASE_URL}/v1` } } } },
      () => [declaredByHost],
    )

    const cleanup = await plugin.setup(host.context)
    await settle()

    expect(host.firstPublication?.get('litellm')?.info.name).toBe('From options')
    expect(host.registry.get('litellm')?.info.name).toBe('From options')
    expect(host.registry.get('litellm')?.info.settings.baseURL).toBe(`${BASE_URL}/v1`)
    await cleanup?.()
  })

  it('sends a provider level header with that provider discovery only', async () => {
    const gatewayB = 'http://127.0.0.1:44479'
    const seen: Seen[] = []
    const answer = gatewayServing(catalog, seen)
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith(gatewayB)) {
        seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }
      return answer(input, init)
    })
    const host = createHost({
      providers: {
        litellm: { settings: { baseURL: `${BASE_URL}/v1` }, headers: { 'x-edge': 'example-edge-token' } },
        'litellm-b': { settings: { baseURL: `${gatewayB}/v1` } },
      },
    })

    const cleanup = await plugin.setup(host.context)

    const toA = seen.filter((c) => c.url.startsWith(BASE_URL))
    const toB = seen.filter((c) => c.url.startsWith(gatewayB))
    expect(toA.length).toBeGreaterThan(0)
    expect(toA.every((c) => c.headers['x-edge'] === 'example-edge-token')).toBe(true)
    expect(toB.every((c) => !('x-edge' in c.headers))).toBe(true)
    await cleanup?.()
  })

  it('keeps handing on a providers value that declares nothing, as before', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const host = createHost({ baseURL: `${BASE_URL}/v1`, apiKey: 'example-key', providers: 'not-a-declaration' })

    const cleanup = await plugin.setup(host.context)

    expect(host.registry.get('litellm')?.info.settings.providers).toBe('not-a-declaration')
    await cleanup?.()
  })

  it('keeps the plugin options form for a single provider exactly as before', async () => {
    globalThis.fetch = vi.fn(gatewayServing(catalog))
    const host = createHost({ baseURL: `${BASE_URL}/v1`, apiKey: 'example-key', excludeModels: ['serpro-x/*'] })

    const cleanup = await plugin.setup(host.context)

    expect(host.models('litellm')).toEqual(['serpro/alpha', 'serpro/beta'])
    expect(host.registry.get('litellm')?.info.name).toBe('LiteLLM (proxy)')
    await cleanup?.()
  })
})
