import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { buildCommandContext } from './command-context'
import type { EntityWriter, NormalizedRecord, SyncScope, WriterContext } from './types'

// Generic command-bus writer. Open Mercato has no generic "upsert any entity" command, so
// a writer must still know the concrete command ids and how to shape their input for its
// entity. This factory owns the shared plumbing — id-mapping lookup for create-vs-update,
// command context, execution — and takes per-entity mapping as configuration. The bundled
// customers.person writer is built on top of it; downstream teams build their own the same
// way and registerWriter() from their module's di.ts.

export type CommandExecutionResult = { result?: Record<string, unknown> } & Record<string, unknown>

export type CommandBusWriterConfig = {
  entityType: string
  /** Defaults to the convention `<module>.<pluralEntity>.create` (see guessCommandIds). */
  createCommand?: string
  updateCommand?: string
  buildCreateInput: (record: NormalizedRecord, scope: SyncScope) => Record<string, unknown>
  buildUpdateInput: (localId: string, record: NormalizedRecord, scope: SyncScope) => Record<string, unknown>
  /** Pull the created entity's local id out of the command result. */
  extractLocalId?: (result: CommandExecutionResult) => string | null
  /** Optional secondary dedupe (e.g. by email) when id-mapping has no hit. */
  resolveExistingLocalId?: (record: NormalizedRecord, ctx: WriterContext) => Promise<string | null>
  /**
   * Optional read() for export / bidirectional: given a local id, return the entity's current
   * content as a NormalizedRecord. MUST surface fields in the same normalized shape upsert()
   * consumes (see the normalization contract in lib/conflict-detection.ts) so content hashes
   * are comparable across sync directions. When omitted, the writer has no read() and export
   * throws for its entity type.
   */
  readRecord?: (localId: string, ctx: WriterContext) => Promise<NormalizedRecord | null>
  /**
   * Optional field canonicalization (see EntityWriter.normalize). Applied by the sync engine
   * before hashing so both sync directions compare equal content equally. Must be idempotent.
   */
  normalizeFields?: (fields: Record<string, unknown>) => Record<string, unknown>
}

function pluralizeEntity(entity: string): string {
  if (entity === 'person') return 'people'
  if (/[^aeiou]y$/.test(entity)) return `${entity.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(entity)) return `${entity}es`
  return `${entity}s`
}

/**
 * Best-effort command-id convention: `customers.person` -> `customers.people.{create,update}`.
 * This is a convenience default only; supply explicit command ids when the convention
 * doesn't hold.
 */
export function guessCommandIds(entityType: string): { create: string; update: string } {
  const dot = entityType.indexOf('.')
  const moduleId = dot >= 0 ? entityType.slice(0, dot) : ''
  const entity = dot >= 0 ? entityType.slice(dot + 1) : entityType
  const plural = pluralizeEntity(entity)
  const prefix = moduleId ? `${moduleId}.${plural}` : plural
  return { create: `${prefix}.create`, update: `${prefix}.update` }
}

function defaultExtractLocalId(result: CommandExecutionResult): string | null {
  const inner = (result?.result ?? result) as Record<string, unknown> | undefined
  if (!inner) return null
  const candidate = inner.entityId ?? inner.id ?? inner.localId
  return typeof candidate === 'string' ? candidate : null
}

export function createCommandBusWriter(config: CommandBusWriterConfig): EntityWriter {
  const guessed = guessCommandIds(config.entityType)
  const createCommand = config.createCommand ?? guessed.create
  const updateCommand = config.updateCommand ?? guessed.update
  const extractLocalId = config.extractLocalId ?? defaultExtractLocalId

  const writer: EntityWriter = {
    entityType: config.entityType,
    async upsert(record, ctx) {
      const commandBus = ctx.container.resolve('commandBus') as CommandBus
      const externalIdMappingService = ctx.container.resolve('externalIdMappingService') as {
        lookupLocalId: (
          integrationId: string,
          entityType: string,
          externalId: string,
          scope: SyncScope,
        ) => Promise<string | null>
      }
      const commandContext = buildCommandContext(ctx.container, ctx.scope)

      let existingLocalId = await externalIdMappingService.lookupLocalId(
        ctx.integrationId,
        ctx.entityType,
        record.externalId,
        ctx.scope,
      )
      if (!existingLocalId && config.resolveExistingLocalId) {
        existingLocalId = await config.resolveExistingLocalId(record, ctx)
      }

      if (existingLocalId) {
        await commandBus.execute(updateCommand, {
          input: config.buildUpdateInput(existingLocalId, record, ctx.scope),
          ctx: commandContext,
        })
        return { id: existingLocalId, action: 'update' }
      }

      const result = (await commandBus.execute(createCommand, {
        input: config.buildCreateInput(record, ctx.scope),
        ctx: commandContext,
      })) as CommandExecutionResult
      const id = extractLocalId(result)
      if (!id) {
        throw new Error(
          `[internal] ${createCommand} did not return a local id for entity ${ctx.entityType}. Provide a custom extractLocalId.`,
        )
      }
      return { id, action: 'create' }
    },
  }
  if (config.readRecord) writer.read = config.readRecord
  if (config.normalizeFields) writer.normalize = config.normalizeFields
  return writer
}

/** Split `record.fields` into base values (bare keys) and custom fields (cf:-prefixed keys). */
export function splitFields(fields: Record<string, unknown>): {
  base: Record<string, unknown>
  customFields: Record<string, unknown>
} {
  const base: Record<string, unknown> = {}
  const customFields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('cf:')) {
      const bare = key.slice(3)
      if (bare) customFields[bare] = value
    } else {
      base[key] = value
    }
  }
  return { base, customFields }
}

/** Pick the first present, non-empty value among candidate keys (case/shape tolerant). */
export function pickField(base: Record<string, unknown>, candidates: string[]): string | null {
  for (const key of candidates) {
    const value = base[key]
    if (value === null || value === undefined) continue
    const text = typeof value === 'string' ? value.trim() : String(value)
    if (text.length > 0) return text
  }
  return null
}
