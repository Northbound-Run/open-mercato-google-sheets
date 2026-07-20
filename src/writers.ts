// Optional bundled EntityWriters, importable as `@northbound-run/sync-google-sheets/writers`.
//
// The module's own di.ts already registers `customersPersonWriter` when the module loads, so
// you only need these when you want to register the bundled writers explicitly, or to build
// your own writer on top of the generic command-bus factory:
//
//   import { bundledWriters } from '@northbound-run/sync-google-sheets/writers'
//   import { registerWriter } from '@northbound-run/sync-google-sheets'
//   bundledWriters.forEach(registerWriter)

import type { EntityWriter } from './modules/sync_google_sheets/lib/writers/types'
import { customersPersonWriter } from './modules/sync_google_sheets/lib/writers/customers-person'

export { customersPersonWriter }
export {
  createCommandBusWriter,
  guessCommandIds,
  splitFields,
  pickField,
} from './modules/sync_google_sheets/lib/writers/command-bus-writer'
export type {
  CommandBusWriterConfig,
  CommandExecutionResult,
} from './modules/sync_google_sheets/lib/writers/command-bus-writer'

/**
 * Ready-to-register writers bundled with the package. Currently just the `customers.person`
 * writer — the generic command-bus writer is exposed as the `createCommandBusWriter` factory
 * (it needs an entity type + command config, so it is not a pre-built instance).
 */
export const bundledWriters: EntityWriter[] = [customersPersonWriter]
