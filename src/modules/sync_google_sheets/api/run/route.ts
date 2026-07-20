import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { startDataSyncRun } from '@open-mercato/core/modules/data_sync/lib/start-run'
import type { SyncRunService } from '@open-mercato/core/modules/data_sync/lib/sync-run-service'
import type { ProgressService } from '@open-mercato/core/modules/progress/lib/progressService'
import { createSheetBindingService, SYNC_GOOGLE_SHEETS_INTEGRATION_ID } from '../../lib/config'
import { runSchema } from '../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['sync_google_sheets.run'] },
}

export const openApi = {
  tags: ['GoogleSheetsSync'],
  summary: 'Trigger a Google Sheets sync run (import, export, or bidirectional)',
}

export async function POST(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = {
    organizationId: auth.orgId as string,
    tenantId: auth.tenantId as string,
    userId: (auth.sub as string | undefined) ?? null,
  }

  const parsed = runSchema.safeParse(await readJsonSafe(req, {}))
  if (!parsed.success) {
    return Response.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const binding = await createSheetBindingService(em).get(parsed.data.entityType, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  })
  if (!binding) {
    return Response.json({ error: `No binding configured for ${parsed.data.entityType}` }, { status: 409 })
  }

  const requested = parsed.data.direction ?? (binding.direction as 'import' | 'export' | 'bidirectional')
  // The engine has no bidirectional queue: a bidirectional run starts with import; the
  // bidirectional-chain subscriber fires the export run once the import completes.
  const runDirection: 'import' | 'export' = requested === 'export' ? 'export' : 'import'

  const syncRunService = container.resolve('syncRunService') as SyncRunService
  const progressService = container.resolve('progressService') as ProgressService

  const { run } = await startDataSyncRun({
    syncRunService,
    progressService,
    scope,
    input: {
      integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
      entityType: parsed.data.entityType,
      direction: runDirection,
      triggeredBy: scope.userId,
    },
  })

  return Response.json({ runId: run.id, direction: runDirection, bidirectional: requested === 'bidirectional' }, { status: 202 })
}
