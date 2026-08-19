import type { Model as ModelV2, Provider as ProviderV2 } from '@opencode-ai/sdk/v2'
import {
  autoDetectLiteLLM,
  checkLiteLLMHealth,
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  normalizeBaseURL,
} from '../utils/litellm-api'
import { requiresResponsesAPI } from '../utils/format-model-name'
import { passesModelFilter } from '../utils/model-filter'
import type { LiteLLMModel, LiteLLMModelInfo, Transport, TransportPolicy } from '../types'
import { buildModelV2 } from './build-model'

const DISCOVERY_TIMEOUT_MS = 5000

/**
 * Decide which transport bucket a model belongs to. Order of
 * precedence (highest first):
 *
 *   1. Explicit allowlist `responsesApiModels`        → 'responses'
 *   2. Explicit denylist  `chatApiModels`             → 'chat'
 *   3. Global policy `transport: 'chat' | 'responses'`
 *   4. Heuristic via {@link requiresResponsesAPI}     → 'responses' or 'chat'
 */
function pickTransport(
  model: LiteLLMModel,
  policy: TransportPolicy,
  responsesApiModels: ReadonlySet<string>,
  chatApiModels: ReadonlySet<string>,
): Transport {
  if (responsesApiModels.has(model.id)) return 'responses'
  if (chatApiModels.has(model.id)) return 'chat'
  if (policy === 'chat') return 'chat'
  if (policy === 'responses') return 'responses'
  return requiresResponsesAPI(model) ? 'responses' : 'chat'
}

/**
 * Resolve the LiteLLM `baseURL` and `apiKey` to use for discovery.
 *
 * Looks at the configured provider options first (so the user's
 * `opencode.json` wins), then falls back to env vars, and finally to
 * auto-detecting a local proxy on the common ports.
 */
/**
 * Extract the `customHeaders` map from the provider options block.
 * Returns `undefined` when no custom headers are configured.
 */
function readCustomHeaders(
  provider: ProviderV2 | undefined,
): Record<string, string> | undefined {
  const options = (provider?.options ?? {}) as Record<string, unknown>
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

async function resolveEndpoint(
  provider: ProviderV2 | undefined,
): Promise<{ baseURL: string; apiKey?: string; customHeaders?: Record<string, string> } | null> {
  const options = (provider?.options ?? {}) as Record<string, unknown>
  const configuredBase = typeof options.baseURL === 'string' ? options.baseURL : undefined
  const configuredKey = typeof options.apiKey === 'string' && options.apiKey ? options.apiKey : undefined
  const envKey = process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
  const customHeaders = readCustomHeaders(provider)

  if (configuredBase) {
    return { baseURL: normalizeBaseURL(configuredBase), apiKey: configuredKey ?? envKey, customHeaders }
  }

  const detected = await autoDetectLiteLLM(configuredKey ?? envKey, customHeaders)
  if (!detected) return null
  return { baseURL: normalizeBaseURL(detected), apiKey: configuredKey ?? envKey, customHeaders }
}

/**
 * Read the routing policy and per-model overrides off the provider's
 * `options` block. Defaults to `'auto'` with empty allow/deny lists.
 */
function readRoutingOptions(
  provider: ProviderV2 | undefined,
): {
  policy: TransportPolicy
  responsesApiModels: Set<string>
  chatApiModels: Set<string>
} {
  const options = (provider?.options ?? {}) as Record<string, unknown>
  const policy =
    typeof options.transport === 'string' &&
    (options.transport === 'auto' || options.transport === 'chat' || options.transport === 'responses')
      ? (options.transport as TransportPolicy)
      : 'auto'
  const responses = Array.isArray(options.responsesApiModels)
    ? options.responsesApiModels.filter((v): v is string => typeof v === 'string')
    : []
  const chat = Array.isArray(options.chatApiModels)
    ? options.chatApiModels.filter((v): v is string => typeof v === 'string')
    : []
  return {
    policy,
    responsesApiModels: new Set(responses),
    chatApiModels: new Set(chat),
  }
}

/**
 * Discover all models from the LiteLLM proxy and bucket them by the
 * transport (`chat` vs `responses`) they should use. Returns a map of
 * model id → V2 `Model` for the requested bucket only.
 *
 * Pass `bucket: 'all'` to ignore the routing heuristic and return
 * every discovered model. Useful for the default chat-only setup
 * where the user hasn't declared a sibling `litellm-responses`
 * provider — without `'all'`, gpt-5* / o-series models would be
 * silently dropped.
 *
 * Capped at {@link DISCOVERY_TIMEOUT_MS} so a slow / unreachable
 * proxy never stalls OpenCode startup.
 */
export async function discoverBucket(
  bucket: Transport | 'all',
  provider: ProviderV2 | undefined,
  api: { id: string; url: string; npm: string },
): Promise<Record<string, ModelV2>> {
  const out: Record<string, ModelV2> = {}

  const work = async () => {
    const endpoint = await resolveEndpoint(provider)
    if (!endpoint) return

    const { baseURL, apiKey, customHeaders } = endpoint
    if (!(await checkLiteLLMHealth(baseURL, apiKey, customHeaders))) {
      console.warn(`[opencode-litellm] LiteLLM appears offline or unauthorized at ${baseURL}`)
      return
    }

    const [modelsResult, infoResult] = await Promise.allSettled([
      discoverLiteLLMModels(baseURL, apiKey, customHeaders),
      discoverLiteLLMModelInfo(baseURL, apiKey, customHeaders),
    ])

    if (modelsResult.status === 'rejected') {
      console.warn(
        '[opencode-litellm] Model discovery failed:',
        modelsResult.reason instanceof Error ? modelsResult.reason.message : String(modelsResult.reason),
      )
      return
    }
    const models = modelsResult.value

    let infoByName: Map<string, LiteLLMModelInfo> | null = null
    if (infoResult.status === 'fulfilled') {
      infoByName = infoResult.value
    } else {
      console.warn(
        '[opencode-litellm] /v1/model/info unavailable; model costs will be zero:',
        infoResult.reason instanceof Error ? infoResult.reason.message : String(infoResult.reason),
      )
    }

    if (models.length === 0) {
      console.warn(
        '[opencode-litellm] LiteLLM responded but exposed zero models. Check your `model_list` in litellm config.yaml',
      )
      return
    }

    const resolvedApi = { ...api, url: `${baseURL}/v1` }

    const routing = readRoutingOptions(provider)
    const options = (provider?.options ?? {}) as Record<string, unknown>
    const includeModels = Array.isArray(options.includeModels)
      ? options.includeModels.filter((v): v is string => typeof v === 'string')
      : undefined
    const excludeModels = Array.isArray(options.excludeModels)
      ? options.excludeModels.filter((v): v is string => typeof v === 'string')
      : undefined
    for (const model of models) {
      // `includeModels`/`excludeModels` let one LiteLLM proxy be split
      // across several OpenCode providers (e.g. by upstream naming
      // prefix) without hand-maintaining a model list.
      if (!passesModelFilter(model.id, includeModels, excludeModels)) continue
      if (bucket !== 'all') {
        const transport = pickTransport(
          model,
          routing.policy,
          routing.responsesApiModels,
          routing.chatApiModels,
        )
        if (transport !== bucket) continue
      }
      // OpenCode's @ai-sdk/openai-compatible adapter uses `api.id` as
      // the wire model name sent to the upstream LiteLLM endpoint
      // (verified empirically — without this override the wire request
      // sends the provider id "litellm" instead, and LiteLLM rejects
      // it with "team not allowed"). Set `api.id` per-model so each
      // entry carries the correct upstream model name.
      const perModelApi = { ...resolvedApi, id: model.id }
      const info = infoByName?.get(model.id) ?? {}
      out[model.id] = buildModelV2(resolvedApi.id, perModelApi, model, info)
    }
  }

  await Promise.race([
    work(),
    new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_TIMEOUT_MS)),
  ])

  return out
}
