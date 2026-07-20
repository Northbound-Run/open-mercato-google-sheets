import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

// Module-owned tables. These hold sync *metadata* only (sheet bindings + content hashes);
// the actual business/PII data is written into target entities (e.g. customers.person),
// which own their own encryption. See encryption.ts.

/**
 * Per-integration, per-entity-type binding of a Google Sheet tab to an Open Mercato entity.
 * Keyed like SyncMapping: one binding per (integration, entityType, org, tenant).
 */
@Entity({ tableName: 'sync_google_sheets_bindings' })
@Index({
  name: 'sync_gsheets_binding_scope_uniq',
  properties: ['integrationId', 'entityType', 'organizationId', 'tenantId'],
  options: { unique: true },
})
export class GoogleSheetsBinding {
  [OptionalProps]?:
    | 'sheetGid'
    | 'headerRow'
    | 'dataStartRow'
    | 'direction'
    | 'conflictPolicy'
    | 'isEnabled'
    | 'lastSyncedAt'
    | 'lastHeadRevisionId'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'integration_id', type: 'text' })
  integrationId!: string

  @Property({ name: 'entity_type', type: 'text' })
  entityType!: string

  @Property({ name: 'spreadsheet_id', type: 'text' })
  spreadsheetId!: string

  @Property({ name: 'sheet_title', type: 'text' })
  sheetTitle!: string

  @Property({ name: 'sheet_gid', type: 'int', nullable: true })
  sheetGid?: number | null

  @Property({ name: 'header_row', type: 'int', default: 1 })
  headerRow: number = 1

  @Property({ name: 'data_start_row', type: 'int', default: 2 })
  dataStartRow: number = 2

  @Property({ name: 'key_column', type: 'text' })
  keyColumn!: string

  @Property({ name: 'direction', type: 'text', default: 'import' })
  direction: 'import' | 'export' | 'bidirectional' = 'import'

  @Property({ name: 'conflict_policy', type: 'text', default: 'last-write-wins' })
  conflictPolicy: string = 'last-write-wins'

  @Property({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled: boolean = true

  @Property({ name: 'last_synced_at', type: Date, nullable: true })
  lastSyncedAt?: Date | null

  @Property({ name: 'last_head_revision_id', type: 'text', nullable: true })
  lastHeadRevisionId?: string | null

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Conflict-detection sidecar. Stores, per record, the 'baseline' content hash both sides
 * shared at the last successful sync — the common ancestor the sync engine diffs each side
 * against to classify it changed/unchanged (see lib/conflict-detection.ts). This subsumes
 * echo prevention: an unchanged side equals the baseline and is skipped. The baseline is
 * advanced only after a write actually lands (write-then-record), and the core scheduler
 * prevents overlapping same-direction runs, so there is no cross-run race to guard.
 */
@Entity({ tableName: 'sync_google_sheets_content_hashes' })
@Index({
  name: 'sync_gsheets_hash_scope_uniq',
  properties: ['integrationId', 'entityType', 'externalId', 'direction', 'organizationId', 'tenantId'],
  options: { unique: true },
})
export class GoogleSheetsContentHash {
  [OptionalProps]?: 'writtenAt' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'integration_id', type: 'text' })
  integrationId!: string

  @Property({ name: 'entity_type', type: 'text' })
  entityType!: string

  @Property({ name: 'external_id', type: 'text' })
  externalId!: string

  /**
   * Row kind. 'baseline' -> the content both sides shared at the last successful sync (the
   * common ancestor used for conflict detection). 'import'/'export' -> legacy per-side echo
   * hashes. The column is free-text, so new kinds need no migration.
   */
  @Property({ name: 'direction', type: 'text' })
  direction!: 'import' | 'export' | 'baseline'

  @Property({ name: 'content_hash', type: 'text' })
  contentHash!: string

  @Property({ name: 'written_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  writtenAt: Date = new Date()

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
