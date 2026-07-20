import {
  resolveConflict,
  isConflictPolicy,
  DEFAULT_CONFLICT_POLICY,
  type ConflictPolicy,
  type SyncSide,
} from '../lib/conflict'

describe('DEFAULT_CONFLICT_POLICY', () => {
  it('is last-write-wins', () => {
    expect(DEFAULT_CONFLICT_POLICY).toBe('last-write-wins')
  })
})

describe('isConflictPolicy', () => {
  it.each<ConflictPolicy>([
    'last-write-wins',
    'sheet-wins',
    'mercato-wins',
    'flag-for-review',
  ])('accepts %s', (policy) => {
    expect(isConflictPolicy(policy)).toBe(true)
  })

  it.each(['', 'both-wins', null, undefined, 0, true])(
    'rejects %p',
    (value) => {
      expect(isConflictPolicy(value)).toBe(false)
    },
  )
})

describe('resolveConflict — source unchanged', () => {
  it('skips when sourceChanged is false regardless of policy', () => {
    for (const policy of ['last-write-wins', 'sheet-wins', 'mercato-wins', 'flag-for-review'] as ConflictPolicy[]) {
      const result = resolveConflict({
        policy,
        writingTo: 'mercato',
        sourceChanged: false,
        targetChanged: true,
      })
      expect(result.outcome).toBe('skip')
      expect(result.winner).toBeNull()
      expect(result.reason).toBe('source-unchanged')
    }
  })
})

describe('resolveConflict — source changed, target unchanged (no conflict)', () => {
  it('applies when writing to mercato and sheet changed', () => {
    // writingTo='mercato', source='sheet'
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: false,
    })
    expect(result.outcome).toBe('apply')
    expect(result.winner).toBe('sheet') // source = opposite('mercato') = 'sheet'
    expect(result.reason).toBe('no-conflict')
  })

  it('applies when writing to sheet and mercato changed', () => {
    // writingTo='sheet', source='mercato'
    const result = resolveConflict({
      policy: 'flag-for-review',
      writingTo: 'sheet',
      sourceChanged: true,
      targetChanged: false,
    })
    expect(result.outcome).toBe('apply')
    expect(result.winner).toBe('mercato')
    expect(result.reason).toBe('no-conflict')
  })
})

describe('resolveConflict — both changed: flag-for-review', () => {
  it('flags when both sides changed', () => {
    const result = resolveConflict({
      policy: 'flag-for-review',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
    })
    expect(result.outcome).toBe('flag')
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('both-changed:flag-for-review')
  })
})

describe('resolveConflict — both changed: sheet-wins', () => {
  it('applies when source is sheet (import direction: sheet → mercato)', () => {
    // writingTo='mercato', source='sheet' — sheet wins means sheet (source) should apply
    const result = resolveConflict({
      policy: 'sheet-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
    })
    expect(result.outcome).toBe('apply')
    expect(result.winner).toBe('sheet')
    expect(result.reason).toBe('both-changed:sheet-wins')
  })

  it('skips when source is mercato (export direction: mercato → sheet)', () => {
    // writingTo='sheet', source='mercato' — sheet wins means mercato (source) should NOT apply
    const result = resolveConflict({
      policy: 'sheet-wins',
      writingTo: 'sheet',
      sourceChanged: true,
      targetChanged: true,
    })
    expect(result.outcome).toBe('skip')
    expect(result.winner).toBe('sheet')
    expect(result.reason).toBe('both-changed:sheet-wins')
  })
})

describe('resolveConflict — both changed: mercato-wins', () => {
  it('applies when source is mercato (export direction: mercato → sheet)', () => {
    // writingTo='sheet', source='mercato'
    const result = resolveConflict({
      policy: 'mercato-wins',
      writingTo: 'sheet',
      sourceChanged: true,
      targetChanged: true,
    })
    expect(result.outcome).toBe('apply')
    expect(result.winner).toBe('mercato')
    expect(result.reason).toBe('both-changed:mercato-wins')
  })

  it('skips when source is sheet (import direction: sheet → mercato)', () => {
    // writingTo='mercato', source='sheet'
    const result = resolveConflict({
      policy: 'mercato-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
    })
    expect(result.outcome).toBe('skip')
    expect(result.winner).toBe('mercato')
    expect(result.reason).toBe('both-changed:mercato-wins')
  })
})

describe('resolveConflict — both changed: last-write-wins', () => {
  // Import direction: writingTo='mercato', source='sheet'
  it('applies when sourceModifiedAt > targetModifiedAt (source is newer)', () => {
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      sourceModifiedAt: 2000,
      targetModifiedAt: 1000,
    })
    expect(result.outcome).toBe('apply')
    expect(result.winner).toBe('sheet') // source='sheet', winner=source because s > t
    expect(result.reason).toBe('both-changed:last-write-wins')
  })

  it('skips when sourceModifiedAt < targetModifiedAt (target is newer)', () => {
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      sourceModifiedAt: 1000,
      targetModifiedAt: 2000,
    })
    expect(result.outcome).toBe('skip')
    expect(result.winner).toBe('mercato') // target='mercato', winner=target because t > s
    expect(result.reason).toBe('both-changed:last-write-wins')
  })

  it('flags when timestamps are equal (no lwwTiebreak)', () => {
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      sourceModifiedAt: 1500,
      targetModifiedAt: 1500,
    })
    expect(result.outcome).toBe('flag')
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('both-changed:lww-indeterminate')
  })

  it('flags when timestamps are missing (no lwwTiebreak)', () => {
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
    })
    expect(result.outcome).toBe('flag')
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('both-changed:lww-indeterminate')
  })

  it('flags when only sourceModifiedAt is missing', () => {
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      targetModifiedAt: 1000,
    })
    expect(result.outcome).toBe('flag')
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('both-changed:lww-indeterminate')
  })

  it('flags when only targetModifiedAt is missing', () => {
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      sourceModifiedAt: 1000,
    })
    expect(result.outcome).toBe('flag')
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('both-changed:lww-indeterminate')
  })

  it('applies via lwwTiebreak=sheet when tiebreak matches source', () => {
    // writingTo='mercato', source='sheet' — tiebreak='sheet' matches source → apply
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      lwwTiebreak: 'sheet',
    })
    expect(result.outcome).toBe('apply')
    expect(result.winner).toBe('sheet')
    expect(result.reason).toBe('both-changed:lww-tiebreak')
  })

  it('skips via lwwTiebreak=mercato when tiebreak does not match source', () => {
    // writingTo='mercato', source='sheet' — tiebreak='mercato' does not match source → skip
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      lwwTiebreak: 'mercato',
    })
    expect(result.outcome).toBe('skip')
    expect(result.winner).toBe('mercato')
    expect(result.reason).toBe('both-changed:lww-tiebreak')
  })

  it('flags via lwwTiebreak=flag explicitly', () => {
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'mercato',
      sourceChanged: true,
      targetChanged: true,
      lwwTiebreak: 'flag',
    })
    expect(result.outcome).toBe('flag')
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('both-changed:lww-indeterminate')
  })

  it('export direction: applies when sourceModifiedAt > targetModifiedAt', () => {
    // writingTo='sheet', source='mercato'
    const result = resolveConflict({
      policy: 'last-write-wins',
      writingTo: 'sheet',
      sourceChanged: true,
      targetChanged: true,
      sourceModifiedAt: 9000,
      targetModifiedAt: 1000,
    })
    expect(result.outcome).toBe('apply')
    expect(result.winner).toBe('mercato') // source='mercato'
    expect(result.reason).toBe('both-changed:last-write-wins')
  })
})
