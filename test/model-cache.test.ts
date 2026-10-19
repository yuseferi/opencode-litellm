import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readModelCache, readModelCacheEntry, readModelCacheResponsesIds, readModelCacheSavedAt, writeModelCache, buildCacheKey } from '../src/utils/model-cache'

const KEY = 'litellm@http://localhost:4000'

let cacheHome: string
const originalCacheHome = process.env.XDG_CACHE_HOME

function cachePathFor(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(cacheHome, 'opencode-litellm', `models-${hash}.json`)
}

function rewriteCacheFile(key: string, mutate: (parsed: Record<string, unknown>) => void) {
  const parsed = JSON.parse(readFileSync(cachePathFor(key), 'utf8'))
  mutate(parsed)
  writeFileSync(cachePathFor(key), JSON.stringify(parsed), 'utf8')
}

beforeAll(() => {
  cacheHome = mkdtempSync(join(tmpdir(), 'opencode-litellm-test-'))
  process.env.XDG_CACHE_HOME = cacheHome
})

afterAll(() => {
  rmSync(cacheHome, { recursive: true, force: true })
  if (originalCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalCacheHome
  }
})

describe('model cache', () => {
  it('returns null when nothing was written', () => {
    expect(readModelCache('missing@http://nowhere')).toBeNull()
    expect(readModelCacheSavedAt('missing@http://nowhere')).toBeNull()
  })

  it('round-trips written models', () => {
    const models = { 'openai/gpt-4o': { name: 'GPT 4o' } }
    writeModelCache(KEY, models)
    expect(readModelCache(KEY)).toEqual(models)
    const savedAt = readModelCacheSavedAt(KEY)
    expect(savedAt).not.toBeNull()
    expect(Date.now() - (savedAt as number)).toBeLessThan(5000)
  })

  it('keeps caches for different keys separate', () => {
    writeModelCache('a@http://x', { a: {} })
    writeModelCache('b@http://x', { b: {} })
    expect(Object.keys(readModelCache('a@http://x') ?? {})).toEqual(['a'])
    expect(Object.keys(readModelCache('b@http://x') ?? {})).toEqual(['b'])
  })

  it('round-trips the Responses-API model ids alongside the models', () => {
    writeModelCache('r@http://x', { chat: {}, responses: {} }, ['responses'])
    expect(readModelCache('r@http://x')).toEqual({ chat: {}, responses: {} })
    expect(readModelCacheResponsesIds('r@http://x')).toEqual(['responses'])
  })

  it('reads an empty Responses id list from a missing or id-less cache', () => {
    expect(readModelCacheResponsesIds('missing@http://nowhere')).toEqual([])
    writeModelCache('no-ids@http://x', { m: {} })
    expect(readModelCacheResponsesIds('no-ids@http://x')).toEqual([])
  })

  it('reads models and Responses ids together in one entry', () => {
    expect(readModelCacheEntry('missing@http://nowhere')).toBeNull()
    writeModelCache('entry@http://x', { chat: {}, responses: {} }, ['responses'])
    expect(readModelCacheEntry('entry@http://x')).toEqual({
      models: { chat: {}, responses: {} },
      responsesIds: ['responses'],
      hints: {},
    })
  })

  it('round-trips model hints and drops malformed ones', () => {
    const a = { acceptsCacheControl: true, adaptiveThinking: true, thinkingAlwaysOn: false }
    const b = { acceptsCacheControl: false, adaptiveThinking: false, thinkingAlwaysOn: true }
    writeModelCache('hints@http://x', { a: {}, b: {} }, [], { a, b })
    expect(readModelCacheEntry('hints@http://x')?.hints).toEqual({ a, b })
    rewriteCacheFile('hints@http://x', (parsed) => {
      parsed.hints = { a: { acceptsCacheControl: 'yes', adaptiveThinking: 1 }, b: null, c: [] }
    })
    expect(readModelCacheEntry('hints@http://x')?.hints).toEqual({
      a: { acceptsCacheControl: false, adaptiveThinking: false, thinkingAlwaysOn: false },
    })
  })

  it('treats caches that predate the thinking hints as a miss', () => {
    writeModelCache(KEY, { m: {} }, ['m'])
    rewriteCacheFile(KEY, (parsed) => {
      parsed.version = 4
      parsed.hints = { m: { acceptsCacheControl: true } }
    })
    expect(readModelCacheEntry(KEY)).toBeNull()
    expect(readModelCache(KEY)).toBeNull()
  })

  it('ignores cache files written by a different plugin version', () => {
    writeModelCache(KEY, { m: {} })
    rewriteCacheFile(KEY, (parsed) => {
      // v1 entries lack the explicit text-only modality metadata and must
      // not make OpenCode fall back to image-capable defaults after upgrade.
      parsed.version = 1
    })
    expect(readModelCache(KEY)).toBeNull()
    writeModelCache(KEY, { m: {} })
  })

  it('treats entries older than the max age as a miss', () => {
    writeModelCache(KEY, { m: {} })
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    rewriteCacheFile(KEY, (parsed) => {
      parsed.savedAt = eightDaysAgo
    })
    expect(readModelCache(KEY)).toBeNull()
    // The throttle helper still reports the raw timestamp.
    expect(readModelCacheSavedAt(KEY)).toBe(eightDaysAgo)
    writeModelCache(KEY, { m: {} })
  })

  it('never leaves temp files behind', () => {
    const dir = join(cacheHome, 'opencode-litellm')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('buildCacheKey', () => {
  it('keeps the plain providerId@baseURL key when no adjustments are configured', () => {
    expect(buildCacheKey('litellm', 'http://localhost:4000', {}, {})).toBe(KEY)
    expect(
      buildCacheKey(
        'litellm',
        'http://localhost:4000',
        { includeModels: undefined, excludeModels: undefined },
        {},
      ),
    ).toBe(KEY)
  })

  it('isolates the key by credential fingerprint', () => {
    // Regression for the CodeRabbit review finding: a model list cached with
    // one credential must never be served to another — keys expose different
    // model sets, so a credential change starts a fresh discovery.
    const without = buildCacheKey('litellm', 'http://localhost:4000', {}, {})
    const keyA = buildCacheKey('litellm', 'http://localhost:4000', {}, {}, {}, 'sk-key-a')
    const keyA2 = buildCacheKey('litellm', 'http://localhost:4000', {}, {}, {}, 'sk-key-a')
    const keyB = buildCacheKey('litellm', 'http://localhost:4000', {}, {}, {}, 'sk-key-b')
    expect(keyA).toBe(keyA2)
    expect(keyA).not.toBe(keyB)
    expect(keyA).not.toBe(without)
    // The fingerprint never carries the raw key.
    expect(keyA).not.toContain('sk-key-a')
  })

  it('changes the key when capability overrides are added or changed', () => {
    // Regression for the CodeRabbit review finding: a model previously
    // cached with `supports_vision: false` must not be served again
    // after the user flips the override to true.
    const base = 'litellm@http://localhost:4000'
    const withoutOverrides = buildCacheKey('litellm', 'http://localhost:4000', {}, {})
    const visionOff = buildCacheKey(
      'litellm',
      'http://localhost:4000',
      {},
      { 'openai/gpt-4o': { supports_vision: false } },
    )
    const visionOn = buildCacheKey(
      'litellm',
      'http://localhost:4000',
      {},
      { 'openai/gpt-4o': { supports_vision: true } },
    )
    expect(visionOff).not.toBe(withoutOverrides)
    expect(visionOff).not.toBe(visionOn)
    expect(visionOn.startsWith(base)).toBe(true)
  })

  it('keeps the plain key when formatModelNames is left at its default (true)', () => {
    expect(
      buildCacheKey('litellm', 'http://localhost:4000', {}, {}, { formatModelNames: true }),
    ).toBe(KEY)
    expect(buildCacheKey('litellm', 'http://localhost:4000', {}, {}, {})).toBe(KEY)
  })

  it('changes the key when formatModelNames is turned off', () => {
    // Display names are baked into cached entries, so flipping the
    // option must not serve the previously formatted (or raw) names.
    const plain = buildCacheKey('litellm', 'http://localhost:4000', {}, {})
    const raw = buildCacheKey('litellm', 'http://localhost:4000', {}, {}, { formatModelNames: false })
    expect(raw).not.toBe(plain)
    expect(raw.startsWith(KEY)).toBe(true)
    // ...and is orthogonal to the other adjustments.
    const rawWithFilters = buildCacheKey(
      'litellm',
      'http://localhost:4000',
      { includeModels: ['prod/*'] },
      {},
      { formatModelNames: false },
    )
    const formattedWithFilters = buildCacheKey(
      'litellm',
      'http://localhost:4000',
      { includeModels: ['prod/*'] },
      {},
    )
    expect(rawWithFilters).not.toBe(formattedWithFilters)
  })

  it('changes the key when includeModels/excludeModels are added', () => {
    const plain = buildCacheKey('litellm', 'http://localhost:4000', {}, {})
    const withFilters = buildCacheKey(
      'litellm',
      'http://localhost:4000',
      { includeModels: ['prod/*'] },
      {},
    )
    const withMore = buildCacheKey(
      'litellm',
      'http://localhost:4000',
      { includeModels: ['prod/*', 'team/*'] },
      {},
    )
    expect(withFilters).not.toBe(plain)
    expect(withFilters).not.toBe(withMore)
  })

  it('is stable regardless of config key order', () => {
    expect(
      buildCacheKey(
        'litellm',
        'http://localhost:4000',
        {},
        {
          'openai/gpt-4o': { supports_vision: true, supports_reasoning: false },
          'claude-sonnet': { supports_pdf_input: true },
        },
      ),
    ).toBe(
      buildCacheKey(
        'litellm',
        'http://localhost:4000',
        {},
        {
          'claude-sonnet': { supports_pdf_input: true },
          'openai/gpt-4o': { supports_reasoning: false, supports_vision: true },
        },
      ),
    )
  })

  it('treats reordered glob patterns as the same config', () => {
    expect(
      buildCacheKey('litellm', 'http://localhost:4000', { includeModels: ['prod/*', 'team/*'] }, {}),
    ).toBe(
      buildCacheKey('litellm', 'http://localhost:4000', { includeModels: ['team/*', 'prod/*'] }, {}),
    )
  })
})
