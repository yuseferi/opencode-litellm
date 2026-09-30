import type { LiteLLMModelInfo } from '../types'

// LiteLLM's sparse flags do not encode these provider restrictions reliably.
// Constrain inference only; explicit deployment effort lists still win.
// https://developers.openai.com/api/docs/models/gpt-5-pro
// https://developers.openai.com/api/docs/models/gpt-5.2-pro
// https://developers.openai.com/api/docs/models/gpt-5.4-pro
const RESTRICTED_EFFORTS = new Map<string, readonly string[]>([
  ['gpt-5-pro', ['high']],
  ['gpt-5.2-pro', ['medium', 'high', 'xhigh']],
  ['gpt-5.4-pro', ['medium', 'high', 'xhigh']],
])

function restrictedReasoningEfforts(...identifiers: unknown[]): readonly string[] | undefined {
  for (const identifier of identifiers) {
    if (typeof identifier !== 'string') continue
    // Keys can include provider/region prefixes or dated OpenAI snapshots.
    const model = identifier.split('/').pop()?.replace(/-\d{4}-\d{2}-\d{2}$/, '')
    if (!model) continue
    const efforts = RESTRICTED_EFFORTS.get(model)
    if (efforts) return efforts
  }
  return undefined
}

/** Resolve discovery metadata without assuming every reasoning model accepts effort options. */
export function resolveReasoningEfforts(
  info: LiteLLMModelInfo,
  params?: Record<string, unknown>,
): string[] | undefined {
  const metadata: Record<string, unknown> = { ...params }
  for (const [key, value] of Object.entries(info)) {
    if (value != null) metadata[key] = value
  }

  if (metadata.supports_reasoning === false) return []

  // Explicit lists are authoritative, including an empty list. In particular,
  // reasoning_effort_levels can describe models that do not accept medium.
  for (const key of ['reasoning_effort_levels', 'supports_reasoning_efforts']) {
    const levels = metadata[key]
    if (Array.isArray(levels)) {
      return [...new Set(levels.filter((level): level is string => typeof level === 'string'))]
    }
  }

  // Some search models carry effort flags even though their request handler
  // rejects reasoning altogether. Accept either chat or Responses API naming.
  const supportedParams = metadata.supported_openai_params
  if (
    Array.isArray(supportedParams) &&
    !supportedParams.includes('reasoning_effort') &&
    !supportedParams.includes('reasoning')
  ) return []

  const flags = new Map<string, boolean>()
  for (const [key, value] of Object.entries(metadata)) {
    const match = key.match(/^supports_([a-z]+)_reasoning_effort$/)
    if (match && typeof value === 'boolean') flags.set(match[1], value)
  }
  if (flags.size === 0) return undefined
  // Negative flags only rule out levels; they do not establish reasoning support.
  if (metadata.supports_reasoning !== true && ![...flags.values()].includes(true)) return undefined

  // LiteLLM's per-level flags are sparse: medium/high have no standard flags,
  // and low is opt-out. Requiring an explicit true hides these baseline levels
  // on models such as GPT-6 Astra, whose only positive flags are xhigh/max.
  // Keep optional levels opt-in rather than guessing none/minimal support.
  // See litellm/router_utils/reasoning_effort_capability.py upstream.
  const efforts = new Set<string>()
  for (const effort of ['low', 'medium', 'high']) {
    if (flags.get(effort) !== false) efforts.add(effort)
  }
  for (const [effort, supported] of flags) {
    if (supported) efforts.add(effort)
  }

  const restricted = restrictedReasoningEfforts(metadata.key, params?.model)
  if (restricted) {
    for (const effort of efforts) {
      if (!restricted.includes(effort)) efforts.delete(effort)
    }
  }

  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  return [
    ...order.filter((effort) => efforts.has(effort)),
    ...[...efforts].filter((effort) => !order.includes(effort)),
  ]
}
