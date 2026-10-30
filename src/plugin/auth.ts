import type { AuthHook, AuthOAuthResult, PluginInput } from '@opencode-ai/plugin'
import { getOpenCodeStoredSso, toOpenCodeOAuthEntry } from '../utils/opencode-auth'
import {
  authorizeLiteLLM,
  authorizeOidc,
  parseOidcConfig,
  refreshSsoToken,
  signInRoot,
  type SsoAuthorization,
  type SsoToken,
} from '../utils/sso'

/** Where the config hook found the provider; a sign-in goes to its proxy, with its gateway headers. */
export interface SignInTarget {
  /** The provider's configured base URL, which discovery always uses. */
  baseURL: string | undefined
  /** The proxy of the stored sign-in, the default for a provider configured nowhere. */
  previousURL: string | undefined
  headers: Record<string, string>
}

// OpenCode 2 refreshes credentials this long before they expire; OpenCode 1 leaves it to plugins.
const REFRESH_LEAD_MS = 5 * 60 * 1000
// After a refresh that did not happen (an unavailable token endpoint), requests use the current
// token for this long instead of each waiting on the token endpoint again.
const RETRY_MS = 30 * 1000

export interface SsoSession {
  /** The stored sign-in, expired or not, or undefined without one. */
  stored(): Promise<SsoToken | undefined>
  /** A live access token; throws when the sign-in expired and cannot be refreshed. */
  access(headers?: Record<string, string>): Promise<string | undefined>
}

interface SessionState {
  token?: Promise<SsoToken | undefined>
  refreshing?: Promise<SsoToken>
  retryAt?: number
}

// One state per provider for the whole process: OpenCode 1 can keep calling a fetch an earlier
// plugin instance wrote into its cached config, and every caller must share one refresh.
const sessions = new Map<string, SessionState>()

/**
 * The OpenCode 1 side of a LiteLLM sign-in: the session OpenCode stored in
 * auth.json, refreshed when it nears expiry and saved back through the
 * OpenCode client, because OpenCode 1 does not refresh plugin credentials.
 */
export function createSsoSession(
  client: PluginInput['client'],
  providerID: string,
  warn: (message: string) => void,
): SsoSession {
  const state = sessions.get(providerID) ?? {}
  sessions.set(providerID, state)
  // A new plugin instance follows a login, so it reads auth.json again.
  state.token = undefined
  state.retryAt = undefined
  const stored = () => (state.token ??= getOpenCodeStoredSso(providerID))

  async function refresh(current: SsoToken, headers?: Record<string, string>): Promise<SsoToken> {
    const latest = await getOpenCodeStoredSso(providerID)
    // Never overwrite a credential saved since: a logout, an API key, or another sign-in.
    if (!latest) throw new Error('The LiteLLM sign-in was removed; connect LiteLLM again')
    if (latest.access !== current.access) {
      // Another OpenCode process refreshed it; a sign-in to another proxy must not inherit this one's requests.
      if (latest.metadata.baseURL !== current.metadata.baseURL) {
        throw new Error('The LiteLLM sign-in changed; connect LiteLLM again')
      }
      return latest
    }
    const next = await refreshSsoToken(current, headers)
    if (next === current) {
      state.retryAt = Date.now() + RETRY_MS
      return current
    }
    // A credential saved during the refresh wins on disk; this process keeps its own tokens.
    if ((await getOpenCodeStoredSso(providerID))?.access === current.access) {
      const saved = await client.auth
        .set({ path: { id: providerID }, body: toOpenCodeOAuthEntry(next) })
        .catch((error: unknown) => ({ error }))
      if (saved.error) {
        warn(
          '[opencode-litellm] Could not save the refreshed LiteLLM sign-in; the next start may ask for a new one.',
        )
      }
    }
    return next
  }

  return {
    stored,
    async access(headers) {
      const current = await stored()
      if (!current) return undefined
      const now = Date.now()
      if (current.expires > now + REFRESH_LEAD_MS) return current.access
      if (current.expires > now && state.retryAt !== undefined && now < state.retryAt)
        return current.access
      // One refresh at a time: a rotated refresh token cannot be spent twice.
      state.refreshing ??= refresh(current, headers)
        .then((next) => {
          state.token = Promise.resolve(next)
          return next
        })
        .finally(() => {
          state.refreshing = undefined
        })
      return (await state.refreshing).access
    },
  }
}

/** Sends the sign-in's live token on every request; OpenCode 1 builds requests from static options. */
export function ssoFetch(session: SsoSession, headers?: Record<string, string>): typeof fetch {
  return async (input, init) => {
    const access = await session.access(headers)
    const requestHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (access) requestHeaders.set('Authorization', `Bearer ${access}`)
    return fetch(input, { ...init, headers: requestHeaders })
  }
}

function text(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

/** Wraps a sign-in for OpenCode 1, which stores a successful result in auth.json. */
function toAuthResult(authorization: SsoAuthorization, baseURL?: string): AuthOAuthResult {
  const success = (token: SsoToken) => {
    const { type: _, ...entry } = toOpenCodeOAuthEntry({
      ...token,
      metadata: { ...token.metadata, ...(baseURL ? { baseURL } : {}) },
    })
    return { type: 'success' as const, ...entry }
  }
  const { url, instructions } = authorization
  if (authorization.mode === 'code') {
    return {
      url,
      instructions,
      method: 'code',
      callback: async (code) => success(await authorization.callback(code)),
    }
  }
  return {
    url,
    instructions,
    method: 'auto',
    callback: async () => success(await authorization.callback),
  }
}

type Prompt = NonNullable<
  Extract<AuthHook['methods'][number], { type: 'oauth' }>['prompts']
>[number]

// OpenCode Desktop cannot submit an empty text prompt, so each optional answer sits behind a select.
const proxyPrompts: Prompt[] = [
  {
    type: 'select',
    key: 'proxy',
    message: 'LiteLLM proxy',
    options: [
      {
        label: 'Configured or previous proxy',
        value: 'known',
        hint: 'the provider baseURL, the last sign-in, or LITELLM_BASE_URL',
      },
      { label: 'Another URL…', value: 'other' },
    ],
  },
  {
    type: 'text',
    key: 'baseURL',
    message: 'LiteLLM proxy URL',
    placeholder: 'https://llm.example.com',
    when: { key: 'proxy', op: 'eq', value: 'other' },
  },
]

/** The proxy a sign-in goes to: a typed URL, else the configured one, the previous sign-in's, or the environment's. */
function proxyFor(
  inputs: Record<string, string>,
  target: SignInTarget,
  providerID: string,
): string | undefined {
  const typed = inputs.proxy === 'other' ? text(inputs.baseURL) : undefined
  if (inputs.proxy === 'other' && !typed) throw new Error('Enter the LiteLLM proxy URL')
  // The previous sign-in's proxy is only a default: unlike configuration, signing in elsewhere replaces it.
  const previous = target.baseURL ? undefined : target.previousURL
  return signInRoot(typed ?? previous, target.baseURL, providerID)
}

/**
 * The `/connect` and `opencode auth login` entries for the LiteLLM provider:
 * LiteLLM SSO, a direct sign-in with an OpenID Connect identity provider, or
 * an API key. `target` reports where the config hook found the provider.
 */
export function liteLLMAuthHook(providerID: string, target: () => SignInTarget): AuthHook {
  return {
    provider: providerID,
    methods: [
      {
        type: 'oauth',
        label: 'LiteLLM SSO',
        prompts: [
          ...proxyPrompts,
          {
            type: 'select',
            key: 'teamChoice',
            message: 'LiteLLM team',
            options: [
              {
                label: 'Default',
                value: 'default',
                hint: 'LiteLLM asks only when your account has several',
              },
              { label: 'A specific team…', value: 'other' },
            ],
          },
          {
            type: 'text',
            key: 'team',
            message: 'LiteLLM team ID or alias',
            when: { key: 'teamChoice', op: 'eq', value: 'other' },
          },
        ],
        authorize: async (inputs = {}) => {
          const baseURL = proxyFor(inputs, target(), providerID)
          if (!baseURL) throw new Error('Enter the LiteLLM proxy URL, or set LITELLM_BASE_URL')
          const team = inputs.teamChoice === 'other' ? text(inputs.team) : undefined
          return toAuthResult(await authorizeLiteLLM(baseURL, target().headers, team))
        },
      },
      {
        type: 'oauth',
        label: 'Identity provider (OIDC)',
        prompts: [
          ...proxyPrompts,
          {
            type: 'text',
            key: 'issuer',
            message: "Your identity provider's issuer URL",
            placeholder: 'https://idp.example.com',
          },
          {
            type: 'text',
            key: 'clientId',
            message:
              'Public client ID (no secret) for the redirect http://127.0.0.1:<port>/callback',
          },
          {
            type: 'select',
            key: 'scope',
            message: 'Scopes',
            options: [
              { label: 'openid', value: 'openid' },
              {
                label: 'openid offline_access',
                value: 'openid offline_access',
                hint: 'some identity providers only issue refresh tokens with it',
              },
              { label: 'Other scopes…', value: 'other' },
            ],
          },
          {
            type: 'text',
            key: 'customScope',
            message: 'Scopes, space-separated, including openid',
            when: { key: 'scope', op: 'eq', value: 'other' },
          },
          {
            type: 'select',
            key: 'ports',
            message: 'Redirect port',
            options: [
              { label: 'Any free port', value: 'any' },
              {
                label: 'Specific ports…',
                value: 'specific',
                hint: 'for identity providers that only accept exact registered redirect URIs',
              },
            ],
          },
          {
            type: 'text',
            key: 'redirectPorts',
            message: 'Ports to try, in order',
            placeholder: '8400, 8401',
            when: { key: 'ports', op: 'eq', value: 'specific' },
          },
        ],
        authorize: async (inputs = {}) => {
          // Nothing is sent to the proxy, so its URL is only recorded for discovery.
          const baseURL = proxyFor(inputs, target(), providerID)
          const config = parseOidcConfig({
            issuer: text(inputs.issuer),
            clientId: text(inputs.clientId),
            scope: inputs.scope === 'other' ? text(inputs.customScope) : text(inputs.scope),
            redirectPorts: inputs.ports === 'specific' ? text(inputs.redirectPorts) : undefined,
          })
          return toAuthResult(await authorizeOidc(config), baseURL)
        },
      },
      { type: 'api', label: 'API key' },
    ],
  }
}
