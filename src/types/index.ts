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
  /**
   * USD price per input/output token, reliably available via
   * `/v1/model/info` (`/v1/models` omits pricing). Absent for models
   * LiteLLM has no price anchor for (e.g. rerank) — treat as "unknown",
   * not "free".
   */
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
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
  supports_reasoning_efforts?: string[]
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
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
