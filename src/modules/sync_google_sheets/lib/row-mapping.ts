// Framework-free row <-> record mapping helpers, extracted from the adapter so they are unit
// testable (the adapter itself imports framework runtime and can't be loaded in the test
// harness). Types are a structural subset of DataMapping / NormalizedRecord to keep this
// module dependency-free.

type RowMappingField = { externalField: string; localField: string; mappingKind?: string }
type RowMapping = { fields?: RowMappingField[] }
type RowRecord = { fields: Record<string, unknown>; raw?: Record<string, unknown> }
type RowRecordIn = { externalId: string; fields: Record<string, unknown>; raw: Record<string, unknown> }

/** Resolve the record key a field maps to, applying the `cf:` prefix for custom fields. */
function fieldKey(field: RowMappingField): string {
  const isCustom = field.mappingKind === 'custom_field' || field.localField.startsWith('cf:')
  if (!isCustom) return field.localField
  const bare = field.localField.startsWith('cf:') ? field.localField.slice(3) : field.localField
  return `cf:${bare}`
}

/**
 * Map a normalized record back to a sheet row, column order following the header row.
 * `currentRow` is the sheet's existing content for this record's row (bidirectional update):
 * every column the import side does not treat as canonical — a blank header, a repeated
 * header (merged/overflowing text), or an unmapped column — is PRESERVED from it instead of
 * being blanked or overwritten, so exporting never destroys out-of-contract sheet content.
 * Without `currentRow` (export-only, or a brand-new row) those cells ship blank.
 */
export function recordToRow(
  headers: string[],
  record: RowRecord,
  mapping: RowMapping,
  currentRow?: unknown[],
): unknown[] {
  const seen = new Set<string>()
  return headers.map((header, i) => {
    const key = String(header ?? '').trim()
    if (!key || seen.has(key)) return currentRow?.[i] ?? ''
    seen.add(key)
    const field = (mapping.fields ?? []).find((f) => f.externalField === key)
    if (field) {
      // Every mapped column — including the external_id (key) column — reads its value from the
      // record's fields. read()/list()-derived records carry the key under its localField (they
      // have no `raw`), so this must NOT skip external_id fields or the key column ships blank.
      // Mapped columns NEVER preserve currentRow: a missing value is a Mercato-side clear and
      // must blank the cell — preserving would keep the stale value and the next import would
      // resurrect it into Mercato.
      return record.fields[fieldKey(field)] ?? record.raw?.[key] ?? ''
    }
    return record.raw?.[key] ?? currentRow?.[i] ?? ''
  })
}

/** Derive a new record's external id from the value of its key-column field. */
export function deriveExternalId(record: RowRecord, mapping: RowMapping, keyColumn: string): string | null {
  const field = (mapping.fields ?? []).find((f) => f.externalField === keyColumn)
  if (!field) return null
  // Same key resolution as recordToRow, so the derived id matches the value written to the row.
  const raw = record.fields[fieldKey(field)]
  const value = raw == null ? '' : String(raw).trim()
  return value.length > 0 ? value : null
}

/** Header text -> a conventional local field key (lower snake case). */
export function slugifyHeader(header: string): string {
  return String(header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
}

const MAX_CELL_LENGTH = 10_000

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
    // Blank headers carry no key. Duplicate headers (merged/overflowing header text — e.g. a
    // belt tab whose row 1 repeats "Name " over eight quantity columns) collapse to one key and
    // the FIRST occurrence wins: the leftmost column is the real field, later same-named
    // columns are artifacts. (Last-wins put a "Shipping 9/20" qty into raw.Name — belt-import bug.)
    if (!header || Object.hasOwn(raw, header)) continue
    raw[header] = sanitizeCellValue(row[i])
  }
  return raw
}

/** Project a raw row to the mapped local field set (shared by the current and legacy derivations). */
function projectFields(raw: Record<string, unknown>, mapping: RowMapping): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const fieldMappings = mapping.fields ?? []

  if (fieldMappings.length === 0) {
    for (const [header, value] of Object.entries(raw)) {
      if (value === null) continue
      fields[slugifyHeader(header) || header] = value
    }
    return fields
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

  return fields
}

/**
 * Normalize one sheet data row into a writer-ready record. Returns null when the key column
 * is empty (a row we can't identify and must skip). When no mapping fields are configured
 * yet, falls back to slugified-header fields so a zero-config import still yields records.
 */
export function rowToRecord(
  headers: string[],
  row: unknown[],
  mapping: RowMapping,
  keyColumn: string,
): RowRecordIn | null {
  const raw = buildRawRow(headers, row)
  // Resolve the key column POSITIONALLY, not by header name: a name can repeat (see
  // buildRawRow), so the key is the first column whose trimmed header matches keyColumn.
  const keyIndex = headers.findIndex((h) => String(h ?? '').trim() === keyColumn)
  const keyValue = keyIndex >= 0 ? sanitizeCellValue(row[keyIndex]) : raw[keyColumn]
  const externalId = keyValue == null ? '' : String(keyValue).trim()
  if (!externalId) return null
  return { externalId, fields: projectFields(raw, mapping), raw }
}

/** True when two non-blank headers share the same trimmed text (merged/overflowing header cells). */
export function hasDuplicateHeaders(headers: string[]): boolean {
  const seen = new Set<string>()
  for (const header of headers) {
    const key = String(header ?? '').trim()
    if (!key) continue
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

/** Last-wins raw build from BEFORE the duplicate-header fix — shared by the legacy helpers. */
function buildRawRowLegacy(headers: string[], row: unknown[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (let i = 0; i < headers.length; i += 1) {
    const header = String(headers[i] ?? '').trim()
    if (!header) continue
    raw[header] = sanitizeCellValue(row[i])
  }
  return raw
}

/**
 * Frozen PRE-FIX row derivation — duplicate headers collapsed LAST-wins and the key resolved
 * by header name — used ONLY to recompute the field hash a pre-fix sync stored as a record's
 * baseline, so the duplicate-header fix doesn't read as a content change and storm false
 * conflicts. Never use this to map rows to records: rowToRecord is the correct derivation.
 */
export function legacyRowFields(
  headers: string[],
  row: unknown[],
  mapping: RowMapping,
  keyColumn: string,
): Record<string, unknown> | null {
  const raw = buildRawRowLegacy(headers, row)
  if (!legacyExternalId(headers, row, keyColumn)) return null
  return projectFields(raw, mapping)
}

/**
 * The external id the PRE-FIX derivation would have assigned this row (name-based key lookup,
 * last-wins on duplicates). When this differs from rowToRecord's positional key, the row's
 * pre-fix id-mapping/baseline lives under a different id — the adapter refuses to sync such a
 * row rather than silently duplicate the record.
 */
export function legacyExternalId(headers: string[], row: unknown[], keyColumn: string): string | null {
  const value = buildRawRowLegacy(headers, row)[keyColumn]
  const text = value == null ? '' : String(value).trim()
  return text.length > 0 ? text : null
}

export function valuesToRecords(
  headers: string[],
  dataRows: unknown[][],
  mapping: RowMapping,
  keyColumn: string,
): RowRecordIn[] {
  const records: RowRecordIn[] = []
  for (const row of dataRows) {
    const record = rowToRecord(headers, row, mapping, keyColumn)
    if (record) records.push(record)
  }
  return records
}
