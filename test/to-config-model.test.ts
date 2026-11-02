import { describe, expect, it } from 'vitest'
import { readModelNameTemplate, toConfigModel } from '../src/plugin/index'
import type { LiteLLMModel } from '../src/types'

function model(id: string, extra: Partial<LiteLLMModel> = {}): LiteLLMModel {
  return { id, object: 'model', ...extra }
}

describe('toConfigModel naming (formatModelNames)', () => {
  const chat = model('anthropic/claude-3-5-sonnet')

  it('prettifies the id by default', () => {
    expect(toConfigModel(chat)?.name).toBe('Claude 3.5 Sonnet')
    expect(toConfigModel(chat, undefined, { formatModelNames: true })?.name).toBe('Claude 3.5 Sonnet')
  })

  it('keeps the raw /v1/models id when formatting is disabled', () => {
    expect(toConfigModel(chat, undefined, { formatModelNames: false })?.name).toBe(
      'anthropic/claude-3-5-sonnet',
    )
  })

  it('preserves an explicit false tool-calling capability', () => {
    expect(
      toConfigModel(chat, undefined, { formatModelNames: true })?.tool_call,
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
    expect(toConfigModel(versioned, undefined, { formatModelNames: false })?.name).toBe(
      'claude-opus-4-5@20251101',
    )
    // ...while the formatted view would collapse them.
    expect(toConfigModel(versioned)?.name).toBe('Claude Opus 4.5')
  })

  it('still hides non-chat models regardless of the naming choice', () => {
    const embedding = model('text-embedding-3-large', { mode: 'embedding' })
    expect(toConfigModel(embedding, undefined, { formatModelNames: false })).toBeNull()
    expect(toConfigModel(embedding, undefined, { formatModelNames: true })).toBeNull()
  })
})

describe('toConfigModel naming (modelNameTemplate)', () => {
  const chat = model('anthropic/claude-3-5-sonnet')
  const naming = { providerId: 'litellm-team-a', providerName: 'Team A' }

  it('fills every known placeholder', () => {
    expect(
      toConfigModel(chat, undefined, {
        ...naming,
        modelNameTemplate: '{provider_name} | {provider_id} | {name} | {id}',
      })?.name,
    ).toBe('Team A | litellm-team-a | Claude 3.5 Sonnet | anthropic/claude-3-5-sonnet')
  })

  it('applies the template to the raw id when formatting is disabled', () => {
    expect(
      toConfigModel(chat, undefined, {
        ...naming,
        formatModelNames: false,
        modelNameTemplate: '[{provider_name}] {name}',
      })?.name,
    ).toBe('[Team A] anthropic/claude-3-5-sonnet')
  })

  it('leaves unknown placeholders as written', () => {
    expect(
      toConfigModel(chat, undefined, {
        ...naming,
        modelNameTemplate: '{name} ({team})',
      })?.name,
    ).toBe('Claude 3.5 Sonnet ({team})')
  })

  it('does not expand placeholders inside a resolved value', () => {
    // Single-pass substitution: the `{id}` produced by `{name}` stays literal.
    expect(
      toConfigModel(model('literal-{id}'), undefined, {
        ...naming,
        modelNameTemplate: '{name}/{id}',
      })?.name,
    ).toBe('Literal {id}/literal-{id}')
  })

  it('falls back to the provider id when no display name is configured', () => {
    expect(
      toConfigModel(chat, undefined, {
        providerId: 'litellm-team-b',
        modelNameTemplate: '{name} ({provider_name})',
      })?.name,
    ).toBe('Claude 3.5 Sonnet (litellm-team-b)')
  })

  it('ignores an empty template', () => {
    expect(toConfigModel(chat, undefined, { modelNameTemplate: '   ' })?.name).toBe(
      'Claude 3.5 Sonnet',
    )
  })
})

describe('readModelNameTemplate', () => {
  it('treats the {name} default and empty strings as unset', () => {
    // Default configs must keep the cache key they had before this option.
    expect(readModelNameTemplate({ modelNameTemplate: '{name}' })).toBeUndefined()
    expect(readModelNameTemplate({ modelNameTemplate: '  {name} ' })).toBeUndefined()
    expect(readModelNameTemplate({ modelNameTemplate: '' })).toBeUndefined()
  })

  it('ignores non-strings and keeps the template as written', () => {
    expect(readModelNameTemplate({ modelNameTemplate: 42 })).toBeUndefined()
    expect(readModelNameTemplate({})).toBeUndefined()
    expect(readModelNameTemplate({ modelNameTemplate: ' {name} ({provider_name}) ' })).toBe(
      ' {name} ({provider_name}) ',
    )
  })
})

describe('toConfigModel temperature', () => {
  const chat = model('company/chat')

  it('declares temperature when supported_openai_params lists it', () => {
    expect(
      toConfigModel(chat, { supported_openai_params: ['max_tokens', 'temperature'] })?.temperature,
    ).toBe(true)
  })

  it('leaves temperature unset when the parameter is not listed', () => {
    expect(
      toConfigModel(chat, { supported_openai_params: ['max_tokens', 'reasoning_effort'] })
        ?.temperature,
    ).toBeUndefined()
    expect(toConfigModel(chat, { supported_openai_params: null })?.temperature).toBeUndefined()
  })

  it('leaves temperature unset when /v1/model/info is unavailable', () => {
    expect(toConfigModel(chat)?.temperature).toBeUndefined()
  })
})
