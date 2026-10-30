import { Integration, type Credential } from '@opencode/plugin'
import type { IntegrationOAuthAuthorization } from '@opencode/plugin/promise/integration'
import type { Context } from '@opencode/plugin/promise/plugin'
import {
  authorizeLiteLLM,
  authorizeOidc,
  parseOidcConfig,
  refreshSsoToken,
  signInRoot,
  type SsoAuthorization,
  type SsoToken,
} from '../utils/sso'

// OpenCode 2 exposes no log API through the plugin context (see
// initV2Logging); the host captures console output into its log files, so a
// plain console write with the `[opencode-litellm]` prefix is the house
// pattern for V2 modules (same as logInfo in plugin/v2.ts).
function logInfo(message: string): void {
  console.log(message)
}

/**
 * Integration id the plugin registers with OpenCode's connect-provider dialog.
 *
 * Deliberately identical to the default provider id (`CHAT_PROVIDER_ID` in
 * `plugin/v2.ts`) so a credential saved through `/connect` lines up with the
 * `litellm` provider without extra wiring; providers registered under other
 * ids still resolve the same credential because the plugin stamps
 * `info.integrationID` on them.
 */
export const LITELLM_INTEGRATION_ID = 'litellm'

const SSO_METHOD_ID = 'sso'
const OIDC_METHOD_ID = 'oidc'
// Only OAuth credentials from these methods carry a LiteLLM bearer token.
const OAUTH_METHOD_IDS: ReadonlySet<string> = new Set([SSO_METHOD_ID, OIDC_METHOD_ID])

/** A credential saved through the connect dialog, with its form answers. */
export interface ConnectedLiteLLM {
  /** Key resolved from the active connection's credential. */
  apiKey: string | undefined
  /** Base URL typed into the dialog's form, when present. */
  baseURL: string | undefined
  /** Provider id typed into the dialog's form, when present. */
  providerID: string | undefined
  /** Id of an OAuth credential, which stays put while its access token rotates. */
  credentialID?: string
}

/** The configured proxy URL and gateway headers a sign-in for a provider id uses. */
export interface SignInTarget {
  baseURL: string | undefined
  headers: Record<string, string>
}

type SignInTargetResolver = (providerID: string) => Promise<SignInTarget>

function readAnswer(
  configuration: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = configuration?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** The bearer token a connection provides, or undefined when it is not a LiteLLM credential. */
export function connectionApiKey(credential: Credential.Value | undefined): string | undefined {
  if (credential?.type === 'key') return credential.key
  if (credential?.type === 'oauth' && OAUTH_METHOD_IDS.has(credential.methodID))
    return credential.access
  return undefined
}

const providerIDField = {
  key: 'providerID',
  type: 'string',
  title: 'Provider ID',
  description:
    'Provider the discovered models appear under. Pick a different id when your config already defines a "litellm" provider, so the connected gateway gets its own entry. Reconnecting with a different id moves the gateway there.',
  default: LITELLM_INTEGRATION_ID,
} as const

const signInBaseURLField = {
  key: 'baseURL',
  type: 'string',
  format: 'uri',
  title: 'Base URL',
  description:
    "The LiteLLM proxy to sign in to. Leave empty to use the configured provider's URL or LITELLM_BASE_URL.",
  placeholder: 'https://llm.example.com',
} as const

/** Proxy URL, provider id, and gateway headers for a sign-in. */
async function signInTarget(
  answer: Record<string, unknown>,
  resolveTarget: SignInTargetResolver,
): Promise<{ providerID: string; baseURL: string | undefined; headers: Record<string, string> }> {
  const providerID = readAnswer(answer, 'providerID') ?? LITELLM_INTEGRATION_ID
  const target = await resolveTarget(providerID)
  const baseURL = signInRoot(readAnswer(answer, 'baseURL'), target.baseURL, providerID)
  return { providerID, baseURL, headers: target.headers }
}

/** Wraps a sign-in for the host, storing the session as an OAuth credential of `methodID`. */
function toAuthorization(
  authorization: SsoAuthorization,
  methodID: string,
  metadata: Record<string, unknown>,
): IntegrationOAuthAuthorization {
  const toCredential = (token: SsoToken): Credential.OAuth => ({
    type: 'oauth',
    methodID: Integration.MethodID.make(methodID),
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    metadata: { ...token.metadata, ...metadata },
  })
  const { url, instructions, expiresAt } = authorization
  if (authorization.mode === 'code') {
    return {
      url,
      instructions,
      expiresAt,
      mode: 'code',
      callback: (code) => authorization.callback(code).then(toCredential),
    }
  }
  const callback = authorization.callback.then(toCredential)
  // The host awaits it once the attempt is recorded; an earlier rejection must not go unhandled.
  callback.catch(() => {})
  return { url, instructions, expiresAt, mode: 'auto', callback }
}

/**
 * Registers the LiteLLM integration so gateways can be connected from the
 * web UI instead of hand-edited config: an API key with a small form for the
 * proxy base URL and an optional provider id, or a browser sign-in through
 * LiteLLM SSO or directly with an OpenID Connect identity provider.
 *
 * Returns the transform registration, or undefined when the host has no
 * integration API (OpenCode 1.18.x's embedded v2 host) or registration
 * fails — model discovery must keep working without the dialog entry.
 */
export async function registerLiteLLMIntegration(
  context: Context,
  resolveTarget: SignInTargetResolver,
): Promise<{ dispose(): Promise<void> } | undefined> {
  if (!context.integration?.transform) return undefined
  // Shared by both sign-in methods: the stored flow decides how a session renews.
  const refresh = async (credential: Credential.OAuth): Promise<Credential.OAuth> => {
    const metadata = credential.metadata ?? {}
    const { headers } = await resolveTarget(
      readAnswer(metadata, 'providerID') ?? LITELLM_INTEGRATION_ID,
    )
    const token = await refreshSsoToken({ ...credential, metadata }, headers)
    return { ...credential, access: token.access, refresh: token.refresh, expires: token.expires }
  }
  try {
    return await context.integration.transform((editor) => {
      editor.update(LITELLM_INTEGRATION_ID, (integration) => {
        integration.name = 'LiteLLM'
      })
      editor.method.update({
        integrationID: LITELLM_INTEGRATION_ID,
        method: {
          type: 'key',
          label: 'API Key',
          form: [
            {
              key: 'baseURL',
              type: 'string',
              format: 'uri',
              title: 'Base URL',
              description:
                'Where the LiteLLM proxy runs, including the /v1 suffix. Leave empty to use LITELLM_BASE_URL or auto-detect a local proxy.',
              placeholder: 'https://llm.example.com/v1',
            },
            providerIDField,
          ],
        },
      })
      editor.method.update({
        integrationID: LITELLM_INTEGRATION_ID,
        method: {
          id: SSO_METHOD_ID,
          type: 'oauth',
          label: 'LiteLLM SSO',
          form: [
            signInBaseURLField,
            providerIDField,
            {
              key: 'team',
              type: 'string',
              title: 'Team',
              description:
                'LiteLLM team ID or alias, for accounts in several teams. Leave empty unless sign-in asks for one.',
            },
          ],
        },
        authorize: async (answer) => {
          const { providerID, baseURL, headers } = await signInTarget(answer, resolveTarget)
          if (!baseURL)
            throw new Error('Enter the LiteLLM proxy URL as Base URL, or set LITELLM_BASE_URL')
          const authorization = await authorizeLiteLLM(baseURL, headers, readAnswer(answer, 'team'))
          return toAuthorization(authorization, SSO_METHOD_ID, { providerID })
        },
        refresh,
      })
      editor.method.update({
        integrationID: LITELLM_INTEGRATION_ID,
        method: {
          id: OIDC_METHOD_ID,
          type: 'oauth',
          label: 'Identity provider (OIDC)',
          form: [
            signInBaseURLField,
            providerIDField,
            {
              key: 'issuer',
              type: 'string',
              format: 'uri',
              title: 'Issuer',
              description:
                "Your identity provider's issuer URL; the proxy's JWT auth must trust it.",
              placeholder: 'https://idp.example.com',
              required: true,
            },
            {
              key: 'clientId',
              type: 'string',
              title: 'Client ID',
              description:
                'A public client (no secret) for authorization code + PKCE with the redirect http://127.0.0.1:<port>/callback. The proxy must accept it as an audience.',
              required: true,
            },
            {
              key: 'scope',
              type: 'string',
              title: 'Scopes',
              description:
                'Space-separated, including openid. Some identity providers only issue refresh tokens with offline_access.',
              default: 'openid',
            },
            {
              key: 'redirectPorts',
              type: 'string',
              title: 'Redirect ports',
              description:
                'Loopback ports to try in order, for identity providers that only accept exact registered redirect URIs. Leave empty for any free port.',
              placeholder: '8400, 8401',
            },
          ],
        },
        authorize: async (answer) => {
          // Nothing is sent to the proxy, so its URL is only recorded for discovery.
          const { providerID, baseURL } = await signInTarget(answer, resolveTarget)
          const config = parseOidcConfig({
            issuer: readAnswer(answer, 'issuer'),
            clientId: readAnswer(answer, 'clientId'),
            scope: readAnswer(answer, 'scope'),
            redirectPorts: readAnswer(answer, 'redirectPorts'),
          })
          const authorization = await authorizeOidc(config)
          return toAuthorization(authorization, OIDC_METHOD_ID, {
            providerID,
            ...(baseURL ? { baseURL } : {}),
          })
        },
        refresh,
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logInfo(`[opencode-litellm] Could not register the connect dialog integration: ${message}`)
    return undefined
  }
}

/**
 * Resolves the active credential for an integration into the values the
 * plugin needs: the API key (or a sign-in's access token) plus the dialog's
 * form answers.
 *
 * Returns undefined when the integration has no connection, the credential
 * is not a LiteLLM one, or the host lacks the connection API. Errors are
 * swallowed on purpose — a missing or unrelated integration must never
 * prevent other auth sources from working.
 */
export async function readConnectedConfig(
  context: Context,
  integrationID: string,
): Promise<ConnectedLiteLLM | undefined> {
  const connection = context.integration?.connection
  if (!connection) return undefined
  try {
    const active = await connection.active(integrationID)
    if (!active) return undefined
    // Resolving refreshes a sign-in whose access token is about to expire.
    const credential = await connection.resolve(active)
    const apiKey = connectionApiKey(credential)
    if (!credential || apiKey === undefined) return undefined
    // OpenCode 2.1 moved the form answers from `configuration` to `metadata`,
    // where sign-ins store theirs too.
    const answers = (credential.metadata ??
      (credential.type === 'key' ? credential.configuration : undefined)) as
      Record<string, unknown> | undefined
    return {
      apiKey,
      baseURL: readAnswer(answers, 'baseURL'),
      providerID: readAnswer(answers, 'providerID'),
      credentialID:
        credential.type === 'oauth' && active.type === 'credential' ? active.id : undefined,
    }
  } catch {
    return undefined
  }
}
