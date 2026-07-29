// Core types for the LiteLLM OpenCode plugin

/**
 * A single model entry returned by LiteLLM's `/v1/models` endpoint.
 * LiteLLM follows the OpenAI-compatible schema.
 */
export interface LiteLLMModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  /**
   * LiteLLM-specific extension. Some deployments include the underlying
   * provider (e.g. "openai", "anthropic", "bedrock") here.
   */
  litellm_provider?: string
  /**
   * Optional capability metadata. Present on `/v1/models` only for some
   * deployments; reliably available via `/v1/model/info` and merged onto
   * the discovered entry by the plugin.
   *
   * Newer LiteLLM versions may expose `'responses'` here for models
   * that must be routed through the OpenAI Responses API rather than
   * `/v1/chat/completions` (e.g. `gpt-5*`, `o1/o3/o4*` with reasoning).
   */
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
}

export interface LiteLLMModelsResponse {
  object: string
  data: LiteLLMModel[]
}

/**
 * The `model_info` block of a `/v1/model/info` entry. This endpoint
 * reliably carries `mode` (and token limits) even for database-defined
 * models, where `/v1/models` only returns the lean OpenAI schema.
 */
export interface LiteLLMModelInfo {
  id?: string
  db_model?: boolean
  /** Alias LiteLLM assigns to the model; mirrors the `/v1/models` id. */
  key?: string
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
  /**
   * Cost per token (in USD). Populated from `/v1/model/info`; defaults
   * to 0 if the endpoint is unreachable or the field is absent.
   */
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

/** A single entry returned by LiteLLM's `/v1/model/info` endpoint. */
export interface LiteLLMModelInfoEntry {
  model_name: string
  litellm_params?: Record<string, unknown>
  model_info?: LiteLLMModelInfo
}

export interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfoEntry[]
}

export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'unknown'

/**
 * Which OpenAI-compatible HTTP surface a model should be invoked through.
 *
 * - `chat`      → `/v1/chat/completions` (most models)
 * - `responses` → `/v1/responses`        (gpt-5*, o-series with reasoning)
 */
export type Transport = 'chat' | 'responses'

/**
 * User-facing routing override. Defaults to `'auto'`.
 *
 * - `'auto'`      → use the heuristic + LiteLLM `mode` field
 * - `'chat'`      → force every discovered model into the chat-completions provider
 * - `'responses'` → force every discovered model into the responses provider
 */
export type TransportPolicy = 'auto' | Transport

export interface LiteLLMOptions {
  baseURL?: string
  apiKey?: string
  /**
   * Routing policy for discovered models. See {@link TransportPolicy}.
   * Defaults to `'auto'`.
   */
  transport?: TransportPolicy
  /**
   * Explicit allowlist of model ids that MUST be routed through the
   * OpenAI Responses API (`/v1/responses`). Takes priority over the
   * heuristic and over the `transport` policy.
   *
   * Match is exact against the LiteLLM model id (e.g. `"gpt-5-4-high"`).
   */
  responsesApiModels?: string[]
  /**
   * Explicit denylist of model ids that MUST be routed through chat
   * completions (`/v1/chat/completions`), even if the heuristic would
   * otherwise put them in the responses bucket. Takes priority over
   * the heuristic but is overridden by `responsesApiModels`.
   */
  chatApiModels?: string[]
  /**
   * Arbitrary HTTP headers to include in every request to the LiteLLM
   * proxy during model discovery (health check + `/v1/models`).
   *
   * Useful for proxies behind Cloudflare Access or other gateways that
   * require extra authentication headers beyond the standard
   * `Authorization: Bearer` token.
   *
   * Example (Cloudflare Access Service Token):
   * ```json
   * {
   *   "customHeaders": {
   *     "CF-Access-Client-Id": "{env:CF_ACCESS_CLIENT_ID}",
   *     "CF-Access-Client-Secret": "{env:CF_ACCESS_CLIENT_SECRET}"
   *   }
   * }
   * ```
   */
  customHeaders?: Record<string, string>
}
