import {
  deriveExternalId,
  recordToRow,
  rowToRecord,
  valuesToRecords,
  sanitizeCellValue,
  legacyRowFields,
  legacyExternalId,
  hasDuplicateHeaders,
} from '../lib/row-mapping'

const mapping = {
  fields: [
    { externalField: 'Email', localField: 'email', mappingKind: 'external_id' },
    { externalField: 'First', localField: 'first_name', mappingKind: 'core' },
    { externalField: 'Tier', localField: 'loyalty_tier', mappingKind: 'custom_field' },
  ],
}
const headers = ['Email', 'First', 'Tier']

describe('recordToRow', () => {
  it('writes the external_id (key) column from the record field — regression: key must NOT be blank', () => {
    const record = { fields: { email: 'john@example.com', first_name: 'John', 'cf:loyalty_tier': 'gold' } }
    expect(recordToRow(headers, record, mapping)).toEqual(['john@example.com', 'John', 'gold'])
  })

  it('does not blank the key column for a read()/list()-derived record (no raw)', () => {
    const record = { fields: { email: 'a@b.com' } }
    expect(recordToRow(headers, record, mapping)[0]).toBe('a@b.com')
  })

  it('falls back to raw, then blank, for absent field values', () => {
    const record = { fields: {}, raw: { First: 'FromRaw' } }
    expect(recordToRow(headers, record, mapping)).toEqual(['', 'FromRaw', ''])
  })

  it('reads custom-field columns via the cf: prefix', () => {
    const record = { fields: { 'cf:loyalty_tier': 'silver' } }
    expect(recordToRow(['Tier'], record, mapping)).toEqual(['silver'])
  })
})

describe('deriveExternalId', () => {
  it('reads the base key-column field value', () => {
    expect(deriveExternalId({ fields: { email: 'john@example.com' } }, mapping, 'Email')).toBe('john@example.com')
  })

  it('resolves a custom-field key column with the cf: prefix, matching recordToRow', () => {
    const record = { fields: { 'cf:loyalty_tier': 'gold' } }
    expect(deriveExternalId(record, mapping, 'Tier')).toBe('gold')
    expect(recordToRow(['Tier'], record, mapping)).toEqual(['gold']) // same value both ways
  })

  it('trims and returns null for empty/missing key values', () => {
    expect(deriveExternalId({ fields: { email: '  x@y.com ' } }, mapping, 'Email')).toBe('x@y.com')
    expect(deriveExternalId({ fields: {} }, mapping, 'Email')).toBeNull()
    expect(deriveExternalId({ fields: { email: '   ' } }, mapping, 'Email')).toBeNull()
    expect(deriveExternalId({ fields: {} }, mapping, 'NoSuchColumn')).toBeNull()
  })
})

// Belt-tab regression (sync-google-sheets belt-import bug): the belt master sheet's row 1 is
// a formatting artifact — blank column A, eight identical "Name " headers (merged/overflowing
// header text over the inbound/quantity columns), then SKU. Duplicate headers must not
// collapse last-wins, and the key column must resolve positionally, not by a name that repeats.
const BELT_HEADERS = ['', 'Name ', 'Name ', 'Name ', 'Name ', 'Name ', 'Name ', 'Name ', 'Name ', 'SKU']
// col A blank; col B = style name; cols C–I = quantity columns (col I is "Shipping 9/20"); col J = SKU
const BELT_ROW = ['', 'Andean Whisper', 'small', '11', '60', '53', '90', '100', '120', '994BEL']

const beltMapping = {
  fields: [
    { externalField: 'SKU', localField: 'variant_sku', mappingKind: 'external_id' },
    { externalField: 'Name', localField: 'style', mappingKind: 'core' },
  ],
}

describe('rowToRecord — duplicate headers (belt-import regression)', () => {
  it('keeps the FIRST duplicate header column — regression: last-wins collapsed Name to the 9/20 qty', () => {
    const record = rowToRecord(BELT_HEADERS, BELT_ROW, beltMapping, 'SKU')
    expect(record).not.toBeNull()
    expect(record!.raw.Name).toBe('Andean Whisper') // was '120' (the last "Name " column)
    expect(record!.fields.style).toBe('Andean Whisper')
  })

  it('resolves the key column positionally — first trimmed-header match wins', () => {
    const record = rowToRecord(BELT_HEADERS, BELT_ROW, beltMapping, 'SKU')
    expect(record!.externalId).toBe('994BEL')
    // A repeated KEY header must also resolve to its first (canonical) column.
    const dupKey = rowToRecord(['', 'SKU', 'SKU', 'Name '], ['', '994BEL', 'junk', 'X'], beltMapping, 'SKU')
    expect(dupKey!.externalId).toBe('994BEL')
  })

  it('still skips rows whose key cell is blank or missing (short row)', () => {
    expect(rowToRecord(BELT_HEADERS, ['', 'No Sku Style', 's', '1', '2', '3', '4', '5', '6', ''], beltMapping, 'SKU')).toBeNull()
    expect(rowToRecord(BELT_HEADERS, ['', 'Short Row'], beltMapping, 'SKU')).toBeNull()
  })

  it('zero-config fallback slugifies the deduplicated headers, first occurrence winning', () => {
    const record = rowToRecord(BELT_HEADERS, BELT_ROW, { fields: [] }, 'SKU')
    expect(record!.externalId).toBe('994BEL')
    expect(record!.fields.name).toBe('Andean Whisper')
    // No name_2-style split keys: duplicates collapse to exactly one first-wins key.
    expect(Object.keys(record!.fields).filter((k) => k.startsWith('name'))).toHaveLength(1)
  })

  it('valuesToRecords maps every row through the same duplicate-header rules', () => {
    const records = valuesToRecords(
      BELT_HEADERS,
      [BELT_ROW, ['', 'Azure Seas', 'medium', '0', '50', '50', '0', '0', '200', '025BEL']],
      beltMapping,
      'SKU',
    )
    expect(records.map((r) => [r.externalId, r.raw.Name])).toEqual([
      ['994BEL', 'Andean Whisper'],
      ['025BEL', 'Azure Seas'],
    ])
  })
})

describe('sanitizeCellValue', () => {
  it('collapses blank to null, trims, and keeps numbers/booleans as-is', () => {
    expect(sanitizeCellValue('  padded  ')).toBe('padded')
    expect(sanitizeCellValue('   ')).toBeNull()
    expect(sanitizeCellValue(null)).toBeNull()
    expect(sanitizeCellValue(undefined)).toBeNull()
    expect(sanitizeCellValue(42)).toBe(42)
    expect(sanitizeCellValue(false)).toBe(false)
  })
})

// Export direction on the same artifact header: only the canonical (first) column of a
// duplicated header may be written — the rest must preserve the sheet's current content.
describe('recordToRow — duplicate headers (belt-export regression)', () => {
  const beltRecord = { fields: { variant_sku: '994BEL', style: 'Andean Whisper' } }
  const CURRENT_ROW = ['A-note', 'Andean Whisper', 'small', '11', '60', '53', '90', '100', '120', '994BEL']

  it('writes only the FIRST duplicate column and preserves every non-canonical cell', () => {
    const row = recordToRow(BELT_HEADERS, beltRecord, beltMapping, CURRENT_ROW)
    expect(row).toEqual([
      'A-note', // blank header → preserved
      'Andean Whisper', // canonical Name column written
      'small', '11', '60', '53', '90', '100', '120', // duplicate "Name " columns preserved
      '994BEL', // key column written
    ])
  })

  it('leaves duplicate/blank columns empty on a brand-new row (nothing to preserve)', () => {
    const row = recordToRow(BELT_HEADERS, beltRecord, beltMapping)
    expect(row).toEqual(['', 'Andean Whisper', '', '', '', '', '', '', '', '994BEL'])
  })

  it('preserves unmapped columns but blanks a mapped column whose value is absent (a Mercato-side clear)', () => {
    const headers = ['SKU', 'Name', 'On Hand', 'Notes']
    const current = ['994BEL', 'Old Style', '11', 'keep me']
    const row = recordToRow(headers, { fields: { variant_sku: '994BEL' } }, beltMapping, current)
    // Name is MAPPED: its absence in the record means the field was cleared in Mercato — the
    // cell must blank, never preserve, or the next import would resurrect the old value.
    expect(row).toEqual(['994BEL', '', '11', 'keep me'])
  })

  it('treats an explicit-null mapped value as a clear, not a preserve', () => {
    const headers = ['SKU', 'Name']
    const row = recordToRow(headers, { fields: { variant_sku: '994BEL', style: null } }, beltMapping, ['994BEL', 'Old'])
    expect(row).toEqual(['994BEL', ''])
  })

  it('handles a current row shorter than the header row (Sheets omits trailing empty cells)', () => {
    const headers = ['SKU', 'Name', 'On Hand', 'Notes']
    const row = recordToRow(headers, { fields: { variant_sku: '994BEL' } }, beltMapping, ['994BEL'])
    expect(row).toEqual(['994BEL', '', '', ''])
  })

  it('without a current row, missing values still ship blank (pre-fix behavior)', () => {
    const row = recordToRow(['SKU', 'Name', 'Notes'], { fields: { variant_sku: '994BEL' } }, beltMapping)
    expect(row).toEqual(['994BEL', '', ''])
  })
})

describe('legacyRowFields — frozen pre-fix derivation, for baseline-hash migration only', () => {
  it('reproduces the old last-wins garbage on the belt header (what stored baselines were hashed from)', () => {
    expect(legacyRowFields(BELT_HEADERS, BELT_ROW, beltMapping, 'SKU')).toEqual({ style: '120' })
  })

  it('matches the current derivation on clean headers (no duplicates → nothing to migrate)', () => {
    const headers = ['SKU', 'Name']
    const row = ['994BEL', 'Andean Whisper']
    expect(legacyRowFields(headers, row, beltMapping, 'SKU')).toEqual(
      rowToRecord(headers, row, beltMapping, 'SKU')!.fields,
    )
  })

  it('returns null when the legacy name-based key resolution lands on a blank cell', () => {
    // Repeated key header: the canonical column has the key, the LAST one is blank — the old
    // name-based lookup read the blank; the positional fix reads the key.
    expect(legacyRowFields(['', 'SKU', 'SKU', 'Name '], ['', '994BEL', '', 'X'], beltMapping, 'SKU')).toBeNull()
    expect(rowToRecord(['', 'SKU', 'SKU', 'Name '], ['', '994BEL', '', 'X'], beltMapping, 'SKU')!.externalId).toBe('994BEL')
  })
})

describe('hasDuplicateHeaders', () => {
  it('detects trimmed duplicates and ignores blank headers', () => {
    expect(hasDuplicateHeaders(BELT_HEADERS)).toBe(true)
    expect(hasDuplicateHeaders(['SKU', 'Name', ''])).toBe(false)
    expect(hasDuplicateHeaders(['', ''])).toBe(false)
  })
})

describe('legacyExternalId — the key a pre-fix sync would have assigned', () => {
  it('agrees with the positional key when the key column is not duplicated (belt tab)', () => {
    expect(legacyExternalId(BELT_HEADERS, BELT_ROW, 'SKU')).toBe('994BEL')
  })

  it('exposes divergence on a duplicated KEY column (last-wins vs positional first)', () => {
    const headers = ['', 'SKU', 'SKU', 'Name ']
    const row = ['', '994BEL', 'junk', 'X']
    expect(legacyExternalId(headers, row, 'SKU')).toBe('junk')
    expect(rowToRecord(headers, row, beltMapping, 'SKU')!.externalId).toBe('994BEL')
  })

  it('returns null when the legacy name-based key lands on a blank cell', () => {
    expect(legacyExternalId(['', 'SKU', 'SKU', 'Name '], ['', '994BEL', '', 'X'], 'SKU')).toBeNull()
  })
})
