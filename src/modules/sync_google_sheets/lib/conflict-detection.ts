import { resolveConflict, type ConflictOutcome, type ConflictPolicy, type SyncSide } from './conflict'

// Turns three content hashes (baseline + both current sides) into a sync decision by
// deriving per-side change flags and delegating to the pure `resolveConflict` policy engine.
//
// The "baseline" is the content hash both sides shared at the last successful sync — the
// common ancestor. A side "changed" when its current hash differs from that baseline. This
// is what makes conflict detection possible: without a baseline you cannot tell which side
// moved, only that they now differ.
//
// IMPORTANT (canonical-normalization contract): the hashes for both sides must be computed
// over the SAME normalized field representation. An EntityWriter's read() must therefore
// return fields in the same shape upsert() consumes (same keys, same value canonicalization
// — e.g. if upsert lowercases email, read() must surface the lowercased email). Otherwise a
// round-trip that changed nothing will hash differently and register as a false conflict.

export type SyncDecisionInput = {
  policy: ConflictPolicy
  /** The side this write targets: 'mercato' for an import row, 'sheet' for an export row. */
  writingTo: SyncSide
  /** Content hash both sides shared at the last successful sync; null if never synced. */
  baselineHash: string | null
  /** Current content hash of the source side (the side being read FROM). */
  sourceHash: string
  /** Current content hash of the target side; null when the target has no record/row yet. */
  targetHash: string | null
}

export type SyncDecision = {
  outcome: ConflictOutcome // 'apply' | 'skip' | 'flag'
  reason: string
  /**
   * The hash to store as the new baseline after handling this row, or null to leave the
   * baseline untouched. Set only when the two sides are (or become) equal — i.e. after an
   * applied write, or when they were already identical.
   */
  nextBaseline: string | null
}

/** Decide whether to apply, skip, or flag a pending one-directional write for one record. */
export function decideSync(input: SyncDecisionInput): SyncDecision {
  const { policy, writingTo, baselineHash, sourceHash, targetHash } = input

  // Target has no record/row yet — nothing to conflict with, so create it.
  if (targetHash === null) {
    return { outcome: 'apply', reason: 'new-target', nextBaseline: sourceHash }
  }

  // No baseline yet (first sync of a pair that already exists on both sides): no common
  // ancestor to diff against.
  if (baselineHash === null) {
    if (sourceHash === targetHash) {
      // Already identical — just establish the baseline, no write needed.
      return { outcome: 'skip', reason: 'already-in-sync', nextBaseline: sourceHash }
    }
    // Differing content with no shared ancestor → treat as a genuine two-sided conflict.
    const res = resolveConflict({ policy, writingTo, sourceChanged: true, targetChanged: true })
    return {
      outcome: res.outcome,
      reason: `no-baseline:${res.reason}`,
      nextBaseline: res.outcome === 'apply' ? sourceHash : null,
    }
  }

  const sourceChanged = sourceHash !== baselineHash
  const targetChanged = targetHash !== baselineHash
  const res = resolveConflict({
    policy,
    writingTo,
    sourceChanged,
    targetChanged,
    // Per-row modification times aren't available (Google Sheets exposes only a file-level
    // Drive modifiedTime, and NormalizedRecord carries no updatedAt), so last-write-wins
    // falls back to its documented safe default: flag genuine two-sided conflicts.
    sourceModifiedAt: null,
    targetModifiedAt: null,
  })

  // Advance the baseline when the sides are (or become) equal: after an applied source write
  // both sides equal sourceHash; when nothing changed on either side the current baseline
  // still holds. A skip-because-the-other-side-won or a flag leaves the baseline untouched.
  let nextBaseline: string | null = null
  if (res.outcome === 'apply') nextBaseline = sourceHash
  else if (!sourceChanged && !targetChanged) nextBaseline = baselineHash

  return { outcome: res.outcome, reason: res.reason, nextBaseline }
}
