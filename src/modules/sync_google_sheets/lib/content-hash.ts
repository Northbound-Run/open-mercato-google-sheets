import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { GoogleSheetsContentHash } from '../data/entities'
import { SYNC_GOOGLE_SHEETS_INTEGRATION_ID, type BindingScope } from './config'

// Deterministic JSON stringify: sort object keys recursively so equal content always
// hashes the same regardless of key insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

/** Stable SHA-256 content hash over a normalized field set (order-independent). */
export function computeContentHash(fields: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(fields)).digest('hex')
}

export type HashDirection = 'import' | 'export'

/**
 * Tracks the content hash this module last wrote to each side of a record, so an import
 * doesn't re-emit a value we just exported (and vice versa). Read + write are the caller's
 * responsibility to wrap in withAtomicFlush when they must be atomic with the target write.
 */
export function createContentHashService(em: EntityManager) {
  async function find(entityType: string, externalId: string, direction: HashDirection, scope: BindingScope) {
    return findOneWithDecryption(
      em,
      GoogleSheetsContentHash,
      {
        integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
        entityType,
        externalId,
        direction,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      },
      undefined,
      scope,
    )
  }

  return {
    async getLastHash(
      entityType: string,
      externalId: string,
      direction: HashDirection,
      scope: BindingScope,
    ): Promise<string | null> {
      const row = await find(entityType, externalId, direction, scope)
      return row?.contentHash ?? null
    },

    /**
     * Return true when `candidateHash` equals the last hash written to `direction` for this
     * record — i.e. the incoming change is our own echo and should be skipped.
     */
    async isEcho(
      entityType: string,
      externalId: string,
      direction: HashDirection,
      candidateHash: string,
      scope: BindingScope,
    ): Promise<boolean> {
      const last = await this.getLastHash(entityType, externalId, direction, scope)
      return last !== null && last === candidateHash
    },

    async record(
      entityType: string,
      externalId: string,
      direction: HashDirection,
      contentHash: string,
      scope: BindingScope,
    ): Promise<void> {
      const existing = await find(entityType, externalId, direction, scope)
      if (existing) {
        existing.contentHash = contentHash
        existing.writtenAt = new Date()
        await em.flush()
        return
      }
      const created = em.create(GoogleSheetsContentHash, {
        integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
        entityType,
        externalId,
        direction,
        contentHash,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      })
      await em.persist(created).flush()
    },
  }
}

export type ContentHashService = ReturnType<typeof createContentHashService>
