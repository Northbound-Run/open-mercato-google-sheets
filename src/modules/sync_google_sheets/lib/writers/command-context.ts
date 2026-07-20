import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { SyncScope } from './types'

/**
 * Build the CommandRuntimeContext a data-sync write runs under: no interactive auth, a
 * single-organization scope derived from the run's tenant/org. Commands run with full
 * trust here because the run was already authorized when it was started.
 */
export function buildCommandContext(container: AppContainer, scope: SyncScope): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as CommandRuntimeContext
}
