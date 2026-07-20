import { z } from 'zod'

/** Accept either a bare spreadsheet id or a full Google Sheets URL and return the id. */
export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : trimmed
}

const directionSchema = z.enum(['import', 'export', 'bidirectional'])
const conflictPolicySchema = z.enum(['last-write-wins', 'sheet-wins', 'mercato-wins', 'flag-for-review'])

export const fieldMappingSchema = z.object({
  externalField: z.string(),
  localField: z.string(),
  transform: z.string().optional(),
  required: z.boolean().optional(),
  mappingKind: z.enum(['core', 'relation', 'external_id', 'custom_field', 'metadata', 'ignore']).optional(),
})

export const dataMappingSchema = z.object({
  entityType: z.string().min(1),
  fields: z.array(fieldMappingSchema).default([]),
  matchStrategy: z.enum(['externalId', 'sku', 'email', 'custom']).default('externalId'),
  matchField: z.string().optional(),
})

export const sheetBindingSchema = z.object({
  entityType: z.string().min(1),
  spreadsheetId: z.string().min(1).transform(extractSpreadsheetId),
  sheetTitle: z.string().min(1),
  sheetGid: z.number().int().nullable().optional(),
  headerRow: z.number().int().positive().optional(),
  dataStartRow: z.number().int().positive().optional(),
  keyColumn: z.string().min(1),
  direction: directionSchema.optional(),
  conflictPolicy: conflictPolicySchema.optional(),
  isEnabled: z.boolean().optional(),
  mapping: dataMappingSchema.optional(),
})

export const previewSchema = z.object({
  spreadsheetId: z.string().min(1).transform(extractSpreadsheetId),
  sheetTitle: z.string().min(1).optional(),
  sheetGid: z.coerce.number().int().optional(),
  headerRow: z.coerce.number().int().positive().optional(),
  keyColumn: z.string().optional(),
  entityType: z.string().optional(),
})

export const runSchema = z.object({
  entityType: z.string().min(1),
  direction: directionSchema.optional(),
})

export type SheetBindingPayload = z.infer<typeof sheetBindingSchema>
export type PreviewPayload = z.infer<typeof previewSchema>
export type RunPayload = z.infer<typeof runSchema>
