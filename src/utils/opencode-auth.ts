import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Shape of an `api`-type entry in OpenCode's own credential store. OpenCode
 * also stores `oauth` and `wellknown` entries there, but LiteLLM proxies
 * only ever use a plain API key, so that's the only variant we care about.
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

async function loadOpenCodeAuthFile(): Promise<OpenCodeAuthFile | null> {
  if (!cachedAuthFile) {
    cachedAuthFile = (async () => {
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
    })()
  }
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

/** Test-only: force the next read to hit disk again. */
export function __resetOpenCodeAuthCacheForTests(): void {
  cachedAuthFile = null
}
