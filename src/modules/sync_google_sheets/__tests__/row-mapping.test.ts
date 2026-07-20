import { deriveExternalId, recordToRow } from '../lib/row-mapping'

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
