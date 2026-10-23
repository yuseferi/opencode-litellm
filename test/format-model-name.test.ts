import { describe, expect, it } from 'vitest'
import { categorizeModel, formatModelName } from '../src/utils/format-model-name'
import type { LiteLLMModel } from '../src/types'

function model(id: string, extra: Partial<LiteLLMModel> = {}): LiteLLMModel {
  return { id, object: 'model', ...extra }
}

describe('formatModelName', () => {
  const cases: Array<[string, string]> = [
    ['openai/gpt-4o-mini', 'GPT 4o Mini'],
    ['anthropic/claude-3-5-sonnet', 'Claude 3.5 Sonnet'],
    ['claude-opus-4-5', 'Claude Opus 4.5'],
    ['claude-opus-4-5@20251101', 'Claude Opus 4.5'],
    ['claude-sonnet-4-6@default', 'Claude Sonnet 4.6'],
    ['bedrock/amazon.nova-pro-v1', 'Amazon Nova Pro V1'],
    ['qwen/qwen3-30b-a3b', 'Qwen3 30B A3B'],
    ['gemini/gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ['openai/whisper-large-v3', 'Whisper Large V3'],
    ['gpt/dall-e-3', 'Dall E 3'],
    ['llama-3.1-8b-instruct-q4_0', 'Llama 3.1 8B Instruct Q4 0'],
    ['litellm/deepseek-v3.2', 'DeepSeek V3.2'],
    ['litellm/glm-5.3', 'GLM 5.3'],
    ['litellm/kimi-k2.5', 'Kimi K2.5'],
    ['litellm/minimax-m2.5', 'MiniMax M2.5'],
  ]

  it.each(cases)('formats %s as %s', (id, expected) => {
    expect(formatModelName(model(id))).toBe(expected)
  })

  it('merges a version pair followed by a dash-separated date stamp', () => {
    expect(formatModelName(model('claude-opus-4-5-20251101'))).toBe(
      'Claude Opus 4.5 20251101',
    )
  })

  it('does not merge version pairs inside longer numeric runs', () => {
    // `turbo` separates the pair; trailing `16k` is a size token.
    expect(formatModelName(model('gpt-3-5-turbo-16k'))).toBe('GPT 3.5 Turbo 16K')
    // A short number before the pair also blocks the merge.
    expect(formatModelName(model('model-1-2-3'))).toBe('Model 1 2 3')
  })

  it('keeps a provider-prefixed vendor name in the display', () => {
    expect(formatModelName(model('bedrock/amazon.nova-pro-v1'))).toContain('Amazon')
  })

  it('falls back to the raw id when tokenisation yields nothing', () => {
    expect(formatModelName(model('---'))).toBe('---')
  })
})

describe('categorizeModel', () => {
  it('uses the mode field when present', () => {
    expect(categorizeModel(model('text-embedding-3-small', { mode: 'embedding' }))).toBe('embedding')
    expect(categorizeModel(model('dall-e-3', { mode: 'image_generation' }))).toBe('image')
    expect(categorizeModel(model('whisper-1', { mode: 'audio_transcription' }))).toBe('audio')
    expect(categorizeModel(model('tts-1', { mode: 'audio_speech' }))).toBe('audio')
    expect(categorizeModel(model('gpt-4o', { mode: 'chat' }))).toBe('chat')
  })

  it('falls back to id heuristics without a mode', () => {
    expect(categorizeModel(model('mistral/mistral-embed'))).toBe('embedding')
    expect(categorizeModel(model('flux-dev'))).toBe('image')
    expect(categorizeModel(model('whisper-large-v3'))).toBe('audio')
    expect(categorizeModel(model('some-unknown-model'))).toBe('chat')
  })
})
