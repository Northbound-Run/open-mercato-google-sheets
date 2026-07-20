import {
  parseScopes,
  resolveScopes,
  resolveOAuthClientConfig,
  getValidAccessToken,
  OAuthConfigError,
  OAuthReauthRequiredError,
  DEFAULT_IMPORT_SCOPES,
  type GoogleOAuthClient,
} from '../lib/oauth'

// ---------------------------------------------------------------------------
// parseScopes
// ---------------------------------------------------------------------------

describe('parseScopes', () => {
  it('returns an array of strings untouched', () => {
    const scopes = ['https://scope1', 'https://scope2']
    expect(parseScopes(scopes)).toEqual(scopes)
  })

  it('trims whitespace in array elements and filters empty strings', () => {
    expect(parseScopes(['  scope1  ', '', '  '])).toEqual(['scope1'])
  })

  it('splits a space-separated string', () => {
    expect(parseScopes('a b c')).toEqual(['a', 'b', 'c'])
  })

  it('splits a comma-separated string', () => {
    expect(parseScopes('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('splits a mixed space-and-comma string', () => {
    expect(parseScopes('a, b ,c')).toEqual(['a', 'b', 'c'])
  })

  it('returns [] for null', () => {
    expect(parseScopes(null)).toEqual([])
  })

  it('returns [] for undefined', () => {
    expect(parseScopes(undefined)).toEqual([])
  })

  it('returns [] for a number', () => {
    expect(parseScopes(42)).toEqual([])
  })

  it('returns [] for a boolean', () => {
    expect(parseScopes(true)).toEqual([])
  })

  it('returns [] for an object', () => {
    expect(parseScopes({ scope: 'read' })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveScopes
// ---------------------------------------------------------------------------

describe('resolveScopes', () => {
  it('uses creds.scopes when set', () => {
    const creds = { scopes: ['custom-scope'] }
    const result = resolveScopes(creds, { env: {} })
    expect(result).toEqual(['custom-scope'])
  })

  it('falls back to env GOOGLE_SHEETS_OAUTH_SCOPES when creds.scopes absent', () => {
    const result = resolveScopes(null, {
      env: { GOOGLE_SHEETS_OAUTH_SCOPES: 'env-scope-a env-scope-b' },
    })
    expect(result).toEqual(['env-scope-a', 'env-scope-b'])
  })

  it('falls back to options.fallback when creds and env both absent', () => {
    const fallback = ['fallback-scope']
    const result = resolveScopes(null, { env: {}, fallback })
    expect(result).toEqual(fallback)
  })

  it('falls back to DEFAULT_IMPORT_SCOPES when nothing is provided', () => {
    const result = resolveScopes(null, { env: {} })
    expect(result).toEqual(DEFAULT_IMPORT_SCOPES)
  })

  it('prefers creds.scopes over env and fallback', () => {
    const result = resolveScopes(
      { scopes: 'creds-scope' },
      {
        env: { GOOGLE_SHEETS_OAUTH_SCOPES: 'env-scope' },
        fallback: ['fallback-scope'],
      },
    )
    expect(result).toEqual(['creds-scope'])
  })

  it('skips empty creds.scopes and tries env', () => {
    const result = resolveScopes(
      { scopes: [] },
      { env: { GOOGLE_SHEETS_OAUTH_SCOPES: 'env-scope' } },
    )
    expect(result).toEqual(['env-scope'])
  })
})

// ---------------------------------------------------------------------------
// resolveOAuthClientConfig
// ---------------------------------------------------------------------------

describe('resolveOAuthClientConfig', () => {
  const baseEnv = {
    GOOGLE_SHEETS_OAUTH_CLIENT_ID: 'env-client-id',
    GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: 'env-client-secret',
    GOOGLE_SHEETS_OAUTH_REDIRECT_URI: 'https://example.com/cb',
  }

  it('returns config from env when credentials are empty', () => {
    const config = resolveOAuthClientConfig({}, { env: baseEnv })
    expect(config).toEqual({
      clientId: 'env-client-id',
      clientSecret: 'env-client-secret',
      redirectUri: 'https://example.com/cb',
    })
  })

  it('per-tenant creds.clientId and creds.clientSecret override env', () => {
    const creds = { clientId: 'tenant-id', clientSecret: 'tenant-secret' }
    const config = resolveOAuthClientConfig(creds, { env: baseEnv })
    expect(config.clientId).toBe('tenant-id')
    expect(config.clientSecret).toBe('tenant-secret')
    expect(config.redirectUri).toBe('https://example.com/cb') // still from env
  })

  it('redirectUriOverride wins over env REDIRECT_URI', () => {
    const config = resolveOAuthClientConfig({}, {
      env: baseEnv,
      redirectUriOverride: 'https://override.example.com/cb',
    })
    expect(config.redirectUri).toBe('https://override.example.com/cb')
  })

  it('returns config when all fields come from credentials', () => {
    const creds = {
      clientId: 'c-id',
      clientSecret: 'c-secret',
    }
    const config = resolveOAuthClientConfig(creds, {
      env: {},
      redirectUriOverride: 'https://redirect.example.com',
    })
    expect(config).toEqual({
      clientId: 'c-id',
      clientSecret: 'c-secret',
      redirectUri: 'https://redirect.example.com',
    })
  })

  it('throws OAuthConfigError when clientId and clientSecret are missing', () => {
    expect(() =>
      resolveOAuthClientConfig({}, {
        env: { GOOGLE_SHEETS_OAUTH_REDIRECT_URI: 'https://example.com/cb' },
      }),
    ).toThrow(OAuthConfigError)
  })

  it('throws OAuthConfigError when only clientSecret is missing', () => {
    expect(() =>
      resolveOAuthClientConfig({ clientId: 'id' }, {
        env: { GOOGLE_SHEETS_OAUTH_REDIRECT_URI: 'https://example.com/cb' },
      }),
    ).toThrow(OAuthConfigError)
  })

  it('throws OAuthConfigError when redirect URI is missing', () => {
    expect(() =>
      resolveOAuthClientConfig({}, {
        env: {
          GOOGLE_SHEETS_OAUTH_CLIENT_ID: 'id',
          GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: 'secret',
        },
      }),
    ).toThrow(OAuthConfigError)
  })

  it('accepts null credentials (treated as empty)', () => {
    const config = resolveOAuthClientConfig(null, { env: baseEnv })
    expect(config.clientId).toBe('env-client-id')
  })
})

// ---------------------------------------------------------------------------
// getValidAccessToken
// ---------------------------------------------------------------------------

const NOW_MS = 1_000_000

/** Env containing client config so resolveOAuthClientConfig won't throw during refresh. */
const REFRESH_ENV: NodeJS.ProcessEnv = {
  GOOGLE_SHEETS_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_SHEETS_OAUTH_REDIRECT_URI: 'https://example.com/cb',
}

function makeStubClient(overrides: Partial<GoogleOAuthClient> = {}): GoogleOAuthClient {
  return {
    buildAuthorizeUrl: jest.fn(),
    exchangeCode: jest.fn(),
    fetchUserInfo: jest.fn(),
    refreshToken: jest.fn().mockResolvedValue({
      access_token: 'new-access-token',
      expires_in: 3600,
    }),
    ...overrides,
  } as unknown as GoogleOAuthClient
}

describe('getValidAccessToken', () => {
  describe('returns cached token when still valid', () => {
    it('returns access_token when expires_at is well in the future', async () => {
      // stillValid: !forceRefresh && accessToken && expiresAt - 60_000 > now
      // needs expiresAt > now + 60_000 = 1_060_000
      const credentials = {
        access_token: 'cached-token',
        expires_at: NOW_MS + 120_000, // > NOW_MS + 60_000
        refresh_token: 'unused-refresh',
      }
      const token = await getValidAccessToken({
        credentials,
        env: REFRESH_ENV,
        nowMs: NOW_MS,
      })
      expect(token).toBe('cached-token')
    })

    it('does not call refreshToken when token is valid', async () => {
      const client = makeStubClient()
      const credentials = {
        access_token: 'cached-token',
        expires_at: NOW_MS + 120_000,
        refresh_token: 'unused-refresh',
      }
      await getValidAccessToken({ credentials, env: REFRESH_ENV, nowMs: NOW_MS, client })
      expect(client.refreshToken).not.toHaveBeenCalled()
    })
  })

  describe('refreshes when token is expired', () => {
    it('calls refreshToken and returns the new access_token', async () => {
      const client = makeStubClient()
      const credentials = {
        access_token: 'old-token',
        expires_at: NOW_MS - 1, // expired
        refresh_token: 'my-refresh-token',
      }
      const token = await getValidAccessToken({
        credentials,
        env: REFRESH_ENV,
        nowMs: NOW_MS,
        client,
      })
      expect(token).toBe('new-access-token')
      expect(client.refreshToken).toHaveBeenCalledTimes(1)
    })

    it('passes correct clientId, clientSecret, refreshToken to the client', async () => {
      const client = makeStubClient()
      const credentials = {
        access_token: 'old-token',
        expires_at: NOW_MS - 1,
        refresh_token: 'my-refresh-token',
      }
      await getValidAccessToken({
        credentials,
        env: REFRESH_ENV,
        nowMs: NOW_MS,
        client,
      })
      expect(client.refreshToken).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'my-refresh-token',
      })
    })

    it('calls onRefreshed with the new token set including a numeric expires_at', async () => {
      const client = makeStubClient()
      const onRefreshed = jest.fn()
      const credentials = {
        access_token: 'old-token',
        expires_at: NOW_MS - 1,
        refresh_token: 'my-refresh-token',
      }
      await getValidAccessToken({
        credentials,
        env: REFRESH_ENV,
        nowMs: NOW_MS,
        client,
        onRefreshed,
      })
      expect(onRefreshed).toHaveBeenCalledTimes(1)
      const [refreshed] = onRefreshed.mock.calls[0]
      expect(refreshed.access_token).toBe('new-access-token')
      // expires_at = nowMs + expires_in * 1000 = 1_000_000 + 3_600_000 = 4_600_000
      expect(refreshed.expires_at).toBe(NOW_MS + 3_600_000)
      expect(typeof refreshed.refresh_token).toBe('string')
    })

    it('preserves existing refresh_token when Google omits it on refresh response', async () => {
      const client = makeStubClient({
        refreshToken: jest.fn().mockResolvedValue({ access_token: 'new-tok' /* no refresh_token */ }),
      })
      const onRefreshed = jest.fn()
      const credentials = {
        expires_at: NOW_MS - 1,
        refresh_token: 'original-refresh',
      }
      await getValidAccessToken({
        credentials,
        env: REFRESH_ENV,
        nowMs: NOW_MS,
        client,
        onRefreshed,
      })
      const [refreshed] = onRefreshed.mock.calls[0]
      expect(refreshed.refresh_token).toBe('original-refresh')
    })

    it('refreshes when access_token is absent even if expires_at is in the future', async () => {
      const client = makeStubClient()
      const credentials = {
        // no access_token
        expires_at: NOW_MS + 120_000,
        refresh_token: 'my-refresh-token',
      }
      const token = await getValidAccessToken({
        credentials,
        env: REFRESH_ENV,
        nowMs: NOW_MS,
        client,
      })
      expect(token).toBe('new-access-token')
      expect(client.refreshToken).toHaveBeenCalledTimes(1)
    })

    it('refreshes when forceRefresh is true even if token is valid', async () => {
      const client = makeStubClient()
      const credentials = {
        access_token: 'valid-token',
        expires_at: NOW_MS + 120_000,
        refresh_token: 'my-refresh-token',
      }
      const token = await getValidAccessToken({
        credentials,
        env: REFRESH_ENV,
        nowMs: NOW_MS,
        client,
        forceRefresh: true,
      })
      expect(token).toBe('new-access-token')
      expect(client.refreshToken).toHaveBeenCalledTimes(1)
    })
  })

  describe('throws OAuthReauthRequiredError when no refresh_token', () => {
    it('throws when refresh_token is absent', async () => {
      const credentials = {
        access_token: 'expired-token',
        expires_at: NOW_MS - 1,
        // no refresh_token
      }
      await expect(
        getValidAccessToken({ credentials, env: REFRESH_ENV, nowMs: NOW_MS }),
      ).rejects.toThrow(OAuthReauthRequiredError)
    })

    it('throws when refresh_token is empty string', async () => {
      const credentials = {
        expires_at: NOW_MS - 1,
        refresh_token: '',
      }
      await expect(
        getValidAccessToken({ credentials, env: REFRESH_ENV, nowMs: NOW_MS }),
      ).rejects.toThrow(OAuthReauthRequiredError)
    })
  })

  describe('throws OAuthReauthRequiredError on invalid_grant from client', () => {
    it('wraps invalid_grant rejection in OAuthReauthRequiredError', async () => {
      const client = makeStubClient({
        refreshToken: jest.fn().mockRejectedValue(new Error('invalid_grant')),
      })
      const credentials = {
        expires_at: NOW_MS - 1,
        refresh_token: 'revoked-token',
      }
      await expect(
        getValidAccessToken({ credentials, env: REFRESH_ENV, nowMs: NOW_MS, client }),
      ).rejects.toThrow(OAuthReauthRequiredError)
    })

    it('wraps message containing invalid_grant case-insensitively', async () => {
      const client = makeStubClient({
        refreshToken: jest.fn().mockRejectedValue(new Error('Google Sheets OAuth refresh failed: INVALID_GRANT')),
      })
      const credentials = {
        expires_at: NOW_MS - 1,
        refresh_token: 'revoked-token',
      }
      await expect(
        getValidAccessToken({ credentials, env: REFRESH_ENV, nowMs: NOW_MS, client }),
      ).rejects.toThrow(OAuthReauthRequiredError)
    })

    it('re-throws non-invalid_grant errors as-is', async () => {
      const networkError = new Error('network timeout')
      const client = makeStubClient({
        refreshToken: jest.fn().mockRejectedValue(networkError),
      })
      const credentials = {
        expires_at: NOW_MS - 1,
        refresh_token: 'some-token',
      }
      await expect(
        getValidAccessToken({ credentials, env: REFRESH_ENV, nowMs: NOW_MS, client }),
      ).rejects.toThrow('network timeout')
    })
  })
})
