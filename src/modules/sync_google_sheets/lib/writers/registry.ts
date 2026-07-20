import type { EntityWriter } from './types'

// In-memory writer registry, mirroring the framework's own data-sync adapter registry
// (a keyed Map). Writers register at module load time from a module's di.ts. Resolution
// is by exact `entityType`. The registry is process-wide and idempotent per entity type
// (last registration wins), so a downstream app can override a bundled writer by
// registering its own for the same entity type.

const writers = new Map<string, EntityWriter>()

export function registerWriter(writer: EntityWriter): void {
  if (!writer || typeof writer.entityType !== 'string' || writer.entityType.length === 0) {
    throw new Error('registerWriter: writer must have a non-empty entityType')
  }
  writers.set(writer.entityType, writer)
}

export function getWriter(entityType: string): EntityWriter | undefined {
  return writers.get(entityType)
}

export function requireWriter(entityType: string): EntityWriter {
  const writer = writers.get(entityType)
  if (!writer) {
    const known = listWriterEntityTypes()
    throw new Error(
      `No EntityWriter registered for "${entityType}". Registered writers: ${
        known.length ? known.join(', ') : '(none)'
      }. Register one from your module's di.ts via registerWriter(...).`,
    )
  }
  return writer
}

export function listWriterEntityTypes(): string[] {
  return [...writers.keys()].sort()
}

/** Test-only: reset the registry between unit tests. */
export function clearWriters(): void {
  writers.clear()
}
