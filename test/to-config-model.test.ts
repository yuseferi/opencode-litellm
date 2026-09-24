import { describe, expect, it } from 'vitest'
import { toConfigModel } from '../src/plugin/index'
import type { LiteLLMModel } from '../src/types'

function model(id: string, extra: Partial<LiteLLMModel> = {}): LiteLLMModel {
  return { id, object: 'model', ...extra }
}

describe('toConfigModel naming (formatModelNames)', () => {
  const chat = model('anthropic/claude-3-5-sonnet')

  it('prettifies the id by default', () => {
    expect(toConfigModel(chat)?.name).toBe('Claude 3.5 Sonnet')
    expect(toConfigModel(chat, undefined, true)?.name).toBe('Claude 3.5 Sonnet')
  })

  it('keeps the raw /v1/models id when formatting is disabled', () => {
    expect(toConfigModel(chat, undefined, false)?.name).toBe(
      'anthropic/claude-3-5-sonnet',
    )
  })

  it('preserves an explicit false tool-calling capability', () => {
    expect(
      toConfigModel(chat, undefined, true)?.tool_call,
    ).toBeUndefined()
    expect(
      toConfigModel(model('text-only', { supports_function_calling: false }))?.tool_call,
    ).toBe(false)
  })

  it('preserves an explicit no-vision modality override', () => {
    expect(
      toConfigModel(model('text-only', { supports_vision: false }))?.modalities,
    ).toEqual({ input: ['text'], output: ['text'] })
  })

  it('defaults to text-only when capability metadata is absent', () => {
    expect(toConfigModel(model('text-only'))?.modalities).toEqual({
      input: ['text'],
      output: ['text'],
    })
  })

  it('leaves provider prefixes and version suffixes intact when raw', () => {
    const versioned = model('claude-opus-4-5@20251101')
    expect(toConfigModel(versioned, undefined, false)?.name).toBe(
      'claude-opus-4-5@20251101',
    )
    // ...while the formatted view would collapse them.
    expect(toConfigModel(versioned)?.name).toBe('Claude Opus 4.5')
  })

  it('still hides non-chat models regardless of the naming choice', () => {
    const embedding = model('text-embedding-3-large', { mode: 'embedding' })
    expect(toConfigModel(embedding, undefined, false)).toBeNull()
    expect(toConfigModel(embedding, undefined, true)).toBeNull()
  })
})
