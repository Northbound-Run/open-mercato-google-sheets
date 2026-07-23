import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { DataMapping, FieldMapping } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SyncMapping } from '@open-mercato/core/modules/data_sync/data/entities'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID, type BindingScope } from './config'
import { slugifyHeader } from './row-mapping'

// The pure row <-> record helpers live in framework-free ./row-mapping so they are unit
// testable; re-export so existing import sites (adapter, downstream packages) are unchanged.
export { sanitizeCellValue, slugifyHeader, rowToRecord, valuesToRecords } from './row-mapping'

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
