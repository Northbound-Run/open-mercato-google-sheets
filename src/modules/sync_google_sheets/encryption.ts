import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

// This module's own tables (sync_google_sheets_bindings, sync_google_sheets_content_hashes)
// hold only sync metadata — spreadsheet ids, tab names, column names, content hashes — not
// PII. The business/PII data is written into target entities (e.g. customers.person), which
// declare their own encryption maps. Declared per the framework convention; add field maps
// here if a future module-owned table stores personal or GDPR-relevant data.
export const defaultEncryptionMaps: ModuleEncryptionMap[] = []

export default defaultEncryptionMaps
