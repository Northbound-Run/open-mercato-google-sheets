import {
  serializeImportCursor,
  parseImportCursor,
  serializeExportCursor,
  parseExportCursor,
  type SheetImportCursor,
  type SheetExportCursor,
} from '../lib/cursor'

describe('serializeImportCursor / parseImportCursor', () => {
  it('round-trips a minimal cursor', () => {
    const raw = serializeImportCursor({ rowOffset: 5 })
    const parsed = parseImportCursor(raw)
    expect(parsed).toEqual<SheetImportCursor>({
      kind: 'gs-import',
      rowOffset: 5,
      headRevisionId: null,
      totalRows: null,
    })
  })

  it('round-trips all optional fields', () => {
    const raw = serializeImportCursor({
      rowOffset: 42,
      headRevisionId: 'rev-abc-123',
      totalRows: 200,
    })
    const parsed = parseImportCursor(raw)
    expect(parsed).toEqual<SheetImportCursor>({
      kind: 'gs-import',
      rowOffset: 42,
      headRevisionId: 'rev-abc-123',
      totalRows: 200,
    })
  })

  it('preserves kind gs-import through the round-trip', () => {
    const parsed = parseImportCursor(serializeImportCursor({ rowOffset: 0 }))
    expect(parsed?.kind).toBe('gs-import')
  })

  it('clamps a negative rowOffset to 0', () => {
    const raw = serializeImportCursor({ rowOffset: -99 })
    const parsed = parseImportCursor(raw)
    expect(parsed?.rowOffset).toBe(0)
  })

  it('clamps a NaN rowOffset to 0', () => {
    const raw = serializeImportCursor({ rowOffset: NaN })
    const parsed = parseImportCursor(raw)
    expect(parsed?.rowOffset).toBe(0)
  })

  it('converts an empty-string headRevisionId to null', () => {
    const raw = serializeImportCursor({ rowOffset: 1, headRevisionId: '' })
    const parsed = parseImportCursor(raw)
    expect(parsed?.headRevisionId).toBeNull()
  })

  it('converts a whitespace-only headRevisionId to null', () => {
    const raw = serializeImportCursor({ rowOffset: 1, headRevisionId: '   ' })
    const parsed = parseImportCursor(raw)
    expect(parsed?.headRevisionId).toBeNull()
  })

  it('returns null for null input', () => {
    expect(parseImportCursor(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseImportCursor(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseImportCursor('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(parseImportCursor('   ')).toBeNull()
  })

  it('returns null for non-JSON string', () => {
    expect(parseImportCursor('not json')).toBeNull()
  })

  it('returns null for {} (missing kind)', () => {
    expect(parseImportCursor('{}')).toBeNull()
  })

  it('returns null when kind is gs-export (wrong kind)', () => {
    expect(parseImportCursor('{"kind":"gs-export","offset":0}')).toBeNull()
  })

  it('floors a fractional rowOffset', () => {
    const raw = serializeImportCursor({ rowOffset: 7.9 })
    const parsed = parseImportCursor(raw)
    expect(parsed?.rowOffset).toBe(7)
  })

  it('floors a fractional totalRows', () => {
    const raw = serializeImportCursor({ rowOffset: 0, totalRows: 99.7 })
    const parsed = parseImportCursor(raw)
    expect(parsed?.totalRows).toBe(99)
  })

  it('treats a negative totalRows as null', () => {
    const raw = serializeImportCursor({ rowOffset: 0, totalRows: -1 })
    const parsed = parseImportCursor(raw)
    expect(parsed?.totalRows).toBeNull()
  })
})

describe('serializeExportCursor / parseExportCursor', () => {
  it('round-trips a minimal export cursor', () => {
    const raw = serializeExportCursor({ offset: 10 })
    const parsed = parseExportCursor(raw)
    expect(parsed).toEqual<SheetExportCursor>({
      kind: 'gs-export',
      offset: 10,
      updatedAfter: null,
    })
  })

  it('round-trips with updatedAfter', () => {
    const ts = '2024-06-01T00:00:00.000Z'
    const raw = serializeExportCursor({ offset: 3, updatedAfter: ts })
    const parsed = parseExportCursor(raw)
    expect(parsed).toEqual<SheetExportCursor>({
      kind: 'gs-export',
      offset: 3,
      updatedAfter: ts,
    })
  })

  it('preserves kind gs-export through the round-trip', () => {
    const parsed = parseExportCursor(serializeExportCursor({ offset: 0 }))
    expect(parsed?.kind).toBe('gs-export')
  })

  it('clamps a negative offset to 0', () => {
    const raw = serializeExportCursor({ offset: -5 })
    const parsed = parseExportCursor(raw)
    expect(parsed?.offset).toBe(0)
  })

  it('converts an empty-string updatedAfter to null', () => {
    const raw = serializeExportCursor({ offset: 0, updatedAfter: '' })
    const parsed = parseExportCursor(raw)
    expect(parsed?.updatedAfter).toBeNull()
  })

  it('returns null for null input', () => {
    expect(parseExportCursor(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseExportCursor(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseExportCursor('')).toBeNull()
  })

  it('returns null for non-JSON string', () => {
    expect(parseExportCursor('not json')).toBeNull()
  })

  it('returns null for {} (missing kind)', () => {
    expect(parseExportCursor('{}')).toBeNull()
  })

  it('returns null when kind is gs-import (wrong kind)', () => {
    expect(parseExportCursor('{"kind":"gs-import","rowOffset":0}')).toBeNull()
  })
})
