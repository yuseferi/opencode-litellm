import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readModelCache, readModelCacheSavedAt, writeModelCache } from '../src/utils/model-cache'

const KEY = 'litellm@http://localhost:4000'

let cacheHome: string

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
  delete process.env.XDG_CACHE_HOME
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

  it('ignores cache files written by a different plugin version', () => {
    writeModelCache(KEY, { m: {} })
    rewriteCacheFile(KEY, (parsed) => {
      parsed.version = 999
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
