import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SsoToken } from './sso'

/**
 * Shape of an `api`-type entry in OpenCode's own credential store. OpenCode
 * also stores `oauth` (a LiteLLM sign-in, see `getOpenCodeStoredSso`) and
 * `wellknown` entries there.
 */
interface OpenCodeApiAuthEntry {
  type: 'api'
  key: string
  metadata?: Record<string, string>
}

type OpenCodeAuthEntry = OpenCodeApiAuthEntry | { type: string; [key: string]: unknown }
type OpenCodeAuthFile = Record<string, OpenCodeAuthEntry>

/**
 * OpenCode stores credentials added via the `/connect` command (or
 * `opencode auth login`) in this file, keyed by provider id. The location
 * is fixed and identical across macOS, Linux, and Windows — see
 * https://opencode.ai/docs/troubleshooting/#storage.
 */
function resolveAuthPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json')
}

// Read once per process. The `config` hook can fire multiple times per
// run (see plugin/index.ts), and re-reading a credentials file from disk
// on every invocation is both wasteful and unnecessary — a `/connect` run
// mid-session wouldn't be picked up by the already-running plugin anyway
// (model discovery itself is cached per baseURL for the same reason).
let cachedAuthFile: Promise<OpenCodeAuthFile | null> | null = null

async function readOpenCodeAuthFile(): Promise<OpenCodeAuthFile | null> {
  try {
    const raw = await readFile(resolveAuthPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as OpenCodeAuthFile
    }
  } catch {
    // File doesn't exist, isn't readable, or isn't valid JSON — treat
    // as "no stored credentials" rather than failing plugin startup.
  }
  return null
}

async function loadOpenCodeAuthFile(): Promise<OpenCodeAuthFile | null> {
  cachedAuthFile ??= readOpenCodeAuthFile()
  return cachedAuthFile
}

/**
 * Look up the API key OpenCode itself stored for a given provider id via
 * the `/connect` command. This is entirely separate from this plugin's
 * own `options.apiKey` / `LITELLM_API_KEY` / `LITELLM_MASTER_KEY`
 * configuration: for a custom provider like this one, OpenCode does not
 * inject stored credentials automatically, so the plugin reads the file
 * directly and applies the key to its own health-check / `/v1/models`
 * discovery fetches and to the completion-time provider `options` (see
 * plugin/index.ts) as a fallback credential source.
 *
 * Returns `undefined` if the file is missing/unreadable, or has no
 * `type: "api"` entry for `providerId`.
 */
export async function getOpenCodeStoredApiKey(providerId: string): Promise<string | undefined> {
  const auth = await loadOpenCodeAuthFile()
  const entry = auth?.[providerId]
  if (entry && entry.type === 'api' && typeof (entry as OpenCodeApiAuthEntry).key === 'string') {
    const key = (entry as OpenCodeApiAuthEntry).key
    if (key.length > 0) {
      return key
    }
  }
  return undefined
}

/**
 * Force the next read to hit disk again. OpenCode 1 rebuilds its plugin
 * instance after a login, and the new instance must see the new credential.
 */
export function resetOpenCodeAuthCache(): void {
  cachedAuthFile = null
}

/**
 * An OpenCode 1 OAuth entry for a LiteLLM sign-in. OpenCode 1 keeps only these
 * fields and drops the rest the next time it rewrites the file, so the
 * sign-in's metadata travels as JSON in `accountId`.
 */
export function toOpenCodeOAuthEntry(token: SsoToken): {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
} {
  const { access, refresh, expires, metadata } = token
  return { type: 'oauth', access, refresh, expires, accountId: JSON.stringify(metadata) }
}

/**
 * The LiteLLM sign-in OpenCode 1 stored for `providerId`, read from disk on
 * every call: the plugin refreshes it in place, and so may another OpenCode
 * process sharing the file.
 */
export async function getOpenCodeStoredSso(providerId: string): Promise<SsoToken | undefined> {
  const entry = (await readOpenCodeAuthFile())?.[providerId]
  if (
    entry?.type !== 'oauth' ||
    typeof entry.access !== 'string' ||
    typeof entry.refresh !== 'string' ||
    typeof entry.expires !== 'number' ||
    typeof entry.accountId !== 'string'
  ) {
    return undefined
  }
  try {
    const metadata: unknown = JSON.parse(entry.accountId)
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
    return {
      access: entry.access,
      refresh: entry.refresh,
      expires: entry.expires,
      metadata: metadata as Record<string, unknown>,
    }
  } catch {
    // Not one of this plugin's sign-ins.
    return undefined
  }
}
