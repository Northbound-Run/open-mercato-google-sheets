import { Migration } from '@mikro-orm/migrations'

export class Migration20260716120000_sync_google_sheets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "sync_google_sheets_bindings" ("id" uuid not null default gen_random_uuid(), "integration_id" text not null, "entity_type" text not null, "spreadsheet_id" text not null, "sheet_title" text not null, "sheet_gid" int null, "header_row" int not null default 1, "data_start_row" int not null default 2, "key_column" text not null, "direction" text not null default 'import', "conflict_policy" text not null default 'last-write-wins', "is_enabled" boolean not null default true, "last_synced_at" timestamptz null, "last_head_revision_id" text null, "organization_id" uuid not null, "tenant_id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "sync_google_sheets_bindings_pkey" primary key ("id"));`)
    this.addSql(`create unique index "sync_gsheets_binding_scope_uniq" on "sync_google_sheets_bindings" ("integration_id", "entity_type", "organization_id", "tenant_id");`)

    this.addSql(`create table "sync_google_sheets_content_hashes" ("id" uuid not null default gen_random_uuid(), "integration_id" text not null, "entity_type" text not null, "external_id" text not null, "direction" text not null, "content_hash" text not null, "written_at" timestamptz not null, "organization_id" uuid not null, "tenant_id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "sync_google_sheets_content_hashes_pkey" primary key ("id"));`)
    this.addSql(`create unique index "sync_gsheets_hash_scope_uniq" on "sync_google_sheets_content_hashes" ("integration_id", "entity_type", "external_id", "direction", "organization_id", "tenant_id");`)
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "sync_google_sheets_bindings" cascade;`)
    this.addSql(`drop table if exists "sync_google_sheets_content_hashes" cascade;`)
  }
}
