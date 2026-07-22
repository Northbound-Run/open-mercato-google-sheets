import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { registerDataSyncAdapter } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'
import { googleSheetsAdapter } from './lib/adapter'
import { googleSheetsHealthCheck } from './lib/health'
import { registerWriter } from './lib/writers/registry'
import { customersPersonWriter } from './lib/writers/customers-person'

function registerModuleIntegrations(): void {
  // Register the Data Sync adapter (keyed by providerKey 'google_sheets').
  registerDataSyncAdapter(googleSheetsAdapter)

  // Register bundled EntityWriters. Downstream modules register their own writers the same
  // way from their di.ts; last registration for an entity type wins.
  registerWriter(customersPersonWriter)
}

// Import-time, not just di.register()-time: data-sync runs execute in separate queue-worker
// processes (`mercato queue worker`) whose container bootstrap may not replay every module's
// di.register() — but the app's generated DI registry always *imports* this module, so an
// import-time side effect is the only registration path guaranteed to run in every process.
// Both registries are keyed maps, so the repeat call inside register() is a harmless no-op.
registerModuleIntegrations()

export function register(container: AppContainer) {
  registerModuleIntegrations()

  container.register({
    googleSheetsHealthCheck: asValue(googleSheetsHealthCheck),
  })
}
