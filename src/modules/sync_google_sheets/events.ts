import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  {
    id: 'sync_google_sheets.run.completed',
    label: 'Google Sheets sync run completed',
    category: 'system',
  },
  {
    id: 'sync_google_sheets.run.failed',
    label: 'Google Sheets sync run failed',
    category: 'system',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'sync_google_sheets', events })
export const emitSyncGoogleSheetsEvent = eventsConfig.emit
export type SyncGoogleSheetsEventId = (typeof events)[number]['id']

export default eventsConfig
