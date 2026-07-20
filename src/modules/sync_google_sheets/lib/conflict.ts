// Pluggable conflict strategies for bidirectional sync (Increment 3).
//
// A conflict exists only when a record changed on BOTH sides since the last sync. The
// adapter passes the change flags (and, where available, modification timestamps) and
// the direction of the pending write; this pure resolver decides whether to apply the
// write, skip it, or flag it for review. Strategy is per-integration config.
//
// Note: Google Sheets has no per-row/per-cell modification time — only file-level Drive
// `modifiedTime`. So `last-write-wins` timestamps are coarse; when they can't decide, the
// resolver defaults to flagging rather than silently overwriting the wrong side.

export type ConflictPolicy = 'last-write-wins' | 'sheet-wins' | 'mercato-wins' | 'flag-for-review'
export type SyncSide = 'sheet' | 'mercato'
export type ConflictOutcome = 'apply' | 'skip' | 'flag'

export type ConflictResolution = {
  outcome: ConflictOutcome
  winner: SyncSide | null
  reason: string
}

export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = 'last-write-wins'

export function isConflictPolicy(value: unknown): value is ConflictPolicy {
  return (
    value === 'last-write-wins' ||
    value === 'sheet-wins' ||
    value === 'mercato-wins' ||
    value === 'flag-for-review'
  )
}

function opposite(side: SyncSide): SyncSide {
  return side === 'sheet' ? 'mercato' : 'sheet'
}

/**
 * Resolve a pending write against the configured policy.
 *
 * @param writingTo   the target side of the pending write (import -> 'mercato', export -> 'sheet')
 * @param sourceChanged   did the source side (opposite of writingTo) change since last sync?
 * @param targetChanged   did the target side change since last sync?
 * @param sourceModifiedAt / targetModifiedAt   epoch-ms timestamps, when known (for LWW)
 * @param lwwTiebreak   what LWW does when timestamps are missing/equal (default: 'flag')
 */
export function resolveConflict(params: {
  policy: ConflictPolicy
  writingTo: SyncSide
  sourceChanged: boolean
  targetChanged: boolean
  sourceModifiedAt?: number | null
  targetModifiedAt?: number | null
  lwwTiebreak?: SyncSide | 'flag'
}): ConflictResolution {
  const { policy, writingTo, sourceChanged, targetChanged } = params
  const source = opposite(writingTo)
  const target = writingTo

  // No source change: nothing new to propagate.
  if (!sourceChanged) {
    return { outcome: 'skip', winner: null, reason: 'source-unchanged' }
  }

  // Source changed but target did not: clean one-way update, no conflict.
  if (!targetChanged) {
    return { outcome: 'apply', winner: source, reason: 'no-conflict' }
  }

  // Both sides changed: apply the configured policy.
  switch (policy) {
    case 'flag-for-review':
      return { outcome: 'flag', winner: null, reason: 'both-changed:flag-for-review' }
    case 'sheet-wins':
      return {
        outcome: source === 'sheet' ? 'apply' : 'skip',
        winner: 'sheet',
        reason: 'both-changed:sheet-wins',
      }
    case 'mercato-wins':
      return {
        outcome: source === 'mercato' ? 'apply' : 'skip',
        winner: 'mercato',
        reason: 'both-changed:mercato-wins',
      }
    case 'last-write-wins': {
      const s = params.sourceModifiedAt
      const t = params.targetModifiedAt
      if (typeof s === 'number' && typeof t === 'number' && s !== t) {
        const winner: SyncSide = s > t ? source : target
        return {
          outcome: winner === source ? 'apply' : 'skip',
          winner,
          reason: 'both-changed:last-write-wins',
        }
      }
      // Timestamps missing or equal — cannot safely decide.
      const tiebreak = params.lwwTiebreak ?? 'flag'
      if (tiebreak === 'flag') {
        return { outcome: 'flag', winner: null, reason: 'both-changed:lww-indeterminate' }
      }
      return {
        outcome: tiebreak === source ? 'apply' : 'skip',
        winner: tiebreak,
        reason: 'both-changed:lww-tiebreak',
      }
    }
    default:
      return { outcome: 'flag', winner: null, reason: 'unknown-policy' }
  }
}
