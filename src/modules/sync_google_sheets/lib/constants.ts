// Framework-free constants. Kept separate from config.ts (which imports the ORM/encryption
// stack) so pure helpers — and their unit tests — can reference the integration id without
// pulling in the framework runtime. config.ts re-exports both for existing callers.

export const SYNC_GOOGLE_SHEETS_INTEGRATION_ID = 'sync_google_sheets'

export type BindingScope = { organizationId: string; tenantId: string }
