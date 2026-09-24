import { Model, Plugin, Provider } from '@opencode/plugin'
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
import { getOpenCodeStoredApiKey } from '../utils/opencode-auth'
import {
  buildCacheKey,
  readModelCache,
  readModelCacheSavedAt,
  writeModelCache,
} from '../utils/model-cache'
import { normalizeBaseURL, autoDetectLiteLLM } from '../utils/litellm-api'
import { parseModelCapabilities } from '../utils/model-capabilities'
import type { ModelCapabilities } from '../utils/model-capabilities'
import type { ModelFilters } from '../utils/model-filter'

const CHAT_PROVIDER_ID = 'litellm'
const OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible'
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
  filters: ModelFilters
  capabilities: ModelCapabilities
  formatModelNames: boolean
  cacheKey: string
  models: Model.Info[]
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

function mergeProviderModels(
  configured: Iterable<Model.Info>,
  discovered: readonly Model.Info[],
): Model.Info[] {
  const result = new Map<string, Model.Info>()
  for (const model of configured) result.set(model.id, model)
  for (const model of discovered) {
    if (!result.has(model.id)) result.set(model.id, model)
  }
  return [...result.values()]
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
  if (source.apiKey) settings.apiKey = source.apiKey
  return settings
}

async function makeProviderSource(
  context: Context,
  provider: ProviderInfo | undefined,
  pluginOptions: Record<string, unknown>,
): Promise<ProviderSource | null> {
  const id = provider?.id ?? readString(pluginOptions.providerID) ?? CHAT_PROVIDER_ID
  const providerSettings = asRecord(provider?.settings)
  const settings = { ...pluginOptions, ...providerSettings }
  const configuredBaseURL = readString(settings.baseURL)
  const customHeaders = {
    ...readHeaders(pluginOptions.customHeaders),
    ...readCustomHeaders(settings),
    ...readHeaders(provider?.headers),
  }
  let connectedApiKey: string | undefined
  if (provider?.integrationID) {
    try {
      const connection = await context.integration.connection.active(provider.integrationID)
      const credential = connection
        ? await context.integration.connection.resolve(connection)
        : undefined
      if (credential?.type === 'key') connectedApiKey = credential.key
    } catch {
      // A missing or unrelated integration does not prevent other auth sources.
    }
  }
  const configuredApiKey =
    readString(providerSettings.apiKey) ??
    readString(pluginOptions.apiKey) ??
    process.env.LITELLM_API_KEY ??
    process.env.LITELLM_MASTER_KEY
  const usesConnectionCredential = !configuredApiKey && Boolean(provider?.integrationID)
  const apiKey =
    configuredApiKey ??
    connectedApiKey ??
    (await getOpenCodeStoredApiKey(id))
  const filters = readModelFilters(settings)
  const capabilities = parseModelCapabilities(settings.modelCapabilities)
  const formatModelNames = readFormatModelNames(settings)
  const detectedBaseURL = configuredBaseURL
    ? normalizeBaseURL(configuredBaseURL)
    : await autoDetectLiteLLM(apiKey, customHeaders)

  if (!detectedBaseURL) {
    return null
  }

  const baseURL = normalizeBaseURL(detectedBaseURL)
  const cacheKey = buildCacheKey(id, baseURL, filters, capabilities, {
    formatModelNames,
  })
  let entries = readModelCache(cacheKey)

  if (!entries || Object.keys(entries).length === 0) {
    entries = await withTimeout(
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
    if (entries && Object.keys(entries).length > 0) writeModelCache(cacheKey, entries)
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
    integrationID: provider?.integrationID,
    usesConnectionCredential,
    credentialReloadRequired: false,
    refreshRequired: false,
    baseURL,
    apiKey,
    customHeaders: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    filters,
    capabilities,
    formatModelNames,
    cacheKey,
    models: toProviderModels(id, entries ?? {}),
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
      const entries = await withTimeout(
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
      if (!entries || Object.keys(entries).length === 0 || apiKey !== source.apiKey) return

      const models = toProviderModels(source.id, entries)
      if (JSON.stringify(models) === JSON.stringify(source.models)) {
        writeModelCache(source.cacheKey, entries)
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

      writeModelCache(source.cacheKey, entries)
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

const definition = Plugin.define({
  id: 'opencode-litellm',
  async setup(context) {
    initV2Logging()

    const pluginOptions = asRecord(context.options)
    let providers: ProviderInfo[] = []
    try {
      providers = (await context.provider.list()).data
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logInfo(`[opencode-litellm] Could not read configured providers: ${message}`)
    }

    const matchingProviders = providers.filter((provider) =>
      isLiteLLMProvider(provider.id, asRecord(provider.settings)),
    )
    const candidates: Array<ProviderInfo | undefined> = matchingProviders.length
      ? matchingProviders
      : [undefined]
    const sources: ProviderSource[] = []

    for (const candidate of candidates) {
      const source = await makeProviderSource(context, candidate, pluginOptions)
      if (source) sources.push(source)
    }

    if (sources.length === 0) {
      logInfo(
        '[opencode-litellm] No LiteLLM proxy found. Configure providers.litellm.settings.baseURL or start LiteLLM on port 4000/8000/8080.',
      )
    }

    const providerRegistration = await context.provider.transform((editor) => {
      for (const source of sources) {
        const current = editor.get(source.id)
        if (current) {
          editor.update(source.id, (provider) => {
            provider.package = source.package
            provider.name = source.name
            const settings = {
              ...(provider.settings ?? {}),
              ...runtimeSettings(source),
            }
            if (source.usesConnectionCredential && !source.apiKey) delete settings.apiKey
            provider.settings = settings
            if (Object.keys(source.headers).length > 0) {
              provider.headers = { ...provider.headers, ...source.headers }
            }
          })
          editor.models.set(
            source.id,
            mergeProviderModels(current.models.values(), source.models),
          )
        } else {
          editor.add({
            info: {
              ...Provider.Info.empty(Provider.ID.make(source.id)),
              name: source.name,
              activation: source.activation,
              package: source.package,
              settings: runtimeSettings(source),
              headers: source.headers,
            },
            models: source.models,
          })
        }
      }
    })

    const controller = new AbortController()
    const inFlight = new Map<string, Promise<void>>()
    void (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'credential.switched') {
            const changedSources = (await Promise.all(
              sources
                .filter((source) => source.integrationID === event.data.integrationID)
                .map(async (source) =>
                  (await refreshConnectionCredential(context, source)) ? source : undefined,
                ),
            )).filter((source): source is ProviderSource => source !== undefined)
            for (const source of changedSources) {
              source.credentialReloadRequired = true
              source.refreshRequired = true
            }
            if (changedSources.length > 0) {
              await refreshProviderSources(context, changedSources, inFlight)
            }
            continue
          }
          if (event.type !== 'session.created') continue
          void refreshProviderSources(context, sources, inFlight)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        logInfo(`[opencode-litellm] Event subscription failed: ${message}`)
      }
    })()

    return async () => {
      controller.abort()
      await providerRegistration.dispose()
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
