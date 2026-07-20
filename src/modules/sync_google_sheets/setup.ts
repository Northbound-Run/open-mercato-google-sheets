import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'

const ALL_FEATURES = [
  'sync_google_sheets.view',
  'sync_google_sheets.connect',
  'sync_google_sheets.configure',
  'sync_google_sheets.run',
]

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ALL_FEATURES,
    admin: ALL_FEATURES,
  },

  async seedDefaults({ container, tenantId, organizationId }) {
    // Register the integration state so it appears in the admin UI. The OAuth connection
    // (refresh token) is established later through the connect flow, not here.
    const integrationStateService = container.resolve('integrationStateService') as IntegrationStateService
    await integrationStateService.upsert(
      'sync_google_sheets',
      { isEnabled: true },
      { tenantId, organizationId },
    )
  },
}

export default setup
