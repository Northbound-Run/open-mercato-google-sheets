import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// CSRF-safe OAuth state. The `state` query param is an opaque random nonce; the full signed
// payload rides in an httpOnly cookie. On callback we verify the cookie signature and that
// its nonce equals the returned state param — binding the callback to the browser that
// started the flow. The signing key is the OAuth client secret (always present when OAuth is
// configured), so no additional secret env is required.

export const OAUTH_STATE_COOKIE_NAME = 'om_gsheets_oauth_state'
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export type OAuthStatePayload = {
  userId: string
  tenantId: string
  organizationId: string
  entityType?: string
  returnUrl: string
  nonce: string
  exp: number
}

export class OAuthStateError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OAuthStateError'
    this.code = code
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(data: string, key: string): string {
  return createHmac('sha256', key).update(data).digest('base64url')
}

export function createOAuthState(
  input: { userId: string; tenantId: string; organizationId: string; entityType?: string; returnUrl: string },
  signingKey: string,
  nowMs: number = Date.now(),
): { stateParam: string; cookie: string } {
  const payload: OAuthStatePayload = {
    ...input,
    nonce: randomBytes(16).toString('base64url'),
    exp: nowMs + OAUTH_STATE_TTL_MS,
  }
  const encoded = base64url(JSON.stringify(payload))
  const signature = sign(encoded, signingKey)
  return { stateParam: payload.nonce, cookie: `${encoded}.${signature}` }
}

export function verifyOAuthState(
  params: {
    cookie: string | null | undefined
    stateParam: string
    signingKey: string
    expectedUserId: string
    expectedTenantId: string
  },
  nowMs: number = Date.now(),
): OAuthStatePayload {
  if (!params.cookie) throw new OAuthStateError('missing_state_cookie', 'OAuth state cookie is missing')
  const dot = params.cookie.lastIndexOf('.')
  if (dot < 0) throw new OAuthStateError('malformed_state', 'OAuth state cookie is malformed')

  const encoded = params.cookie.slice(0, dot)
  const signature = params.cookie.slice(dot + 1)
  const expectedSig = sign(encoded, params.signingKey)
  const a = Buffer.from(signature)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OAuthStateError('bad_signature', 'OAuth state signature is invalid')
  }

  let payload: OAuthStatePayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload
  } catch {
    throw new OAuthStateError('malformed_state', 'OAuth state payload is unreadable')
  }

  if (payload.nonce !== params.stateParam) throw new OAuthStateError('state_mismatch', 'OAuth state does not match')
  if (typeof payload.exp !== 'number' || payload.exp < nowMs) {
    throw new OAuthStateError('state_expired', 'OAuth state has expired')
  }
  if (payload.userId !== params.expectedUserId) throw new OAuthStateError('user_mismatch', 'OAuth state user mismatch')
  if (payload.tenantId !== params.expectedTenantId) {
    throw new OAuthStateError('tenant_mismatch', 'OAuth state tenant mismatch')
  }
  return payload
}

/** Read a single cookie value from a raw Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const segment of header.split(';')) {
    const trimmed = segment.trim()
    if (trimmed.startsWith(`${name}=`)) return decodeURIComponent(trimmed.slice(name.length + 1))
  }
  return null
}

/** Build a Set-Cookie header value for the state cookie (or a clearing one when value is null). */
export function buildStateCookieHeader(value: string | null): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  if (value === null) {
    return `${OAUTH_STATE_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  }
  const maxAge = Math.floor(OAUTH_STATE_TTL_MS / 1000)
  return `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
}
