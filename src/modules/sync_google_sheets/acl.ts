// Feature-based RBAC for the Google Sheets sync module.
// Grant these in setup.ts `defaultRoleFeatures`; gate routes/pages/widgets with
// `requireFeatures`. Never use requireRoles. After changing this list, run
// `yarn mercato auth sync-role-acls` to reconcile existing tenants.
export type AclFeature = {
  id: string
  title: string
  module: string
  dependsOn?: string[]
}

export const features: AclFeature[] = [
  {
    id: 'sync_google_sheets.view',
    title: 'View Google Sheets sync integrations, status, and previews',
    module: 'sync_google_sheets',
  },
  {
    id: 'sync_google_sheets.connect',
    title: 'Connect and disconnect Google accounts (OAuth)',
    module: 'sync_google_sheets',
    dependsOn: ['sync_google_sheets.view'],
  },
  {
    id: 'sync_google_sheets.configure',
    title: 'Configure sheet bindings, column mappings, schedules, and conflict policy',
    module: 'sync_google_sheets',
    dependsOn: ['sync_google_sheets.view'],
  },
  {
    id: 'sync_google_sheets.run',
    title: 'Trigger and manage Google Sheets sync runs',
    module: 'sync_google_sheets',
    dependsOn: ['sync_google_sheets.view'],
  },
]

export default features
