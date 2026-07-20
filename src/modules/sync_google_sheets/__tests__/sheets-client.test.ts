import { columnNumberToLetter, buildA1Range } from '../lib/sheets-client'

describe('columnNumberToLetter', () => {
  it.each<[number, string]>([
    [1, 'A'],
    [2, 'B'],
    [26, 'Z'],
    [27, 'AA'],
    [28, 'AB'],
    [52, 'AZ'],
    [53, 'BA'],
    [702, 'ZZ'],
    [703, 'AAA'],
  ])('converts column %i to %s', (input, expected) => {
    expect(columnNumberToLetter(input)).toBe(expected)
  })

  it('clamps values below 1 to column A', () => {
    expect(columnNumberToLetter(0)).toBe('A')
    expect(columnNumberToLetter(-5)).toBe('A')
  })

  it('floors fractional column numbers', () => {
    expect(columnNumberToLetter(1.9)).toBe('A')
    expect(columnNumberToLetter(26.9)).toBe('Z')
  })
})

describe('buildA1Range', () => {
  it('builds a whole-width row window when no columns are specified', () => {
    expect(
      buildA1Range({ sheetTitle: 'Tab', startRow: 2, endRow: 51 }),
    ).toBe('Tab!2:51')
  })

  it('builds a column-bounded range', () => {
    expect(
      buildA1Range({ sheetTitle: 'Tab', startRow: 2, endRow: 51, startColumn: 1, endColumn: 4 }),
    ).toBe('Tab!A2:D51')
  })

  it('single-quotes a title containing a space', () => {
    expect(
      buildA1Range({ sheetTitle: 'My Tab', startRow: 2, endRow: 51, startColumn: 1, endColumn: 4 }),
    ).toBe("'My Tab'!A2:D51")
  })

  it('doubles an embedded apostrophe in the title', () => {
    expect(
      buildA1Range({ sheetTitle: "O'Brien", startRow: 1, endRow: 10, startColumn: 1, endColumn: 2 }),
    ).toBe("'O''Brien'!A1:B10")
  })

  it('does not quote an alphanumeric-only title', () => {
    const range = buildA1Range({ sheetTitle: 'Sheet1', startRow: 1, endRow: 5 })
    expect(range).toBe('Sheet1!1:5')
  })

  it('does not quote a title with underscores', () => {
    const range = buildA1Range({ sheetTitle: 'Sheet_1', startRow: 3, endRow: 7 })
    expect(range).toBe('Sheet_1!3:7')
  })

  it('handles single-column range (startColumn without endColumn)', () => {
    // When endColumn is omitted but startColumn is provided, endCol = columnNumberToLetter(startColumn)
    const range = buildA1Range({ sheetTitle: 'Data', startRow: 1, endRow: 100, startColumn: 3 })
    expect(range).toBe('Data!C1:C100')
  })

  it('builds a range starting at column Z', () => {
    expect(
      buildA1Range({ sheetTitle: 'Tab', startRow: 1, endRow: 2, startColumn: 26, endColumn: 27 }),
    ).toBe('Tab!Z1:AA2')
  })

  it('whole-width range with a title needing quoting', () => {
    expect(
      buildA1Range({ sheetTitle: 'Raw Data', startRow: 1, endRow: 100 }),
    ).toBe("'Raw Data'!1:100")
  })
})
