import { getGoogleOAuthClient, getValidAccessToken, isReauthRequiredError } from './oauth'

export type HealthResult = {
  status: 'healthy' | 'unhealthy'
  message: string
  details?: Record<string, unknown>
}

/**
 * Integration health check (wired via integration.healthCheck.service). Receives the
 * resolved (decrypted) credentials and confirms the Google authorization is live by
 * obtaining a valid access token and calling the userinfo endpoint. A revoked refresh
 * token surfaces as unhealthy with `reauthRequired`, which the admin UI turns into a
 * reconnect prompt.
 */
export const googleSheetsHealthCheck = {
  async check(credentials: Record<string, unknown>): Promise<HealthResult> {
    try {
      const token = await getValidAccessToken({ credentials })
      const info = await getGoogleOAuthClient()
        .fetchUserInfo(token)
        .catch(() => null)
      const email = info?.email ?? (typeof credentials.connected_email === 'string' ? credentials.connected_email : null)
      return {
        status: 'healthy',
        message: email ? `Connected as ${email}` : 'Google authorization is valid',
        details: { email },
      }
    } catch (error) {
      if (isReauthRequiredError(error)) {
        return {
          status: 'unhealthy',
          message: 'Google authorization is no longer valid — reconnect the account.',
          details: { reauthRequired: true },
        }
      }
      const message = error instanceof Error ? error.message : 'Unknown Google Sheets error'
      return { status: 'unhealthy', message: `Google Sheets connection failed: ${message}`, details: { error: message } }
    }
  },
}
