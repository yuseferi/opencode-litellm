import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { normalizeBaseURL } from './litellm-api'

// Cap for each login and refresh request to the proxy or the identity provider.
const REQUEST_TIMEOUT_MS = 10_000
// How long a browser sign-in may take; the connect attempt expires with it.
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000
const CLI_SSO_POLL_INTERVAL_MS = 2_000
const CLI_SSO_EXPIRES_IN_SECONDS = 600
// LiteLLM's default CLI token lifetime, for proxies whose poll response omits `expires_in`.
const CLI_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000
const CLI_AUTH_DISCOVERY_PATH = '/.well-known/litellm-cli-auth'
const OIDC_DISCOVERY_PATH = '/.well-known/openid-configuration'
/** Expiry of a token that carries none, such as a virtual key without `expires`. */
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER
// Persisted in credential metadata; never rename.
const PKCE_FLOW = 'litellm_cli_pkce'
const OIDC_FLOW = 'oidc_pkce'

/** A signed-in session; OpenCode stores it as the OAuth credential, metadata included. */
export interface SsoToken {
  access: string
  refresh: string
  /** Exact expiry in epoch milliseconds; OpenCode refreshes five minutes before it. */
  expires: number
  metadata: Record<string, unknown>
}

/** A started sign-in, in the shape of OpenCode's OAuth authorization. */
export type SsoAuthorization = { url: string; instructions: string; expiresAt?: number } & (
  | { mode: 'auto'; callback: Promise<SsoToken> }
  | { mode: 'code'; callback: (code: string) => Promise<SsoToken> }
)

export interface OidcConfig {
  issuer: string
  clientId: string
  scope: string
  redirectPorts: number[]
}

type Json = Record<string, unknown>
type ProxyHeaders = Record<string, string> | undefined
type TokenFailure = { ok: false; transient: boolean; message: string }
type TokenResult =
  { ok: true; token: { access: string; refresh: string; expires: number } } | TokenFailure
type CliAuthDiscovery = {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  resource: string
}
type CliSsoStart = {
  loginId: string
  pollSecret: string
  userCode: string
  expiresInSeconds: number
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Tokens and client IDs: printable ASCII without spaces. */
function isAuthToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value)
}

/** The OAuth `error` code when it is a plain code; descriptions and other fields are never echoed. */
function oauthErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

// A loop, not /\/+$/: that regex backtracks quadratically on a long slash run followed by another character.
function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return value.slice(0, end)
}

function expiresIn(seconds: number): number {
  return Math.floor(Date.now() + seconds * 1_000)
}

function requestSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
}

function authHeaders(headers: ProxyHeaders, contentType?: string): Headers {
  const result = new Headers(headers)
  result.set('Accept', 'application/json')
  if (contentType) result.set('Content-Type', contentType)
  return result
}

async function readJson(response: Response, stage: string): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error(`${stage} returned invalid JSON`)
  }
}

// The host awaits a callback only once the attempt is recorded; until then a rejection must not crash the process.
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {})
  return promise
}

function constantTimeEqual(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function jwtClaims(token: string): Json | undefined {
  const [, payload, ...rest] = token.split('.')
  if (rest.length !== 1 || !payload || !/^[\w-]+$/.test(payload)) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return isRecord(claims) ? claims : undefined
  } catch {
    return undefined
  }
}

/** A JWT's `exp` in milliseconds, or `fallback` for an opaque token. */
function tokenExpiry(token: string, fallback: number): number {
  const exp = positiveNumber(jwtClaims(token)?.exp)
  return exp === undefined ? fallback : Math.min(Math.floor(exp * 1_000), NEVER_EXPIRES)
}

/**
 * The proxy root a sign-in talks to. SSO tokens are bearer credentials, so plain http is only
 * accepted on a loopback host.
 */
export function ssoRoot(baseURL: string): string {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new Error(`LiteLLM base URL is not a valid URL: ${baseURL}`)
  }
  const host = url.hostname
  const loopback =
    host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'))
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('LiteLLM sign-in needs an https base URL (http only on a loopback host)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('LiteLLM base URL must not carry credentials, a query, or a fragment')
  }
  return normalizeBaseURL(url.href)
}

/**
 * The proxy a sign-in for `providerID` goes to. Explicit configuration wins in discovery, so a typed
 * URL that differs from it is refused: the token would be sent to a proxy that did not issue it.
 */
export function signInRoot(
  typed: string | undefined,
  configured: string | undefined,
  providerID: string,
): string | undefined {
  if (typed && configured && ssoRoot(typed) !== ssoRoot(configured)) {
    throw new Error(
      `Provider "${providerID}" is configured for ${configured}; leave Base URL empty to sign in there`,
    )
  }
  const baseURL = typed ?? configured ?? (process.env.LITELLM_BASE_URL?.trim() || undefined)
  return baseURL && ssoRoot(baseURL)
}

/** Whether two base URLs name the same proxy. */
export function sameProxy(a: string, b: string): boolean {
  try {
    return ssoRoot(a) === ssoRoot(b)
  } catch {
    return false
  }
}

/** What a sign-in's model cache is keyed by: stable while its tokens rotate, new for a new sign-in. */
export function ssoIdentity(token: SsoToken): string {
  const { flow, clientId, issuer, subject } = token.metadata
  if (flow === PKCE_FLOW) return `${flow} ${String(clientId)}`
  if (flow === OIDC_FLOW) return `${flow} ${String(issuer)} ${String(subject)}`
  // CLI SSO and UI tokens are never refreshed.
  return token.access
}

function canonicalIssuer(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash)
    throw new Error('LiteLLM CLI auth has invalid issuer')
  return `${url.origin}${trimTrailingSlashes(url.pathname) || '/'}`
}

function sameOriginUrl(value: unknown, issuer: URL, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`LiteLLM CLI auth discovery has invalid ${field}`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`LiteLLM CLI auth discovery has invalid ${field}`)
  }
  if (url.origin !== issuer.origin)
    throw new Error(`LiteLLM CLI auth discovery has cross-origin ${field}`)
  if (url.username || url.password || url.hash)
    throw new Error(`LiteLLM CLI auth discovery has invalid ${field}`)
  return value.trim()
}

/** An https URL without credentials or fragment, returned verbatim. */
function httpsUrl(value: unknown, { allowQuery }: { allowQuery: boolean }): string | undefined {
  if (typeof value !== 'string' || value.includes('#') || (!allowQuery && value.includes('?')))
    return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value : undefined
  } catch {
    return undefined
  }
}

/** POSTs a token form without following redirects; each flow validates its own success fields. */
async function postTokenForm(
  endpoint: string,
  form: URLSearchParams,
  headers: ProxyHeaders,
  label: string,
): Promise<{ ok: true; data: Json } | TokenFailure> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(headers, 'application/x-www-form-urlencoded'),
      body: form,
      redirect: 'manual',
      signal: requestSignal(),
    })
  } catch {
    return { ok: false, transient: true, message: `${label} token exchange failed (network error)` }
  }
  let data: Json | undefined
  try {
    const parsed: unknown = await response.json()
    if (isRecord(parsed)) data = parsed
  } catch (error) {
    if (response.ok && !(error instanceof SyntaxError)) {
      return {
        ok: false,
        transient: true,
        message: `${label} token exchange failed (network error)`,
      }
    }
  }
  if (!response.ok) {
    const code = oauthErrorCode(data?.error)
    return {
      ok: false,
      transient: response.status === 429 || response.status >= 500,
      message: code
        ? `${label} token exchange rejected (${code})`
        : `${label} token exchange failed (HTTP ${response.status})`,
    }
  }
  return { ok: true, data: data ?? {} }
}

async function requestPkceToken(
  endpoint: string,
  form: URLSearchParams,
  headers: ProxyHeaders,
  existingRefreshToken?: string,
): Promise<TokenResult> {
  const response = await postTokenForm(endpoint, form, headers, 'LiteLLM')
  if (!response.ok) return response
  const { data } = response
  const lifetime = positiveNumber(data.expires_in)
  const expires = lifetime === undefined ? NaN : expiresIn(lifetime)
  if (
    !isAuthToken(data.access_token) ||
    (!isAuthToken(data.refresh_token) && !isAuthToken(existingRefreshToken)) ||
    typeof data.token_type !== 'string' ||
    data.token_type.toLowerCase() !== 'bearer' ||
    !Number.isSafeInteger(expires)
  ) {
    return {
      ok: false,
      transient: false,
      message: 'LiteLLM token exchange returned an invalid response',
    }
  }
  return {
    ok: true,
    token: {
      access: data.access_token,
      // A refresh may not rotate the refresh token; keep the existing one when the server omits it.
      refresh: isAuthToken(data.refresh_token) ? data.refresh_token : existingRefreshToken!,
      expires,
    },
  }
}

/**
 * Exchanges a grant for an id_token and checks its claims (OIDC Core §3.1.3.7). The signature is
 * deliberately not verified: the proxy verifies it against the IdP's keys before honouring the
 * bearer, so these checks only stop OpenCode from storing a token meant for another client or login.
 */
async function requestOidcToken(
  endpoint: string,
  form: URLSearchParams,
  expected: { issuer: string; clientId: string; nonce?: string; subject?: string },
  existingRefreshToken = '',
): Promise<TokenResult & { subject?: string }> {
  // IdP requests never carry the proxy's headers: they can hold gateway credentials.
  const response = await postTokenForm(endpoint, form, undefined, 'OIDC')
  if (!response.ok) return response
  const { id_token: idToken, refresh_token: refreshToken } = response.data
  const claims = isAuthToken(idToken) ? jwtClaims(idToken) : undefined
  if (!isAuthToken(idToken) || !claims) {
    return { ok: false, transient: false, message: 'OIDC token response has no valid id_token' }
  }
  const invalid = (claim: string): TokenFailure => ({
    ok: false,
    transient: false,
    message: `OIDC id_token has invalid ${claim}`,
  })
  if (claims.iss !== expected.issuer) return invalid('iss')
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(expected.clientId))
    return invalid('aud')
  // azp is optional, even with several audiences, but when present it must name this client.
  if (claims.azp !== undefined && claims.azp !== expected.clientId) return invalid('azp')
  if (typeof claims.sub !== 'string' || !claims.sub) return invalid('sub')
  if (expected.subject !== undefined && claims.sub !== expected.subject) return invalid('sub')
  const expires = typeof claims.exp === 'number' ? Math.floor(claims.exp * 1_000) : NaN
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return invalid('exp')
  if (expected.nonce !== undefined && !constantTimeEqual(claims.nonce, expected.nonce))
    return invalid('nonce')
  return {
    ok: true,
    token: {
      access: idToken,
      // The refresh token is optional, and an IdP that does not rotate it keeps the existing one valid.
      refresh: isAuthToken(refreshToken) ? refreshToken : existingRefreshToken,
      expires,
    },
    subject: claims.sub,
  }
}

interface Loopback {
  redirectUri: string
  state: string
  expiresAt: number
  /** The authorization code of the first callback carrying `state`. */
  code: Promise<string>
  close(): void
}

/**
 * Serves an RFC 8252 loopback redirect on 127.0.0.1 until `code` settles: on the first valid
 * callback, an OAuth error, the sign-in timeout, or `close()`.
 */
async function listenForCallback(label: string, ports: readonly number[]): Promise<Loopback> {
  const state = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + CALLBACK_TIMEOUT_MS
  const server = createServer()
  let settle!: (result: { code?: string; error?: Error }) => void
  const code = handled(
    new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => settle({ error: new Error(`${label} sign-in timed out`) }),
        CALLBACK_TIMEOUT_MS,
      )
      settle = (result) => {
        settle = () => {}
        clearTimeout(timeout)
        server.close()
        if (result.error) reject(result.error)
        else resolve(result.code!)
      }
    }),
  )
  server.on('request', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      response.writeHead(400).end('Invalid callback URL')
      return
    }
    if (url.pathname !== '/callback') {
      response.writeHead(404).end()
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end()
      return
    }
    if (!constantTimeEqual(url.searchParams.get('state'), state)) {
      response.writeHead(400).end('Invalid OAuth state')
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      response.writeHead(400).end('OAuth login failed')
      const errorCode = oauthErrorCode(error)
      settle({
        error: new Error(`${label} sign-in was denied${errorCode ? ` (${errorCode})` : ''}`),
      })
      return
    }
    const authorizationCode = url.searchParams.get('code')
    if (!authorizationCode) {
      response.writeHead(400).end('Missing OAuth code')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><title>LiteLLM login complete</title><p>You can close this window.</p>',
    )
    settle({ code: authorizationCode })
  })
  // Try each pre-registered port in order; without any, the OS assigns one (RFC 8252 §7.3).
  const candidates = ports.length > 0 ? ports : [0]
  for (const [index, port] of candidates.entries()) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      break
    } catch (error) {
      if (index === candidates.length - 1) {
        settle({ error: error as Error })
        throw error
      }
    }
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    settle({ error: new Error(`${label} callback failed to start`) })
    throw new Error(`${label} callback failed to start`)
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    state,
    expiresAt,
    code,
    close: () => settle({ error: new Error(`${label} sign-in cancelled`) }),
  }
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

async function discoverPkce(
  root: string,
  headers: ProxyHeaders,
): Promise<CliAuthDiscovery | undefined> {
  const response = await fetch(`${root}${CLI_AUTH_DISCOVERY_PATH}`, {
    headers: authHeaders(headers),
    redirect: 'manual',
    signal: requestSignal(),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`LiteLLM CLI auth discovery failed (HTTP ${response.status})`)
  const data = await readJson(response, 'LiteLLM CLI auth discovery')
  if (!isRecord(data) || data.contract_version !== 1) {
    throw new Error('LiteLLM CLI auth discovery has unsupported contract version')
  }
  if (
    !Array.isArray(data.code_challenge_methods_supported) ||
    !data.code_challenge_methods_supported.includes('S256')
  ) {
    throw new Error('LiteLLM CLI auth discovery does not support S256')
  }
  let issuer: URL
  try {
    issuer = new URL(String(data.issuer))
    if (canonicalIssuer(issuer.href) !== canonicalIssuer(root)) throw new Error('mismatch')
  } catch {
    throw new Error('LiteLLM CLI auth discovery issuer does not match the proxy URL')
  }
  return {
    authorizationEndpoint: sameOriginUrl(
      data.authorization_endpoint,
      issuer,
      'authorization endpoint',
    ),
    tokenEndpoint: sameOriginUrl(data.token_endpoint, issuer, 'token endpoint'),
    registrationEndpoint: sameOriginUrl(
      data.registration_endpoint,
      issuer,
      'registration endpoint',
    ),
    resource: sameOriginUrl(data.resource, issuer, 'resource'),
  }
}

/** LiteLLM's CLI-auth contract: dynamic client registration, then authorization code + PKCE. */
async function authorizePkce(
  root: string,
  discovery: CliAuthDiscovery,
  headers: ProxyHeaders,
): Promise<SsoAuthorization> {
  const verifier = randomBytes(32).toString('base64url')
  const callback = await listenForCallback('LiteLLM', [])
  try {
    const registrationResponse = await fetch(discovery.registrationEndpoint, {
      method: 'POST',
      headers: authHeaders(headers, 'application/json'),
      body: JSON.stringify({
        client_name: 'opencode-litellm',
        redirect_uris: [callback.redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
      redirect: 'manual',
      signal: requestSignal(),
    })
    if (!registrationResponse.ok) {
      throw new Error(
        `LiteLLM PKCE client registration failed (HTTP ${registrationResponse.status})`,
      )
    }
    const registration = await readJson(registrationResponse, 'LiteLLM CLI auth registration')
    if (
      !isRecord(registration) ||
      !isAuthToken(registration.client_id) ||
      !Array.isArray(registration.redirect_uris) ||
      !registration.redirect_uris.includes(callback.redirectUri)
    ) {
      throw new Error('LiteLLM PKCE client registration returned an invalid response')
    }
    const clientId = registration.client_id
    const url = new URL(discovery.authorizationEndpoint)
    for (const [key, value] of Object.entries({
      client_id: clientId,
      redirect_uri: callback.redirectUri,
      response_type: 'code',
      resource: discovery.resource,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: callback.state,
    })) {
      url.searchParams.set(key, value)
    }
    return {
      mode: 'auto',
      url: url.toString(),
      instructions: 'Sign in to LiteLLM in your browser, on the machine that runs OpenCode.',
      expiresAt: callback.expiresAt,
      callback: handled(
        callback.code.then(async (code) => {
          const result = await requestPkceToken(
            discovery.tokenEndpoint,
            new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: callback.redirectUri,
              client_id: clientId,
              code_verifier: verifier,
              resource: discovery.resource,
            }),
            headers,
          )
          if (!result.ok) throw new Error(result.message)
          return {
            ...result.token,
            metadata: {
              flow: PKCE_FLOW,
              baseURL: root,
              clientId,
              tokenEndpoint: discovery.tokenEndpoint,
              resource: discovery.resource,
            },
          }
        }),
      ),
    }
  } catch (error) {
    callback.close()
    throw error
  }
}

async function startCliSso(root: string, headers: ProxyHeaders): Promise<CliSsoStart | undefined> {
  const response = await fetch(`${root}/sso/cli/start`, {
    method: 'POST',
    headers,
    redirect: 'manual',
    signal: requestSignal(),
  })
  if (response.status === 404 || response.status === 405) return undefined
  if (!response.ok) throw new Error(`LiteLLM CLI SSO start failed (HTTP ${response.status})`)
  const data = await readJson(response, 'LiteLLM CLI SSO start')
  if (
    !isRecord(data) ||
    typeof data.login_id !== 'string' ||
    !data.login_id ||
    typeof data.poll_secret !== 'string' ||
    !data.poll_secret ||
    typeof data.user_code !== 'string' ||
    !data.user_code
  ) {
    throw new Error('LiteLLM CLI SSO start returned an invalid response')
  }
  return {
    loginId: data.login_id,
    pollSecret: data.poll_secret,
    userCode: data.user_code,
    expiresInSeconds: positiveNumber(data.expires_in) ?? CLI_SSO_EXPIRES_IN_SECONDS,
  }
}

/** The teams a CLI SSO poll offers, as `id` plus a display label. */
function cliSsoTeams(data: Json): Array<{ id: string; label: string }> {
  const details = Array.isArray(data.team_details) ? data.team_details : []
  const teams = details.flatMap((team) => {
    if (!isRecord(team)) return []
    const id = typeof team.team_id === 'string' ? team.team_id : team.id
    const alias = team.team_alias
    return typeof id === 'string' && id
      ? [{ id, label: typeof alias === 'string' && alias ? alias : id }]
      : []
  })
  if (teams.length === 0 && Array.isArray(data.teams)) {
    teams.push(
      ...data.teams.flatMap((id) => (typeof id === 'string' && id ? [{ id, label: id }] : [])),
    )
  }
  return teams
}

async function pollCliSso(
  root: string,
  start: CliSsoStart,
  headers: ProxyHeaders,
  team?: string,
): Promise<SsoToken> {
  const deadline = Date.now() + start.expiresInSeconds * 1_000
  const pollUrl = new URL(`${root}/sso/cli/poll/${encodeURIComponent(start.loginId)}`)
  let teamId: string | undefined
  while (Date.now() < deadline) {
    if (teamId) pollUrl.searchParams.set('team_id', teamId)
    let response: Response
    try {
      response = await fetch(pollUrl, {
        headers: { ...headers, 'x-litellm-cli-poll-secret': start.pollSecret },
        redirect: 'manual',
        signal: requestSignal(),
      })
    } catch {
      await delay(CLI_SSO_POLL_INTERVAL_MS)
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      await delay(CLI_SSO_POLL_INTERVAL_MS)
      continue
    }
    if (response.status === 400) throw new Error('LiteLLM CLI SSO login expired or is invalid')
    if (!response.ok) throw new Error(`LiteLLM CLI SSO polling failed (HTTP ${response.status})`)
    const data = await readJson(response, 'LiteLLM CLI SSO polling')
    if (!isRecord(data)) throw new Error('LiteLLM CLI SSO polling returned an invalid response')
    if (data.status === 'ready' && isAuthToken(data.key)) {
      const lifetime = positiveNumber(data.expires_in)
      return {
        access: data.key,
        refresh: '',
        expires: lifetime
          ? expiresIn(lifetime)
          : tokenExpiry(data.key, Date.now() + CLI_TOKEN_LIFETIME_MS),
        metadata: { baseURL: root },
      }
    }
    if (data.status === 'ready' && data.requires_team_selection === true && !teamId) {
      const teams = cliSsoTeams(data)
      if (teams.length === 0)
        throw new Error('LiteLLM CLI SSO requested team selection without any teams')
      const selected = team
        ? teams.find((candidate) => candidate.id === team || candidate.label === team)
        : undefined
      if (!selected) {
        // The connect dialog cannot ask mid-sign-in, so the choice has to come from the Team field.
        const choices = teams
          .map(({ id, label }) => (label === id ? id : `${label} (${id})`))
          .join(', ')
        throw new Error(
          `${team ? `Your LiteLLM account has no team "${team}"` : 'LiteLLM asks which team to sign in with'}; connect again with one of these as Team: ${choices}`,
        )
      }
      teamId = selected.id
      continue
    }
    if (data.status !== 'pending')
      throw new Error('LiteLLM CLI SSO polling returned an invalid response')
    await delay(CLI_SSO_POLL_INTERVAL_MS)
  }
  throw new Error('LiteLLM CLI SSO login expired')
}

async function generateVirtualKey(
  root: string,
  userToken: string,
  headers: ProxyHeaders,
): Promise<{ key: string; expires?: number }> {
  const response = await fetch(`${root}/key/generate`, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    redirect: 'manual',
    signal: requestSignal(),
  })
  if (!response.ok) throw new Error(`/key/generate failed (HTTP ${response.status})`)
  const data = await readJson(response, '/key/generate')
  if (!isRecord(data) || !isAuthToken(data.key)) throw new Error('/key/generate returned no key')
  const expires = typeof data.expires === 'string' ? Date.parse(data.expires) : NaN
  return { key: data.key, expires: Number.isSafeInteger(expires) ? expires : undefined }
}

/** The oldest flow: the user copies a token from the LiteLLM UI, exchanged for a virtual key when the proxy allows it. */
function authorizePastedToken(root: string, headers: ProxyHeaders): SsoAuthorization {
  return {
    mode: 'code',
    url: `${root}/sso/key/generate`,
    instructions:
      'Sign in to LiteLLM in your browser, then paste the token from the LiteLLM UI as the code.',
    callback: async (code) => {
      const token = code
        .trim()
        .replace(/^Bearer\s+/i, '')
        .trim()
      if (!isAuthToken(token)) throw new Error('Paste the token from the LiteLLM UI')
      try {
        const generated = await generateVirtualKey(root, token, headers)
        return {
          access: generated.key,
          refresh: '',
          expires: generated.expires ?? NEVER_EXPIRES,
          metadata: { baseURL: root },
        }
      } catch (error) {
        // `/key/generate` needs a database and key-generation rights; the UI token works on its own.
        const message = error instanceof Error ? error.message : String(error)
        console.log(
          `[opencode-litellm] Using the pasted LiteLLM token directly; no virtual key: ${message}`,
        )
        return {
          access: token,
          refresh: '',
          expires: tokenExpiry(token, NEVER_EXPIRES),
          metadata: { baseURL: root },
        }
      }
    },
  }
}

/**
 * Starts a LiteLLM-hosted sign-in, preferring the newest flow the proxy offers: the CLI-auth
 * contract (authorization code + PKCE), then CLI SSO with a confirmation code, then a token
 * pasted from the LiteLLM UI.
 */
export async function authorizeLiteLLM(
  baseURL: string,
  headers?: Record<string, string>,
  team?: string,
): Promise<SsoAuthorization> {
  const root = ssoRoot(baseURL)
  const discovery = await discoverPkce(root, headers)
  if (discovery) return authorizePkce(root, discovery, headers)
  const start = await startCliSso(root, headers)
  if (!start) return authorizePastedToken(root, headers)
  return {
    mode: 'auto',
    url: `${root}/sso/key/generate?${new URLSearchParams({ source: 'litellm-cli', key: start.loginId })}`,
    // OpenCode 1's connect dialog shows the text after the last colon as the code to confirm.
    instructions: `Sign in to LiteLLM in your browser and confirm this code: ${start.userCode}`,
    expiresAt: expiresIn(start.expiresInSeconds),
    callback: handled(pollCliSso(root, start, headers, team)),
  }
}

/** Validates the identity provider fields of the connect form. */
export function parseOidcConfig(raw: {
  issuer?: string
  clientId?: string
  scope?: string
  redirectPorts?: string
}): OidcConfig {
  const invalid = (field: string, expected: string) =>
    new Error(`Invalid OIDC ${field}: expected ${expected}`)
  const issuer = httpsUrl(raw.issuer?.trim(), { allowQuery: false })
  if (!issuer) throw invalid('issuer', 'an https URL without credentials, query, or fragment')
  const clientId = raw.clientId?.trim()
  if (!isAuthToken(clientId)) throw invalid('client ID', 'a non-empty value without spaces')
  const scope = raw.scope?.trim() || 'openid'
  if (!scope.split(/\s+/).includes('openid'))
    throw invalid('scopes', 'a space-separated list that includes "openid"')
  const redirectPorts = (raw.redirectPorts ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (!redirectPorts.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw invalid('redirect ports', 'port numbers from 1 to 65535')
  }
  return { issuer, clientId, scope, redirectPorts }
}

async function discoverOidc(
  issuer: string,
): Promise<{ issuer: string; authorizationEndpoint: string; tokenEndpoint: string }> {
  const response = await fetch(`${trimTrailingSlashes(issuer)}${OIDC_DISCOVERY_PATH}`, {
    headers: authHeaders(undefined),
    redirect: 'manual',
    signal: requestSignal(),
  })
  if (!response.ok) throw new Error(`OIDC discovery failed (HTTP ${response.status})`)
  const data = await readJson(response, 'OIDC discovery')
  if (
    !isRecord(data) ||
    typeof data.issuer !== 'string' ||
    trimTrailingSlashes(data.issuer) !== trimTrailingSlashes(issuer)
  ) {
    throw new Error('OIDC discovery issuer does not match the configured issuer')
  }
  const methods = data.code_challenge_methods_supported
  if (methods !== undefined && (!Array.isArray(methods) || !methods.includes('S256'))) {
    throw new Error('OIDC discovery does not support S256')
  }
  const authorizationEndpoint = httpsUrl(data.authorization_endpoint, { allowQuery: true })
  if (!authorizationEndpoint) throw new Error('OIDC discovery has invalid authorization_endpoint')
  const tokenEndpoint = httpsUrl(data.token_endpoint, { allowQuery: true })
  if (!tokenEndpoint) throw new Error('OIDC discovery has invalid token_endpoint')
  return { issuer: data.issuer, authorizationEndpoint, tokenEndpoint }
}

/**
 * Signs in with the identity provider directly, as a public client, for proxies running LiteLLM
 * JWT auth. The `id_token` becomes the bearer token; nothing is sent to the proxy.
 */
export async function authorizeOidc(config: OidcConfig): Promise<SsoAuthorization> {
  const discovery = await discoverOidc(config.issuer)
  const verifier = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const callback = await listenForCallback('OIDC', config.redirectPorts)
  const url = new URL(discovery.authorizationEndpoint)
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: callback.redirectUri,
    scope: config.scope,
    state: callback.state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  })) {
    url.searchParams.set(key, value)
  }
  return {
    mode: 'auto',
    url: url.toString(),
    instructions:
      'Sign in with your identity provider in your browser, on the machine that runs OpenCode.',
    expiresAt: callback.expiresAt,
    callback: handled(
      callback.code.then(async (code) => {
        const result = await requestOidcToken(
          discovery.tokenEndpoint,
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: callback.redirectUri,
            client_id: config.clientId,
            code_verifier: verifier,
          }),
          { issuer: discovery.issuer, clientId: config.clientId, nonce },
        )
        if (!result.ok) throw new Error(result.message)
        return {
          ...result.token,
          metadata: {
            flow: OIDC_FLOW,
            issuer: discovery.issuer,
            clientId: config.clientId,
            tokenEndpoint: discovery.tokenEndpoint,
            subject: result.subject,
            scope: config.scope,
          },
        }
      }),
    ),
  }
}

/**
 * Renews a session through its token endpoint. A transient failure keeps the current token until it
 * actually expires; CLI SSO and UI tokens have no refresh grant and last until they expire.
 */
export async function refreshSsoToken(
  token: SsoToken,
  headers?: Record<string, string>,
): Promise<SsoToken> {
  const { metadata } = token
  let result: TokenResult
  if (metadata.flow === PKCE_FLOW) {
    if (
      typeof metadata.baseURL !== 'string' ||
      !isAuthToken(metadata.clientId) ||
      !isAuthToken(token.refresh)
    ) {
      throw new Error('Invalid LiteLLM PKCE credential; connect LiteLLM again')
    }
    const issuer = new URL(ssoRoot(metadata.baseURL))
    result = await requestPkceToken(
      sameOriginUrl(metadata.tokenEndpoint, issuer, 'token endpoint'),
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh,
        client_id: metadata.clientId,
        resource: sameOriginUrl(metadata.resource, issuer, 'resource'),
      }),
      headers,
      token.refresh,
    )
  } else if (metadata.flow === OIDC_FLOW && isAuthToken(token.refresh)) {
    const tokenEndpoint = httpsUrl(metadata.tokenEndpoint, { allowQuery: true })
    const { issuer, clientId, subject } = metadata
    if (
      !tokenEndpoint ||
      typeof issuer !== 'string' ||
      !isAuthToken(clientId) ||
      typeof subject !== 'string' ||
      !subject
    ) {
      throw new Error('Invalid LiteLLM OIDC credential; connect LiteLLM again')
    }
    result = await requestOidcToken(
      tokenEndpoint,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh,
        client_id: clientId,
      }),
      { issuer, clientId, subject },
      token.refresh,
    )
  } else {
    if (Date.now() < token.expires) return token
    throw new Error('LiteLLM sign-in expired; connect LiteLLM again')
  }
  if (result.ok) return { ...token, ...result.token }
  if (result.transient && Date.now() < token.expires) return token
  // A transient failure leaves the session intact, and a new sign-in would need the same endpoint.
  throw new Error(result.transient ? result.message : `${result.message}; connect LiteLLM again`)
}
