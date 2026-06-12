import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import type { Provider } from '@opencode-ai/sdk'
import type { Auth } from '@opencode-ai/sdk/v2'
import {
  autoDetectLiteLLM,
  checkLiteLLMHealth,
  discoverLiteLLMModels,
  normalizeBaseURL,
} from '../utils/litellm-api'
import {
  formatModelName,
  extractModelOwner,
  categorizeModel,
} from '../utils/format-model-name'
import { discoverBucket } from './discover'
import type { LiteLLMModel } from '../types'

const PROVIDER_ID = 'litellm'
const DISCOVERY_TIMEOUT_MS = 5000

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
 * Convert a discovered LiteLLM model into an OpenCode config-level
 * model entry (the shape used in `provider.*.models` inside
 * `opencode.json`).
 */
function toConfigModel(model: LiteLLMModel): Record<string, unknown> {
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
  if (model.supports_vision) {
    entry.attachment = true
  }
  return entry
}

/**
 * LiteLLM Plugin for OpenCode.
 *
 * Resolves credentials via the SDK `auth` hook so the user is prompted
 * once via opencode's `/connect` flow and the key is stored in opencode's
 * auth store — no inline `apiKey` needed in `opencode.json`.
 *
 * The `auth.loader` callback injects the stored key into provider options
 * before the AI SDK adapter initialises, so `@ai-sdk/openai-compatible`
 * always sees a populated `Authorization` header.
 *
 * The `provider.models` hook activates dynamic model discovery: opencode
 * calls it when the model picker opens and passes the resolved `Auth`
 * object via `ctx.auth`. This replaces the earlier `config`-hook approach
 * which ran at startup and could not access stored credentials.
 *
 * The `config` hook is kept as a fallback for opencode <1.14.50 and for
 * users who prefer explicit `options.baseURL` / env-var auth.
 *
 * Minimum required opencode version: 1.14.50
 */
export const LiteLLMPlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  return {
    // ── Auth: register /connect flow and inject stored key ─────────────────
    auth: {
      provider: PROVIDER_ID,

      /**
       * Called by opencode after it loads stored credentials for this
       * provider. Return value is merged into `provider.options`, so
       * setting `apiKey` here populates the Authorization header for
       * every AI SDK request without requiring it in opencode.json.
       */
      loader: async (
        getAuth: () => Promise<Auth>,
        _provider: Provider,
      ): Promise<Record<string, unknown>> => {
        try {
          const auth = await getAuth()
          if (auth?.type === 'api' && auth.key) {
            return { apiKey: auth.key }
          }
        } catch {
          // No stored credentials yet — user will be prompted via /connect.
        }
        return {}
      },

      methods: [
        {
          type: 'api',
          label: 'API key',
          prompts: [
            {
              type: 'text',
              key: 'key',
              message: 'LiteLLM master key',
              placeholder: 'sk-…',
            },
          ],
          authorize: async (inputs?: Record<string, string>) => {
            const key = inputs?.key?.trim()
            if (!key) return { type: 'failed' }
            return { type: 'success', key }
          },
        },
      ],
    },

    // ── Provider: dynamic model discovery via SDK hook ──────────────────────
    provider: {
      id: PROVIDER_ID,

      /**
       * Called by opencode when the model picker opens for this provider.
       * `ctx.auth` carries the stored API key (populated by `auth.loader`
       * above). We pass it through to `discoverBucket` so discovery uses
       * the same key as the chat requests.
       */
      models: async (providerV2, ctx) => {
        const ctxAuthKey =
          ctx.auth?.type === 'api' ? ctx.auth.key : undefined
        // Inject ctx key into provider options so resolveEndpoint picks it up.
        const enrichedProvider = ctxAuthKey
          ? {
              ...providerV2,
              options: {
                ...(providerV2.options ?? {}),
                apiKey: ctxAuthKey,
              },
            }
          : providerV2

        return discoverBucket(
          'all',
          enrichedProvider as any,
          {
            id: PROVIDER_ID,
            url: (providerV2.options as any)?.baseURL ?? '',
            npm: '@ai-sdk/openai-compatible',
          },
        )
      },
    },

    // ── Config: startup fallback for model injection ────────────────────────
    config: async (config: any) => {
      if (!config.provider) config.provider = {}

      const existing = config.provider[PROVIDER_ID] as
        | Record<string, unknown>
        | undefined
      const options = (existing?.options ?? {}) as Record<string, unknown>
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

      let baseURL: string | null = null
      if (configuredBase) {
        baseURL = normalizeBaseURL(configuredBase)
      } else {
        baseURL = await autoDetectLiteLLM(apiKey, customHeaders)
      }

      if (!baseURL) {
        console.warn(
          '[opencode-litellm] No LiteLLM proxy found. Configure provider.litellm.options.baseURL or start LiteLLM on port 4000/8000/8080.',
        )
        return
      }

      if (!existing) {
        config.provider[PROVIDER_ID] = {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM (proxy)',
          options: { baseURL: `${baseURL}/v1` },
          models: {},
        }
      }

      const provider = config.provider[PROVIDER_ID] as Record<string, unknown>
      if (!provider.npm) provider.npm = '@ai-sdk/openai-compatible'
      if (!provider.options) provider.options = { baseURL: `${baseURL}/v1` }
      if (!provider.models) provider.models = {}

      const models = provider.models as Record<string, unknown>

      const work = async () => {
        if (!(await checkLiteLLMHealth(baseURL!, apiKey, customHeaders))) {
          console.warn(
            `[opencode-litellm] LiteLLM appears offline or unauthorized at ${baseURL}`,
          )
          return
        }

        let discovered: LiteLLMModel[]
        try {
          discovered = await discoverLiteLLMModels(baseURL!, apiKey, customHeaders)
        } catch (error) {
          console.warn(
            '[opencode-litellm] Model discovery failed:',
            error instanceof Error ? error.message : String(error),
          )
          return
        }

        if (discovered.length === 0) {
          console.warn(
            '[opencode-litellm] LiteLLM responded but exposed zero models.',
          )
          return
        }

        for (const model of discovered) {
          if (models[model.id]) continue
          models[model.id] = toConfigModel(model)
        }

        if (models['_'] && Object.keys(models).length > 1) {
          delete models['_']
        }

        console.log(
          `[opencode-litellm] Discovered ${discovered.length} models from ${baseURL}`,
        )
      }

      await Promise.race([
        work(),
        new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_TIMEOUT_MS)),
      ])
    },
  }
}

// Re-export the responses plugin for backwards compat, but it's now a no-op.
export const LiteLLMResponsesPlugin: Plugin = async (_input: PluginInput) => {
  return {}
}
