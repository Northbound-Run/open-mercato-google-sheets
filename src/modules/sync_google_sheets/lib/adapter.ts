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
import { decideSync, type SyncDecision } from './conflict-detection'
import { DEFAULT_CONFLICT_POLICY, isConflictPolicy, type ConflictPolicy } from './conflict'
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
import { createServiceAccountTokenProvider, resolveServiceAccountCredentials } from './service-account'
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

/**
 * Build an access-token provider bound to the run's stored credentials. Service-account
 * credentials (blob or env) mint tokens directly from the SA key — no refresh or persist;
 * otherwise fall back to the OAuth refresh-token path, persisting refreshed tokens.
 */
function buildAccessTokenProvider(
  credentials: Record<string, unknown>,
  scope: TenantScope,
  credentialsService: CredentialsService,
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
    // Conflict detection (and its baseline bookkeeping) only applies to bidirectional
    // bindings — a one-way import has no export side to conflict with, so it does a lean
    // full-scan upsert with no per-row read/hash overhead.
    const enforceConflicts = binding.direction === 'bidirectional'
    const policy: ConflictPolicy = isConflictPolicy(binding.conflictPolicy)
      ? binding.conflictPolicy
      : DEFAULT_CONFLICT_POLICY
    if (enforceConflicts && !writer.read) {
      throw new Error(
        `EntityWriter for ${input.entityType} does not implement read(); bidirectional sync needs it to detect Mercato-side changes.`,
      )
    }
    // Hash over the writer's canonical field shape so sheet-derived and read()-derived content
    // compare equal for equal data (see EntityWriter.normalize).
    const normalize = writer.normalize
    const hashFields = (fields: Record<string, unknown>): string =>
      computeContentHash(normalize ? normalize(fields) : fields)

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

    // Bidirectional import: reconcile each incoming sheet row against the current Mercato
    // state and the last-synced baseline before writing, honouring the binding's conflict
    // policy. The baseline is advanced only after a successful write (write-then-record),
    // and the scheduler prevents overlapping same-direction runs — so no cross-run TOCTOU.
    const importRowWithConflictCheck = async (
      record: NormalizedRecord,
      sourceHash: string,
    ): Promise<ImportItem> => {
      const externalId = record.externalId
      const existingLocalId = await externalIdMappingService.lookupLocalId(
        SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
        input.entityType,
        externalId,
        input.scope,
      )
      let targetHash: string | null = null
      if (existingLocalId && writer.read) {
        const current = await writer.read(existingLocalId, writerCtx)
        if (current) targetHash = hashFields(current.fields)
      }
      const baselineHash = await hashService.getBaseline(input.entityType, externalId, scope)
      const decision = decideSync({ policy, writingTo: 'mercato', baselineHash, sourceHash, targetHash })

      if (decision.outcome === 'flag') {
        return {
          externalId,
          action: 'failed',
          data: { errorMessage: `sync conflict flagged for manual review (${decision.reason})` },
        }
      }
      if (decision.outcome === 'skip') {
        if (decision.nextBaseline) {
          await hashService.setBaseline(input.entityType, externalId, decision.nextBaseline, scope)
        }
        return {
          externalId,
          action: 'skip',
          data: { localId: existingLocalId ?? null, reason: decision.reason },
          hash: sourceHash,
        }
      }
      // apply: write the sheet's version into Mercato, then advance the baseline.
      const { id, action } = await writer.upsert(record, writerCtx)
      if (action !== 'skip') {
        await externalIdMappingService.storeExternalIdMapping(
          SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
          input.entityType,
          id,
          externalId,
          input.scope,
        )
      }
      if (decision.nextBaseline) {
        await hashService.setBaseline(input.entityType, externalId, decision.nextBaseline, scope)
      }
      return { externalId, action, data: { localId: id }, hash: sourceHash }
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
          const sourceHash = hashFields(record.fields)
          if (enforceConflicts) {
            items.push(await importRowWithConflictCheck(record, sourceHash))
            continue
          }
          // Import-only binding: no export side, so no conflict is possible — blind upsert.
          const { id, action } = await writer.upsert(record, writerCtx)
          if (action !== 'skip') {
            await externalIdMappingService.storeExternalIdMapping(
              SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
              input.entityType,
              id,
              record.externalId,
              input.scope,
            )
          }
          items.push({ externalId: record.externalId, action, data: { localId: id }, hash: sourceHash })
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

  // Export path. Reconciles each mapped record against the sheet's current content and the
  // last-synced baseline (bidirectional honours the conflict policy; export-only treats
  // Mercato as the source of truth, skipping no-ops), then batch-writes the winners. Still
  // needs end-to-end validation against a live sheet. Only records that already have an
  // id-mapping are exported (the update case); brand-new Mercato records without a mapping
  // are a documented follow-up (they need per-entity enumeration the generic core can't provide).
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

    // Index the current sheet rows: externalId -> row number (where to write), and, for
    // bidirectional bindings, externalId -> current content hash (to detect whether the
    // sheet side changed since the last sync).
    const keyColLetter = columnLetter(keyColumnIndex + 1)
    const keyRange = `${quoteTitle(tab.title)}!${keyColLetter}${binding.dataStartRow}:${keyColLetter}`
    const keyValues = await client.readValues(binding.spreadsheetId, keyRange)
    const rowByExternalId = new Map<string, number>()
    keyValues.forEach((r, i) => {
      const key = r[0] == null ? '' : String(r[0]).trim()
      if (key) rowByExternalId.set(key, binding.dataStartRow + i)
    })
    let appendRow = binding.dataStartRow + keyValues.length

    const enforceConflicts = binding.direction === 'bidirectional'
    const policy: ConflictPolicy = isConflictPolicy(binding.conflictPolicy)
      ? binding.conflictPolicy
      : DEFAULT_CONFLICT_POLICY
    const endCol = columnLetter(Math.max(headers.length, 1))
    // Hash over the writer's canonical field shape so sheet-derived and read()-derived content
    // compare equal for equal data (see EntityWriter.normalize).
    const normalize = writer?.normalize
    const hashFields = (fields: Record<string, unknown>): string =>
      computeContentHash(normalize ? normalize(fields) : fields)

    // For bidirectional export we need the sheet's *current* content to detect conflicts, so
    // read the full data block once and hash each row (keyed by externalId). Export-only
    // treats Mercato as the source of truth and never inspects the sheet's content.
    const sheetHashByExternalId = new Map<string, string>()
    if (enforceConflicts && keyValues.length > 0) {
      const lastDataRow = binding.dataStartRow + keyValues.length - 1
      const dataRange = `${quoteTitle(tab.title)}!A${binding.dataStartRow}:${endCol}${lastDataRow}`
      const dataRows = await client.readValues(binding.spreadsheetId, dataRange)
      for (const sheetRecord of valuesToRecords(headers, dataRows, input.mapping, binding.keyColumn)) {
        sheetHashByExternalId.set(sheetRecord.externalId, hashFields(sheetRecord.fields))
      }
    }

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
    // Baselines to advance only after the batched sheet write actually lands.
    const pendingBaselines: Array<{ externalId: string; hash: string }> = []

    for (const mappingRow of mappings) {
      const localId = mappingRow.internalEntityId
      const externalId = mappingRow.externalId
      try {
        const record = await writer.read!(localId, writerCtx)
        if (!record) {
          results.push({ localId, externalId, status: 'skipped', error: 'no local record' })
          continue
        }
        const sourceHash = hashFields(record.fields)
        const baselineHash = await hashService.getBaseline(input.entityType, externalId, scope)

        const decision: SyncDecision = enforceConflicts
          ? decideSync({
              policy,
              writingTo: 'sheet',
              baselineHash,
              sourceHash,
              targetHash: sheetHashByExternalId.get(externalId) ?? null,
            })
          : // Export-only: Mercato is the source of truth — overwrite the sheet, skip no-ops.
            sourceHash === baselineHash
            ? { outcome: 'skip', reason: 'unchanged', nextBaseline: baselineHash }
            : { outcome: 'apply', reason: 'export-overwrite', nextBaseline: sourceHash }

        if (decision.outcome === 'flag') {
          results.push({
            localId,
            externalId,
            status: 'error',
            error: `sync conflict flagged for manual review (${decision.reason})`,
          })
          continue
        }
        if (decision.outcome === 'skip') {
          // No sheet write to wait on — safe to advance the baseline now if requested.
          if (decision.nextBaseline) {
            await hashService.setBaseline(input.entityType, externalId, decision.nextBaseline, scope)
          }
          results.push({ localId, externalId, status: 'skipped', error: decision.reason })
          continue
        }
        // apply: queue the row write; defer the baseline until the batch write lands.
        const rowValues = recordToRow(headers, record, input.mapping)
        const targetRow = rowByExternalId.get(externalId) ?? appendRow++
        updates.push({
          range: `${quoteTitle(tab.title)}!A${targetRow}:${endCol}${targetRow}`,
          values: [rowValues],
        })
        pendingBaselines.push({ externalId, hash: decision.nextBaseline ?? sourceHash })
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
      // The sheet write landed — now advance the baselines for the rows we wrote.
      for (const { externalId, hash } of pendingBaselines) {
        await hashService.setBaseline(input.entityType, externalId, hash, scope)
      }
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
