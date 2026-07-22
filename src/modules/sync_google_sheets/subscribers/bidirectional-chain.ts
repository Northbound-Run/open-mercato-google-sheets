import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { startDataSyncRun } from '@open-mercato/core/modules/data_sync/lib/start-run'
import type { SyncRunService } from '@open-mercato/core/modules/data_sync/lib/sync-run-service'
import type { ProgressService } from '@open-mercato/core/modules/progress/lib/progressService'
import { createSheetBindingService, SYNC_GOOGLE_SHEETS_INTEGRATION_ID } from '../lib/config'

// Bidirectional orchestration = two chained runs (the engine has no bidirectional queue).
// When one of OUR import runs completes and the entity's binding is bidirectional, kick off
// the matching export run. Written defensively against the event payload/context shape,
// which is part of the first-of-kind export path (R1) to be validated by the Increment 3
// spike — a shape mismatch fails safe (no export) rather than throwing.
export const metadata = {
  event: 'data_sync.run.completed',
  persistent: true,
  id: 'sync_google_sheets_bidirectional_chain',
}

type SubscriberCtx = {
  container?: AppContainer
  resolve?: <T = unknown>(name: string) => T
}

function resolveService<T>(ctx: SubscriberCtx | undefined, name: string): T | null {
  try {
    if (ctx?.container?.resolve) return ctx.container.resolve(name) as T
  } catch {
    /* fall through */
  }
  try {
    if (typeof ctx?.resolve === 'function') return ctx.resolve<T>(name)
  } catch {
    /* fall through */
  }
  return null
}

function readScope(...sources: Record<string, unknown>[]): { organizationId: string; tenantId: string } | null {
  for (const source of sources) {
    const scope = (source.scope as Record<string, unknown> | undefined) ?? source
    const organizationId = scope?.organizationId
    const tenantId = scope?.tenantId
    if (typeof organizationId === 'string' && typeof tenantId === 'string') {
      return { organizationId, tenantId }
    }
  }
  return null
}

export default async function handler(event: unknown, ctx: SubscriberCtx): Promise<void> {
  const outer = (event ?? {}) as Record<string, unknown>
  const payload = ((outer.payload as Record<string, unknown>) ?? outer) as Record<string, unknown>

  const integrationId = payload.integrationId ?? outer.integrationId
  const direction = payload.direction ?? outer.direction
  if (integrationId !== SYNC_GOOGLE_SHEETS_INTEGRATION_ID || direction !== 'import') return

  const entityType = String(payload.entityType ?? outer.entityType ?? '')
  const scope = readScope(payload, outer)
  if (!entityType || !scope) return

  const em = resolveService<EntityManager>(ctx, 'em')
  if (!em) return
  const binding = await createSheetBindingService(em).get(entityType, scope)
  if (!binding || binding.direction !== 'bidirectional') return

  // Core data_sync registers this service as 'dataSyncRunService' (see data_sync/di.ts).
  const syncRunService = resolveService<SyncRunService>(ctx, 'dataSyncRunService')
  const progressService = resolveService<ProgressService>(ctx, 'progressService')
  if (!syncRunService || !progressService) return

  await startDataSyncRun({
    syncRunService,
    progressService,
    scope: { ...scope, userId: null },
    input: {
      integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
      entityType,
      direction: 'export',
      triggeredBy: 'sync_google_sheets:bidirectional-chain',
    },
  })
}
