// Shared access-token-provider construction for every Google Sheets call path (sync-engine
// adapter, request-time routes like preview, health checks). Service-account credentials —
// from the stored credential blob or the GOOGLE_SHEETS_SA_* env vars — mint tokens directly
// from the SA key with nothing to persist; otherwise fall back to the OAuth refresh-token
// path, persisting refreshed tokens back into the integration credential blob. Keep all new
// call sites on this helper so the SA fallback can never drift out of sync again.

import { getValidAccessToken } from './oauth'
import { createServiceAccountTokenProvider, resolveServiceAccountCredentials } from './service-account'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID, type BindingScope } from './constants'
import type { AccessTokenProvider } from './sheets-client'

export type CredentialsSaver = {
  save: (id: string, creds: Record<string, unknown>, scope: BindingScope) => Promise<void>
}

/**
 * Build an access-token provider bound to the tenant's stored credentials. `credentials` is
 * mutated in place (and persisted) when the OAuth path refreshes, so callers should pass a
 * copy they own. `scope` is structural — the data_sync engine's TenantScope and our routes'
 * BindingScope are both `{ organizationId, tenantId }`.
 */
export function buildAccessTokenProvider(
  credentials: Record<string, unknown>,
  scope: BindingScope,
  credentialsService: CredentialsSaver,
): AccessTokenProvider {
  const serviceAccount = resolveServiceAccountCredentials(credentials)
  if (serviceAccount) {
    return createServiceAccountTokenProvider({ credentials: serviceAccount })
  }
  return async (opts) =>
    getValidAccessToken({
      credentials,
      forceRefresh: opts?.forceRefresh,
      onRefreshed: async (tokens) => {
        Object.assign(credentials, tokens)
        await credentialsService.save(SYNC_GOOGLE_SHEETS_INTEGRATION_ID, { ...credentials }, scope)
      },
    })
}
