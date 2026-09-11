import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_FLAGS,
  applyCapabilityOverrides,
  parseModelCapabilities,
} from '../src/utils/model-capabilities'

describe('parseModelCapabilities', () => {
  it('returns an empty map for non-object input', () => {
    expect(parseModelCapabilities(undefined)).toEqual({})
    expect(parseModelCapabilities(null)).toEqual({})
    expect(parseModelCapabilities('supports_vision')).toEqual({})
    expect(parseModelCapabilities(['supports_vision'])).toEqual({})
  })

  it('keeps boolean flags and drops non-boolean values', () => {
    expect(
      parseModelCapabilities({
        'gpt-4o': { supports_vision: true, mode: 'chat', supports_reasoning: 'yes' },
      }),
    ).toEqual({ 'gpt-4o': { supports_vision: true } })
  })

  it('preserves explicit false overrides', () => {
    expect(parseModelCapabilities({ 'gpt-4o': { supports_vision: false } })).toEqual({
      'gpt-4o': { supports_vision: false },
    })
  })

  it('accepts capability keys beyond the known flags', () => {
    expect(
      parseModelCapabilities({ 'gpt-4o': { supports_prompt_caching: true } }),
    ).toEqual({ 'gpt-4o': { supports_prompt_caching: true } })
  })

  it('skips ids whose flags contain no boolean values', () => {
    expect(parseModelCapabilities({ m1: { mode: 'chat' }, m2: {} })).toEqual({})
  })

  it('skips non-object per-model values', () => {
    expect(
      parseModelCapabilities({ m1: true, m2: 'vision', m3: ['supports_vision'] }),
    ).toEqual({})
  })
})

describe('applyCapabilityOverrides', () => {
  it('spreads overrides over the base model so explicit false wins', () => {
    expect(
      applyCapabilityOverrides({ id: 'gpt-4o', supports_vision: true }, { supports_vision: false }),
    ).toEqual({ id: 'gpt-4o', supports_vision: false })
  })

  it('adds capability flags the proxy never reported', () => {
    expect(applyCapabilityOverrides({ id: 'm' }, { supports_audio_input: true })).toEqual({
      id: 'm',
      supports_audio_input: true,
    })
  })

  it('returns the base object untouched when there are no overrides', () => {
    const base = { id: 'gpt-4o', supports_vision: true }
    expect(applyCapabilityOverrides(base)).toBe(base)
    expect(applyCapabilityOverrides(base, {})).toBe(base)
  })

  it('does not mutate the base object', () => {
    const base = { id: 'gpt-4o', supports_vision: true as boolean | undefined }
    const merged = applyCapabilityOverrides(base, { supports_vision: false })
    expect(base.supports_vision).toBe(true)
    expect(merged).not.toBe(base)
  })
})

describe('CAPABILITY_FLAGS', () => {
  it('covers the capability flags enriched from /v1/model/info', () => {
    expect([...CAPABILITY_FLAGS]).toEqual([
      'supports_vision',
      'supports_function_calling',
      'supports_reasoning',
      'supports_pdf_input',
      'supports_audio_input',
    ])
  })
})
