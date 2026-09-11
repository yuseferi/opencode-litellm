export const CAPABILITY_FLAGS = [
  'supports_vision',
  'supports_function_calling',
  'supports_reasoning',
  'supports_pdf_input',
  'supports_audio_input',
] as const

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number]

/**
 * Per-model boolean capability overrides keyed by exact model id
 * (`provider.litellm.options.modelCapabilities`). Keys of the inner
 * record are not restricted to `CapabilityFlag`: any boolean capability
 * key LiteLLM reports is accepted, so future flags work without a
 * plugin change.
 */
export type ModelCapabilities = Record<string, Record<string, boolean>>

/**
 * Defensively parse the `modelCapabilities` provider option. Non-object
 * input, non-object per-model values, and non-boolean flag values are
 * dropped; everything else (including explicit `false`) is kept.
 */
export function parseModelCapabilities(raw: unknown): ModelCapabilities {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ModelCapabilities = {}
  for (const [modelId, flags] of Object.entries(raw as Record<string, unknown>)) {
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) continue
    const parsed: Record<string, boolean> = {}
    for (const [flag, value] of Object.entries(flags as Record<string, unknown>)) {
      if (typeof value === 'boolean') parsed[flag] = value
    }
    if (Object.keys(parsed).length > 0) out[modelId] = parsed
  }
  return out
}

/**
 * Overlay user-configured capability flags onto a (possibly enriched)
 * model entry. Explicit `false` wins over whatever the proxy reported,
 * and unknown-to-the-proxy flags are added outright.
 */
export function applyCapabilityOverrides<T extends object>(
  model: T,
  overrides?: Readonly<Record<string, boolean>>,
): T {
  if (!overrides || Object.keys(overrides).length === 0) return model
  return Object.assign({}, model, overrides)
}
