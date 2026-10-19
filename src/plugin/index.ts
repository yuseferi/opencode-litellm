import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  autoDetectLiteLLM,
  checkLiteLLMHealth,
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  getRequestTimeoutMs,
  normalizeBaseURL,
} from '../utils/litellm-api'
import {
  formatModelName,
  categorizeModel,
} from '../utils/format-model-name'
import { requiresResponsesAPI } from '../utils/transport'
import type { LiteLLMModel, LiteLLMModelInfo } from '../types'
import { getOpenCodeStoredApiKey } from '../utils/opencode-auth'
import type { ModelHints } from '../utils/model-cache'
import {
  buildCacheKey,
  readModelCacheEntry,
  writeModelCache,
  readModelCacheSavedAt,
} from '../utils/model-cache'
import { passesModelFilter } from '../utils/model-filter'
import type { ModelFilters } from '../utils/model-filter'
import { applyCapabilityOverrides, parseModelCapabilities } from '../utils/model-capabilities'
import type { ModelCapabilities } from '../utils/model-capabilities'

const CHAT_PROVIDER_ID = 'litellm'
// The OpenCode 1 config hook can only choose a runtime package per provider,
// so models that need the Responses API get a sibling provider. OpenCode 2
// selects the runtime per model instead (see plugin/v2.ts) and never creates
// this provider. The suffix is reserved: the config hook skips ids that end
// with it so it never treats its own sibling as a chat provider.
const RESPONSES_PROVIDER_SUFFIX = '-responses'
const RESPONSES_NPM = '@ai-sdk/openai'
// Covers the 3 s health check plus the parallel models/model-info fetch
// phase, with headroom. Scales with LITELLM_REQUEST_TIMEOUT_MS so slow
// proxies aren't cut off by the overall cap either (issue #20).
export const DISCOVERY_TIMEOUT_MS = Math.max(20000, getRequestTimeoutMs() + 5000)
// Don't revalidate a baseURL's cache more often than this, so a burst
// of `session.created` events can't generate repeated discovery traffic.
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

type LogDetails = {
  service: string
  level: LogLevel
  message: string
}

let logWriter: ((details: LogDetails) => void) | null = null

function initLogging(client: PluginInput['client']): void {
  logWriter = (details) => {
    void client.app.log({ body: details }).catch(() => {})
  }
}

/** OpenCode 2 does not expose a server log method through its plugin context. */
export function initV2Logging(): void {
  logWriter = null
}

/**
 * Route plugin logs through OpenCode's log API instead of stdout.
 * console.* writes straight into the same terminal the OpenCode TUI
 * renders in, corrupting the interface on every background refresh
 * (issue #15); client.app.log lands in OpenCode's log files instead.
 */
function log(level: LogLevel, message: string): void {
  if (logWriter) {
    logWriter({ service: 'opencode-litellm', level, message })
    return
  }
  // No client wired up (unit tests, unusual embedders) — fall back to
  // the console rather than silently dropping diagnostics.
  if (level === 'info' || level === 'debug') console.log(message)
  else console.warn(message)
}

/**
 * OpenCode invokes the `config` hook several times per run with a
 * cumulative config object. Track which model ids we already injected
 * per provider (keyed by `providerId@baseURL`) so repeat invocations
 * can return early instead of re-querying the proxy.
 */
const injectedModelIds = new Map<string, Set<string>>()

/**
 * Per-provider fetch context captured during the `config` hook, so the
 * `event` hook can revalidate the cache in the background (SWR) without
 * re-deriving auth/headers. Keyed by `providerId@baseURL` — the same
 * key as the on-disk cache — so providers sharing a proxy keep
 * independent refresh contexts.
 */
interface RefreshContext {
  baseURL: string
  apiKey?: string
  customHeaders?: Record<string, string>
  filters: ModelFilters
  capabilities: ModelCapabilities
  formatModelNames: boolean
  providerId: string
}
const refreshContexts = new Map<string, RefreshContext>()

/** Cache keys with an in-flight background refresh, to avoid pile-ups. */
const refreshInFlight = new Set<string>()

/**
 * Race a promise against a timeout, resolving to `null` if the timeout
 * wins. Clears the timer either way so a resolved discovery can't keep
 * a short-lived process alive waiting on a pending `setTimeout`.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Helper to determine if a provider ID or its configured options indicate
 * compatibility with LiteLLM.
 */
export function isLiteLLMProvider(
  providerId: string,
  options: Record<string, unknown>,
): boolean {
  if (providerId === CHAT_PROVIDER_ID) return true
  if (providerId.startsWith('litellm-') || providerId.startsWith('litellm_')) return true
  if (options.litellm === true) return true
  if (options.litellmCompatible === true) return true
  if (options['litellm-compatible'] === true) return true
  if (options.litellm_compatible === true) return true
  return false
}

/**
 * Read `customHeaders` from a provider options block.
 */
export function readCustomHeaders(
  options: Record<string, unknown>,
): Record<string, string> | undefined {
  const raw = options.customHeaders
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

/**
 * Collect the gateway headers a provider needs on *every* request — both the
 * plugin's own discovery fetches and the completion-time runtime.
 *
 * OpenCode 1 hands the provider's native `options.headers` to the runtime
 * package, but the plugin's discovery fetches historically read only the
 * legacy `customHeaders` key. A gateway that authenticates via
 * `options.headers` (e.g. Cloudflare Access) would therefore serve
 * completions while every discovery call 401s. Merge both here, with
 * `customHeaders` winning on conflict, so discovery and runtime agree.
 */
export function readProviderHeaders(
  options: Record<string, unknown>,
): Record<string, string> | undefined {
  const merged = {
    ...readHeaderMap(options.headers),
    ...(readCustomHeaders(options) ?? {}),
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Read the `includeModels`/`excludeModels` glob filters from a provider
 * options block (issue #21's feature: split one proxy's catalog across
 * several OpenCode providers). Non-string entries are dropped; an empty
 * result means "don't filter".
 */
export function readModelFilters(options: Record<string, unknown>): ModelFilters {
  const readPatterns = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined
    const out = raw.filter((v): v is string => typeof v === 'string')
    return out.length > 0 ? out : undefined
  }
  return {
    includeModels: readPatterns(options.includeModels),
    excludeModels: readPatterns(options.excludeModels),
  }
}

export function readFormatModelNames(options: Record<string, unknown>): boolean {
  return options.formatModelNames !== false
}

/**
 * Overlay metadata onto a `/v1/models` entry in three tiers: the entry's
 * own fields win, `/v1/model/info` fills gaps (notably `mode`, which
 * `/v1/models` omits for database-defined models), and finally
 * user-configured `modelCapabilities` overrides apply — explicit
 * `false` included — because the user knows their deployment better
 * than either endpoint (issue #25).
 */
function enrichModel(
  model: LiteLLMModel,
  info: LiteLLMModelInfo | undefined,
  overrides?: Record<string, boolean>,
): LiteLLMModel {
  return applyCapabilityOverrides(
    {
      ...model,
      mode: model.mode ?? info?.mode,
      max_tokens: model.max_tokens ?? info?.max_tokens,
      max_input_tokens: model.max_input_tokens ?? info?.max_input_tokens,
      max_output_tokens: model.max_output_tokens ?? info?.max_output_tokens,
      supports_function_calling:
        model.supports_function_calling ?? info?.supports_function_calling,
      supports_vision: model.supports_vision ?? info?.supports_vision,
      supports_reasoning: model.supports_reasoning ?? info?.supports_reasoning,
      supports_pdf_input: model.supports_pdf_input ?? info?.supports_pdf_input,
      supports_audio_input: model.supports_audio_input ?? info?.supports_audio_input,
      input_cost_per_token: model.input_cost_per_token ?? info?.input_cost_per_token,
      output_cost_per_token: model.output_cost_per_token ?? info?.output_cost_per_token,
      cache_read_input_token_cost:
        model.cache_read_input_token_cost ?? info?.cache_read_input_token_cost,
      cache_creation_input_token_cost:
        model.cache_creation_input_token_cost ?? info?.cache_creation_input_token_cost,
    },
    overrides,
  )
}

/**
 * OpenCode's `cost` config field is USD per **million** tokens (the
 * models.dev convention); LiteLLM's `/v1/model/info` reports USD per
 * single token. `1e6` bridges the two — verified against a live
 * `x-litellm-response-cost` header, not just the unit names.
 */
const USD_PER_TOKEN_TO_PER_MILLION = 1_000_000

/**
 * Convert a discovered LiteLLM model into an OpenCode config-level
 * model entry (the shape used in `provider.*.models` inside
 * `opencode.json`). Returns `null` for non-chat models (embedding,
 * image, audio) — they can't be used as primary chat models and would
 * clutter the picker.
 *
 * Exported for tests: `formatModelNames` decides whether the display
 * name is the prettified id or the raw `/v1/models` id verbatim.
 */
export function toConfigModel(
  model: LiteLLMModel,
  info?: LiteLLMModelInfo,
  formatModelNames = true,
): Record<string, unknown> | null {
  const type = categorizeModel(model)
  if (type === 'embedding' || type === 'image' || type === 'audio') {
    return null
  }
  const entry: Record<string, unknown> = {
    name: formatModelNames ? formatModelName(model) : model.id,
  }
  // Some deployments only report the OpenAI-style `max_tokens` total;
  // use it as the context limit when `max_input_tokens` is absent.
  const contextLimit = model.max_input_tokens ?? model.max_tokens
  if (contextLimit || model.max_output_tokens) {
    entry.limit = {
      context: contextLimit ?? 0,
      output: model.max_output_tokens ?? 0,
    }
  }
  if (model.supports_function_calling != null) {
    entry.tool_call = model.supports_function_calling
  }
  if (model.supports_reasoning) {
    entry.reasoning = true
  }
  if (model.supports_vision) {
    entry.attachment = true
  }
  // Only emit `cost` when LiteLLM actually reported a price. Omitting
  // it (rather than defaulting to 0) lets OpenCode/models.dev fall back
  // to their own default instead of us asserting "this model is free"
  // for something LiteLLM simply has no price anchor for (e.g. rerank).
  if (model.input_cost_per_token != null || model.output_cost_per_token != null) {
    const cost: Record<string, number> = {
      input: (model.input_cost_per_token ?? 0) * USD_PER_TOKEN_TO_PER_MILLION,
      output: (model.output_cost_per_token ?? 0) * USD_PER_TOKEN_TO_PER_MILLION,
    }
    if (model.cache_read_input_token_cost != null) {
      cost.cache_read = model.cache_read_input_token_cost * USD_PER_TOKEN_TO_PER_MILLION
    }
    if (model.cache_creation_input_token_cost != null) {
      cost.cache_write = model.cache_creation_input_token_cost * USD_PER_TOKEN_TO_PER_MILLION
    }
    entry.cost = cost
  }
  const input: Array<'text' | 'image' | 'pdf' | 'audio'> = ['text']
  if (model.supports_vision) input.push('image')
  if (model.supports_pdf_input) input.push('pdf')
  if (model.supports_audio_input) input.push('audio')
  // LiteLLM often omits capability flags for database-defined models.
  // Do not omit `modalities` in that case: OpenCode's fallback for an
  // unknown custom model includes image input, which makes text-only
  // llama.cpp routes receive image parts and fail with "image input is
  // not supported". Text-only is the safe default until a proxy reports
  // a positive capability.
  entry.modalities = { input, output: ['text'] }
  entry.variants = info?.supports_reasoning_efforts?.length
    ? Object.fromEntries(
        info.supports_reasoning_efforts.map((effort) => [
          effort,
          { reasoningEffort: effort },
        ]),
      )
    : undefined
  return entry
}

/**
 * Result of discovering a LiteLLM proxy's models.
 *
 * `models` is the `{ id -> entry }` map written into an OpenCode provider
 * config (or translated into `Model.Info` on OpenCode 2). `responsesIds`
 * lists the subset that must be invoked through the OpenAI Responses API;
 * callers route those accordingly without inspecting each entry. `hints`
 * carries per-model upstream facts OpenCode 2 maps to `compatibility` and
 * `variants`.
 */
export interface DiscoveredModels {
  models: Record<string, unknown>
  responsesIds: string[]
  hints: Record<string, ModelHints>
}

/**
 * Fetch and build OpenCode model entries from a LiteLLM proxy.
 *
 * Pure with respect to plugin config: it performs the network calls,
 * classifies + formats each model, and returns the built entries plus the
 * ids that require the Responses API and per-model hints. The provider's
 * `includeModels`/`excludeModels` filters, `modelCapabilities` overrides and
 * `formatModelNames` choice are applied here (not at merge time) so every
 * path that persists or serves a cache — cold discovery and background
 * refresh — writes the same adjusted view.
 *
 * Returns `null` when the proxy is unreachable/unauthorized or exposes
 * no models, so callers can distinguish "no data" from "empty result".
 */
export async function discoverModels(
  baseURL: string,
  apiKey: string | undefined,
  customHeaders: Record<string, string> | undefined,
  providerId: string,
  filters: ModelFilters = {},
  capabilities: ModelCapabilities = {},
  formatModelNames = true,
): Promise<DiscoveredModels | null> {
  if (!(await checkLiteLLMHealth(baseURL, apiKey, customHeaders))) {
    log(
      'warn',
      `[opencode-litellm] LiteLLM appears offline or unauthorized for provider "${providerId}" at ${baseURL}`,
    )
    return null
  }

  // `/v1/models` omits `mode` and capability metadata for
  // database-defined models, so fetch `/v1/model/info` alongside
  // it. The info call is best-effort: without it, classification
  // falls back to id heuristics.
  const [modelsResult, infoResult] = await Promise.allSettled([
    discoverLiteLLMModels(baseURL, apiKey, customHeaders),
    discoverLiteLLMModelInfo(baseURL, apiKey, customHeaders),
  ])

  if (modelsResult.status === 'rejected') {
    const error = modelsResult.reason
    log(
      'warn',
      `[opencode-litellm] Model discovery failed for provider "${providerId}": ` +
        (error instanceof Error ? error.message : String(error)),
    )
    return null
  }

  const discovered = modelsResult.value
  let infoByName: Map<string, LiteLLMModelInfo> | null = null
  if (infoResult.status === 'fulfilled') {
    infoByName = infoResult.value
  } else {
    const reason = infoResult.reason
    log(
      'warn',
      `[opencode-litellm] /v1/model/info unavailable for provider "${providerId}"; non-chat model filtering will use id heuristics only: ` +
        (reason instanceof Error ? reason.message : String(reason)),
    )
  }

  if (discovered.length === 0) {
    log(
      'warn',
      `[opencode-litellm] LiteLLM responded for provider "${providerId}" but exposed zero models.`,
    )
    return null
  }

  const built: Record<string, unknown> = {}
  const responsesIds: string[] = []
  const hints: Record<string, ModelHints> = {}
  let skipped = 0
  let wildcards = 0
  let filtered = 0
  const unmatched: string[] = []
  for (const model of discovered) {
    // `deepseek/*` is an access rule, not a callable model. But a
    // trailing `*` (`claude-sonnet-4-6*`) is a model-group alias,
    // so only skip the `provider/*` form.
    if (model.id.includes('/*')) {
      wildcards++
      continue
    }
    // `includeModels`/`excludeModels` let one LiteLLM proxy be split
    // across several OpenCode providers (e.g. by upstream naming
    // prefix) without hand-maintaining a model list.
    if (!passesModelFilter(model.id, filters.includeModels, filters.excludeModels)) {
      filtered++
      continue
    }
    const info = infoByName?.get(model.id)
    if (infoByName && !info) unmatched.push(model.id)
    const enriched = enrichModel(model, info, capabilities[model.id])
    const entry = toConfigModel(enriched, info, formatModelNames)
    if (!entry) {
      skipped++
      continue
    }
    built[model.id] = entry
    if (requiresResponsesAPI(enriched)) responsesIds.push(model.id)
    const params = info?.supported_openai_params
    hints[model.id] = {
      acceptsCacheControl: Array.isArray(params) && params.includes('cache_control'),
      adaptiveThinking: info?.supports_adaptive_thinking === true,
      thinkingAlwaysOn: info?.thinking_always_on === true,
    }
  }

  if (unmatched.length > 0) {
    log(
      'warn',
      `[opencode-litellm] /v1/model/info has no entry for ${unmatched.length} model(s) on provider "${providerId}"; ` +
        `classification uses id heuristics for: ${unmatched.slice(0, 5).join(', ')}` +
        (unmatched.length > 5 ? `, +${unmatched.length - 5} more` : ''),
    )
  }

  // Only blame the filters when every non-wildcard model was rejected by
  // them — if some hit `skipped` (non-chat) instead, `built` being empty
  // has an unrelated cause and this warning would misdirect the user.
  if (filtered > 0 && filtered + wildcards === discovered.length) {
    log(
      'warn',
      `[opencode-litellm] includeModels/excludeModels filtered out all ${filtered} model(s) discovered for provider "${providerId}" — check the glob patterns in options.includeModels/options.excludeModels.`,
    )
  }

  log(
    'info',
    `[opencode-litellm] Discovered ${discovered.length} models for provider "${providerId}" from ${baseURL} ` +
      `(${Object.keys(built).length} built` +
      (skipped > 0 ? `, ${skipped} non-chat hidden` : '') +
      (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
      (filtered > 0 ? `, ${filtered} filtered by includeModels/excludeModels` : '') +
      ')',
  )

  return { models: built, responsesIds, hints }
}

/**
 * Merge freshly built model entries into a provider's `models` map
 * without clobbering user-curated (or previously injected) entries.
 * Returns the ids actually added by this call.
 */
function mergeModels(
  models: Record<string, unknown>,
  built: Record<string, unknown>,
): string[] {
  const added: string[] = []
  for (const [id, entry] of Object.entries(built)) {
    if (Object.hasOwn(models, id)) continue
    models[id] = entry
    added.push(id)
  }
  // Remove the seed placeholder if real models were merged in.
  if (Object.hasOwn(models, '_') && Object.keys(models).length > 1) {
    delete models['_']
  }
  return added
}

/**
 * Ensure the sibling provider that carries Responses-API models exists in
 * the OpenCode 1 config, mirroring the chat provider's endpoint and
 * credentials. Returns its `models` map.
 *
 * The Responses runtime is `@ai-sdk/openai` (AI SDK 5's OpenAI provider
 * defaults to `/v1/responses`). The sibling is only materialized when at
 * least one discovered model needs it, so chat-only proxies keep a single
 * provider and never pay for the extra entry.
 */
function ensureResponsesProvider(
  config: { provider: Record<string, unknown> },
  baseProviderId: string,
  baseProvider: Record<string, unknown>,
  baseURL: string,
  apiKey: string | undefined,
  customHeaders: Record<string, string> | undefined,
): Record<string, unknown> {
  const id = `${baseProviderId}${RESPONSES_PROVIDER_SUFFIX}`
  if (!config.provider[id] || typeof config.provider[id] !== 'object') {
    config.provider[id] = {}
  }
  const provider = config.provider[id] as Record<string, unknown>
  if (!provider.npm) provider.npm = RESPONSES_NPM
  if (typeof provider.name !== 'string' || !provider.name) {
    const baseName =
      typeof baseProvider.name === 'string' && baseProvider.name
        ? baseProvider.name
        : 'LiteLLM (proxy)'
    provider.name = `${baseName} Responses`
  }
  if (!provider.options || typeof provider.options !== 'object') {
    provider.options = {}
  }
  const options = provider.options as Record<string, unknown>
  if (!options.baseURL) options.baseURL = `${baseURL}/v1`
  if (!options.apiKey && apiKey) options.apiKey = apiKey
  // OpenCode 1 reads provider headers from `options.headers` and hands them to
  // the runtime package (`@ai-sdk/openai` here); it has no `customHeaders` key.
  // Mirror the chat provider's native headers and promote the plugin's
  // `customHeaders` so Responses requests carry the same gateway headers.
  const baseOptions = (baseProvider.options ?? {}) as Record<string, unknown>
  const mergedHeaders = {
    ...readHeaderMap(baseOptions.headers),
    ...(customHeaders ?? {}),
    ...readHeaderMap(options.headers),
  }
  if (Object.keys(mergedHeaders).length > 0) {
    options.headers = mergedHeaders
  }
  if (!provider.models || typeof provider.models !== 'object') {
    provider.models = {}
  }
  return provider.models as Record<string, unknown>
}

/**
 * Extract a `string -> string` header map from an arbitrary provider option
 * value, ignoring anything that isn't a string. Returns an empty map for
 * missing or malformed input.
 */
function readHeaderMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, header] of Object.entries(value as Record<string, unknown>)) {
      if (typeof header === 'string') out[key] = header
    }
  }
  return out
}

/**
 * Split freshly discovered entries into the chat provider and the Responses
 * sibling, injecting each side without clobbering curated entries. Returns
 * every id this call added, across both providers, so the config hook's
 * idempotency check sees a single set.
 */
function injectDiscoveredModels(
  config: { provider: Record<string, unknown> },
  baseProviderId: string,
  baseProvider: Record<string, unknown>,
  baseModels: Record<string, unknown>,
  entries: Record<string, unknown>,
  responsesIds: readonly string[],
  baseURL: string,
  apiKey: string | undefined,
  customHeaders: Record<string, string> | undefined,
): string[] {
  const responsesSet = new Set(responsesIds)
  const existingSibling = config.provider[`${baseProviderId}${RESPONSES_PROVIDER_SUFFIX}`]
  const siblingModelsExisting: Record<string, unknown> =
    existingSibling &&
    typeof existingSibling === 'object' &&
    (existingSibling as Record<string, unknown>).models &&
    typeof (existingSibling as Record<string, unknown>).models === 'object'
      ? ((existingSibling as Record<string, unknown>).models as Record<string, unknown>)
      : {}

  const chatEntries: Record<string, unknown> = {}
  const responsesEntries: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(entries)) {
    // A model already present under the other provider was curated there (or
    // injected by an earlier run); leave it alone instead of duplicating it
    // across both providers.
    if (responsesSet.has(id)) {
      if (Object.hasOwn(baseModels, id)) continue
      responsesEntries[id] = entry
    } else {
      if (Object.hasOwn(siblingModelsExisting, id)) continue
      chatEntries[id] = entry
    }
  }

  const added = mergeModels(baseModels, chatEntries)
  if (Object.keys(responsesEntries).length > 0) {
    const siblingModels = ensureResponsesProvider(
      config,
      baseProviderId,
      baseProvider,
      baseURL,
      apiKey,
      customHeaders,
    )
    added.push(...mergeModels(siblingModels, responsesEntries))
  }
  return added
}

/**
 * Revalidate a provider's model cache off the critical path (SWR). The
 * refreshed entries land in the on-disk cache and surface on the next
 * OpenCode start — OpenCode only reads provider config at startup, so
 * we can't mutate the live picker here.
 */
async function backgroundRefresh(cacheKey: string): Promise<void> {
  if (refreshInFlight.has(cacheKey)) return
  const ctx = refreshContexts.get(cacheKey)
  if (!ctx) return
  // Skip if the cache was refreshed recently — a burst of new sessions
  // shouldn't hammer the proxy with health checks and discovery calls.
  const savedAt = readModelCacheSavedAt(cacheKey)
  if (savedAt !== null && Date.now() - savedAt < REFRESH_MIN_INTERVAL_MS) {
    return
  }
  refreshInFlight.add(cacheKey)
  try {
    const discovered = await withTimeout(
      discoverModels(
        ctx.baseURL,
        ctx.apiKey,
        ctx.customHeaders,
        ctx.providerId,
        ctx.filters,
        ctx.capabilities,
        ctx.formatModelNames,
      ),
      DISCOVERY_TIMEOUT_MS,
    )
    if (discovered && Object.keys(discovered.models).length > 0) {
      writeModelCache(cacheKey, discovered.models, discovered.responsesIds, discovered.hints)
      log(
        'info',
        `[opencode-litellm] Background-refreshed model cache for ${ctx.baseURL} (${Object.keys(discovered.models).length} models)`,
      )
    }
  } catch {
    // Best-effort — a failed refresh just leaves the stale cache in place.
  } finally {
    refreshInFlight.delete(cacheKey)
  }
}

/**
 * LiteLLM Plugin for OpenCode.
 *
 * Uses the `config` hook to discover models from a LiteLLM proxy and
 * inject them into the provider's `models` map at startup. This is the
 * only reliable way to dynamically populate a provider — the
 * `provider.models` hook is not called by OpenCode for custom providers.
 *
 * Configure the provider in your `opencode.json`:
 *
 * {
 *   "plugin": ["opencode-plugin-litellm@latest"],
 *   "provider": {
 *     "litellm": {
 *       "npm": "@ai-sdk/openai-compatible",
 *       "name": "LiteLLM (proxy)",
 *       "options": {
 *         "baseURL": "http://localhost:4000/v1",
 *         "apiKey": "{env:LITELLM_API_KEY}"
 *       }
 *     }
 *   }
 * }
 */
export const LiteLLMPlugin: Plugin = async (input: PluginInput) => {
  initLogging(input.client)
  return {
    config: async (config: any) => {
      // Ensure the provider entry exists
      if (!config.provider) config.provider = {}

      // Find all matching LiteLLM providers
      const providerIds = Object.keys(config.provider)
      const liteLLMProviders: Array<{ id: string; provider: Record<string, unknown> }> = []

      for (const id of providerIds) {
        // The Responses sibling is created and populated below; never treat
        // it as a chat provider (that would recurse into `…-responses-responses`).
        if (id.endsWith(RESPONSES_PROVIDER_SUFFIX)) continue
        const provider = config.provider[id]
        if (provider && typeof provider === 'object') {
          const options = (provider.options ?? {}) as Record<string, unknown>
          if (isLiteLLMProvider(id, options)) {
            liteLLMProviders.push({ id, provider })
          }
        }
      }

      // If no providers are matched (e.g., zero-config auto-detection),
      // fall back to default 'litellm' provider to ensure backwards compatibility.
      if (liteLLMProviders.length === 0) {
        const id = CHAT_PROVIDER_ID
        let provider = config.provider[id] as Record<string, unknown> | undefined
        if (!provider) {
          provider = {
            npm: '@ai-sdk/openai-compatible',
            name: 'LiteLLM (proxy)',
            options: {},
            models: {},
          }
        }
        liteLLMProviders.push({ id, provider })
      }

      // Process each matched provider
      for (const { id: providerId, provider } of liteLLMProviders) {
        const options = (provider.options ?? {}) as Record<string, unknown>
        const configuredBase =
          typeof options.baseURL === 'string' ? options.baseURL : undefined
        const configuredKey =
          typeof options.apiKey === 'string' && options.apiKey
            ? options.apiKey
            : undefined
        const envKey =
          process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || undefined
        /*
        Falls back to the key OpenCode itself stored for this provider id via
        '/connect' (~/.local/share/opencode/auth.json). For a custom provider
        like this one there is no automatic auth.json injection (see below), so
        the plugin reads the stored key here and applies it to both its own
        discovery fetches and the completion-time provider options. Without it,
        a key-only proxy would fail discovery even though chat works.

        Precedence rule: the stored credential — the user's explicit
        choice made in the box — wins over the pod environment. The env is a
        box-level fallback for users who have not saved a credential — never an
        override of a user's saved key.
        */
        const storedKey = await getOpenCodeStoredApiKey(providerId)
        const apiKey = configuredKey ?? storedKey ?? envKey
        // Native `options.headers` and the legacy `customHeaders` both reach
        // discovery and the runtime, so a gateway that only sets one still
        // authenticates the plugin's own fetches.
        const customHeaders = readProviderHeaders(options)
        const filters = readModelFilters(options)
        const capabilities = parseModelCapabilities(options.modelCapabilities)
        const formatModelNames = readFormatModelNames(options)

        // Resolve base URL
        let baseURL: string | null = null
        if (configuredBase) {
          baseURL = normalizeBaseURL(configuredBase)
        } else {
          baseURL = await autoDetectLiteLLM(apiKey, customHeaders)
        }

        if (!baseURL) {
          log(
            'warn',
            `[opencode-litellm] No LiteLLM proxy found for provider "${providerId}". Configure options.baseURL or start LiteLLM on port 4000/8000/8080.`,
          )
          continue
        }

        // Initialize/Update the provider entry in config
        if (!config.provider[providerId]) {
          config.provider[providerId] = provider
        }
        const actualProvider = config.provider[providerId] as Record<string, unknown>

        if (!actualProvider.npm) {
          actualProvider.npm = '@ai-sdk/openai-compatible'
        }

        if (!actualProvider.options) {
          actualProvider.options = {}
        }
        const actualOptions = actualProvider.options as Record<string, unknown>
        if (!actualOptions.baseURL) {
          actualOptions.baseURL = `${baseURL}/v1`
        }
        /*
        For a fully custom, config-only provider like this one, OpenCode
        builds the real completion-time AI SDK client straight from
        `options` - there's no separate auth.json auto-injection for
        arbitrary custom providers (that only applies to a handful of
        models.dev-catalog providers with special-cased loaders). So the
        `apiKey` resolved above (config > env var > OpenCode-stored
        credential) must be written back here, or real chat completions
        go out with no Authorization header even though discovery
        succeeded using the same resolved key.
        */
        if (!actualOptions.apiKey && apiKey) {
          actualOptions.apiKey = apiKey
        }

        if (!actualProvider.models) {
          actualProvider.models = {}
        }

        const models = actualProvider.models as Record<string, unknown>

        // Identity includes the filter/capability/naming config: those
        // are baked into cached entries, so changing them must start a
        // fresh discovery instead of serving the old adjusted view.
        // The cache key is isolated by the effective credential (a fingerprint,
        // never the raw key): a credential change starts a fresh discovery
        // instead of serving another credential's cached model list.
        const cacheKey = buildCacheKey(providerId, baseURL, filters, capabilities, {
          formatModelNames,
        }, apiKey)

        // Remember how to reach this proxy so the `event` hook can
        // revalidate its cache in the background on new sessions.
        refreshContexts.set(cacheKey, {
          baseURL,
          apiKey,
          customHeaders,
          filters,
          capabilities,
          formatModelNames,
          providerId,
        })

        // The Responses sibling (if any) holds a disjoint set of ids, so the
        // idempotency check has to look at both providers.
        const responsesProviderId = `${providerId}${RESPONSES_PROVIDER_SUFFIX}`
        const responsesModels = (): Record<string, unknown> => {
          const sibling = config.provider[responsesProviderId]
          if (!sibling || typeof sibling !== 'object') return {}
          const candidate = (sibling as Record<string, unknown>).models
          return candidate && typeof candidate === 'object'
            ? (candidate as Record<string, unknown>)
            : {}
        }

        // Repeat config-hook invocations within a run are a no-op once
        // we've injected this provider's models.
        const alreadyInjected = injectedModelIds.get(cacheKey)
        if (
          alreadyInjected &&
          [...alreadyInjected].every(
            (id) =>
              Object.hasOwn(models, id) || Object.hasOwn(responsesModels(), id),
          )
        ) {
          continue
        }

        // SWR fast path: serve cached entries synchronously so startup
        // isn't blocked on the network. A background refresh (see the
        // `event` hook) keeps the cache fresh for the next launch.
        // The cache is scoped per provider so two providers pointing at
        // the same proxy (with different keys) don't share model lists.
        const cached = readModelCacheEntry(cacheKey)
        if (cached && Object.keys(cached.models).length > 0) {
          const added = injectDiscoveredModels(
            config,
            providerId,
            actualProvider,
            models,
            cached.models,
            cached.responsesIds,
            baseURL,
            apiKey,
            customHeaders,
          )
          injectedModelIds.set(cacheKey, new Set(added))
          log(
            'info',
            `[opencode-litellm] Loaded ${Object.keys(cached.models).length} models from cache for provider "${providerId}" (${baseURL}); refresh happens in the background on new sessions.`,
          )
          continue
        }

        // Cold cache: do a live fetch (slow first run only), inject, and
        // persist for subsequent startups. Capped by a timeout so a slow
        // proxy never blocks boot.
        const discovered = await withTimeout(
          discoverModels(
            baseURL,
            apiKey,
            customHeaders,
            providerId,
            filters,
            capabilities,
            formatModelNames,
          ),
          DISCOVERY_TIMEOUT_MS,
        )
        if (discovered && Object.keys(discovered.models).length > 0) {
          const added = injectDiscoveredModels(
            config,
            providerId,
            actualProvider,
            models,
            discovered.models,
            discovered.responsesIds,
            baseURL,
            apiKey,
            customHeaders,
          )
          injectedModelIds.set(cacheKey, new Set(added))
          writeModelCache(cacheKey, discovered.models, discovered.responsesIds, discovered.hints)
        }
      }
    },
    event: async ({ event }) => {
      // Revalidate model caches off the critical path when a new session
      // opens. Fresh data lands in the cache and surfaces on the next
      // OpenCode start (SWR).
      if (event.type !== 'session.created') return
      for (const cacheKey of refreshContexts.keys()) {
        void backgroundRefresh(cacheKey)
      }
    },
  }
}

// Re-export the responses plugin for backwards compat, but it's now a no-op.
// The config hook approach handles all models in a single provider.
export const LiteLLMResponsesPlugin: Plugin = async (_input: PluginInput) => {
  return {}
}
