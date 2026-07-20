import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { registerDataSyncAdapter } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'
import { googleSheetsAdapter } from './lib/adapter'
import { googleSheetsHealthCheck } from './lib/health'
import { registerWriter } from './lib/writers/registry'
import { customersPersonWriter } from './lib/writers/customers-person'

export function register(container: AppContainer) {
  // Register the Data Sync adapter (keyed by providerKey 'google_sheets').
  registerDataSyncAdapter(googleSheetsAdapter)

  // Register bundled EntityWriters. Downstream modules register their own writers the same
  // way from their di.ts; last registration for an entity type wins.
  registerWriter(customersPersonWriter)

  container.register({
    googleSheetsHealthCheck: asValue(googleSheetsHealthCheck),
  })
}
