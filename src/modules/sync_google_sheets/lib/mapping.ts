import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { DataMapping, FieldMapping } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SyncMapping } from '@open-mercato/core/modules/data_sync/data/entities'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID, type BindingScope } from './config'
import type { NormalizedRecord } from './writers/types'

const MAX_CELL_LENGTH = 10_000

/** Header text -> a conventional local field key (lower snake case). */
export function slugifyHeader(header: string): string {
  return String(header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
}

/**
 * Generic, entity-agnostic mapping suggestion: each sheet header becomes a `core` field
 * whose localField is the slugified header. The key column is tagged `external_id`.
 */
export function suggestFieldMappings(headers: string[], keyColumn?: string): FieldMapping[] {
  const seen = new Set<string>()
  const fields: FieldMapping[] = []
  for (const header of headers) {
    const externalField = String(header ?? '').trim()
    if (!externalField || seen.has(externalField)) continue
    seen.add(externalField)
    const isKey = keyColumn != null && externalField === keyColumn
    fields.push({
      externalField,
      localField: slugifyHeader(externalField) || externalField,
      mappingKind: isKey ? 'external_id' : 'core',
    })
  }
  return fields
}

export function buildSuggestedMapping(entityType: string, headers: string[], keyColumn?: string): DataMapping {
  return {
    entityType,
    fields: suggestFieldMappings(headers, keyColumn),
    matchStrategy: 'externalId',
  }
}

/** Load the confirmed column→field mapping from the core SyncMapping row, or a default. */
export async function loadSheetMapping(
  em: EntityManager,
  entityType: string,
  scope: BindingScope,
): Promise<DataMapping> {
  const stored = await findOneWithDecryption(
    em,
    SyncMapping,
    {
      integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
      entityType,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    },
    undefined,
    scope,
  )
  if (stored?.mapping && typeof stored.mapping === 'object') {
    return stored.mapping as unknown as DataMapping
  }
  return { entityType, fields: [], matchStrategy: 'externalId' }
}

/** Persist the confirmed mapping into the core SyncMapping row (upsert). */
export async function saveSheetMapping(
  em: EntityManager,
  entityType: string,
  mapping: DataMapping,
  scope: BindingScope,
): Promise<void> {
  const stored = await findOneWithDecryption(
    em,
    SyncMapping,
    {
      integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
      entityType,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    },
    undefined,
    scope,
  )
  if (stored) {
    stored.mapping = mapping as unknown as Record<string, unknown>
    await em.flush()
    return
  }
  const created = em.create(SyncMapping, {
    integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
    entityType,
    mapping: mapping as unknown as Record<string, unknown>,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  })
  await em.persist(created).flush()
}

/**
 * Sanitize a raw cell value. Cells are read with FORMATTED_VALUE, so formulas already
 * arrive as their computed value; we still trim, cap absurdly long strings, and collapse
 * empty strings to null so downstream writers can treat "blank" uniformly.
 */
export function sanitizeCellValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  const text = String(value)
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > MAX_CELL_LENGTH ? trimmed.slice(0, MAX_CELL_LENGTH) : trimmed
}

function buildRawRow(headers: string[], row: unknown[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (let i = 0; i < headers.length; i += 1) {
    const header = String(headers[i] ?? '').trim()
    if (!header) continue
    raw[header] = sanitizeCellValue(row[i])
  }
  return raw
}

/**
 * Normalize one sheet data row into a writer-ready record. Returns null when the key column
 * is empty (a row we can't identify and must skip). When no mapping fields are configured
 * yet, falls back to slugified-header fields so a zero-config import still yields records.
 */
export function rowToRecord(
  headers: string[],
  row: unknown[],
  mapping: DataMapping,
  keyColumn: string,
): NormalizedRecord | null {
  const raw = buildRawRow(headers, row)
  const externalIdValue = raw[keyColumn]
  const externalId = externalIdValue == null ? '' : String(externalIdValue).trim()
  if (!externalId) return null

  const fields: Record<string, unknown> = {}
  const fieldMappings = mapping.fields ?? []

  if (fieldMappings.length === 0) {
    for (const [header, value] of Object.entries(raw)) {
      if (value === null) continue
      fields[slugifyHeader(header) || header] = value
    }
    return { externalId, fields, raw }
  }

  for (const field of fieldMappings) {
    if (field.mappingKind === 'ignore') continue
    const value = raw[field.externalField]
    if (value === undefined) continue
    if (field.mappingKind === 'custom_field' || field.localField.startsWith('cf:')) {
      const key = field.localField.startsWith('cf:') ? field.localField.slice(3) : field.localField
      if (key.trim().length > 0) fields[`cf:${key}`] = value
      continue
    }
    // external_id fields are already captured via keyColumn; keep them out of the payload
    // unless they map to a real local field.
    if (field.mappingKind === 'external_id') continue
    fields[field.localField] = value
  }

  return { externalId, fields, raw }
}

export function valuesToRecords(
  headers: string[],
  dataRows: unknown[][],
  mapping: DataMapping,
  keyColumn: string,
): NormalizedRecord[] {
  const records: NormalizedRecord[] = []
  for (const row of dataRows) {
    const record = rowToRecord(headers, row, mapping, keyColumn)
    if (record) records.push(record)
  }
  return records
}
