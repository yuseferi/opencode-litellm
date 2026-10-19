import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Facts about a discovered model's upstream that OpenCode 2 turns into
 * `Model.Info.compatibility` and `variants`. They ride alongside the
 * config-shaped model entries (which have no field for them) through
 * discovery and the cache.
 */
export interface ModelHints {
  /**
   * The deployment accepts Anthropic-style `cache_control` markers on
   * Chat Completions (`supported_openai_params` lists `cache_control`).
   */
  acceptsCacheControl: boolean
  /**
   * The model takes `thinking: { type: "adaptive" }` plus an `effort` level
   * (`supports_adaptive_thinking`).
   */
  adaptiveThinking: boolean
  /** Thinking cannot be turned off (`thinking_always_on`). */
  thinkingAlwaysOn: boolean
}

/**
 * Bump when the shape of a cached model entry changes so stale caches
 * from older plugin versions are ignored rather than deserialized into
 * an incompatible structure.
 */
const CACHE_VERSION = 5

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
  /**
   * Model ids that must be invoked through the OpenAI Responses API. Kept
   * alongside `models` because the provider-config entries themselves carry
   * no transport marker (their shape is the user-facing OpenCode config).
   */
  responsesIds?: string[]
  /**
   * Per-model facts about the upstream that OpenCode 2 needs but that have
   * no place in a provider-config entry (see `ModelHints`).
   */
  hints?: Record<string, ModelHints>
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
  credential?: string,
): string {
  let base = `${providerId}@${baseURL}`
  // The credential fingerprint: a short hash (never the raw key) so a
  // credential change isolates the cached model list — a key that exposes a
  // different set of models must start a fresh discovery instead of serving
  // another credential's entries.
  if (credential) {
    base += `@${createHash('sha256').update(credential).digest('hex').slice(0, 12)}`
  }
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
 * Read and validate a cache file once. Returns `null` on any problem
 * (missing file, parse error, version mismatch, or a missing `models`
 * block). Every reader below shares this so a caller that needs both the
 * models and the Responses ids parses the file a single time.
 */
function readCacheFile(cacheKey: string): ModelCacheFile | null {
  try {
    const raw = readFileSync(cacheFile(cacheKey), 'utf8')
    const parsed = JSON.parse(raw) as ModelCacheFile
    if (parsed.version !== CACHE_VERSION) return null
    if (!parsed.models || typeof parsed.models !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** Keep only the string entries of a cached `responsesIds` list. */
function normalizeResponsesIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string')
}

/** Keep only well-formed entries of a cached `hints` map. */
function normalizeHints(value: unknown): Record<string, ModelHints> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, ModelHints> = {}
  for (const [id, hint] of Object.entries(value as Record<string, unknown>)) {
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)) continue
    const { acceptsCacheControl, adaptiveThinking, thinkingAlwaysOn } = hint as Record<string, unknown>
    out[id] = {
      acceptsCacheControl: acceptsCacheControl === true,
      adaptiveThinking: adaptiveThinking === true,
      thinkingAlwaysOn: thinkingAlwaysOn === true,
    }
  }
  return out
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
  const parsed = readCacheFile(cacheKey)
  if (!parsed) return null
  if (
    typeof parsed.savedAt !== 'number' ||
    Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS
  ) {
    return null
  }
  return parsed.models
}

/**
 * Read the models, Responses-API model ids and model hints for a cache key
 * in one parse. Returns `null` under the same conditions as
 * {@link readModelCache} (missing/expired cache), so the three can't
 * disagree within a single lookup.
 */
export function readModelCacheEntry(
  cacheKey: string,
): {
  models: Record<string, unknown>
  responsesIds: string[]
  hints: Record<string, ModelHints>
} | null {
  const parsed = readCacheFile(cacheKey)
  if (!parsed) return null
  if (
    typeof parsed.savedAt !== 'number' ||
    Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS
  ) {
    return null
  }
  return {
    models: parsed.models,
    responsesIds: normalizeResponsesIds(parsed.responsesIds),
    hints: normalizeHints(parsed.hints),
  }
}

/**
 * Return the `savedAt` timestamp (epoch ms) of a cache entry, or
 * `null` if there's no readable/valid cache. Used to throttle
 * background refreshes so still-fresh caches aren't re-fetched.
 */
export function readModelCacheSavedAt(cacheKey: string): number | null {
  const parsed = readCacheFile(cacheKey)
  if (!parsed || typeof parsed.savedAt !== 'number') return null
  return parsed.savedAt
}

/**
 * Return the cached Responses-API model ids for a cache key. Returns an
 * empty array on any problem (missing file, parse error, version
 * mismatch), matching {@link readModelCache}'s miss semantics.
 */
export function readModelCacheResponsesIds(cacheKey: string): string[] {
  const parsed = readCacheFile(cacheKey)
  if (!parsed) return []
  return normalizeResponsesIds(parsed.responsesIds)
}

/**
 * Persist model entries for a cache key. Best-effort: never throws, so
 * a read-only or full filesystem can't break discovery.
 */
export function writeModelCache(
  cacheKey: string,
  models: Record<string, unknown>,
  responsesIds: readonly string[] = [],
  hints: Record<string, ModelHints> = {},
): void {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    const payload: ModelCacheFile = {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      models,
      responsesIds: [...responsesIds],
      hints,
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
