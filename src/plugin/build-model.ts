import type { Model as ModelV2 } from '@opencode-ai/sdk/v2'
import type { LiteLLMModel, LiteLLMModelInfo } from '../types'
import {
  categorizeModel,
  formatModelName,
} from '../utils/format-model-name'

/**
 * Build an OpenCode V2 `Model` entry from a discovered LiteLLM model.
 *
 * The V2 schema requires a lot of fields we have no real data for
 * (`cost`, `limit`, `release_date`, …). We fill these with sensible
 * defaults — zero cost / zero limits / today's date — so the entry
 * type-checks and the picker renders something useful. Real values
 * can be added in a future release if LiteLLM exposes them via
 * `/v1/model/info`, which carries `max_tokens`, `input_cost_per_token`,
 * etc.
 */
export function buildModelV2(
  providerID: string,
  api: { id: string; url: string; npm: string },
  model: LiteLLMModel,
  info?: LiteLLMModelInfo,
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
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
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
    variants: info?.supports_reasoning_efforts?.length
      ? Object.fromEntries(
          info.supports_reasoning_efforts.map((effort) => [
            effort,
            { reasoningEffort: effort },
          ]),
        )
      : undefined,
  }
}
