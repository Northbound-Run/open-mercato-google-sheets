import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { getValidAccessToken } from './oauth'
import { createGoogleSheetsClient, type GoogleSheetsClient } from './sheets-client'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID, type BindingScope } from './config'

type CredentialsServiceLike = {
  resolve: (id: string, scope: BindingScope) => Promise<Record<string, unknown> | null>
  save: (id: string, creds: Record<string, unknown>, scope: BindingScope) => Promise<void>
}

/**
 * Resolve the tenant's stored Google credentials and build an authenticated Sheets client
 * whose access-token provider refreshes on expiry and persists the refreshed token. Used by
 * request-time routes (preview) that don't go through the sync engine.
 */
export async function createAuthedSheetsClient(
  container: AppContainer,
  scope: BindingScope,
): Promise<{ client: GoogleSheetsClient; credentials: Record<string, unknown> }> {
  const credentialsService = container.resolve('integrationCredentialsService') as CredentialsServiceLike
  const credentials = { ...((await credentialsService.resolve(SYNC_GOOGLE_SHEETS_INTEGRATION_ID, scope)) ?? {}) }
  const client = createGoogleSheetsClient({
    accessTokenProvider: async (opts) =>
      getValidAccessToken({
        credentials,
        forceRefresh: opts?.forceRefresh,
        onRefreshed: async (tokens) => {
          Object.assign(credentials, tokens)
          await credentialsService.save(SYNC_GOOGLE_SHEETS_INTEGRATION_ID, { ...credentials }, scope)
        },
      }),
  })
  return { client, credentials }
}
