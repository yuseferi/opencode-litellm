import { describe, expect, it } from 'vitest'
import { buildAPIURL, normalizeBaseURL } from '../src/utils/litellm-api'

describe('normalizeBaseURL', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseURL('http://localhost:4000/')).toBe('http://localhost:4000')
    expect(normalizeBaseURL('http://localhost:4000///')).toBe('http://localhost:4000')
  })

  it('strips a /v1 suffix so the plugin can re-append endpoint paths', () => {
    expect(normalizeBaseURL('http://localhost:4000/v1')).toBe('http://localhost:4000')
    expect(normalizeBaseURL('https://proxy.example.com/v1/')).toBe('https://proxy.example.com')
  })

  it('leaves other paths untouched', () => {
    expect(normalizeBaseURL('https://proxy.example.com/api')).toBe('https://proxy.example.com/api')
  })

  it('defaults to localhost:4000', () => {
    expect(normalizeBaseURL(undefined)).toBe('http://localhost:4000')
  })
})

describe('buildAPIURL', () => {
  it('appends /v1/models by default', () => {
    expect(buildAPIURL('http://localhost:4000/v1')).toBe('http://localhost:4000/v1/models')
  })

  it('appends a custom endpoint', () => {
    expect(buildAPIURL('http://localhost:4000/', '/v1/model/info')).toBe(
      'http://localhost:4000/v1/model/info',
    )
  })
})
