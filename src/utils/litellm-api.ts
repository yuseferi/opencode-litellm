import type { LiteLLMModel, LiteLLMModelInfo, LiteLLMModelInfoResponse, LiteLLMModelsResponse } from '../types'
import { CAPABILITY_FLAGS } from './model-capabilities'

export const DEFAULT_LITELLM_URL = 'http://localhost:4000'
const MODELS_ENDPOINT = '/v1/models'
const MODEL_INFO_ENDPOINT = '/v1/model/info'
// Health checks fail fast so auto-detection stays snappy; the actual
// discovery fetches get a generous budget because `/v1/model/info`
// payloads from remote proxies with many database-defined models can
// be large and slow to generate.
const HEALTH_TIMEOUT_MS = 3000
const DEFAULT_FETCH_TIMEOUT_MS = 15000

/**
 * Per-request timeout for discovery fetches (`/v1/models`,
 * `/v1/model/info`), overridable via `LITELLM_REQUEST_TIMEOUT_MS` for
 * proxies that legitimately need longer than the 15 s default (issue
 * #20). Invalid values fall back to the default.
 */
export function getRequestTimeoutMs(): number {
  const raw = process.env.LITELLM_REQUEST_TIMEOUT_MS
  if (!raw) return DEFAULT_FETCH_TIMEOUT_MS
  // Number() (not parseInt) so '12.5' or '60abc' fall back to the
  // default instead of silently truncating to a bogus 12 ms timeout.
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_FETCH_TIMEOUT_MS
  return parsed
}

/**
 * Normalise a base URL so the rest of the plugin can rely on a
 * predictable shape (no trailing slash, no `/v1` suffix).
 */
export function normalizeBaseURL(baseURL: string = DEFAULT_LITELLM_URL): string {
  let normalized = baseURL.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

/** Build a full URL for a given API endpoint. */
export function buildAPIURL(baseURL: string, endpoint: string = MODELS_ENDPOINT): string {
  return `${normalizeBaseURL(baseURL)}${endpoint}`
}

function buildHeaders(apiKey?: string, customHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const key = apiKey ?? process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
  if (key) {
    headers['Authorization'] = `Bearer ${key}`
  }
  if (customHeaders) {
    Object.assign(headers, customHeaders)
  }
  return headers
}

/** Lightweight ping to see whether a LiteLLM server is reachable. */
export async function checkLiteLLMHealth(
  baseURL: string = DEFAULT_LITELLM_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<boolean> {
  try {
    const response = await fetch(buildAPIURL(baseURL), {
      method: 'GET',
      headers: buildHeaders(apiKey, customHeaders),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    // 401 still means a server is alive — we just don't have the right
    // credentials. Surface that as "unhealthy" so the user is prompted
    // to set LITELLM_API_KEY.
    return response.ok
  } catch {
    return false
  }
}

/** Discover all models exposed by a LiteLLM proxy. */
export async function discoverLiteLLMModels(
  baseURL: string = DEFAULT_LITELLM_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<LiteLLMModel[]> {
  const url = buildAPIURL(baseURL)
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(getRequestTimeoutMs()),
  })

  if (!response.ok) {
    throw new Error(`LiteLLM responded with HTTP ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as LiteLLMModelsResponse
  return data.data ?? []
}

/**
 * Fetch per-model metadata (`mode`, token limits, capability flags)
 * from `/v1/model/info`, keyed by model name. `/v1/models` omits these
 * fields for database-defined models, so classification (e.g. filtering
 * out embedding models) relies on this endpoint.
 */
export async function discoverLiteLLMModelInfo(
  baseURL: string = DEFAULT_LITELLM_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<Map<string, LiteLLMModelInfo>> {
  const url = buildAPIURL(baseURL, MODEL_INFO_ENDPOINT)
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(getRequestTimeoutMs()),
  })

  if (!response.ok) {
    throw new Error(`LiteLLM responded with HTTP ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as LiteLLMModelInfoResponse
  const infoByName = new Map<string, LiteLLMModelInfo>()
  for (const entry of data.data ?? []) {
    if (!entry.model_info) continue
    // Some deployments set capability flags on the params block rather
    // than inside model_info. Fill those gaps so enrichment sees them.
    const info: LiteLLMModelInfo = { ...entry.model_info }
    for (const flag of CAPABILITY_FLAGS) {
      const paramsValue = entry.litellm_params?.[flag]
      if (info[flag] == null && typeof paramsValue === 'boolean') {
        info[flag] = paramsValue
      }
    }

    // Add supports reasoning efforts if present in litellm_params
    const reasoningEffortPattern = /^supports_([a-z]+)_reasoning_effort$/
    const efforts = new Set<string>()
    for (const source of [info, entry.litellm_params]) {
      if (!source || typeof source !== 'object') continue
      for (const [key, value] of Object.entries(source)) {
        const match = key.match(reasoningEffortPattern)
        if (match && value === true) {
          efforts.add(match[1])
        }
      }
    }
    if (efforts.size > 0) {
      info.supports_reasoning_efforts = [
        ...new Set([...(info.supports_reasoning_efforts ?? []), ...efforts]),
      ]
    }

    // Index under every alias LiteLLM may use for this model — the
    // `/v1/models` id can match any of them depending on how the
    // deployment names its entries (alias vs upstream model string).
    const keys = [
      entry.model_name,
      entry.model_info.key,
      typeof entry.litellm_params?.model === 'string' ? entry.litellm_params.model : undefined,
    ]
    for (const key of keys) {
      if (key && !infoByName.has(key)) {
        infoByName.set(key, info)
      }
    }
  }
  return infoByName
}

/**
 * Use an explicit LITELLM_BASE_URL when set; otherwise try the most common
 * ports. The default `litellm --port` is 4000, with 8000 and 8080 also common.
 */
export async function autoDetectLiteLLM(apiKey?: string, customHeaders?: Record<string, string>): Promise<string | null> {
  const configuredBaseURL = process.env.LITELLM_BASE_URL?.trim()
  if (configuredBaseURL) return normalizeBaseURL(configuredBaseURL)

  const commonPorts = [4000, 8000, 8080]
  for (const port of commonPorts) {
    const baseURL = `http://localhost:${port}`
    if (await checkLiteLLMHealth(baseURL, apiKey, customHeaders)) {
      return baseURL
    }
  }
  return null
}
