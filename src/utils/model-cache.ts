import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Bump when the shape of a cached model entry changes so stale caches
 * from older plugin versions are ignored rather than deserialized into
 * an incompatible structure.
 */
const CACHE_VERSION = 1

/** The on-disk shape of a per-baseURL model cache file. */
interface ModelCacheFile {
  version: number
  savedAt: number
  models: Record<string, unknown>
}

/**
 * Directory where SWR model caches live. Honours `XDG_CACHE_HOME`,
 * falling back to `~/.cache`, and finally the OS temp dir if the home
 * directory is somehow unavailable.
 */
function cacheDir(): string {
  const home = homedir()
  const base =
    process.env.XDG_CACHE_HOME || (home ? join(home, '.cache') : tmpdir())
  return join(base, 'opencode-litellm')
}

/** Stable, filesystem-safe filename derived from the normalized baseURL. */
function cacheFile(baseURL: string): string {
  const hash = createHash('sha256').update(baseURL).digest('hex').slice(0, 16)
  return join(cacheDir(), `models-${hash}.json`)
}

/**
 * Read cached model entries for a baseURL. Returns `null` on any
 * problem (missing file, parse error, version mismatch) — the caller
 * treats that as a cache miss and falls back to a live fetch.
 */
export function readModelCache(
  baseURL: string,
): Record<string, unknown> | null {
  try {
    const raw = readFileSync(cacheFile(baseURL), 'utf8')
    const parsed = JSON.parse(raw) as ModelCacheFile
    if (parsed.version !== CACHE_VERSION) return null
    if (!parsed.models || typeof parsed.models !== 'object') return null
    return parsed.models
  } catch {
    return null
  }
}

/**
 * Persist model entries for a baseURL. Best-effort: never throws, so a
 * read-only or full filesystem can't break discovery.
 */
export function writeModelCache(
  baseURL: string,
  models: Record<string, unknown>,
): void {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    const payload: ModelCacheFile = {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      models,
    }
    writeFileSync(cacheFile(baseURL), JSON.stringify(payload), 'utf8')
  } catch {
    // Ignore — the cache is an optimization, not a requirement.
  }
}
