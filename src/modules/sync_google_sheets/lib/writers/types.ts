import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'

// The EntityWriter abstraction is the crux of "reusable, not hardcoded". Open Mercato
// writes are entity-specific commands (there is no generic "upsert any entity"), so the
// adapter stays generic by delegating the actual write to a writer registered per entity
// type. Downstream teams register their own writers from their module's di.ts — no fork
// of this package required.

export type WriterAction = 'create' | 'update' | 'skip'

export type SyncScope = {
  tenantId: string
  organizationId: string
  userId?: string | null
}

export type NormalizedRecord = {
  /** Stable external identity (value of the configured key column). */
  externalId: string
  /**
   * Mapped local field values. Base fields use bare keys (e.g. `email`); custom fields
   * use the `cf:<key>` request-payload convention (e.g. `cf:loyalty_tier`).
   */
  fields: Record<string, unknown>
  /** The raw source row keyed by header, for writers that need more than mapped fields. */
  raw?: Record<string, unknown>
}

export type WriterContext = {
  scope: SyncScope
  container: AppContainer
  em: EntityManager
  integrationId: string
  entityType: string
}

export interface EntityWriter {
  /** The entity type this writer handles, e.g. `customers.person`. */
  entityType: string
  /** Upsert a normalized record; return the local id + resolved action for stats/id-mapping. */
  upsert(record: NormalizedRecord, ctx: WriterContext): Promise<{ id: string; action: WriterAction }>
  /** Read a local record for export / bidirectional (required for those directions). */
  read?(localId: string, ctx: WriterContext): Promise<NormalizedRecord | null>
  /**
   * Optional canonicalization of a record's fields (e.g. lowercase email, trim) so that
   * sheet-derived and read()-derived content hash identically for equal content. The sync
   * engine applies it before hashing on both sides (see lib/conflict-detection.ts's
   * normalization contract). Must be idempotent.
   */
  normalize?(fields: Record<string, unknown>): Record<string, unknown>
  /**
   * Optional enumeration for new-record export: page through this entity's records so the
   * adapter can push records created in Mercato that have no sheet row yet. Each item pairs a
   * local id with its NormalizedRecord, keyed the same way read()/upsert use (so hashing and
   * mapping stay consistent). When omitted, only already-mapped records are exported (updates).
   */
  list?(
    ctx: WriterContext,
    page: { offset: number; limit: number },
  ): Promise<{ items: Array<{ localId: string; record: NormalizedRecord }>; hasMore: boolean }>
}
