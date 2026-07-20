import {
  buildIntegrationDetailWidgetSpotId,
  type IntegrationBundle,
  type IntegrationDefinition,
} from '@open-mercato/shared/modules/integrations/types'

export const syncGoogleSheetsDetailWidgetSpotId = buildIntegrationDetailWidgetSpotId('sync_google_sheets')

export const integration: IntegrationDefinition = {
  id: 'sync_google_sheets',
  title: 'Google Sheets',
  description:
    'Import, schedule, and bidirectionally sync Google Sheets with Open Mercato entities. OAuth2 connection, per-tenant refresh tokens, pluggable per-entity writers.',
  category: 'data_sync',
  hub: 'data_sync',
  providerKey: 'google_sheets',
  icon: 'sheet',
  docsUrl: 'https://developers.google.com/sheets/api',
  package: '@northbound-run/sync-google-sheets',
  version: '0.1.0',
  author: 'Northbound',
  company: 'Northbound',
  license: 'MIT',
  tags: ['google', 'sheets', 'spreadsheet', 'data_sync', 'import', 'export', 'oauth2'],
  detailPage: {
    widgetSpotId: syncGoogleSheetsDetailWidgetSpotId,
  },
  defaultState: { isEnabled: false },
  // The OAuth *app* client id/secret default to env (GOOGLE_SHEETS_OAUTH_CLIENT_ID/_SECRET);
  // these optional credential fields let a tenant override with their own Google Cloud app.
  // The per-tenant refresh/access tokens are stored by the OAuth callback, not entered here.
  credentials: {
    fields: [
      {
        key: 'clientId',
        label: 'OAuth Client ID (optional override)',
        type: 'text',
        required: false,
        placeholder: '1234567890-abcdef.apps.googleusercontent.com',
        helpText:
          'Optional. Defaults to the GOOGLE_SHEETS_OAUTH_CLIENT_ID env var. Set only to use a per-tenant Google Cloud OAuth app.',
      },
      {
        key: 'clientSecret',
        label: 'OAuth Client Secret (optional override)',
        type: 'secret',
        required: false,
        helpText: 'Optional. Defaults to the GOOGLE_SHEETS_OAUTH_CLIENT_SECRET env var. Stored encrypted at rest.',
      },
      {
        key: 'scopes',
        label: 'OAuth Scopes (comma-separated, optional)',
        type: 'text',
        required: false,
        placeholder:
          'https://www.googleapis.com/auth/spreadsheets.readonly,https://www.googleapis.com/auth/drive.metadata.readonly',
        helpText:
          'Optional. Defaults to spreadsheets.readonly + drive.metadata.readonly + userinfo.email (import). Include https://www.googleapis.com/auth/spreadsheets to enable export, then reconnect.',
      },
      // Service-account auth (app-owned sheets): fill these INSTEAD of the OAuth fields. When a
      // client email + private key are present the adapter uses the service account and skips
      // the OAuth connect flow entirely. The target spreadsheet must be shared with this email.
      {
        key: 'clientEmail',
        label: 'Service account email (optional — app-owned sheets)',
        type: 'text',
        required: false,
        placeholder: 'sync@my-project.iam.gserviceaccount.com',
        helpText:
          'Optional. Use a Google service account instead of OAuth. Share the target spreadsheet with this address, then provide this together with the private key to switch this integration to service-account auth.',
      },
      {
        key: 'privateKey',
        label: 'Service account private key (PEM, optional)',
        type: 'secret',
        required: false,
        helpText:
          "Optional. The service account key's private_key (PEM, including the BEGIN/END lines). Stored encrypted. Required alongside the email to use service-account auth.",
      },
    ],
  },
  healthCheck: { service: 'googleSheetsHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined
