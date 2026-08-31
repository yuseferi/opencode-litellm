import type { LiteLLMModel } from '../types'

/**
 * Strip Vertex-style version pinning suffixes that have no place in a
 * display name. LiteLLM exposes Anthropic-on-Vertex models with ids
 * like `claude-opus-4-5@20251101` or `claude-sonnet-4-6@default`; those
 * `@…` suffixes mean "this exact dated revision" or "the
 * provider-default revision" and aren't part of the model's brand name.
 */
function stripVersionSuffix(part: string): string {
  return part.replace(/@(default|\d{6,8})$/i, '')
}

/**
 * Heuristic: does this numeric token look like a real version component
 * (single or double digit) rather than a date stamp or build number?
 *
 * Anthropic / OpenAI version components are always 1–2 digits in
 * practice (`3`, `4`, `5`, `16`); a 6–8 digit token is almost certainly
 * a `YYYYMMDD` revision stamp like `20251101` and must NOT be merged
 * with the digit before it.
 */
function looksLikeVersionComponent(token: string): boolean {
  return /^\d{1,2}$/.test(token)
}

/**
 * Collapse two adjacent numeric tokens at the end of a tokenised id
 * into a single dotted version token. Anthropic uses dash-only ids
 * (`claude-opus-4-5`) where the trailing `4-5` is really a `4.5`
 * version pair, but the formatter would otherwise render it as
 * "Claude Opus 4 5".
 *
 * Conservative on purpose:
 *   - Only the FIRST mergeable pair scanning from the right is collapsed:
 *     `gpt-3-5-turbo-16k` merges `3-5` into `3.5` and stops there.
 *   - Both tokens must look like real version components (1–2 digits),
 *     so a `YYYYMMDD` revision stamp like `20251101` is never merged
 *     into a version number itself.
 *   - We refuse to collapse if the token immediately AFTER the pair is
 *     also a short number (would create ambiguity in `1-2-3` runs). A
 *     trailing 6–8 digit `YYYYMMDD` revision stamp does not block the
 *     merge — it stays its own token, so `claude-opus-4-5-20251101`
 *     renders "Claude Opus 4.5 20251101", not "Claude Opus 4 5 20251101".
 */
function joinTrailingVersionPair(tokens: string[]): string[] {
  for (let i = tokens.length - 1; i >= 1; i--) {
    const a = tokens[i - 1]
    const b = tokens[i]
    if (looksLikeVersionComponent(a) && looksLikeVersionComponent(b)) {
      const next = tokens[i + 1]
      const nextIsDateStamp = next !== undefined && /^\d{6,8}$/.test(next)
      if (next === undefined || nextIsDateStamp || !/^\d+$/.test(next)) {
        const merged = [...tokens.slice(0, i - 1), `${a}.${b}`, ...tokens.slice(i + 1)]
        return merged
      }
    }
  }
  return tokens
}

/**
 * Categorize the model so we can attach sensible `modalities` metadata
 * in the OpenCode provider config.
 */
export function categorizeModel(model: LiteLLMModel): 'chat' | 'embedding' | 'image' | 'audio' | 'unknown' {
  if (model.mode) {
    const m = model.mode.toLowerCase()
    if (m.includes('embedding')) return 'embedding'
    if (m.includes('image')) return 'image'
    if (m.includes('audio') || m.includes('speech') || m.includes('transcription')) return 'audio'
    if (m.includes('chat') || m.includes('completion')) return 'chat'
  }

  const id = model.id.toLowerCase()
  if (id.includes('embed') || id.includes('embedding')) return 'embedding'
  if (id.includes('whisper') || id.includes('tts')) return 'audio'
  if (id.includes('dall-e') || id.includes('stable-diffusion') || id.includes('flux')) return 'image'
  return 'chat'
}

/**
 * Format a LiteLLM model ID into a human readable display name.
 *
 * Pre-processing:
 *   - Strip the first `provider/` segment (`vertex_ai/`, `openai/`, …).
 *   - Strip Vertex revision suffixes (`@<date>`, `@default`).
 *
 * Tokenisation post-processing:
 *   - Collapse a trailing pair of bare numeric tokens into a single
 *     dotted version. Anthropic uses dash-only ids — `claude-opus-4-7`
 *     would otherwise render as "Claude Opus 4 7" instead of
 *     "Claude Opus 4.7".
 *
 * Examples:
 *   "openai/gpt-4o-mini"                  -> "GPT 4o Mini"
 *   "claude-opus-4-7"                     -> "Claude Opus 4.7"
 *   "claude-opus-4-5@20251101"            -> "Claude Opus 4.5"
 *   "claude-sonnet-4-6@default"           -> "Claude Sonnet 4.6"
 *   "bedrock/amazon.nova-pro-v1"          -> "Amazon Nova Pro V1"
 *   "qwen/qwen3-30b-a3b"                  -> "Qwen3 30B A3B"
 */
export function formatModelName(model: LiteLLMModel): string {
  const { id } = model

  // Drop provider prefix when present, but only the FIRST segment, so
  // ids like `bedrock/amazon.nova-pro-v1` still carry the vendor name
  // through to the display.
  const slashIdx = id.indexOf('/')
  const afterProvider = slashIdx >= 0 ? id.slice(slashIdx + 1) : id

  // Strip Vertex revision suffixes (`@20251101`, `@default`).
  const modelPart = stripVersionSuffix(afterProvider)

  const acronyms = new Set([
    'gpt', 'oss', 'api', 'gguf', 'ggml', 'nomic', 'vl', 'it', 'mlx',
    'llm', 'ai', 'sdk', 'aws', 'gcp', 'tts', 'stt', 'mm',
  ])

  const rawTokens = modelPart
    .split(/[-_.]/) // split on -, _ and .
    .filter(Boolean)

  // Collapse a trailing numeric pair (`4-5`) into a dotted version
  // (`4.5`) for Anthropic-style ids. No-op when versions already use
  // dots (which survive the split as separate tokens but only re-merge
  // when both sides are pure digits).
  const tokens = joinTrailingVersionPair(rawTokens).map((token) => {
    const lower = token.toLowerCase()
    if (acronyms.has(lower)) return token.toUpperCase()
    // sizes (30b, 7b, 4k...)
    if (/^\d+[bkmg]$/i.test(token)) return token.toUpperCase()
    // quantizations (q4, q8...)
    if (/^q\d+$/i.test(token)) return token.toUpperCase()
    // dotted versions (3.5, 2.5, 4.7) — emitted by joinTrailingVersionPair
    // or naturally present in dotted base_models.
    if (/^\d+\.\d+/.test(token)) return token
    // shapes like a3b, e4b, 3n  -> uppercase
    if (/^[a-z]\d+[a-z]?$/i.test(token)) {
      return token.toUpperCase()
    }
    // shapes like "4o" (OpenAI branding) — keep digit + lowercase letter
    if (/^\d+[a-z]$/i.test(token)) {
      return token.toLowerCase()
    }
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
  })

  return tokens.join(' ') || id
}
