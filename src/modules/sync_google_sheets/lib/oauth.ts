// VENDORED, self-contained Google OAuth2 client (raw fetch — no `googleapis` SDK, no
// dependency on `@open-mercato/channel-gmail`). Replicates channel-gmail's
// RealGoogleOAuthClient shape against Google's documented OAuth2 v2 surface.
//
//   Authorize  https://accounts.google.com/o/oauth2/v2/auth
//   Token      https://oauth2.googleapis.com/token
//   Userinfo   https://www.googleapis.com/oauth2/v3/userinfo

import { requestOAuthToken, tokenResponseToExpiresAt, type OAuthTokenResponse } from './oauth-token'

export { tokenResponseToExpiresAt }
export type { OAuthTokenResponse }

export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
export const SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
export const DRIVE_METADATA_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly'
export const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'

/** Least-privilege default for import-only use. */
export const DEFAULT_IMPORT_SCOPES = [
  SHEETS_READONLY_SCOPE,
  DRIVE_METADATA_READONLY_SCOPE,
  USERINFO_EMAIL_SCOPE,
]
/** Superset needed once export/bidirectional is enabled (write access). */
export const DEFAULT_EXPORT_SCOPES = [
  SHEETS_WRITE_SCOPE,
  DRIVE_METADATA_READONLY_SCOPE,
  USERINFO_EMAIL_SCOPE,
]

const ENV_CLIENT_ID = 'GOOGLE_SHEETS_OAUTH_CLIENT_ID'
const ENV_CLIENT_SECRET = 'GOOGLE_SHEETS_OAUTH_CLIENT_SECRET'
const ENV_REDIRECT_URI = 'GOOGLE_SHEETS_OAUTH_REDIRECT_URI'
const ENV_SCOPES = 'GOOGLE_SHEETS_OAUTH_SCOPES'

/** Refresh a little before the real expiry to avoid using a token that dies mid-request. */
const TOKEN_EXPIRY_SKEW_MS = 60_000

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthConfigError'
  }
}

/** Thrown when the stored refresh token is revoked/invalid — the tenant must reconnect. */
export class OAuthReauthRequiredError extends Error {
  constructor(message = 'Google authorization is no longer valid; reconnect the account.') {
    super(message)
    this.name = 'OAuthReauthRequiredError'
  }
}

export function isReauthRequiredError(error: unknown): error is OAuthReauthRequiredError {
  return error instanceof OAuthReauthRequiredError
}

export function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter((s) => s.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return []
}

export type OAuthClientConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/**
 * Resolve the Google OAuth *app* client config. Per-tenant stored credential fields
 * (clientId/clientSecret) win, falling back to the shared app configured via env. The
 * redirect URI comes from env or an explicit override (e.g. derived from request origin).
 */
export function resolveOAuthClientConfig(
  credentials: Record<string, unknown> | null | undefined,
  options: { env?: NodeJS.ProcessEnv; redirectUriOverride?: string } = {},
): OAuthClientConfig {
  const env = options.env ?? process.env
  const creds = credentials ?? {}
  const clientId = firstNonEmpty(creds.clientId, env[ENV_CLIENT_ID])
  const clientSecret = firstNonEmpty(creds.clientSecret, env[ENV_CLIENT_SECRET])
  const redirectUri = firstNonEmpty(options.redirectUriOverride, env[ENV_REDIRECT_URI])

  if (!clientId || !clientSecret) {
    throw new OAuthConfigError(
      `Google Sheets OAuth client is not configured. Set ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET} (or per-tenant clientId/clientSecret credential fields).`,
    )
  }
  if (!redirectUri) {
    throw new OAuthConfigError(
      `Google Sheets OAuth redirect URI is not configured. Set ${ENV_REDIRECT_URI} to your app's <origin>/api/sync_google_sheets/oauth/callback.`,
    )
  }
  return { clientId, clientSecret, redirectUri }
}

export function resolveScopes(
  credentials: Record<string, unknown> | null | undefined,
  options: { env?: NodeJS.ProcessEnv; fallback?: string[] } = {},
): string[] {
  const env = options.env ?? process.env
  const fromCreds = parseScopes(credentials?.scopes)
  if (fromCreds.length) return fromCreds
  const fromEnv = parseScopes(env[ENV_SCOPES])
  if (fromEnv.length) return fromEnv
  return options.fallback ?? DEFAULT_IMPORT_SCOPES
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

export interface BuildAuthorizeUrlInput {
  clientId: string
  redirectUri: string
  state: string
  scopes: string[]
  loginHint?: string
}

export interface ExchangeCodeInput {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
}

export interface RefreshTokenInput {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface UserInfoResponse {
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

export interface GoogleOAuthClient {
  buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string
  exchangeCode(input: ExchangeCodeInput): Promise<OAuthTokenResponse>
  refreshToken(input: RefreshTokenInput): Promise<OAuthTokenResponse>
  fetchUserInfo(accessToken: string): Promise<UserInfoResponse>
}

class RealGoogleOAuthClient implements GoogleOAuthClient {
  buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
    const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL)
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', (input.scopes.length ? input.scopes : DEFAULT_IMPORT_SCOPES).join(' '))
    url.searchParams.set('state', input.state)
    // access_type=offline + prompt=consent are required to receive a refresh_token.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('include_granted_scopes', 'true')
    if (input.loginHint) url.searchParams.set('login_hint', input.loginHint)
    return url.toString()
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams()
    params.set('grant_type', 'authorization_code')
    params.set('code', input.code)
    params.set('redirect_uri', input.redirectUri)
    params.set('client_id', input.clientId)
    params.set('client_secret', input.clientSecret)
    return requestOAuthToken(GOOGLE_OAUTH_TOKEN_URL, params, {
      errorLabel: 'Google Sheets OAuth code exchange failed',
    })
  }

  async refreshToken(input: RefreshTokenInput): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams()
    params.set('grant_type', 'refresh_token')
    params.set('refresh_token', input.refreshToken)
    params.set('client_id', input.clientId)
    params.set('client_secret', input.clientSecret)
    return requestOAuthToken(GOOGLE_OAUTH_TOKEN_URL, params, {
      errorLabel: 'Google Sheets OAuth refresh failed',
    })
  }

  async fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(GOOGLE_OAUTH_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`Google userinfo fetch failed: ${res.status} ${res.statusText}`)
      }
      return (await res.json()) as UserInfoResponse
    } finally {
      clearTimeout(timeout)
    }
  }
}

let cachedClient: GoogleOAuthClient | null = null

export function getGoogleOAuthClient(): GoogleOAuthClient {
  if (!cachedClient) cachedClient = new RealGoogleOAuthClient()
  return cachedClient
}

/** Test hook: inject a stub client (pass null to restore the real one). */
export function setGoogleOAuthClient(client: GoogleOAuthClient | null): void {
  cachedClient = client
}

/** The connection tokens this module persists in the integration credentials blob. */
export type StoredOAuthTokens = {
  refresh_token?: string | null
  access_token?: string | null
  /** Absolute expiry, epoch ms. */
  expires_at?: number | null
}

function readExpiresAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const asNum = Number(value)
    if (Number.isFinite(asNum)) return asNum
    const asDate = Date.parse(value)
    if (Number.isFinite(asDate)) return asDate
  }
  return null
}

/**
 * Return a valid access token for the stored connection, refreshing via the refresh token
 * when the cached access token is missing or (near) expired. `onRefreshed` persists the
 * newly minted token set so the next run reuses it. Throws OAuthReauthRequiredError when
 * the refresh token is revoked (Google `invalid_grant`).
 */
export async function getValidAccessToken(params: {
  credentials: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  forceRefresh?: boolean
  nowMs?: number
  onRefreshed?: (tokens: Required<StoredOAuthTokens>) => Promise<void> | void
  client?: GoogleOAuthClient
}): Promise<string> {
  const now = params.nowMs ?? Date.now()
  const accessToken = typeof params.credentials.access_token === 'string' ? params.credentials.access_token : ''
  const expiresAt = readExpiresAtMs(params.credentials.expires_at)
  const refreshToken = typeof params.credentials.refresh_token === 'string' ? params.credentials.refresh_token : ''

  const stillValid = !params.forceRefresh && accessToken && expiresAt !== null && expiresAt - TOKEN_EXPIRY_SKEW_MS > now
  if (stillValid) return accessToken

  if (!refreshToken) {
    throw new OAuthReauthRequiredError('No Google refresh token is stored; connect the account first.')
  }

  const clientConfig = resolveOAuthClientConfig(params.credentials, { env: params.env })
  const client = params.client ?? getGoogleOAuthClient()

  let token: OAuthTokenResponse
  try {
    token = await client.refreshToken({
      clientId: clientConfig.clientId,
      clientSecret: clientConfig.clientSecret,
      refreshToken,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/invalid_grant/i.test(message)) {
      throw new OAuthReauthRequiredError()
    }
    throw err
  }

  const newExpiry = tokenResponseToExpiresAt(token, now)
  const refreshed: Required<StoredOAuthTokens> = {
    access_token: token.access_token,
    // Google usually omits refresh_token on refresh — keep the existing one.
    refresh_token: token.refresh_token ?? refreshToken,
    expires_at: newExpiry ? newExpiry.getTime() : now + 3_500_000,
  }
  if (params.onRefreshed) await params.onRefreshed(refreshed)
  return token.access_token
}
