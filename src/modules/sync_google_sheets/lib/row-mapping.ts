// Framework-free row <-> record mapping helpers, extracted from the adapter so they are unit
// testable (the adapter itself imports framework runtime and can't be loaded in the test
// harness). Types are a structural subset of DataMapping / NormalizedRecord to keep this
// module dependency-free.

type RowMappingField = { externalField: string; localField: string; mappingKind?: string }
type RowMapping = { fields?: RowMappingField[] }
type RowRecord = { fields: Record<string, unknown>; raw?: Record<string, unknown> }

/** Resolve the record key a field maps to, applying the `cf:` prefix for custom fields. */
function fieldKey(field: RowMappingField): string {
  const isCustom = field.mappingKind === 'custom_field' || field.localField.startsWith('cf:')
  if (!isCustom) return field.localField
  const bare = field.localField.startsWith('cf:') ? field.localField.slice(3) : field.localField
  return `cf:${bare}`
}

/** Map a normalized record back to a sheet row, column order following the header row. */
export function recordToRow(headers: string[], record: RowRecord, mapping: RowMapping): unknown[] {
  return headers.map((header) => {
    const field = (mapping.fields ?? []).find((f) => f.externalField === header)
    if (field) {
      // Every mapped column — including the external_id (key) column — reads its value from the
      // record's fields. read()/list()-derived records carry the key under its localField (they
      // have no `raw`), so this must NOT skip external_id fields or the key column ships blank.
      return record.fields[fieldKey(field)] ?? record.raw?.[header] ?? ''
    }
    return record.raw?.[header] ?? ''
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
