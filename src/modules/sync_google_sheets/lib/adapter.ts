import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type {
  DataMapping,
  DataSyncAdapter,
  ExportBatch,
  ExportItemResult,
  ImportBatch,
  ImportItem,
  StreamExportInput,
  StreamImportInput,
  TenantScope,
  ValidationResult,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SyncExternalIdMapping } from '@open-mercato/core/modules/integrations/data/entities'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID, createSheetBindingService, type BindingScope } from './config'
import { createContentHashService, computeContentHash } from './content-hash'
import { loadSheetMapping, rowToRecord, valuesToRecords } from './mapping'
import {
  buildA1Range,
  createGoogleSheetsClient,
  type AccessTokenProvider,
  type GoogleSheetsClient,
  type SheetTab,
  type SpreadsheetMeta,
} from './sheets-client'
import { getValidAccessToken, DEFAULT_EXPORT_SCOPES } from './oauth'
import { getWriter, listWriterEntityTypes, requireWriter } from './writers/registry'
import type { NormalizedRecord, WriterContext } from './writers/types'

const PROVIDER_KEY = 'google_sheets'

type ExternalIdMappingService = {
  lookupLocalId: (i: string, e: string, x: string, s: TenantScope) => Promise<string | null>
  lookupExternalId: (i: string, e: string, l: string, s: TenantScope) => Promise<string | null>
  storeExternalIdMapping: (i: string, e: string, l: string, x: string, s: TenantScope) => Promise<unknown>
}

type CredentialsService = {
  save: (id: string, creds: Record<string, unknown>, scope: TenantScope) => Promise<void>
}

/** Convert a command-style entity type (`customers.person`) to a query/coverage id (`customers:person`). */
function toCoverageEntityId(entityType: string): string {
  return entityType.replace('.', ':')
}

/** Build an access-token provider bound to the run's stored credentials, persisting refreshes. */
function buildAccessTokenProvider(
  credentials: Record<string, unknown>,
  scope: TenantScope,
  credentialsService: CredentialsService,
): AccessTokenProvider {
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

function resolveTab(meta: SpreadsheetMeta, binding: { sheetGid?: number | null; sheetTitle: string }): SheetTab {
  const byGid = binding.sheetGid != null ? meta.sheets.find((s) => s.sheetId === binding.sheetGid) : undefined
  const tab = byGid ?? meta.sheets.find((s) => s.title === binding.sheetTitle)
  if (!tab) {
    throw new Error(`Tab "${binding.sheetTitle}" was not found in spreadsheet ${meta.spreadsheetId}`)
  }
  return tab
}

async function readHeaderRow(
  client: GoogleSheetsClient,
  spreadsheetId: string,
  tab: SheetTab,
  headerRow: number,
): Promise<string[]> {
  const range = buildA1Range({
    sheetTitle: tab.title,
    startRow: headerRow,
    endRow: headerRow,
    startColumn: 1,
    endColumn: Math.max(tab.columnCount || 26, 1),
  })
  const values = await client.readValues(spreadsheetId, range)
  return (values[0] ?? []).map((v) => String(v ?? '').trim())
}

/** Map a normalized record back to a sheet row, column order following the header row. */
function recordToRow(headers: string[], record: NormalizedRecord, mapping: DataMapping): unknown[] {
  return headers.map((header) => {
    const field = (mapping.fields ?? []).find((f) => f.externalField === header)
    if (field) {
      if (field.mappingKind === 'custom_field' || field.localField.startsWith('cf:')) {
        const key = field.localField.startsWith('cf:') ? field.localField.slice(3) : field.localField
        return record.fields[`cf:${key}`] ?? ''
      }
      if (field.mappingKind !== 'external_id') {
        return record.fields[field.localField] ?? record.raw?.[header] ?? ''
      }
    }
    return record.raw?.[header] ?? ''
  })
}

export const googleSheetsAdapter: DataSyncAdapter = {
  providerKey: PROVIDER_KEY,
  // Advertises both directions; a *run* is always import OR export (the engine has no
  // bidirectional queue). Bidirectional is orchestrated as two chained runs by api/run.
  direction: 'bidirectional',
  runMode: 'generic',
  operationalTelemetry: true,

  // Dynamic: whatever entity types have a registered writer. Evaluated at call time, after
  // di.ts has registered the bundled + downstream writers.
  get supportedEntities(): string[] {
    return listWriterEntityTypes()
  },

  async getMapping(input): Promise<DataMapping> {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    return loadSheetMapping(em, input.entityType, input.scope)
  },

  async validateConnection(input): Promise<ValidationResult> {
    try {
      const container = await createRequestContainer()
      const em = container.resolve('em') as EntityManager
      const credentialsService = container.resolve('integrationCredentialsService') as CredentialsService
      const bindingService = createSheetBindingService(em)
      const binding = await bindingService.get(input.entityType, input.scope)
      if (!binding) {
        return { ok: false, message: `No Google Sheets binding configured for ${input.entityType}.` }
      }
      const accessTokenProvider = buildAccessTokenProvider(
        { ...(input.credentials as Record<string, unknown>) },
        input.scope,
        credentialsService,
      )
      const client = createGoogleSheetsClient({ accessTokenProvider })
      const meta = await client.getSpreadsheet(binding.spreadsheetId)
      const tab = resolveTab(meta, binding)
      return {
        ok: true,
        message: `Connected to "${meta.title}" — tab "${tab.title}"`,
        details: { spreadsheetTitle: meta.title, tab: tab.title, tabCount: meta.sheets.length },
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Google Sheets validation failed' }
    }
  },

  async *streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const credentialsService = container.resolve('integrationCredentialsService') as CredentialsService
    const externalIdMappingService = container.resolve('externalIdMappingService') as ExternalIdMappingService
    const bindingService = createSheetBindingService(em)
    const hashService = createContentHashService(em)

    const binding = await bindingService.get(input.entityType, input.scope)
    if (!binding) throw new Error(`No Google Sheets binding configured for ${input.entityType}.`)
    const writer = requireWriter(input.entityType)
    const scope: BindingScope = input.scope
    // Hash bookkeeping (echo prevention) only matters when the sheet is also an export
    // target. Import-only bindings do a lean full-scan upsert with no hash overhead.
    const trackHashes = binding.direction !== 'import'

    const credentials = { ...(input.credentials as Record<string, unknown>) }
    const client = createGoogleSheetsClient({
      accessTokenProvider: buildAccessTokenProvider(credentials, input.scope, credentialsService),
    })

    const meta = await client.getSpreadsheet(binding.spreadsheetId)
    const tab = resolveTab(meta, binding)
    const driveMeta = await client
      .getDriveFileMeta(binding.spreadsheetId)
      .catch(() => ({ modifiedTime: null, headRevisionId: null }))
    const headers = await readHeaderRow(client, binding.spreadsheetId, tab, binding.headerRow)
    const columnCount = Math.max(headers.length, tab.columnCount || 1)

    const writerCtx: WriterContext = {
      scope: input.scope,
      container,
      em,
      integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
      entityType: input.entityType,
    }

    const startCursor = input.cursor ? safeParseImportRowOffset(input.cursor) : 0
    let rowOffset = startCursor
    let batchIndex = 0

    while (true) {
      const startRow = binding.dataStartRow + rowOffset
      const endRow = startRow + input.batchSize - 1
      const range = buildA1Range({
        sheetTitle: tab.title,
        startRow,
        endRow,
        startColumn: 1,
        endColumn: columnCount,
      })
      const rows = await client.readValues(binding.spreadsheetId, range)
      if (rows.length === 0) break

      const items: ImportItem[] = []
      for (const record of valuesToRecords(headers, rows, input.mapping, binding.keyColumn)) {
        try {
          const hash = computeContentHash(record.fields)
          const { id, action } = await writer.upsert(record, writerCtx)
          if (action !== 'skip') {
            await externalIdMappingService.storeExternalIdMapping(
              SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
              input.entityType,
              id,
              record.externalId,
              input.scope,
            )
            if (trackHashes) await hashService.record(input.entityType, record.externalId, 'import', hash, scope)
          }
          items.push({ externalId: record.externalId, action, data: { localId: id }, hash })
        } catch (error) {
          items.push({
            externalId: record.externalId,
            action: 'failed',
            data: { errorMessage: error instanceof Error ? error.message : 'Import row failed' },
          })
        }
      }

      rowOffset += rows.length
      const hasMore = rows.length >= input.batchSize
      yield {
        items,
        cursor: buildImportCursor(rowOffset, driveMeta.headRevisionId),
        hasMore,
        processedCount: rows.length,
        refreshCoverageEntityTypes: [toCoverageEntityId(input.entityType)],
        batchIndex,
        message: `Imported sheet rows ${startRow}–${startRow + rows.length - 1}`,
      }
      batchIndex += 1
      if (!hasMore) break
    }

    await bindingService.touchWatermark(
      input.entityType,
      { lastSyncedAt: new Date(), lastHeadRevisionId: driveMeta.headRevisionId },
      scope,
    )
  },

  // FIRST-OF-KIND export path (R1). The Data Sync engine's runExport has never been
  // exercised by a shipped adapter — validate with the Increment 3 spike before relying on
  // it in production. Exports records that already have an id-mapping (the bidirectional
  // update case); brand-new Mercato records without a mapping are a documented follow-up
  // (they require per-entity enumeration the generic core can't provide).
  async *streamExport(input: StreamExportInput): AsyncIterable<ExportBatch> {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const credentialsService = container.resolve('integrationCredentialsService') as CredentialsService
    const bindingService = createSheetBindingService(em)
    const hashService = createContentHashService(em)

    const binding = await bindingService.get(input.entityType, input.scope)
    if (!binding) throw new Error(`No Google Sheets binding configured for ${input.entityType}.`)
    const writer = getWriter(input.entityType)
    if (!writer?.read) {
      throw new Error(
        `EntityWriter for ${input.entityType} does not implement read(); export requires it. Provide a read() to export this entity.`,
      )
    }
    const scope: BindingScope = input.scope

    const credentials = { ...(input.credentials as Record<string, unknown>) }
    const client = createGoogleSheetsClient({
      accessTokenProvider: buildAccessTokenProvider(credentials, input.scope, credentialsService),
    })

    const meta = await client.getSpreadsheet(binding.spreadsheetId)
    const tab = resolveTab(meta, binding)
    const headers = await readHeaderRow(client, binding.spreadsheetId, tab, binding.headerRow)
    const keyColumnIndex = headers.indexOf(binding.keyColumn)
    if (keyColumnIndex < 0) throw new Error(`Key column "${binding.keyColumn}" not found in sheet header.`)

    // Build externalId -> sheet row number index from the key column.
    const keyColLetter = columnLetter(keyColumnIndex + 1)
    const keyRange = `${quoteTitle(tab.title)}!${keyColLetter}${binding.dataStartRow}:${keyColLetter}`
    const keyValues = await client.readValues(binding.spreadsheetId, keyRange)
    const rowByExternalId = new Map<string, number>()
    keyValues.forEach((r, i) => {
      const key = r[0] == null ? '' : String(r[0]).trim()
      if (key) rowByExternalId.set(key, binding.dataStartRow + i)
    })
    let appendRow = binding.dataStartRow + keyValues.length

    // Export candidates: records this integration already mapped, paged by cursor offset.
    const offset = input.cursor ? safeParseExportOffset(input.cursor) : 0
    const mappings = await findWithDecryption(
      em,
      SyncExternalIdMapping,
      {
        integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
        internalEntityType: input.entityType,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
      { orderBy: { lastSyncedAt: 'asc' }, limit: input.batchSize, offset },
      scope,
    )

    const writerCtx: WriterContext = {
      scope: input.scope,
      container,
      em,
      integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
      entityType: input.entityType,
    }

    const results: ExportItemResult[] = []
    const updates: Array<{ range: string; values: unknown[][] }> = []
    for (const mappingRow of mappings) {
      const localId = mappingRow.internalEntityId
      const externalId = mappingRow.externalId
      try {
        const record = await writer.read!(localId, writerCtx)
        if (!record) {
          results.push({ localId, externalId, status: 'skipped', error: 'no local record' })
          continue
        }
        const hash = computeContentHash(record.fields)
        // Echo prevention: skip when the sheet already holds what we last exported.
        if (await hashService.isEcho(input.entityType, externalId, 'export', hash, scope)) {
          results.push({ localId, externalId, status: 'skipped', error: 'unchanged (echo)' })
          continue
        }
        const rowValues = recordToRow(headers, record, input.mapping)
        const targetRow = rowByExternalId.get(externalId) ?? appendRow++
        const endCol = columnLetter(Math.max(headers.length, 1))
        updates.push({
          range: `${quoteTitle(tab.title)}!A${targetRow}:${endCol}${targetRow}`,
          values: [rowValues],
        })
        await hashService.record(input.entityType, externalId, 'export', hash, scope)
        results.push({ localId, externalId, status: 'success' })
      } catch (error) {
        results.push({
          localId,
          externalId,
          status: 'error',
          error: error instanceof Error ? error.message : 'export row failed',
        })
      }
    }

    if (updates.length > 0) {
      await client.batchUpdateValues(binding.spreadsheetId, updates)
    }

    const hasMore = mappings.length >= input.batchSize
    yield { results, cursor: buildExportCursor(offset + mappings.length), hasMore, batchIndex: 0 }

    if (!hasMore) {
      await bindingService.touchWatermark(input.entityType, { lastSyncedAt: new Date() }, scope)
    }
  },
}

// --- small local cursor/A1 helpers kept private to the adapter -------------------------

function buildImportCursor(rowOffset: number, headRevisionId: string | null): string {
  return JSON.stringify({ kind: 'gs-import', rowOffset, headRevisionId })
}
function safeParseImportRowOffset(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { rowOffset?: number }
    return typeof parsed?.rowOffset === 'number' && parsed.rowOffset >= 0 ? Math.floor(parsed.rowOffset) : 0
  } catch {
    return 0
  }
}
function buildExportCursor(offset: number): string {
  return JSON.stringify({ kind: 'gs-export', offset })
}
function safeParseExportOffset(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { offset?: number }
    return typeof parsed?.offset === 'number' && parsed.offset >= 0 ? Math.floor(parsed.offset) : 0
  } catch {
    return 0
  }
}
function columnLetter(column: number): string {
  let n = Math.max(1, Math.floor(column))
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}
function quoteTitle(title: string): string {
  if (/^[A-Za-z0-9_]+$/.test(title)) return title
  return `'${title.replace(/'/g, "''")}'`
}
