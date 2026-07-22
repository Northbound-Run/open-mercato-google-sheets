import { generateKeyPairSync } from 'node:crypto'
import { buildAccessTokenProvider } from '../lib/access-token-provider'

// Regression guard for the preview/health service-account gap: every token-provider call
// site must prefer SA credentials (blob or env) and only fall back to the OAuth
// refresh-token path when no SA key is present.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const scope = { organizationId: 'org-1', tenantId: 'tenant-1' }
const ENV_KEYS = [
  'GOOGLE_SHEETS_SA_CLIENT_EMAIL',
  'GOOGLE_SHEETS_SA_PRIVATE_KEY',
  'GOOGLE_SHEETS_SA_SUBJECT',
  'GOOGLE_SHEETS_OAUTH_CLIENT_ID',
  'GOOGLE_SHEETS_OAUTH_CLIENT_SECRET',
  'GOOGLE_SHEETS_OAUTH_REDIRECT_URI',
]

function tokenResponse(token: string): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('buildAccessTokenProvider', () => {
  const originalFetch = global.fetch
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })
  afterEach(() => {
    global.fetch = originalFetch
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('mints a service-account token from blob credentials, with no persist', async () => {
    global.fetch = jest.fn().mockResolvedValue(tokenResponse('sa-token'))
    const saver = { save: jest.fn().mockResolvedValue(undefined) }
    const provider = buildAccessTokenProvider(
      { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey },
      scope,
      saver,
    )
    await expect(provider()).resolves.toBe('sa-token')
    expect(saver.save).not.toHaveBeenCalled()
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(String(url)).toBe('https://oauth2.googleapis.com/token')
    expect(String((init as RequestInit).body)).toContain('jwt-bearer')
  })

  it('falls back to GOOGLE_SHEETS_SA_* env credentials when the blob has none', async () => {
    process.env.GOOGLE_SHEETS_SA_CLIENT_EMAIL = 'svc@proj.iam.gserviceaccount.com'
    process.env.GOOGLE_SHEETS_SA_PRIVATE_KEY = privateKey
    global.fetch = jest.fn().mockResolvedValue(tokenResponse('env-sa-token'))
    const saver = { save: jest.fn().mockResolvedValue(undefined) }
    const provider = buildAccessTokenProvider({}, scope, saver)
    await expect(provider()).resolves.toBe('env-sa-token')
    expect(saver.save).not.toHaveBeenCalled()
  })

  it('returns a still-valid OAuth access token without refreshing or saving', async () => {
    global.fetch = jest.fn()
    const saver = { save: jest.fn().mockResolvedValue(undefined) }
    const provider = buildAccessTokenProvider(
      { access_token: 'cached', expires_at: Date.now() + 3_600_000, refresh_token: 'r1' },
      scope,
      saver,
    )
    await expect(provider()).resolves.toBe('cached')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(saver.save).not.toHaveBeenCalled()
  })

  it('refreshes an expired OAuth token and persists the refreshed tokens', async () => {
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_ID = 'client-id'
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET = 'client-secret'
    process.env.GOOGLE_SHEETS_OAUTH_REDIRECT_URI = 'https://app.example.com/api/sync_google_sheets/oauth/callback'
    global.fetch = jest.fn().mockResolvedValue(tokenResponse('new-tok'))
    const saver = { save: jest.fn().mockResolvedValue(undefined) }
    const credentials = { access_token: 'old', expires_at: 1, refresh_token: 'refresh-1' }
    const provider = buildAccessTokenProvider(credentials, scope, saver)
    await expect(provider()).resolves.toBe('new-tok')
    expect(saver.save).toHaveBeenCalledWith(
      'sync_google_sheets',
      expect.objectContaining({ access_token: 'new-tok', refresh_token: 'refresh-1' }),
      scope,
    )
  })
})
