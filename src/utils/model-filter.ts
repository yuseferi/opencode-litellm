/**
 * Minimal glob matching for model-id filters (`includeModels`/
 * `excludeModels`). Supports only `*` (any run of characters, including
 * none) — enough for the common case (`"anthropic/*"`) without
 * pulling in a glob dependency. Everything else in the pattern is
 * matched literally.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

function matchesAny(id: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(id))
}

/**
 * Decide whether a discovered model id should be injected into a
 * provider, given that provider's `includeModels`/`excludeModels`
 * options.
 *
 * - No `includeModels` → every id passes the include step (default:
 *   don't filter).
 * - `includeModels` present → only ids matching at least one pattern
 *   pass.
 * - `excludeModels` is applied after, and always wins over `include`.
 */
export function passesModelFilter(
  id: string,
  includeModels?: readonly string[],
  excludeModels?: readonly string[],
): boolean {
  if (includeModels && includeModels.length > 0 && !matchesAny(id, includeModels)) {
    return false
  }
  if (excludeModels && excludeModels.length > 0 && matchesAny(id, excludeModels)) {
    return false
  }
  return true
}
