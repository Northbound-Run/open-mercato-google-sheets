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
