import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { GoogleSheetsBinding } from '../data/entities'

export const SYNC_GOOGLE_SHEETS_INTEGRATION_ID = 'sync_google_sheets'

export type BindingScope = { organizationId: string; tenantId: string }

export type SheetBindingInput = {
  entityType: string
  spreadsheetId: string
  sheetTitle: string
  sheetGid?: number | null
  headerRow?: number
  dataStartRow?: number
  keyColumn: string
  direction?: 'import' | 'export' | 'bidirectional'
  conflictPolicy?: string
  isEnabled?: boolean
}

/**
 * CRUD access to the per-integration sheet bindings (GoogleSheetsBinding). integrationId is
 * always `sync_google_sheets`; bindings are keyed by (entityType, org, tenant) and scoped by
 * organization + tenant on every read/write.
 */
export function createSheetBindingService(em: EntityManager) {
  return {
    async get(entityType: string, scope: BindingScope): Promise<GoogleSheetsBinding | null> {
      return findOneWithDecryption(
        em,
        GoogleSheetsBinding,
        {
          integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
          entityType,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          deletedAt: null,
        },
        undefined,
        scope,
      )
    },

    async list(scope: BindingScope): Promise<GoogleSheetsBinding[]> {
      return findWithDecryption(
        em,
        GoogleSheetsBinding,
        {
          integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          deletedAt: null,
        },
        { orderBy: { createdAt: 'asc' } },
        scope,
      )
    },

    async upsert(input: SheetBindingInput, scope: BindingScope): Promise<GoogleSheetsBinding> {
      const existing = await this.get(input.entityType, scope)
      if (existing) {
        existing.spreadsheetId = input.spreadsheetId
        existing.sheetTitle = input.sheetTitle
        existing.sheetGid = input.sheetGid ?? existing.sheetGid ?? null
        if (input.headerRow !== undefined) existing.headerRow = input.headerRow
        if (input.dataStartRow !== undefined) existing.dataStartRow = input.dataStartRow
        existing.keyColumn = input.keyColumn
        if (input.direction !== undefined) existing.direction = input.direction
        if (input.conflictPolicy !== undefined) existing.conflictPolicy = input.conflictPolicy
        if (input.isEnabled !== undefined) existing.isEnabled = input.isEnabled
        existing.deletedAt = null
        await em.flush()
        return existing
      }

      const created = em.create(GoogleSheetsBinding, {
        integrationId: SYNC_GOOGLE_SHEETS_INTEGRATION_ID,
        entityType: input.entityType,
        spreadsheetId: input.spreadsheetId,
        sheetTitle: input.sheetTitle,
        sheetGid: input.sheetGid ?? null,
        headerRow: input.headerRow ?? 1,
        dataStartRow: input.dataStartRow ?? 2,
        keyColumn: input.keyColumn,
        direction: input.direction ?? 'import',
        conflictPolicy: input.conflictPolicy ?? 'last-write-wins',
        isEnabled: input.isEnabled ?? true,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      })
      await em.persist(created).flush()
      return created
    },

    async remove(entityType: string, scope: BindingScope): Promise<void> {
      const existing = await this.get(entityType, scope)
      if (!existing) return
      existing.deletedAt = new Date()
      await em.flush()
    },

    /** Advance the incremental watermark after a completed run. */
    async touchWatermark(
      entityType: string,
      update: { lastSyncedAt?: Date; lastHeadRevisionId?: string | null },
      scope: BindingScope,
    ): Promise<void> {
      const existing = await this.get(entityType, scope)
      if (!existing) return
      if (update.lastSyncedAt !== undefined) existing.lastSyncedAt = update.lastSyncedAt
      if (update.lastHeadRevisionId !== undefined) existing.lastHeadRevisionId = update.lastHeadRevisionId
      await em.flush()
    },
  }
}

export type SheetBindingService = ReturnType<typeof createSheetBindingService>
