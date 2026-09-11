import { describe, expect, it } from 'vitest'
import { passesModelFilter } from '../src/utils/model-filter'

describe('passesModelFilter', () => {
  it('passes everything when no filters are set', () => {
    expect(passesModelFilter('claude-opus-4-5')).toBe(true)
    expect(passesModelFilter('anything', undefined, undefined)).toBe(true)
  })

  it('treats empty arrays as no filter', () => {
    expect(passesModelFilter('gpt-5', [], [])).toBe(true)
  })

  it('keeps only ids matching at least one includeModels pattern', () => {
    expect(passesModelFilter('prod/claude-opus-4-5', ['prod/*'])).toBe(true)
    expect(passesModelFilter('staging/claude-opus-4-5', ['prod/*'])).toBe(false)
    expect(passesModelFilter('prod/gpt-5', ['prod/*', 'canary/*'])).toBe(true)
    expect(passesModelFilter('canary/gpt-5', ['prod/*', 'canary/*'])).toBe(true)
  })

  it('drops ids matching excludeModels, which always wins', () => {
    expect(passesModelFilter('prod/gpt-5-canary', undefined, ['*-canary'])).toBe(false)
    expect(passesModelFilter('prod/gpt-5', ['prod/*'], ['*-canary'])).toBe(true)
    expect(passesModelFilter('prod/gpt-5-canary', ['prod/*'], ['*-canary'])).toBe(false)
  })

  it('supports stars anywhere in a pattern, including no-character matches', () => {
    expect(passesModelFilter('claude-opus-4-5', ['claude*4-5'])).toBe(true)
    expect(passesModelFilter('gpt5', ['gpt*'])).toBe(true)
    expect(passesModelFilter('gpt4o', ['gpt*'])).toBe(true)
  })

  it('matches regex metacharacters literally', () => {
    // The dot in `gpt-4.1` is a literal dot, not a regex wildcard.
    expect(passesModelFilter('gpt-4.1', ['gpt-4.1'])).toBe(true)
    expect(passesModelFilter('gpt-4x1', ['gpt-4.1'])).toBe(false)
    // Parentheses, brackets and plus signs are also literal.
    expect(passesModelFilter('model(1)', ['model(1)'])).toBe(true)
    expect(passesModelFilter('modelx1', ['model(1)'])).toBe(false)
    expect(passesModelFilter('a+b', ['a+b'])).toBe(true)
    expect(passesModelFilter('aab', ['a+b'])).toBe(false)
  })

  it('matching is case-sensitive', () => {
    expect(passesModelFilter('PROD/model', ['prod/*'])).toBe(false)
  })
})
