// VENDORED raw-HTTP client for the Google Sheets v4 and Drive v3 REST APIs. No SDK —
// just `fetch` with a Bearer token, quota-aware backoff on 429/5xx, a single 401 refresh,
// and a hard per-request timeout. Mirrors the shape of channel-gmail's gmail-client.
//
// The access token is supplied by an injected provider so this client stays decoupled
// from OAuth storage/refresh and is trivially unit-testable.

const SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_CAP_MS = 60_000

export type AccessTokenProvider = (options?: { forceRefresh?: boolean }) => Promise<string>

export type SheetTab = {
  sheetId: number
  title: string
  index: number
  rowCount: number
  columnCount: number
}

export type SpreadsheetMeta = {
  spreadsheetId: string
  title: string
  sheets: SheetTab[]
}

export type DriveFileMeta = {
  modifiedTime: string | null
  headRevisionId: string | null
}

/** Google Sheets cell render options — FORMATTED_VALUE returns the displayed value,
 * so a formula cell (`=SUM(...)`) yields its computed value, never the formula string. */
export type ValueRenderOption = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA'
export type ValueInputOption = 'RAW' | 'USER_ENTERED'

export type GoogleSheetsClient = ReturnType<typeof createGoogleSheetsClient>

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Convert a 1-based column number to its A1 letters (1 -> A, 27 -> AA). */
export function columnNumberToLetter(column: number): string {
  let n = Math.max(1, Math.floor(column))
  let letters = ''
  while (n > 0) {
    const remainder = (n - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

function escapeSheetTitle(title: string): string {
  // A1 sheet titles containing spaces/specials must be single-quoted; embedded quotes doubled.
  if (/^[A-Za-z0-9_]+$/.test(title)) return title
  return `'${title.replace(/'/g, "''")}'`
}

/** Build an A1 range like `'My Tab'!A2:D51` from a 1-based row window and column count. */
export function buildA1Range(params: {
  sheetTitle: string
  startRow: number
  endRow: number
  startColumn?: number
  endColumn?: number
}): string {
  const startCol = columnNumberToLetter(params.startColumn ?? 1)
  const endCol = columnNumberToLetter(params.endColumn ?? params.startColumn ?? 1)
  const prefix = `${escapeSheetTitle(params.sheetTitle)}!`
  if (params.endColumn == null && params.startColumn == null) {
    // Whole-width row window: `Tab!2:51`.
    return `${prefix}${params.startRow}:${params.endRow}`
  }
  return `${prefix}${startCol}${params.startRow}:${endCol}${params.endRow}`
}

export type CreateGoogleSheetsClientOptions = {
  accessTokenProvider: AccessTokenProvider
  requestTimeoutMs?: number
  maxRetries?: number
  env?: NodeJS.ProcessEnv
  /** Test seam: override fetch. */
  fetchImpl?: typeof fetch
}

export function createGoogleSheetsClient(options: CreateGoogleSheetsClientOptions) {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? fetch
  const requestTimeoutMs =
    options.requestTimeoutMs ??
    resolvePositiveInt(env.OM_GOOGLE_SHEETS_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
  const maxRetries =
    options.maxRetries ?? resolvePositiveInt(env.OM_GOOGLE_SHEETS_MAX_RETRIES, DEFAULT_MAX_RETRIES)
  const retryCapMs = resolvePositiveInt(env.OM_GOOGLE_SHEETS_RETRY_CAP_MS, DEFAULT_RETRY_CAP_MS)

  function backoffMs(attempt: number, retryAfterHeader: string | null): number {
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader)
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, retryCapMs)
    }
    return Math.min(500 * 2 ** attempt, retryCapMs)
  }

  async function request<T>(
    url: string,
    init: RequestInit = {},
    attempt = 0,
    refreshed = false,
  ): Promise<T> {
    const token = await options.accessTokenProvider(refreshed ? { forceRefresh: true } : undefined)
    const response = await doFetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
    })

    if (response.status === 401 && !refreshed) {
      return request<T>(url, init, attempt, true)
    }

    if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
      await sleep(backoffMs(attempt, response.headers.get('retry-after')))
      return request<T>(url, init, attempt + 1, refreshed)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Google Sheets request failed (${response.status}): ${body.slice(0, 500)}`)
    }

    if (response.status === 204) return null as T
    return (await response.json()) as T
  }

  return {
    /** List tabs and grid dimensions for a spreadsheet. */
    async getSpreadsheet(spreadsheetId: string): Promise<SpreadsheetMeta> {
      const fields = 'spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))'
      const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`
      const payload = await request<{
        spreadsheetId?: string
        properties?: { title?: string }
        sheets?: Array<{
          properties?: {
            sheetId?: number
            title?: string
            index?: number
            gridProperties?: { rowCount?: number; columnCount?: number }
          }
        }>
      }>(url)
      return {
        spreadsheetId: payload.spreadsheetId ?? spreadsheetId,
        title: payload.properties?.title ?? '',
        sheets: (payload.sheets ?? []).map((sheet) => ({
          sheetId: sheet.properties?.sheetId ?? 0,
          title: sheet.properties?.title ?? '',
          index: sheet.properties?.index ?? 0,
          rowCount: sheet.properties?.gridProperties?.rowCount ?? 0,
          columnCount: sheet.properties?.gridProperties?.columnCount ?? 0,
        })),
      }
    },

    /** Read a rectangular range. Returns raw row-major cell values (ragged rows possible). */
    async readValues(
      spreadsheetId: string,
      a1Range: string,
      opts: { valueRenderOption?: ValueRenderOption } = {},
    ): Promise<unknown[][]> {
      const params = new URLSearchParams()
      params.set('valueRenderOption', opts.valueRenderOption ?? 'FORMATTED_VALUE')
      params.set('dateTimeRenderOption', 'FORMATTED_STRING')
      params.set('majorDimension', 'ROWS')
      const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1Range)}?${params.toString()}`
      const payload = await request<{ values?: unknown[][] }>(url)
      return Array.isArray(payload.values) ? payload.values : []
    },

    /** Overwrite a single range (export write). */
    async updateValues(
      spreadsheetId: string,
      a1Range: string,
      values: unknown[][],
      opts: { valueInputOption?: ValueInputOption } = {},
    ): Promise<void> {
      const params = new URLSearchParams()
      params.set('valueInputOption', opts.valueInputOption ?? 'RAW')
      const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1Range)}?${params.toString()}`
      await request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range: a1Range, majorDimension: 'ROWS', values }),
      })
    },

    /** Overwrite several ranges in one request (export write, batched). */
    async batchUpdateValues(
      spreadsheetId: string,
      data: Array<{ range: string; values: unknown[][] }>,
      opts: { valueInputOption?: ValueInputOption } = {},
    ): Promise<void> {
      if (data.length === 0) return
      const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`
      await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: opts.valueInputOption ?? 'RAW',
          data: data.map((d) => ({ range: d.range, majorDimension: 'ROWS', values: d.values })),
        }),
      })
    },

    /** Append rows after the last row of a range (export of new records). */
    async appendValues(
      spreadsheetId: string,
      a1Range: string,
      values: unknown[][],
      opts: { valueInputOption?: ValueInputOption } = {},
    ): Promise<void> {
      if (values.length === 0) return
      const params = new URLSearchParams()
      params.set('valueInputOption', opts.valueInputOption ?? 'RAW')
      params.set('insertDataOption', 'INSERT_ROWS')
      const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1Range)}:append?${params.toString()}`
      await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range: a1Range, majorDimension: 'ROWS', values }),
      })
    },

    /** Drive file-level change signal (there is no per-row modification time in Sheets). */
    async getDriveFileMeta(spreadsheetId: string): Promise<DriveFileMeta> {
      const url = `${DRIVE_FILES_URL}/${encodeURIComponent(spreadsheetId)}?fields=modifiedTime,headRevisionId&supportsAllDrives=true`
      const payload = await request<{ modifiedTime?: string; headRevisionId?: string }>(url)
      return {
        modifiedTime: payload.modifiedTime ?? null,
        headRevisionId: payload.headRevisionId ?? null,
      }
    },
  }
}
