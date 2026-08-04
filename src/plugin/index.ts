import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  autoDetectLiteLLM,
  checkLiteLLMHealth,
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  normalizeBaseURL,
} from '../utils/litellm-api'
import {
  formatModelName,
  categorizeModel,
} from '../utils/format-model-name'
import type { LiteLLMModel, LiteLLMModelInfo } from '../types'

const CHAT_PROVIDER_ID = 'litellm'
// Covers the sequential 3 s health check plus the parallel 15 s
// models/model-info fetch phase, with headroom.
const DISCOVERY_TIMEOUT_MS = 20000

/**
 * OpenCode invokes the `config` hook several times per run with a
 * cumulative config object. Track which model ids we already injected
 * per baseURL so repeat invocations can return early instead of
 * re-querying the proxy.
 */
const injectedModelIds = new Map<string, Set<string>>()

/**
 * Helper to determine if a provider ID or its configured options indicate
 * compatibility with LiteLLM.
 */
function isLiteLLMProvider(
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
function readCustomHeaders(
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
 * Overlay metadata from `/v1/model/info` onto a `/v1/models` entry.
 * Fields already present on the lean entry win; the info block only
 * fills gaps (notably `mode`, which `/v1/models` omits for
 * database-defined models).
 */
function enrichModel(model: LiteLLMModel, info: LiteLLMModelInfo): LiteLLMModel {
  return {
    ...model,
    mode: model.mode ?? info.mode,
    max_tokens: model.max_tokens ?? info.max_tokens,
    max_input_tokens: model.max_input_tokens ?? info.max_input_tokens,
    max_output_tokens: model.max_output_tokens ?? info.max_output_tokens,
    supports_function_calling: model.supports_function_calling ?? info.supports_function_calling,
    supports_vision: model.supports_vision ?? info.supports_vision,
    supports_reasoning: model.supports_reasoning ?? info.supports_reasoning,
    supports_pdf_input: model.supports_pdf_input ?? info.supports_pdf_input,
    supports_audio_input: model.supports_audio_input ?? info.supports_audio_input,
    input_cost_per_token: model.input_cost_per_token ?? info.input_cost_per_token,
    output_cost_per_token: model.output_cost_per_token ?? info.output_cost_per_token,
  }
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
 */
function toConfigModel(model: LiteLLMModel): Record<string, unknown> | null {
  const type = categorizeModel(model)
  if (type === 'embedding' || type === 'image' || type === 'audio') {
    return null
  }
  const entry: Record<string, unknown> = {
    name: formatModelName(model),
  }
  if (model.max_input_tokens || model.max_output_tokens) {
    entry.limit = {
      context: model.max_input_tokens ?? 0,
      output: model.max_output_tokens ?? 0,
    }
  }
  if (model.supports_function_calling) {
    entry.tool_call = true
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
    entry.cost = {
      input: (model.input_cost_per_token ?? 0) * USD_PER_TOKEN_TO_PER_MILLION,
      output: (model.output_cost_per_token ?? 0) * USD_PER_TOKEN_TO_PER_MILLION,
    }
  }
  const input: Array<'text' | 'image' | 'pdf' | 'audio'> = ['text']
  if (model.supports_vision) input.push('image')
  if (model.supports_pdf_input) input.push('pdf')
  if (model.supports_audio_input) input.push('audio')
  if (input.length > 1) {
    entry.modalities = { input, output: ['text'] }
  }
  return entry
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
export const LiteLLMPlugin: Plugin = async (_input: PluginInput) => {
  return {
    config: async (config: any) => {
      // Ensure the provider entry exists
      if (!config.provider) config.provider = {}

      // Find all matching LiteLLM providers
      const providerIds = Object.keys(config.provider)
      const liteLLMProviders: Array<{ id: string; provider: Record<string, unknown> }> = []

      for (const id of providerIds) {
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
          process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
        const apiKey = configuredKey ?? envKey
        const customHeaders = readCustomHeaders(options)

        // Resolve base URL
        let baseURL: string | null = null
        if (configuredBase) {
          baseURL = normalizeBaseURL(configuredBase)
        } else {
          baseURL = await autoDetectLiteLLM(apiKey, customHeaders)
        }

        if (!baseURL) {
          console.warn(
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
          actualProvider.options = { baseURL: `${baseURL}/v1` }
        } else {
          const actualOptions = actualProvider.options as Record<string, unknown>
          if (!actualOptions.baseURL) {
            actualOptions.baseURL = `${baseURL}/v1`
          }
        }

        if (!actualProvider.models) {
          actualProvider.models = {}
        }

        const models = actualProvider.models as Record<string, unknown>

        // Discover models with timeout
        const work = async () => {
          const alreadyInjected = injectedModelIds.get(baseURL!)
          if (
            alreadyInjected &&
            [...alreadyInjected].every((id) => models[id])
          ) {
            return
          }

          if (!(await checkLiteLLMHealth(baseURL!, apiKey, customHeaders))) {
            console.warn(
              `[opencode-litellm] LiteLLM appears offline or unauthorized for provider "${providerId}" at ${baseURL}`,
            )
            return
          }

          // `/v1/models` omits `mode` and capability metadata for
          // database-defined models, so fetch `/v1/model/info` alongside
          // it. The info call is best-effort: without it, classification
          // falls back to id heuristics.
          const [modelsResult, infoResult] = await Promise.allSettled([
            discoverLiteLLMModels(baseURL!, apiKey, customHeaders),
            discoverLiteLLMModelInfo(baseURL!, apiKey, customHeaders),
          ])

          if (modelsResult.status === 'rejected') {
            const error = modelsResult.reason
            console.warn(
              `[opencode-litellm] Model discovery failed for provider "${providerId}":`,
              error instanceof Error ? error.message : String(error),
            )
            return
          }

          const discovered = modelsResult.value
          let infoByName: Map<string, LiteLLMModelInfo> | null = null
          if (infoResult.status === 'fulfilled') {
            infoByName = infoResult.value
          } else {
            const reason = infoResult.reason
            console.warn(
              `[opencode-litellm] /v1/model/info unavailable for provider "${providerId}"; non-chat model filtering will use id heuristics only:`,
              reason instanceof Error ? reason.message : String(reason),
            )
          }

          if (discovered.length === 0) {
            console.warn(
              `[opencode-litellm] LiteLLM responded for provider "${providerId}" but exposed zero models.`,
            )
            return
          }

          let added = 0
          let skipped = 0
          let wildcards = 0
          const unmatched: string[] = []
          for (const model of discovered) {
            // Wildcard entries (`deepseek/*`) are access rules, not
            // callable models — invoking one sends a literal `*` upstream.
            if (model.id.includes('*')) {
              wildcards++
              continue
            }
            // Don't overwrite user-curated entries
            if (models[model.id]) continue
            const info = infoByName?.get(model.id)
            if (infoByName && !info) unmatched.push(model.id)
            const entry = toConfigModel(info ? enrichModel(model, info) : model)
            if (!entry) {
              skipped++
              continue
            }
            models[model.id] = entry
            added++
          }

          if (unmatched.length > 0) {
            console.warn(
              `[opencode-litellm] /v1/model/info has no entry for ${unmatched.length} model(s) on provider "${providerId}"; ` +
                `classification uses id heuristics for: ${unmatched.slice(0, 5).join(', ')}` +
                (unmatched.length > 5 ? `, +${unmatched.length - 5} more` : ''),
            )
          }

          // Remove the seed placeholder if real models were discovered
          if (models['_'] && Object.keys(models).length > 1) {
            delete models['_']
          }

          injectedModelIds.set(baseURL!, new Set(Object.keys(models)))

          console.log(
            `[opencode-litellm] Discovered ${discovered.length} models for provider "${providerId}" from ${baseURL} ` +
              `(${added} added` +
              (skipped > 0 ? `, ${skipped} non-chat hidden` : '') +
              (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
              ')',
          )
        }

        await Promise.race([
          work(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, DISCOVERY_TIMEOUT_MS),
          ),
        ])
      }
    },
  }
}

// Re-export the responses plugin for backwards compat, but it's now a no-op.
// The config hook approach handles all models in a single provider.
export const LiteLLMResponsesPlugin: Plugin = async (_input: PluginInput) => {
  return {}
}
