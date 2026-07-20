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
  /** Read a local record for export (optional; the adapter falls back to the query engine). */
  read?(localId: string, ctx: WriterContext): Promise<NormalizedRecord | null>
}
