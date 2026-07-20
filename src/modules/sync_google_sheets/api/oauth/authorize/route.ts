import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { toAbsoluteUrl } from '@open-mercato/shared/lib/url'
import {
  getGoogleOAuthClient,
  OAuthConfigError,
  resolveOAuthClientConfig,
  resolveScopes,
} from '../../../lib/oauth'
import { buildStateCookieHeader, createOAuthState } from '../../../lib/oauth-state'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID } from '../../../lib/config'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sync_google_sheets.connect'] },
}

export const openApi = {
  tags: ['GoogleSheetsSync'],
  summary: 'Start the Google OAuth connect flow (302 redirect to Google)',
}

const CALLBACK_PATH = '/api/sync_google_sheets/oauth/callback'

type CredentialsServiceLike = {
  resolve: (id: string, scope: { organizationId: string; tenantId: string }) => Promise<Record<string, unknown> | null>
}

function normalizeReturnUrl(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/backend/integrations'
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId || !auth.orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const scope = { organizationId: auth.orgId as string, tenantId: auth.tenantId as string }
  const url = new URL(req.url)
  const entityType = url.searchParams.get('entityType') ?? undefined
  const returnUrl = normalizeReturnUrl(url.searchParams.get('returnUrl'))

  const container = await createRequestContainer()
  const credentialsService = container.resolve('integrationCredentialsService') as CredentialsServiceLike
  const stored = (await credentialsService.resolve(SYNC_GOOGLE_SHEETS_INTEGRATION_ID, scope)) ?? {}

  const redirectUri = process.env.GOOGLE_SHEETS_OAUTH_REDIRECT_URI || toAbsoluteUrl(req, CALLBACK_PATH)
  let clientConfig
  try {
    clientConfig = resolveOAuthClientConfig(stored, { redirectUriOverride: redirectUri })
  } catch (error) {
    if (error instanceof OAuthConfigError) {
      return Response.json({ error: error.message, code: 'oauth_not_configured' }, { status: 409 })
    }
    throw error
  }
  const scopes = resolveScopes(stored)

  const { stateParam, cookie } = createOAuthState(
    {
      userId: auth.sub as string,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      entityType,
      returnUrl,
    },
    clientConfig.clientSecret,
  )

  const authorizeUrl = getGoogleOAuthClient().buildAuthorizeUrl({
    clientId: clientConfig.clientId,
    redirectUri: clientConfig.redirectUri,
    state: stateParam,
    scopes,
    loginHint: auth.email as string | undefined,
  })

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl, 'Set-Cookie': buildStateCookieHeader(cookie) },
  })
}

export default GET
