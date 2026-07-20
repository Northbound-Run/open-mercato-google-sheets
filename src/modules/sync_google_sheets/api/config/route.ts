import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { createSheetBindingService } from '../../lib/config'
import { saveSheetMapping } from '../../lib/mapping'
import { sheetBindingSchema } from '../../data/validators'
import type { GoogleSheetsBinding } from '../../data/entities'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sync_google_sheets.view'] },
  POST: { requireAuth: true, requireFeatures: ['sync_google_sheets.configure'] },
}

export const openApi = {
  tags: ['GoogleSheetsSync'],
  summary: 'List or upsert Google Sheets bindings (sheet ↔ entity configuration)',
}

function serialize(binding: GoogleSheetsBinding) {
  return {
    id: binding.id,
    entityType: binding.entityType,
    spreadsheetId: binding.spreadsheetId,
    sheetTitle: binding.sheetTitle,
    sheetGid: binding.sheetGid ?? null,
    headerRow: binding.headerRow,
    dataStartRow: binding.dataStartRow,
    keyColumn: binding.keyColumn,
    direction: binding.direction,
    conflictPolicy: binding.conflictPolicy,
    isEnabled: binding.isEnabled,
    lastSyncedAt: binding.lastSyncedAt ? binding.lastSyncedAt.toISOString() : null,
    updatedAt: binding.updatedAt ? binding.updatedAt.toISOString() : null,
  }
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = { organizationId: auth.orgId as string, tenantId: auth.tenantId as string }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const bindings = await createSheetBindingService(em).list(scope)
  return Response.json({ items: bindings.map(serialize) })
}

export async function POST(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = { organizationId: auth.orgId as string, tenantId: auth.tenantId as string }

  const parsed = sheetBindingSchema.safeParse(await readJsonSafe(req, {}))
  if (!parsed.success) {
    return Response.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const bindingService = createSheetBindingService(em)

  const { mapping, ...bindingInput } = parsed.data
  const binding = await bindingService.upsert(bindingInput, scope)
  if (mapping) {
    await saveSheetMapping(em, bindingInput.entityType, mapping, scope)
  }
  return Response.json(serialize(binding), { status: 201 })
}
