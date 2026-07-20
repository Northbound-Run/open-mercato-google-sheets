import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { toAbsoluteUrl } from '@open-mercato/shared/lib/url'
import {
  getGoogleOAuthClient,
  resolveOAuthClientConfig,
  tokenResponseToExpiresAt,
} from '../../../lib/oauth'
import {
  buildStateCookieHeader,
  OAUTH_STATE_COOKIE_NAME,
  OAuthStateError,
  readCookie,
  verifyOAuthState,
} from '../../../lib/oauth-state'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID } from '../../../lib/config'

export const metadata = {
  // The signed state cookie carries CSRF protection; requireAuth still binds the callback
  // to a live session (verified against the state below).
  GET: { requireAuth: true },
}

export const openApi = {
  tags: ['GoogleSheetsSync'],
  summary: 'Google OAuth callback — exchange code, persist encrypted tokens, redirect back',
}

const CALLBACK_PATH = '/api/sync_google_sheets/oauth/callback'
const DEFAULT_RETURN = '/backend/integrations'

type CredentialsServiceLike = {
  resolve: (id: string, scope: { organizationId: string; tenantId: string }) => Promise<Record<string, unknown> | null>
  save: (id: string, creds: Record<string, unknown>, scope: { organizationId: string; tenantId: string }) => Promise<void>
}

type StateServiceLike = {
  upsert: (
    id: string,
    input: { isEnabled?: boolean; reauthRequired?: boolean },
    scope: { organizationId: string; tenantId: string },
  ) => Promise<unknown>
}

function redirectFlash(
  req: Request,
  returnUrl: string,
  type: 'connected' | 'error',
  code?: string,
): Response {
  const safeReturn = returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : DEFAULT_RETURN
  const base = new URL(safeReturn, new URL(req.url).origin)
  base.searchParams.set('flash', type)
  base.searchParams.set('integration', SYNC_GOOGLE_SHEETS_INTEGRATION_ID)
  if (code) base.searchParams.set('code', code)
  return new Response(null, {
    status: 302,
    headers: { Location: base.toString(), 'Set-Cookie': buildStateCookieHeader(null) },
  })
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const code = url.searchParams.get('code') ?? ''
  const stateParam = url.searchParams.get('state') ?? ''
  const oauthError = url.searchParams.get('error')

  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId || !auth.orgId) {
    return redirectFlash(req, DEFAULT_RETURN, 'error', 'unauthorized')
  }
  if (oauthError) return redirectFlash(req, DEFAULT_RETURN, 'error', oauthError)
  if (!code || !stateParam) return redirectFlash(req, DEFAULT_RETURN, 'error', 'missing_code_or_state')

  const scope = { organizationId: auth.orgId as string, tenantId: auth.tenantId as string }
  const container = await createRequestContainer()
  const credentialsService = container.resolve('integrationCredentialsService') as CredentialsServiceLike
  const stored = (await credentialsService.resolve(SYNC_GOOGLE_SHEETS_INTEGRATION_ID, scope)) ?? {}

  const redirectUri = process.env.GOOGLE_SHEETS_OAUTH_REDIRECT_URI || toAbsoluteUrl(req, CALLBACK_PATH)
  let clientConfig
  try {
    clientConfig = resolveOAuthClientConfig(stored, { redirectUriOverride: redirectUri })
  } catch {
    return redirectFlash(req, DEFAULT_RETURN, 'error', 'oauth_not_configured')
  }

  let statePayload
  try {
    statePayload = verifyOAuthState({
      cookie: readCookie(req.headers.get('cookie'), OAUTH_STATE_COOKIE_NAME),
      stateParam,
      signingKey: clientConfig.clientSecret,
      expectedUserId: auth.sub as string,
      expectedTenantId: auth.tenantId as string,
    })
  } catch (error) {
    const errorCode = error instanceof OAuthStateError ? error.code : 'invalid_state'
    return redirectFlash(req, DEFAULT_RETURN, 'error', errorCode)
  }

  const returnUrl = statePayload.returnUrl || DEFAULT_RETURN

  let token
  try {
    token = await getGoogleOAuthClient().exchangeCode({
      clientId: clientConfig.clientId,
      clientSecret: clientConfig.clientSecret,
      redirectUri: clientConfig.redirectUri,
      code,
    })
  } catch {
    return redirectFlash(req, returnUrl, 'error', 'exchange_failed')
  }

  const info = await getGoogleOAuthClient()
    .fetchUserInfo(token.access_token)
    .catch(() => null)
  const expiresAt = tokenResponseToExpiresAt(token)
  const merged: Record<string, unknown> = {
    ...stored,
    refresh_token: token.refresh_token ?? (stored.refresh_token as string | undefined) ?? null,
    access_token: token.access_token,
    expires_at: expiresAt ? expiresAt.getTime() : null,
    connected_email: info?.email ?? null,
    connected_sub: info?.sub ?? null,
    connected_scopes: token.scope ?? null,
    connected_at: new Date().toISOString(),
  }
  await credentialsService.save(SYNC_GOOGLE_SHEETS_INTEGRATION_ID, merged, scope)

  try {
    const stateService = container.resolve('integrationStateService') as StateServiceLike
    await stateService.upsert(SYNC_GOOGLE_SHEETS_INTEGRATION_ID, { isEnabled: true, reauthRequired: false }, scope)
  } catch {
    // best-effort; connection is already saved
  }

  return redirectFlash(req, returnUrl, 'connected')
}

export default GET
