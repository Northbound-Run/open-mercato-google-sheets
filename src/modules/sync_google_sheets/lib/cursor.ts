// Cursor state for Google Sheets sync runs.
//
// The Data Sync engine persists `batch.cursor` (an opaque string) after every batch
// via `syncRunService.commitBatchProgress` — that persisted cursor is what makes a run
// resumable after a worker crash. We JSON-encode a small, versioned object.
//
// Offset-only cursors are fragile when a sheet is edited mid-run (inserted/removed rows
// shift every subsequent offset), so `rowOffset` is treated as a *resumption hint* only:
// record matching/upsert is keyed by the configured key column, and the persisted
// `headRevisionId` lets a resumed run detect that the sheet changed underneath it.

export type SheetImportCursor = {
  kind: 'gs-import'
  /** Next 0-based data row to read (excludes the header row). */
  rowOffset: number
  /** Drive headRevisionId captured at run start, for change/consistency detection. */
  headRevisionId?: string | null
  /** Best-effort total data-row count captured at run start (for progress). */
  totalRows?: number | null
}

export type SheetExportCursor = {
  kind: 'gs-export'
  /** Next 0-based record offset to export. */
  offset: number
  /** ISO watermark: only export local records updated after this. */
  updatedAfter?: string | null
}

function toNonNegInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function serializeImportCursor(state: {
  rowOffset: number
  headRevisionId?: string | null
  totalRows?: number | null
}): string {
  const cursor: SheetImportCursor = {
    kind: 'gs-import',
    rowOffset: toNonNegInt(state.rowOffset),
    headRevisionId: toStringOrNull(state.headRevisionId),
    totalRows: typeof state.totalRows === 'number' && state.totalRows >= 0 ? Math.floor(state.totalRows) : null,
  }
  return JSON.stringify(cursor)
}

export function parseImportCursor(raw: string | null | undefined): SheetImportCursor | null {
  if (!raw || raw.trim().length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SheetImportCursor>
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'gs-import') return null
    return {
      kind: 'gs-import',
      rowOffset: toNonNegInt(parsed.rowOffset),
      headRevisionId: toStringOrNull(parsed.headRevisionId),
      totalRows:
        typeof parsed.totalRows === 'number' && parsed.totalRows >= 0 ? Math.floor(parsed.totalRows) : null,
    }
  } catch {
    return null
  }
}

export function serializeExportCursor(state: { offset: number; updatedAfter?: string | null }): string {
  const cursor: SheetExportCursor = {
    kind: 'gs-export',
    offset: toNonNegInt(state.offset),
    updatedAfter: toStringOrNull(state.updatedAfter),
  }
  return JSON.stringify(cursor)
}

export function parseExportCursor(raw: string | null | undefined): SheetExportCursor | null {
  if (!raw || raw.trim().length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SheetExportCursor>
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'gs-export') return null
    return {
      kind: 'gs-export',
      offset: toNonNegInt(parsed.offset),
      updatedAfter: toStringOrNull(parsed.updatedAfter),
    }
  } catch {
    return null
  }
}
