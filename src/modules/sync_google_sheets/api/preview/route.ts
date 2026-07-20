import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { buildA1Range } from '../../lib/sheets-client'
import { buildSuggestedMapping } from '../../lib/mapping'
import { createAuthedSheetsClient } from '../../lib/session'
import { previewSchema } from '../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['sync_google_sheets.configure'] },
}

export const openApi = {
  tags: ['GoogleSheetsSync'],
  summary: 'Read a sheet header row and suggest a column→field mapping',
}

export async function POST(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = { organizationId: auth.orgId as string, tenantId: auth.tenantId as string }

  const parsed = previewSchema.safeParse(await readJsonSafe(req, {}))
  if (!parsed.success) {
    return Response.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }
  const input = parsed.data

  try {
    const container = await createRequestContainer()
    const { client } = await createAuthedSheetsClient(container, scope)
    const meta = await client.getSpreadsheet(input.spreadsheetId)

    const tab =
      (input.sheetGid != null ? meta.sheets.find((s) => s.sheetId === input.sheetGid) : undefined) ??
      (input.sheetTitle ? meta.sheets.find((s) => s.title === input.sheetTitle) : undefined) ??
      meta.sheets[0]
    if (!tab) return Response.json({ error: 'Spreadsheet has no readable tabs' }, { status: 422 })

    const headerRow = input.headerRow ?? 1
    const headerRange = buildA1Range({
      sheetTitle: tab.title,
      startRow: headerRow,
      endRow: headerRow,
      startColumn: 1,
      endColumn: Math.max(tab.columnCount || 26, 1),
    })
    const values = await client.readValues(input.spreadsheetId, headerRange)
    const headers = (values[0] ?? []).map((v) => String(v ?? '').trim()).filter((h) => h.length > 0)

    const suggestedMapping = buildSuggestedMapping(input.entityType ?? '', headers, input.keyColumn)

    return Response.json({
      spreadsheetId: meta.spreadsheetId,
      spreadsheetTitle: meta.title,
      tabs: meta.sheets.map((s) => ({ sheetId: s.sheetId, title: s.title, rowCount: s.rowCount, columnCount: s.columnCount })),
      selectedTab: { sheetId: tab.sheetId, title: tab.title },
      headerRow,
      headers,
      suggestedKeyColumn: input.keyColumn ?? headers[0] ?? null,
      suggestedMapping,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read spreadsheet'
    return Response.json({ error: message }, { status: 502 })
  }
}
