import { Integration, Model, Plugin, Provider } from '@opencode/plugin'
import type { Context } from '@opencode/plugin/promise/plugin'
import type { PluginInput } from '@opencode-ai/plugin'
import {
  DISCOVERY_TIMEOUT_MS,
  discoverModels,
  initV2Logging,
  isLiteLLMProvider,
  readCustomHeaders,
  readFormatModelNames,
  readModelFilters,
  withTimeout,
  LiteLLMPlugin,
} from './index'
import {
  LITELLM_INTEGRATION_ID,
  readConnectedConfig,
  registerLiteLLMIntegration,
  type ConnectedLiteLLM,
} from './integration'
import {
  buildCacheKey,
  readModelCacheEntry,
  readModelCacheSavedAt,
  writeModelCache,
} from '../utils/model-cache'
import { normalizeBaseURL, autoDetectLiteLLM } from '../utils/litellm-api'
import { parseModelCapabilities } from '../utils/model-capabilities'
import type { ModelCapabilities } from '../utils/model-capabilities'
import type { ModelFilters } from '../utils/model-filter'

const CHAT_PROVIDER_ID = 'litellm'
const OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible'
// Runtime package that talks to `/v1/responses`. OpenCode 2 lets one model
// override the provider's package, so Responses models stay under their
// original provider id and no sibling provider is needed here.
//
// `@opencode/ai/providers/openai/responses` is the Responses runtime OpenCode
// bundles today; a plain OpenAI-compatible provider defaults to the Chat
// Completions runtime, so the override is what selects the Responses API.
//
// Note this is the OpenAI-specific runtime: it applies OpenAI request defaults
// (`store: false`, plus `reasoningEffort`/`reasoningSummary`/encrypted-reasoning
// `include` for `gpt-5*` ids) on top of the proxy endpoint. The provider-neutral
// `@opencode/ai/providers/openai-compatible/responses` is the closer match for a
// generic LiteLLM proxy, but it must actually load in the target OpenCode 2.x
// (`@opencode/ai@2.0.19` ships both). Verified live against the OpenAI runtime;
// switch here if the compatible variant becomes reliably available.
const RESPONSES_PACKAGE = '@opencode/ai/providers/openai/responses'
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000

type ProviderInfo = Awaited<ReturnType<Context['provider']['list']>>['data'][number]

interface ProviderSource {
  id: string
  name: string
  activation: ProviderInfo['activation']
  package: string
  settings: Record<string, unknown>
  headers: Record<string, string>
  integrationID?: string
  usesConnectionCredential: boolean
  baseURL: string
  apiKey?: string
  customHeaders?: Record<string, string>
  credentialReloadRequired: boolean
  refreshRequired: boolean
  /**
   * True when this source came from option/env/port auto-detection rather than
   * a host-registered provider. A fallback only stands in until the real
   * provider appears; reconcile replaces it at that point so the user's
   * `providers.<id>.settings.baseURL` wins over the guessed endpoint.
   *
   * Distinct from {@link pendingPublication}: a fallback source is always
   * pending until a configured provider supersedes it, whereas a configured
   * source is pending only until its first successful `reload()`.
   */
  fromFallback: boolean
  /**
   * True until this source has been published to the provider registry by a
   * successful `reload()`. Reconciliation retries (and re-adds) any source
   * still pending, so a transient reload failure does not strand it.
   */
  pendingPublication: boolean
  filters: ModelFilters
  capabilities: ModelCapabilities
  formatModelNames: boolean
  cacheKey: string
  models: Model.Info[]
  /**
   * Model ids this plugin injected into the provider registry (as opposed
   * to ids the user curated in config). Only these are eligible to be
   * removed when a later refresh no longer discovers them.
   */
  ownedModelIds: Set<string>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readHeaders(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, header] of Object.entries(asRecord(value))) {
    if (typeof header === 'string') result[key] = header
  }
  return result
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toProviderModels(
  providerID: string,
  entries: Record<string, unknown>,
  responsesIds: ReadonlySet<string> = new Set<string>(),
): Model.Info[] {
  const provider = Provider.ID.make(providerID)

  return Object.entries(entries).flatMap(([modelID, value]) => {
    const entry = asRecord(value)
    if (Object.keys(entry).length === 0) return []

    const limit = asRecord(entry.limit)
    const defaults = Model.Info.default(provider, Model.ID.make(modelID))
    const modalities = asRecord(entry.modalities)
    const input = Array.isArray(modalities.input)
      ? modalities.input.filter((item): item is string => typeof item === 'string')
      : defaults.capabilities.input
    const output = Array.isArray(modalities.output)
      ? modalities.output.filter((item): item is string => typeof item === 'string')
      : defaults.capabilities.output

    const rawCost = asRecord(entry.cost)
    const cost: Model.Info['cost'] =
      typeof rawCost.input === 'number' || typeof rawCost.output === 'number'
        ? [
            {
              input: numberOrZero(rawCost.input) as Model.Info['cost'][number]['input'],
              output: numberOrZero(rawCost.output) as Model.Info['cost'][number]['output'],
              cache: {
                read: numberOrZero(rawCost.cache_read) as Model.Info['cost'][number]['cache']['read'],
                write: numberOrZero(rawCost.cache_write) as Model.Info['cost'][number]['cache']['write'],
              },
            },
          ]
        : []

    const rawVariants = asRecord(entry.variants)
    const variants = Object.entries(rawVariants).map(([id, settings]) => ({
      id: id as Model.VariantID,
      settings: asRecord(settings),
    })) as Model.Info['variants']
    return [
      {
        ...defaults,
        // A model that targets `/v1/responses` overrides the provider's
        // runtime package for itself, so it keeps the provider id while
        // still reaching the Responses API.
        ...(responsesIds.has(modelID) ? { package: RESPONSES_PACKAGE } : {}),
        name: readString(entry.name) ?? modelID,
        limit: {
          context: numberOrDefault(limit.context, defaults.limit.context),
          output: numberOrDefault(limit.output, defaults.limit.output),
        },
        capabilities: {
          tools: entry.tool_call === undefined ? defaults.capabilities.tools : entry.tool_call === true,
          input,
          output,
        },
        cost,
        variants,
      },
    ]
  })
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/**
 * Merge freshly discovered models into a provider's current model set.
 *
 * Previously-discovered ids owned by this plugin are replaced/removed so a
 * refresh reflects LiteLLM's current inventory; ids the user curated
 * themselves are never removed. Returns the merged list plus the set of
 * ids the plugin now owns.
 */
function mergeProviderModels(
  configured: Iterable<Model.Info>,
  discovered: readonly Model.Info[],
  owned: ReadonlySet<string>,
): { models: Model.Info[]; owned: Set<string> } {
  const discoveredIds = new Set(discovered.map((model) => model.id))
  const result = new Map<string, Model.Info>()
  const nextOwned = new Set<string>()

  for (const model of configured) {
    // Drop plugin-injected models that LiteLLM no longer returns; curated
    // models are not in `owned`, so they always survive.
    if (owned.has(model.id) && !discoveredIds.has(model.id)) continue
    result.set(model.id, model)
    if (owned.has(model.id)) nextOwned.add(model.id)
  }

  for (const model of discovered) {
    if (!result.has(model.id)) {
      result.set(model.id, model)
      nextOwned.add(model.id)
    }
  }

  return { models: [...result.values()], owned: nextOwned }
}

function runtimeSettings(source: ProviderSource): Record<string, unknown> {
  const settings = { ...source.settings }
  for (const key of [
    'litellm',
    'litellmCompatible',
    'litellm-compatible',
    'litellm_compatible',
    'customHeaders',
    'includeModels',
    'excludeModels',
    'modelCapabilities',
    'formatModelNames',
    'providerID',
  ]) {
    delete settings[key]
  }
  settings.baseURL = `${source.baseURL}/v1`
  // Connection-managed credentials are resolved only for discovery. They
  // must not be materialized into provider settings: OpenCode owns
  // credential injection for integrated providers. Explicit credentials
  // (provider settings, plugin options, env) still flow through.
  if (source.apiKey && !source.usesConnectionCredential) settings.apiKey = source.apiKey
  return settings
}

async function makeProviderSource(
  context: Context,
  provider: ProviderInfo | undefined,
  pluginOptions: Record<string, unknown>,
): Promise<ProviderSource | null> {
  const providerSettings = asRecord(provider?.settings)
  const settings = { ...pluginOptions, ...providerSettings }
  const customHeaders = {
    ...readHeaders(pluginOptions.customHeaders),
    ...readCustomHeaders(settings),
    ...readHeaders(provider?.headers),
  }
  // Credential plus dialog form answers. A provider wired to its own
  // integration keeps using exactly that one; otherwise the plugin's
  // registered integration is consulted, so a gateway can be connected
  // entirely from the web UI with no hand-written config.
  const connected: ConnectedLiteLLM | undefined = await readConnectedConfig(
    context,
    provider?.integrationID ?? LITELLM_INTEGRATION_ID,
  )
  const id =
    provider?.id ??
    readString(pluginOptions.providerID) ??
    connected?.providerID ??
    CHAT_PROVIDER_ID
  const configuredBaseURL = readString(settings.baseURL)
  const connectedApiKey = connected?.apiKey
  const configuredApiKey =
    readString(providerSettings.apiKey) ??
    readString(pluginOptions.apiKey) ??
    process.env.LITELLM_API_KEY ??
    process.env.LITELLM_MASTER_KEY
  // A provider bound to an integration relies on OpenCode for its credential
  // even before one is connected. The plugin's own integration only counts
  // once it actually resolved a key, so env/config setups are unaffected.
  const usesConnectionCredential =
    !configuredApiKey && Boolean(provider?.integrationID ?? connectedApiKey)
  const integrationID =
    provider?.integrationID ??
    (usesConnectionCredential && connectedApiKey ? LITELLM_INTEGRATION_ID : undefined)
  const apiKey = configuredApiKey ?? connectedApiKey
  const filters = readModelFilters(settings)
  const capabilities = parseModelCapabilities(settings.modelCapabilities)
  const formatModelNames = readFormatModelNames(settings)
  // Explicit config beats the URL typed into the dialog, which beats the
  // environment and local port probing.
  const detectedBaseURL = configuredBaseURL
    ? normalizeBaseURL(configuredBaseURL)
    : connected?.baseURL
      ? normalizeBaseURL(connected.baseURL)
      : await autoDetectLiteLLM(apiKey, customHeaders)

  if (!detectedBaseURL) {
    return null
  }

  const baseURL = normalizeBaseURL(detectedBaseURL)
  const cacheKey = buildCacheKey(id, baseURL, filters, capabilities, {
    formatModelNames,
  })
  const cacheEntry = readModelCacheEntry(cacheKey)
  let entries = cacheEntry?.models ?? null
  let responsesIds = cacheEntry?.responsesIds ?? []

  if (!entries || Object.keys(entries).length === 0) {
    const discovered = await withTimeout(
      discoverModels(
        baseURL,
        apiKey,
        customHeaders,
        id,
        filters,
        capabilities,
        formatModelNames,
      ),
      DISCOVERY_TIMEOUT_MS,
    )
    if (discovered && Object.keys(discovered.models).length > 0) {
      entries = discovered.models
      responsesIds = discovered.responsesIds
      writeModelCache(cacheKey, entries, responsesIds)
    } else {
      entries = null
      responsesIds = []
    }
  } else {
    logInfo(
      `[opencode-litellm] Loaded ${Object.keys(entries).length} models from cache for provider "${id}" (${baseURL}); refresh happens in the background on new sessions.`,
    )
  }

  return {
    id,
    name: provider?.name || 'LiteLLM (proxy)',
    activation: provider?.activation ?? 'enabled',
    package: provider?.package || OPENAI_COMPATIBLE_PACKAGE,
    settings,
    headers: customHeaders,
    integrationID,
    usesConnectionCredential,
    credentialReloadRequired: false,
    refreshRequired: false,
    fromFallback: provider === undefined,
    pendingPublication: true,
    baseURL,
    apiKey,
    customHeaders: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    filters,
    capabilities,
    formatModelNames,
    cacheKey,
    models: toProviderModels(id, entries ?? {}, new Set(responsesIds)),
    ownedModelIds: new Set<string>(),
  }
}

function logInfo(message: string): void {
  console.log(message)
}

async function refreshProviderSource(
  context: Context,
  source: ProviderSource,
  inFlight: Map<string, Promise<void>>,
): Promise<void> {
  const activeRefresh = inFlight.get(source.cacheKey)
  if (activeRefresh) {
    await activeRefresh
    if (source.refreshRequired) await refreshProviderSource(context, source, inFlight)
    return
  }

  const savedAt = readModelCacheSavedAt(source.cacheKey)
  if (
    !source.refreshRequired &&
    savedAt !== null &&
    Date.now() - savedAt < REFRESH_MIN_INTERVAL_MS
  ) {
    return
  }

  const apiKey = source.apiKey
  let refresh!: Promise<void>
  refresh = (async () => {
    try {
      const discovered = await withTimeout(
        discoverModels(
          source.baseURL,
          apiKey,
          source.customHeaders,
          source.id,
          source.filters,
          source.capabilities,
          source.formatModelNames,
        ),
        DISCOVERY_TIMEOUT_MS,
      )
      if (
        !discovered ||
        Object.keys(discovered.models).length === 0 ||
        apiKey !== source.apiKey
      ) {
        return
      }

      const models = toProviderModels(
        source.id,
        discovered.models,
        new Set(discovered.responsesIds),
      )
      if (JSON.stringify(models) === JSON.stringify(source.models)) {
        writeModelCache(source.cacheKey, discovered.models, discovered.responsesIds)
        source.refreshRequired = false
        return
      }

      const previousModels = source.models
      source.models = models
      try {
        await context.provider.reload()
      } catch (error) {
        source.models = previousModels
        throw error
      }

      writeModelCache(source.cacheKey, discovered.models, discovered.responsesIds)
      source.refreshRequired = false
      logInfo(
        `[opencode-litellm] Refreshed ${models.length} models for provider "${source.id}"; the provider registry was reloaded.`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logInfo(`[opencode-litellm] Background refresh failed for provider "${source.id}": ${message}`)
    } finally {
      if (inFlight.get(source.cacheKey) === refresh) inFlight.delete(source.cacheKey)
    }
  })()
  inFlight.set(source.cacheKey, refresh)
  await refresh
}

async function refreshConnectionCredential(
  context: Context,
  source: ProviderSource,
): Promise<boolean> {
  if (!source.integrationID || !source.usesConnectionCredential) return false

  try {
    const connection = await context.integration.connection.active(source.integrationID)
    const credential = connection
      ? await context.integration.connection.resolve(connection)
      : undefined
    const apiKey = credential?.type === 'key' ? credential.key : undefined
    if (apiKey === source.apiKey) return false
    source.apiKey = apiKey
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logInfo(`[opencode-litellm] Could not refresh credentials for provider "${source.id}": ${message}`)
    return false
  }
}

async function refreshProviderSources(
  context: Context,
  sources: ProviderSource[],
  inFlight: Map<string, Promise<void>>,
): Promise<void> {
  const pendingCredentialReload = sources.filter((source) => source.credentialReloadRequired)
  if (pendingCredentialReload.length > 0) {
    try {
      await context.provider.reload()
      for (const source of pendingCredentialReload) source.credentialReloadRequired = false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logInfo(`[opencode-litellm] Could not reload providers after a credential switch: ${message}`)
      return
    }
  }

  await Promise.all(sources.map((source) => refreshProviderSource(context, source, inFlight)))
}

/**
 * LiteLLM-shaped providers the host currently exposes.
 *
 * OpenCode 2 registers user-configured providers *after* plugin setup, so the
 * list has to be re-read on later `provider.updated` events instead of being
 * trusted once at startup. Otherwise a `providers.litellm.settings.baseURL`
 * config is invisible to the plugin and discovery silently falls back to
 * auto-detection.
 */
async function listMatchingProviders(context: Context): Promise<ProviderInfo[]> {
  try {
    const providers = (await context.provider.list()).data
    return providers.filter((provider) =>
      isLiteLLMProvider(provider.id, asRecord(provider.settings)),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logInfo(`[opencode-litellm] Could not read configured providers: ${message}`)
    return []
  }
}

/**
 * Discover and add sources for LiteLLM providers that have appeared since the
 * last reconciliation. Ids already present are left untouched *unless* the
 * existing entry is a fallback that never came from a host-registered
 * provider — in that case it is replaced, so merging a late provider overrides
 * the option/env/auto-detected endpoint (including its baseURL and
 * credentials). Safe to call repeatedly (startup, `provider.updated`,
 * `session.created`). Returns sources that still need publishing via
 * `reload()` (new providers plus any whose previous publication failed).
 */
async function reconcileProviderSources(
  context: Context,
  pluginOptions: Record<string, unknown>,
  sources: Map<string, ProviderSource>,
): Promise<ProviderSource[]> {
  const changed: ProviderSource[] = []
  for (const provider of await listMatchingProviders(context)) {
    const existing = sources.get(provider.id)
    // Skip sources that are both configured (not a fallback) and already
    // published; a pending configured source must be returned so it is retried.
    if (existing && !existing.fromFallback && !existing.pendingPublication) continue
    const source = await makeProviderSource(context, provider, pluginOptions)
    if (!source) continue
    sources.set(source.id, source)
    changed.push(source)
  }
  return changed
}

/**
 * Build and publish a source from the dialog's active credential.
 *
 * Called for the first connect with nothing bound yet, and to rebuild
 * dialog-built sources after a credential switch — a reconnect may move the
 * gateway to a new base URL or provider id, so those sources are re-derived
 * wholesale instead of key-refreshed.
 *
 * An existing source for the same id is left untouched unless it is a pure
 * auto-detection/dialog-built fallback (no explicit baseURL in
 * options/config): a fallback only stands in until a real endpoint is
 * known, so the dialog's answers take over from it. Explicit option/env
 * baseURLs — and host-registered providers — keep winning and are never
 * replaced. Replaced sources' owned model ids carry over so models the
 * gateway no longer serves are dropped on the next merge, and sources
 * replaced under a different id are dropped from `sources` and marked in
 * `staleProviderIds` for removal from the provider registry.
 */
async function publishConnectedSource(
  context: Context,
  pluginOptions: Record<string, unknown>,
  sources: Map<string, ProviderSource>,
  staleProviderIds: Set<string>,
  replacing: ProviderSource[] = [],
): Promise<void> {
  try {
    const source = await makeProviderSource(context, undefined, pluginOptions)
    if (!source) return
    const existing = sources.get(source.id)
    if (existing && !(existing.fromFallback && !readString(existing.settings.baseURL))) return
    const previous = existing ?? replacing.find((candidate) => candidate.id === source.id)
    if (previous) source.ownedModelIds = new Set(previous.ownedModelIds)
    for (const previousSource of replacing) {
      if (previousSource.id === source.id) continue
      const mapped = sources.get(previousSource.id)
      if (mapped === previousSource) sources.delete(previousSource.id)
      // Absent from the map means an earlier attempt already removed it but
      // failed before reloading — still owed a registry removal. A different
      // live source under the id (e.g. a host-registered provider took over)
      // is left entirely alone.
      if (mapped === previousSource || mapped === undefined) {
        staleProviderIds.add(previousSource.id)
      }
    }
    sources.set(source.id, source)
    await context.provider.reload()
    source.pendingPublication = false
    logInfo(
      `[opencode-litellm] Registered provider "${source.id}" from the connected LiteLLM credential.`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logInfo(`[opencode-litellm] Could not register the connected provider: ${message}`)
  }
}

const definition = Plugin.define({
  id: 'opencode-litellm',
  async setup(context) {
    // OpenCode 1.18.x embeds a v2 plugin host whose context has no `provider`
    // domain. It still calls `setup` on any plugin that exports one, but those
    // versions are served by the `server()` entrypoint below. Bail out before
    // touching the logger so `server()`'s client-backed logging stays intact.
    if (!context.provider) return

    initV2Logging()

    const pluginOptions = asRecord(context.options)
    const sources = new Map<string, ProviderSource>()
    // Providers the dialog replaced under a new id; the transform below
    // removes them from the registry on the next reload.
    const staleProviderIds = new Set<string>()

    // Surface LiteLLM in the connect-provider dialog so gateways can be
    // connected from the web UI. Purely additive: a host without the
    // integration API, or a failed registration, keeps every other auth path.
    const integrationRegistration = await registerLiteLLMIntegration(context)

    // First pass. On OpenCode 2 the host has not registered user-configured
    // providers yet, so this typically finds only built-ins; the event loop
    // below reconciles again when they appear.
    await reconcileProviderSources(context, pluginOptions, sources)
    // With no configured provider, fall back to purely option/env-driven
    // discovery so `LITELLM_BASE_URL` and plugin options keep working.
    if (sources.size === 0) {
      const fallback = await makeProviderSource(context, undefined, pluginOptions)
      if (fallback) sources.set(fallback.id, fallback)
    }
    if (sources.size === 0) {
      logInfo(
        '[opencode-litellm] No LiteLLM proxy found. Configure providers.litellm.settings.baseURL or start LiteLLM on port 4000/8000/8080.',
      )
    }

    const providerRegistration = await context.provider.transform((editor) => {
      // Sources replaced under a different id leave their registry entries
      // behind; drop them before publishing the current sources.
      for (const id of staleProviderIds) editor.remove(id)
      staleProviderIds.clear()
      for (const source of sources.values()) {
        const current = editor.get(source.id)
        if (current) {
          editor.update(source.id, (provider) => {
            provider.package = source.package
            provider.name = source.name
            // Bind the provider to the integration its credential comes from,
            // so OpenCode keeps injecting the key after a credential switch.
            if (source.usesConnectionCredential && source.integrationID) {
              provider.integrationID = Integration.ID.make(source.integrationID)
            }
            const settings = {
              ...(provider.settings ?? {}),
              ...runtimeSettings(source),
            }
            // Integration-managed credentials never belong in settings,
            // even if a stale apiKey was materialized there previously.
            if (source.usesConnectionCredential) delete settings.apiKey
            provider.settings = settings
            if (Object.keys(source.headers).length > 0) {
              provider.headers = { ...provider.headers, ...source.headers }
            }
          })
          const merged = mergeProviderModels(
            current.models.values(),
            source.models,
            source.ownedModelIds,
          )
          source.ownedModelIds = merged.owned
          editor.models.set(source.id, merged.models)
        } else {
          source.ownedModelIds = new Set(source.models.map((model) => model.id))
          editor.add({
            info: {
              ...Provider.Info.empty(Provider.ID.make(source.id)),
              name: source.name,
              activation: source.activation,
              package: source.package,
              settings: runtimeSettings(source),
              headers: source.headers,
              // With `integrationID` set, OpenCode resolves the API key from
              // the connected credential at request time — the key itself
              // never enters provider settings.
              ...(source.usesConnectionCredential && source.integrationID
                ? { integrationID: Integration.ID.make(source.integrationID) }
                : {}),
            },
            models: source.models,
          })
        }
      }
      // The initial transform is itself the publication step for sources built
      // during setup, so they are no longer "pending" after this point.
      for (const source of sources.values()) source.pendingPublication = false
    })

    const controller = new AbortController()
    const inFlight = new Map<string, Promise<void>>()

    // Reconciliation is kicked off from the event loop, which must not block on
    // discovery. Overlapping triggers are folded into one follow-up pass, so a
    // provider that shows up mid-discovery is neither missed nor discovered
    // twice.
    let reconcileRunning: Promise<void> | null = null
    let reconcileAgain = false

    const reconcileOnce = async (): Promise<void> => {
      // A newly built source is only "published" once `reload()` succeeds. Until
      // then it stays `pendingPublication`, so the next pass returns and retries
      // it instead of skipping it forever after a transient reload failure.
      let pending: ProviderSource[]
      try {
        pending = await reconcileProviderSources(context, pluginOptions, sources)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logInfo(`[opencode-litellm] Could not reconcile configured providers: ${message}`)
        return
      }
      if (pending.length === 0) return
      try {
        await context.provider.reload()
        for (const source of pending) source.pendingPublication = false
        logInfo(
          `[opencode-litellm] Registered ${pending.length} newly configured LiteLLM provider(s).`,
        )
      } catch (error) {
        // Leave `pendingPublication` set so the next trigger retries instead of
        // treating these sources as already published.
        const message = error instanceof Error ? error.message : String(error)
        logInfo(
          `[opencode-litellm] Could not reload providers after discovering a new provider; will retry: ${message}`,
        )
      }
    }

    const reconcileAndReload = async (): Promise<void> => {
      if (reconcileRunning) {
        reconcileAgain = true
        return reconcileRunning
      }
      reconcileRunning = (async () => {
        do {
          reconcileAgain = false
          await reconcileOnce()
        } while (reconcileAgain)
      })().finally(() => {
        reconcileRunning = null
        // A trigger can land in the gap between the loop's final check and this
        // continuation. Without re-checking, that update would be dropped.
        if (reconcileAgain) void reconcileAndReload()
      })
      return reconcileRunning
    }

    void (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'provider.updated') {
            void reconcileAndReload()
            continue
          }
          if (event.type === 'credential.switched') {
            // Sources the plugin built from the dialog re-derive everything
            // (key, baseURL, provider id) from the active connection, so a
            // reconnect can legitimately move them to a different gateway.
            // Configured sources only refresh their key: config outranks the
            // dialog for everything but the key.
            const dialogBuilt = [...sources.values()].filter(
              (source) =>
                source.integrationID === event.data.integrationID &&
                source.fromFallback &&
                source.usesConnectionCredential &&
                !readString(source.settings.baseURL),
            )
            const changedSources = (await Promise.all(
              [...sources.values()]
                .filter((source) => source.integrationID === event.data.integrationID)
                .map(async (source) =>
                  (await refreshConnectionCredential(context, source)) ? source : undefined,
                ),
            )).filter((source): source is ProviderSource => source !== undefined)
            for (const source of changedSources) {
              source.credentialReloadRequired = true
              source.refreshRequired = true
            }
            const keyOnlySources = changedSources.filter((source) => !dialogBuilt.includes(source))
            if (keyOnlySources.length > 0) {
              await refreshProviderSources(context, keyOnlySources, inFlight)
            }
            if (
              event.data.integrationID === LITELLM_INTEGRATION_ID &&
              (dialogBuilt.length > 0 || changedSources.length === 0)
            ) {
              // Rebuild dialog-built sources from the fresh credential — or,
              // when no source is bound yet, publish the first one, taking
              // over from a keyless auto-detection fallback if one exists.
              await publishConnectedSource(
                context,
                pluginOptions,
                sources,
                staleProviderIds,
                dialogBuilt,
              )
            }
            continue
          }
          if (event.type !== 'session.created') continue
          void (async () => {
            await reconcileAndReload()
            await refreshProviderSources(context, [...sources.values()], inFlight)
          })()
        }
      } catch (error) {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        logInfo(`[opencode-litellm] Event subscription failed: ${message}`)
      }
    })()

    // A provider can register during setup's own auto-detection probes, before
    // the subscription above is established; that `provider.updated` would be
    // lost until the next session. One idempotent pass right after subscribing
    // closes that window.
    void reconcileAndReload()

    return async () => {
      controller.abort()
      await providerRegistration.dispose()
      await integrationRegistration?.dispose()
    }
  },
})

export const LiteLLMPluginDefinition = {
  ...definition,
  // OpenCode 1.18.29+ accepts object-form plugin exports with a server().
  async server(input: PluginInput) {
    return LiteLLMPlugin(input)
  },
}

export default LiteLLMPluginDefinition
