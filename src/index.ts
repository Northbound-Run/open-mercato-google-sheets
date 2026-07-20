export { metadata } from './modules/sync_google_sheets/index'

// Public EntityWriter API. Register your own writers from your module's di.ts — see the
// "Writing a Custom EntityWriter" section of the README.
export {
  registerWriter,
  getWriter,
  requireWriter,
  listWriterEntityTypes,
} from './modules/sync_google_sheets/lib/writers/registry'
export type {
  EntityWriter,
  NormalizedRecord,
  WriterContext,
  WriterAction,
  SyncScope,
} from './modules/sync_google_sheets/lib/writers/types'
