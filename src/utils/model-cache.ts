import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Bump when the shape of a cached model entry changes so stale caches
 * from older plugin versions are ignored rather than deserialized into
 * an incompatible structure.
 */
const CACHE_VERSION = 2

/**
 * Maximum age of a cache entry before it's treated as a miss. Without a
 * bound, a proxy that goes away permanently would keep serving the same
 * stale model list on every launch. A background refresh normally keeps
 * entries fresh well within this window.
 */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

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

/**
 * Stable, filesystem-safe filename derived from the cache key. Callers
 * pass `providerId@baseURL` so two providers pointing at the same proxy
 * (possibly with different API keys) keep separate caches.
 */
function cacheFile(cacheKey: string): string {
  const hash = createHash('sha256').update(cacheKey).digest('hex').slice(0, 16)
  return join(cacheDir(), `models-${hash}.json`)
}

/**
 * Canonical JSON serialization (object keys sorted) so semantically
 * identical filter/capability configs fingerprint identically no matter
 * the key order in the user's `opencode.json`.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Cache identity for a provider's model view. `providerId@baseURL`
 * alone isn't enough: `includeModels`/`excludeModels`,
 * `modelCapabilities` and `formatModelNames` are baked into cached
 * entries by discovery, so a config change must not reuse the old cache
 * — it would keep serving the previous adjusted view until a second
 * restart. A fingerprint is appended whenever adjustments exist
 * (pattern order ignored); default configs keep the plain key so
 * existing caches stay warm across plugin upgrades.
 */
export function buildCacheKey(
  providerId: string,
  baseURL: string,
  filters: { includeModels?: string[]; excludeModels?: string[] },
  capabilities: Record<string, Record<string, boolean>>,
  naming: { formatModelNames?: boolean } = {},
): string {
  const base = `${providerId}@${baseURL}`
  const rawNames = naming.formatModelNames === false
  const hasAdjustments =
    (filters.includeModels?.length ?? 0) > 0 ||
    (filters.excludeModels?.length ?? 0) > 0 ||
    Object.keys(capabilities).length > 0 ||
    rawNames
  if (!hasAdjustments) return base
  const fingerprint = createHash('sha256')
    .update(
      canonicalize({
        includeModels: filters.includeModels ? [...filters.includeModels].sort() : undefined,
        excludeModels: filters.excludeModels ? [...filters.excludeModels].sort() : undefined,
        capabilities,
        // Omitted (not `true`) when formatting is on, so keys for
        // configs that never touch this option are unchanged.
        formatModelNames: rawNames ? false : undefined,
      }),
    )
    .digest('hex')
    .slice(0, 12)
  return `${base}@${fingerprint}`
}

/**
 * Read cached model entries for a cache key. Returns `null` on any
 * problem (missing file, parse error, version mismatch, or an entry
 * older than `CACHE_MAX_AGE_MS`) — the caller treats that as a cache
 * miss and falls back to a live fetch.
 */
export function readModelCache(
  cacheKey: string,
): Record<string, unknown> | null {
  try {
    const raw = readFileSync(cacheFile(cacheKey), 'utf8')
    const parsed = JSON.parse(raw) as ModelCacheFile
    if (parsed.version !== CACHE_VERSION) return null
    if (!parsed.models || typeof parsed.models !== 'object') return null
    if (
      typeof parsed.savedAt !== 'number' ||
      Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS
    ) {
      return null
    }
    return parsed.models
  } catch {
    return null
  }
}

/**
 * Return the `savedAt` timestamp (epoch ms) of a cache entry, or
 * `null` if there's no readable/valid cache. Used to throttle
 * background refreshes so still-fresh caches aren't re-fetched.
 */
export function readModelCacheSavedAt(cacheKey: string): number | null {
  try {
    const raw = readFileSync(cacheFile(cacheKey), 'utf8')
    const parsed = JSON.parse(raw) as ModelCacheFile
    if (parsed.version !== CACHE_VERSION) return null
    if (typeof parsed.savedAt !== 'number') return null
    return parsed.savedAt
  } catch {
    return null
  }
}

/**
 * Persist model entries for a cache key. Best-effort: never throws, so
 * a read-only or full filesystem can't break discovery.
 */
export function writeModelCache(
  cacheKey: string,
  models: Record<string, unknown>,
): void {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    const payload: ModelCacheFile = {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      models,
    }
    // Write to a temp file and rename so concurrent OpenCode processes
    // never observe a partially-written JSON file (rename is atomic on
    // the same filesystem).
    const target = cacheFile(cacheKey)
    const tmp = `${target}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, target)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Ignore cleanup failure.
      }
      throw err
    }
  } catch {
    // Ignore — the cache is an optimization, not a requirement.
  }
}
