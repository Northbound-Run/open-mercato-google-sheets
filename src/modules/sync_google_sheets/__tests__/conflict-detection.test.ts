import { decideSync, type SyncDecisionInput } from '../lib/conflict-detection'
import type { ConflictPolicy } from '../lib/conflict'

const A = 'hash-A'
const B = 'hash-B'
const C = 'hash-C'

function decide(partial: Partial<SyncDecisionInput>): ReturnType<typeof decideSync> {
  return decideSync({
    policy: 'flag-for-review',
    writingTo: 'mercato',
    baselineHash: A,
    sourceHash: A,
    targetHash: A,
    ...partial,
  })
}

describe('decideSync — new / unsynced targets', () => {
  it('applies and seeds the baseline when the target has no record yet', () => {
    const d = decide({ targetHash: null, baselineHash: null, sourceHash: B })
    expect(d).toEqual({ outcome: 'apply', reason: 'new-target', nextBaseline: B })
  })

  it('applies for a new target even if a stale baseline somehow exists', () => {
    const d = decide({ targetHash: null, baselineHash: A, sourceHash: B })
    expect(d.outcome).toBe('apply')
    expect(d.nextBaseline).toBe(B)
  })
})

describe('decideSync — no baseline (first sync of an existing pair)', () => {
  it('skips and seeds the baseline when both sides are already identical', () => {
    const d = decide({ baselineHash: null, sourceHash: B, targetHash: B })
    expect(d).toEqual({ outcome: 'skip', reason: 'already-in-sync', nextBaseline: B })
  })

  it('treats differing content with no ancestor as a conflict (flag-for-review → flag)', () => {
    const d = decide({ baselineHash: null, sourceHash: B, targetHash: C, policy: 'flag-for-review' })
    expect(d.outcome).toBe('flag')
    expect(d.reason).toContain('no-baseline')
    expect(d.nextBaseline).toBeNull()
  })

  it('no ancestor + sheet-wins + importing (source=sheet) → applies the sheet', () => {
    const d = decide({
      baselineHash: null,
      sourceHash: B,
      targetHash: C,
      policy: 'sheet-wins',
      writingTo: 'mercato', // source side is the sheet
    })
    expect(d.outcome).toBe('apply')
    expect(d.nextBaseline).toBe(B)
  })

  it('no ancestor + sheet-wins + exporting (source=mercato) → skips (sheet target wins)', () => {
    const d = decide({
      baselineHash: null,
      sourceHash: B,
      targetHash: C,
      policy: 'sheet-wins',
      writingTo: 'sheet', // source side is mercato
    })
    expect(d.outcome).toBe('skip')
    expect(d.nextBaseline).toBeNull()
  })
})

describe('decideSync — with a baseline', () => {
  it('skips (and re-affirms the baseline) when neither side changed', () => {
    const d = decide({ baselineHash: A, sourceHash: A, targetHash: A })
    expect(d.outcome).toBe('skip')
    expect(d.nextBaseline).toBe(A)
  })

  it('applies when only the source changed (clean one-way update)', () => {
    const d = decide({ baselineHash: A, sourceHash: B, targetHash: A })
    expect(d.outcome).toBe('apply')
    expect(d.nextBaseline).toBe(B)
  })

  it('skips when only the target changed (nothing new on the source to propagate)', () => {
    const d = decide({ baselineHash: A, sourceHash: A, targetHash: B })
    expect(d.outcome).toBe('skip')
    expect(d.nextBaseline).toBeNull()
  })

  describe('both sides changed', () => {
    const bothChanged: Partial<SyncDecisionInput> = { baselineHash: A, sourceHash: B, targetHash: C }

    it('flag-for-review → flag', () => {
      expect(decide({ ...bothChanged, policy: 'flag-for-review' }).outcome).toBe('flag')
    })

    it('last-write-wins → flag (no per-row timestamps available)', () => {
      expect(decide({ ...bothChanged, policy: 'last-write-wins' }).outcome).toBe('flag')
    })

    it('sheet-wins while importing (source=sheet) → apply', () => {
      const d = decide({ ...bothChanged, policy: 'sheet-wins', writingTo: 'mercato' })
      expect(d.outcome).toBe('apply')
      expect(d.nextBaseline).toBe(B)
    })

    it('sheet-wins while exporting (source=mercato) → skip', () => {
      const d = decide({ ...bothChanged, policy: 'sheet-wins', writingTo: 'sheet' })
      expect(d.outcome).toBe('skip')
      expect(d.nextBaseline).toBeNull()
    })

    it('mercato-wins while exporting (source=mercato) → apply', () => {
      const d = decide({ ...bothChanged, policy: 'mercato-wins', writingTo: 'sheet' })
      expect(d.outcome).toBe('apply')
      expect(d.nextBaseline).toBe(B)
    })

    it('mercato-wins while importing (source=sheet) → skip', () => {
      const d = decide({ ...bothChanged, policy: 'mercato-wins', writingTo: 'mercato' })
      expect(d.outcome).toBe('skip')
      expect(d.nextBaseline).toBeNull()
    })
  })

  it('never advances the baseline on a flag (conflict left unresolved)', () => {
    const d = decide({ baselineHash: A, sourceHash: B, targetHash: C, policy: 'flag-for-review' })
    expect(d.nextBaseline).toBeNull()
  })
})

// Baseline migration after a mapping-derivation fix (duplicate-header handling): baseline A was
// recorded pre-fix; B is the post-fix hash of the SAME unchanged sheet content. The adapter
// supplies the legacy-derivation hash so decideSync can tell "content edited" apart from
// "hash shifted because the derivation was fixed".
describe('decideSync — legacy derivation hashes (baseline migration)', () => {
  it('import: source matches baseline only under the legacy derivation + target untouched → apply to heal, re-anchor baseline', () => {
    const d = decide({ baselineHash: A, sourceHash: B, legacySourceHash: A, targetHash: A, writingTo: 'mercato' })
    expect(d).toEqual({ outcome: 'apply', reason: 'rebaseline:derivation-change', nextBaseline: B })
  })

  it('import: legacy-matched source + target REALLY changed → skip, no false conflict, target edit survives', () => {
    const d = decide({ baselineHash: A, sourceHash: B, legacySourceHash: A, targetHash: C, writingTo: 'mercato', policy: 'flag-for-review' })
    expect(d.outcome).toBe('skip')
    expect(d.reason).toBe('source-unchanged')
    expect(d.nextBaseline).toBeNull()
  })

  it('export: target matches baseline only under the legacy derivation + source unchanged → skip, NEVER writes the possibly-stale source', () => {
    const d = decide({ baselineHash: A, sourceHash: A, targetHash: B, legacyTargetHash: A, writingTo: 'sheet' })
    expect(d.outcome).toBe('skip')
    // Both sides effectively unchanged → existing rule re-affirms the (stale) baseline value;
    // harmless, and the next import-direction run re-anchors it to the post-fix hash.
    expect(d.nextBaseline).toBe(A)
  })

  it('export: legacy-matched target + source REALLY changed → apply, killing the false conflict storm', () => {
    const d = decide({ baselineHash: A, sourceHash: B, targetHash: C, legacyTargetHash: A, writingTo: 'sheet', policy: 'flag-for-review' })
    expect(d).toEqual({ outcome: 'apply', reason: 'no-conflict', nextBaseline: B })
  })

  it('a legacy hash that does NOT match the baseline changes nothing (genuine both-side edits still conflict)', () => {
    const d = decide({ baselineHash: A, sourceHash: B, legacySourceHash: C, targetHash: C, policy: 'flag-for-review' })
    expect(d.outcome).toBe('flag')
  })

  it('no legacy hashes supplied → pre-fix behavior is identical (both-changed flags)', () => {
    const d = decide({ baselineHash: A, sourceHash: B, targetHash: C, policy: 'flag-for-review' })
    expect(d.outcome).toBe('flag')
  })

  it('both sides derivation-only with a corrected target flag still exercises the rebaseline-apply', () => {
    const d = decide({
      baselineHash: A,
      sourceHash: B,
      legacySourceHash: A,
      targetHash: C,
      legacyTargetHash: A,
      writingTo: 'mercato',
    })
    expect(d).toEqual({ outcome: 'apply', reason: 'rebaseline:derivation-change', nextBaseline: B })
  })

  it('sides that are hash-equal after the legacy correction re-anchor the baseline without writing', () => {
    // Manual heal to the new derivation: both sides now agree on B, baseline still pre-fix A.
    const d = decide({ baselineHash: A, sourceHash: B, legacySourceHash: A, targetHash: B, writingTo: 'mercato' })
    expect(d).toEqual({ outcome: 'skip', reason: 'already-in-sync', nextBaseline: B })
  })

  it('hash-equal sides with NO legacy info also skip + re-anchor (converged edits are not a conflict)', () => {
    const d = decide({ baselineHash: A, sourceHash: B, targetHash: B, policy: 'flag-for-review' })
    expect(d).toEqual({ outcome: 'skip', reason: 'already-in-sync', nextBaseline: B })
  })

  it('legacy hashes are ignored on the target-missing short-circuit', () => {
    const d = decide({ baselineHash: A, sourceHash: B, legacySourceHash: A, targetHash: null })
    expect(d).toEqual({ outcome: 'apply', reason: 'new-target', nextBaseline: B })
  })

  it('legacy hashes are ignored when there is no baseline to match against', () => {
    const d = decide({ baselineHash: null, sourceHash: B, legacySourceHash: A, targetHash: C, policy: 'flag-for-review' })
    expect(d.outcome).toBe('flag')
    expect(d.reason).toContain('no-baseline')
  })
})
