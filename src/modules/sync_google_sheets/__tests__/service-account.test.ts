import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
  buildSignedJwt,
  createServiceAccountTokenProvider,
  DEFAULT_SERVICE_ACCOUNT_SCOPES,
  isServiceAccountCredentials,
  normalizePrivateKey,
  resolveServiceAccountCredentials,
  type ServiceAccountCredentials,
} from '../lib/service-account'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const b64urlToBuffer = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const decode = (s: string): Record<string, unknown> => JSON.parse(b64urlToBuffer(s).toString('utf8'))
const verifySig = (jwt: string): boolean => {
  const [h, c, sig] = jwt.split('.')
  return createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, b64urlToBuffer(sig))
}

const sa: ServiceAccountCredentials = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey }
const NOW = 1_700_000_000_000

describe('buildSignedJwt', () => {
  it('produces a 3-part JWT with a valid RS256 signature', () => {
    const jwt = buildSignedJwt(sa, DEFAULT_SERVICE_ACCOUNT_SCOPES, NOW)
    expect(jwt.split('.')).toHaveLength(3)
    expect(verifySig(jwt)).toBe(true)
  })

  it('encodes the expected header and claims', () => {
    const [h, c] = buildSignedJwt(sa, ['scope-a', 'scope-b'], NOW).split('.')
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = decode(c)
    expect(claims.iss).toBe(sa.client_email)
    expect(claims.scope).toBe('scope-a scope-b')
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token')
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.exp).toBe(1_700_000_000 + 3600)
    expect(claims.sub).toBeUndefined()
  })

  it('includes sub for domain-wide delegation when subject is set', () => {
    const jwt = buildSignedJwt({ ...sa, subject: 'user@example.com' }, ['s'], NOW)
    expect(decode(jwt.split('.')[1]).sub).toBe('user@example.com')
  })
})

describe('normalizePrivateKey', () => {
  it('restores literal \\n escapes to real newlines', () => {
    const escaped = privateKey.replace(/\n/g, '\\n')
    expect(escaped).toContain('\\n')
    const restored = normalizePrivateKey(escaped)
    expect(restored).not.toContain('\\n')
    expect(restored).toContain('\n')
    expect(restored.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
  })

  it('signs correctly from a \\n-escaped key', () => {
    expect(verifySig(buildSignedJwt({ ...sa, private_key: privateKey.replace(/\n/g, '\\n') }, ['s'], NOW))).toBe(true)
  })
})

describe('resolveServiceAccountCredentials', () => {
  it('reads the credential blob (snake_case)', () => {
    expect(resolveServiceAccountCredentials({ client_email: 'a@b.iam', private_key: 'KEY' }, {})).toEqual({
      client_email: 'a@b.iam',
      private_key: 'KEY',
      subject: null,
    })
  })

  it('reads camelCase + subject', () => {
    expect(resolveServiceAccountCredentials({ clientEmail: 'a@b.iam', privateKey: 'KEY', subject: 'u@x' }, {})).toEqual({
      client_email: 'a@b.iam',
      private_key: 'KEY',
      subject: 'u@x',
    })
  })

  it('falls back to env', () => {
    const env = { GOOGLE_SHEETS_SA_CLIENT_EMAIL: 'e@b.iam', GOOGLE_SHEETS_SA_PRIVATE_KEY: 'ENVKEY' } as NodeJS.ProcessEnv
    expect(resolveServiceAccountCredentials(null, env)?.client_email).toBe('e@b.iam')
  })

  it('returns null / false when incomplete', () => {
    expect(resolveServiceAccountCredentials({ client_email: 'a@b.iam' }, {})).toBeNull()
    expect(isServiceAccountCredentials(null, {})).toBe(false)
    expect(isServiceAccountCredentials({ client_email: 'a', private_key: 'k' }, {})).toBe(true)
  })
})

describe('createServiceAccountTokenProvider', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  const mockToken = (token: string, expiresIn = 3600): (() => number) => {
    let calls = 0
    global.fetch = (async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ access_token: `${token}-${calls}`, expires_in: expiresIn, token_type: 'Bearer' }),
      }
    }) as unknown as typeof fetch
    return () => calls
  }

  it('mints a token then caches it until near expiry', async () => {
    const calls = mockToken('tok')
    const provider = createServiceAccountTokenProvider({ credentials: sa, now: () => 1_000_000 })
    expect(await provider()).toBe('tok-1')
    expect(await provider()).toBe('tok-1')
    expect(calls()).toBe(1)
  })

  it('refreshes when the cached token is near expiry', async () => {
    mockToken('tok', 3600)
    let clock = 1_000_000
    const provider = createServiceAccountTokenProvider({ credentials: sa, now: () => clock })
    expect(await provider()).toBe('tok-1')
    clock += 3_600_000
    expect(await provider()).toBe('tok-2')
  })

  it('forceRefresh bypasses the cache', async () => {
    mockToken('tok')
    const provider = createServiceAccountTokenProvider({ credentials: sa, now: () => 1_000_000 })
    expect(await provider()).toBe('tok-1')
    expect(await provider({ forceRefresh: true })).toBe('tok-2')
  })
})
