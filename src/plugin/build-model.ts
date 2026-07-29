import type { Model as ModelV2 } from '@opencode-ai/sdk/v2'
import type { LiteLLMModel, LiteLLMModelInfo } from '../types'
import {
  categorizeModel,
  formatModelName,
} from '../utils/format-model-name'

/**
 * Build an OpenCode V2 `Model` entry from a discovered LiteLLM model.
 *
 * Cost data is populated from `/v1/model/info` (`info` param).
 * Falls back to zero when the endpoint is unreachable.
 */
export function buildModelV2(
  providerID: string,
  api: { id: string; url: string; npm: string },
  model: LiteLLMModel,
  info: LiteLLMModelInfo,
): ModelV2 {
  const type = categorizeModel(model)
  const isVision = !!model.supports_vision
  const isAudio = type === 'audio'
  const isImageOut = type === 'image'

  return {
    id: model.id,
    providerID,
    api,
    name: formatModelName(model),
    capabilities: {
      temperature: true,
      reasoning: !!model.supports_reasoning,
      attachment: isVision || isAudio,
      toolcall: !!model.supports_function_calling,
      input: {
        text: true,
        audio: isAudio,
        image: isVision,
        video: false,
        pdf: !!model.supports_pdf_input,
      },
      output: {
        text: !isImageOut,
        audio: false,
        image: isImageOut,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      // OpenCode uses dollars per million tokens ($/M tokens);
      // LiteLLM returns dollars per token. Multiply by 1e6.
      input: (info.input_cost_per_token ?? 0) * 1_000_000,
      output: (info.output_cost_per_token ?? 0) * 1_000_000,
      cache: {
        read: (info.cache_read_input_token_cost ?? 0) * 1_000_000,
        write: (info.cache_creation_input_token_cost ?? 0) * 1_000_000,
      },
    },
    limit: {
      context: model.max_input_tokens ?? 0,
      input: model.max_input_tokens,
      output: model.max_output_tokens ?? 0,
    },
    status: 'active',
    options: {},
    headers: {},
    release_date: '',
  }
}
