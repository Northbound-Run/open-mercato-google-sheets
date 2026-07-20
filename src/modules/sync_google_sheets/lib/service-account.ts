// Service-account auth for app-owned sheets: no OAuth consent, no refresh tokens. Mint a
// short-lived access token via the JWT-bearer flow — build a JWT asserting the service
// account's identity + scopes, sign it RS256 with the SA private key, and exchange it at
// Google's token endpoint. Raw-fetch (via the shared requestOAuthToken helper), no SDK —
// consistent with the vendored oauth.ts. This module is framework-free (unit-testable).

import { createSign } from 'node:crypto'
import { requestOAuthToken } from './oauth-token'
import { DRIVE_METADATA_READONLY_SCOPE, SHEETS_WRITE_SCOPE } from './oauth'
import type { AccessTokenProvider } from './sheets-client'

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const TOKEN_LIFETIME_SEC = 3600
const TOKEN_EXPIRY_SKEW_MS = 60_000

const ENV_SA_CLIENT_EMAIL = 'GOOGLE_SHEETS_SA_CLIENT_EMAIL'
const ENV_SA_PRIVATE_KEY = 'GOOGLE_SHEETS_SA_PRIVATE_KEY'
const ENV_SA_SUBJECT = 'GOOGLE_SHEETS_SA_SUBJECT'

export type ServiceAccountCredentials = {
  client_email: string
  private_key: string
  /** Optional: a Workspace user to impersonate via domain-wide delegation. */
  subject?: string | null
}

/** Default scopes for app-owned sheets: read+write Sheets + Drive metadata (change signal). */
export const DEFAULT_SERVICE_ACCOUNT_SCOPES = [SHEETS_WRITE_SCOPE, DRIVE_METADATA_READONLY_SCOPE]

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// SA JSON keys carry a PEM whose newlines are often stored as literal `\n` (e.g. when pasted
// into an env var or JSON); restore real newlines so node's crypto can parse the key.
export function normalizePrivateKey(key: string): string {
  const trimmed = key.trim()
  return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed
}

/**
 * Resolve service-account credentials from the integration credential blob, falling back to
 * env (a single app-wide service account). Returns null when no SA key is present — the
 * caller then uses the OAuth path.
 */
export function resolveServiceAccountCredentials(
  credentials: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceAccountCredentials | null {
  const creds = credentials ?? {}
  const client_email = firstString(creds.client_email, creds.clientEmail, env[ENV_SA_CLIENT_EMAIL])
  const private_key = firstString(creds.private_key, creds.privateKey, env[ENV_SA_PRIVATE_KEY])
  if (!client_email || !private_key) return null
  const subject = firstString(creds.subject, creds.impersonate, env[ENV_SA_SUBJECT]) || null
  return { client_email, private_key, subject }
}

/** True when service-account credentials are available (blob or env). */
export function isServiceAccountCredentials(
  credentials: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveServiceAccountCredentials(credentials, env) !== null
}

/** Build and RS256-sign a Google JWT-bearer assertion for the given service account + scopes. */
export function buildSignedJwt(sa: ServiceAccountCredentials, scopes: string[], nowMs: number): string {
  const iat = Math.floor(nowMs / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: scopes.join(' '),
      aud: GOOGLE_OAUTH_TOKEN_URL,
      exp: iat + TOKEN_LIFETIME_SEC,
      iat,
      ...(sa.subject ? { sub: sa.subject } : {}),
    }),
  )
  const signingInput = `${header}.${claims}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(normalizePrivateKey(sa.private_key))
  return `${signingInput}.${base64url(signature)}`
}

/**
 * An AccessTokenProvider backed by a service account. Mints a token via the JWT-bearer flow
 * and caches it until shortly before expiry. Drop-in for the OAuth provider — sheets-client
 * and the sync engine only see the AccessTokenProvider contract.
 */
export function createServiceAccountTokenProvider(params: {
  credentials: ServiceAccountCredentials
  scopes?: string[]
  now?: () => number
}): AccessTokenProvider {
  const scopes = params.scopes ?? DEFAULT_SERVICE_ACCOUNT_SCOPES
  const now = params.now ?? (() => Date.now())
  let cached: { token: string; expiresAtMs: number } | null = null

  return async (opts) => {
    const t = now()
    if (!opts?.forceRefresh && cached && cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > t) {
      return cached.token
    }
    const body = new URLSearchParams()
    body.set('grant_type', JWT_BEARER_GRANT)
    body.set('assertion', buildSignedJwt(params.credentials, scopes, t))
    const res = await requestOAuthToken(GOOGLE_OAUTH_TOKEN_URL, body, {
      errorLabel: 'Google service-account token request failed',
    })
    const expiresInSec = typeof res.expires_in === 'number' ? res.expires_in : TOKEN_LIFETIME_SEC
    cached = { token: res.access_token, expiresAtMs: t + expiresInSec * 1000 }
    return res.access_token
  }
}
