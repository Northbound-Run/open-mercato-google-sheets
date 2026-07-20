# @northbound-run/sync-google-sheets

A standalone Open Mercato Data Sync adapter that connects Google Sheets to any entity in your Open Mercato app. Import rows on demand, run them on a schedule, or keep a sheet and your entity store in sync bidirectionally — all without touching this package's source. The adapter is entity-agnostic: it delegates writes to a pluggable `EntityWriter` registry, so teams can support their own entity types from their own module's `di.ts` without forking the package.

The adapter ships in three increments: **Increment 1** (import + OAuth) is production-ready today. **Increment 2** adds scheduled sync by reusing the core `SyncSchedule` primitive. **Increment 3** completes the export and bidirectional path with per-row conflict policies — the export engine design is first-of-kind within the Data Sync framework.

---

## Requirements

- An Open Mercato app on `@open-mercato/core` **0.6.x** or later (the `data_sync` and `integrations` modules must be enabled)
- Node.js **24** or later (the package builds for the `node24` target and uses native `fetch` and other modern Node APIs)
- A Google Cloud project with an **OAuth 2.0 Client ID** (Web application type), the **Google Sheets API** enabled, and the **Google Drive API** enabled

---

## Install

### 1. Add the package

```bash
yarn add @northbound-run/sync-google-sheets
```

### 2. Register the module

Add one line to `src/modules.ts` in your Open Mercato app:

```ts
// src/modules.ts
import { enabledModules } from './modules-base'

export default [
  ...enabledModules,
  { id: 'sync_google_sheets', from: '@northbound-run/sync-google-sheets' },
]
```

### 3. Generate and migrate

Run these commands in a fresh container or terminal (not while the dev server is running the first time):

```bash
yarn generate
yarn db:migrate
```

`yarn generate` picks up the new module's entities, routes, and navigation entries. `yarn db:migrate` applies the migration the module ships, which creates two metadata tables — `sync_google_sheets_bindings` (one row per sheet↔entity binding) and `sync_google_sheets_content_hashes` (the echo-prevention sidecar for bidirectional sync). OAuth tokens are **not** stored in a module-owned table; they live in the framework's integration credential store (see [How It Works](#how-it-works)).

---

## Google OAuth Setup

### Create an OAuth 2.0 Client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select your project (or create one).
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
3. Choose **Web application**.
4. Under **Authorized redirect URIs** add:
   ```
   https://<your-app-origin>/api/sync_google_sheets/oauth/callback
   ```
   For local development also add:
   ```
   http://localhost:3000/api/sync_google_sheets/oauth/callback
   ```
5. Copy the **Client ID** and **Client Secret** — you will need them for the environment variables below.

### Enable APIs

In **APIs & Services → Library**, enable:
- **Google Sheets API**
- **Google Drive API** (used to resolve spreadsheet metadata and list available sheets)

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_SHEETS_OAUTH_CLIENT_ID` | Yes | OAuth 2.0 Client ID from Google Cloud Console |
| `GOOGLE_SHEETS_OAUTH_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret |
| `GOOGLE_SHEETS_OAUTH_REDIRECT_URI` | Yes | Must match the redirect URI registered in Google Cloud Console (e.g. `https://app.example.com/api/sync_google_sheets/oauth/callback`) |
| `GOOGLE_SHEETS_OAUTH_SCOPES` | No | Space-separated OAuth scopes. Defaults to `https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/userinfo.email` which is sufficient for import. To enable export or bidirectional sync, add `https://www.googleapis.com/auth/spreadsheets` and prompt the connected user to re-consent. |
| `OM_GOOGLE_SHEETS_REQUEST_TIMEOUT_MS` | No | Per-request HTTP timeout in milliseconds when calling the Sheets API. Default: `30000` (30 s). |
| `OM_GOOGLE_SHEETS_MAX_RETRIES` | No | Maximum number of automatic retries on transient network errors or 429/503 responses. Default: `3`. |
| `OM_GOOGLE_SHEETS_RETRY_CAP_MS` | No | Maximum back-off ceiling for retries in milliseconds. Default: `8000` (8 s). |
| `OM_OAUTH_TOKEN_TIMEOUT_MS` | No | Timeout for the OAuth token exchange and refresh requests. Default: `10000` (10 s). |

---

## Configuration

Once installed, navigate to **Settings → Integrations → Google Sheets Sync** in your app's admin panel.

### 1. Connect a Google account

Click **Connect Google Account**. You will be redirected to Google's OAuth consent screen. After granting access you are redirected back and the module stores the encrypted OAuth tokens via the framework's integration credential service (`integrationCredentialsService`), encrypted with the app's tenant-data-encryption key — never in plaintext, and never in a module-owned table.

A status chip shows **Connected as user@example.com** when the token is valid. If the token is revoked or expired the chip shows **Reconnect required** — click **Reconnect** to re-initiate the OAuth flow without losing your sheet bindings.

### 2. Create an integration (sheet binding)

Click **New integration** and fill in:

| Field | Description |
|---|---|
| **Spreadsheet ID or URL** | Paste the full Google Sheets URL or just the bare spreadsheet ID from the URL (`/d/<id>/`). |
| **Tab** | The sheet tab name exactly as it appears in the workbook (case-sensitive). |
| **Header row** | The row number containing column headers. Usually `1`. |
| **Data start row** | The first row of data beneath the header. Usually `2`. |
| **Key column** | The column header whose value uniquely identifies each record. Its value becomes the record's external ID — used for upsert matching and recorded in the `sync_google_sheets_content_hashes` sidecar for echo prevention. |
| **Target entity type** | The Open Mercato entity type this sheet maps to (e.g. `customers.person`). An `EntityWriter` for this type must be registered. |
| **Direction** | `Import only`, `Export only`, or `Bidirectional`. **Import is production-ready; Export and Bidirectional are experimental and not yet validated end-to-end** — they also require the `spreadsheets` write scope (see [Environment Variables](#environment-variables)). Use them only against non-critical data. |
| **Conflict policy** | How the adapter resolves a row that has changed on both sides since the last run. See options below. |

### 3. Confirm the column mapping

After saving the basic config, click **Preview mapping**. The adapter reads the header row from the sheet and suggests a `sheet column → Open Mercato field` mapping based on name similarity. Review and adjust, then click **Save mapping**.

### 4. Run or schedule

- Click **Run import now** to trigger a one-shot import immediately.
- Enable **Scheduled sync** and pick a frequency (hourly / daily / weekly / custom cron) to have the core `SyncSchedule` worker run the import automatically. *(Scheduled sync is Increment 2 — in progress; see [Increment Status](#increment-status).)*

### Conflict policies

Conflict policies apply only to **Bidirectional** sync (experimental). A conflict arises when a row changed on *both* sides since the last run; otherwise the changed side is applied cleanly. The value in parentheses is what is stored in `sync_google_sheets_bindings.conflict_policy`.

| Policy (stored value) | Behaviour |
|---|---|
| **Source wins** (`sheet-wins`) | The sheet value overwrites the local record. |
| **Local wins** (`mercato-wins`) | The local record is kept; the conflicting sheet row is skipped for this run. |
| **Newest wins** (`last-write-wins`, default) | The most recently modified side is kept. Google Sheets exposes only a file-level `modifiedTime`, so when timestamps are missing or equal the adapter flags the row rather than guessing. |
| **Manual review** (`flag-for-review`) | The conflict is flagged and neither side is written until a human resolves it from the admin UI. |

---

## Writing a Custom EntityWriter

The adapter is entity-agnostic by design. It does not know how to write a `customers.person` or a `catalog.product` — that knowledge lives in your domain module. You teach the adapter by registering an `EntityWriter`.

### The interface

```ts
// From @northbound-run/sync-google-sheets
import type {
  EntityWriter,
  NormalizedRecord,
  WriterContext,
  WriterAction,
} from '@northbound-run/sync-google-sheets'

export const myPersonWriter: EntityWriter = {
  /** Must match the "Target entity type" configured in the admin UI. */
  entityType: 'customers.person',

  /**
   * Upsert a normalized record. The adapter calls this once per sheet row.
   * Return the local entity ID and the action taken so the run log can report
   * created / updated / skipped counts.
   */
  async upsert(
    record: NormalizedRecord,
    ctx: WriterContext,
  ): Promise<{ id: string; action: WriterAction }> {
    const { em, scope } = ctx
    // record.externalId  — value of the key column
    // record.fields      — mapped local fields (bare keys + cf:<key> for custom fields)
    // record.raw         — the full raw row keyed by header, if you need extra columns

    // ... your upsert logic here ...

    return { id: entity.id, action: 'create' }
  },

  /**
   * Optional: read a local record for export.
   * If omitted, the adapter falls back to the query engine's read path.
   */
  async read(localId: string, ctx: WriterContext): Promise<NormalizedRecord | null> {
    // ... your read logic here ...
    return null
  },
}
```

### Registering the writer

Call `registerWriter` from your module's `di.ts`. The function is idempotent — registering the same `entityType` twice replaces the earlier registration.

```ts
// src/di.ts  (or src/modules/<your_module>/di.ts)
import { registerWriter } from '@northbound-run/sync-google-sheets'
import { myPersonWriter } from './modules/my_module/writers/person-writer'

export function registerDi() {
  registerWriter(myPersonWriter)
}
```

### Bundled writers

The package ships one ready-to-register writer plus the factory it is built on:

- **`customers.person`** (`customersPersonWriter`) — A thin writer for the `@open-mercato/core` customers module. Maps common columns (`first_name`, `last_name`, `email`, `phone`) and falls back gracefully for unknown columns by writing them as custom fields. The module's own `di.ts` registers it automatically on load.
- **`createCommandBusWriter(config)`** — The generic factory the `customers.person` writer is built on. It dispatches your module's create / update commands on the Open Mercato command bus, letting any module own persistence. Use it as the starting point for your own entity types.

`bundledWriters` is the array of ready-to-register instances (currently just `customersPersonWriter`). Register them explicitly if you have disabled auto-registration or simply want to be explicit:

```ts
import { bundledWriters } from '@northbound-run/sync-google-sheets/writers'
import { registerWriter } from '@northbound-run/sync-google-sheets'

bundledWriters.forEach(registerWriter)
```

---

## Increment Status

| Increment | What it covers | Status |
|---|---|---|
| **1 — Import + OAuth** | OAuth flow, encrypted token storage, one-shot import, column mapping preview, run log | Production-ready |
| **2 — Scheduled sync** | Provided by the core `data_sync` scheduler — this integration automatically gets a **Sync schedules** tab (cron/interval, next-run). Fired schedules create the same import run as *Run import now*. Requires the app to run the `data_sync` queue + scheduler workers. | **Available via core** (import path production-ready; scheduled runs not independently validated here) |
| **3 — Export + Bidirectional** | Writes from Open Mercato back to the sheet; conflict policy enforcement; bidirectional run loop; the export engine path is first-of-kind within the Data Sync framework | Experimental — code shipped, not yet validated |

> ⚠️ **Export and Bidirectional (Increment 3) are experimental.** The write-back / export path ships and is selectable in the config UI, but has **not** been validated end-to-end against a live sheet. Treat it as a preview and use it only against non-critical data until it is marked production-ready.

---

## Publishing

This package is scoped to `@northbound-run/` and publishes to the public npm registry — `publishConfig.access` is `"public"` in `package.json`, so anyone can install it without an npm auth token.

To publish to a private registry instead, set `publishConfig.registry` to your registry URL (Verdaccio, GitHub Packages, AWS CodeArtifact, etc.) and change `access` back to `"restricted"`.

`dist/` is `.gitignore`d (not tracked in the working tree) but **is** shipped in the published tarball: the `files` field lists `dist` and `src`, and the `prepack` script runs the esbuild build (`build.mjs`) automatically before `npm pack` / `npm publish`, so a fresh `dist/` is always included. The raw `src/*.ts` ships too because the `exports` map resolves TypeScript types from source.

---

## How It Works

`@northbound-run/sync-google-sheets` registers a Data Sync **adapter** with `providerKey: "google_sheets"` in the Open Mercato `data_sync` hub. When the hub triggers a run, the adapter:

1. Resolves the OAuth token for the connected account (decrypting it with the tenant DEK).
2. Calls the Google Sheets API via **raw `fetch`** — no `googleapis` SDK, no dependency on `@open-mercato/channel-gmail` or any other package that bundles Google credentials. This keeps the package lean and avoids version coupling.
3. Parses the response into `NormalizedRecord` objects using the saved column→field mapping.
4. Calls the registered `EntityWriter.upsert()` for each row and accumulates create / update / skip counts.
5. Records the run outcome (timestamp, created / updated / skipped counts, any per-row errors) through the core Data Sync run log.

For export (Increment 3), the flow reverses: the adapter calls `EntityWriter.read()` (or the query engine) for each local record, maps fields back to sheet columns, and writes via the Sheets API `batchUpdate` endpoint.

OAuth tokens are stored encrypted through the framework's integration credential service (`integrationCredentialsService`), keyed by the integration id — not in a module-owned table — using the same tenant-data-encryption key store as the rest of the framework. Set `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` for local development and connect a KMS provider (Vault by default) for production.
