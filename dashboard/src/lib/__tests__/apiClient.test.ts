import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// apiClient asks the auth seam for its bearer token. Stubbing the seam keeps these tests to the
// client's own surface — error envelopes, error classes, and the 401 retry — with no SDK in jsdom.
const provider = {
  kind: 'firebase' as const,
  getIdToken: vi.fn<(forceRefresh?: boolean) => Promise<string | null>>(),
}
vi.mock('@/auth', () => ({ requireAuthProvider: () => Promise.resolve(provider) }))

const {
  ApiClientError,
  ConflictError,
  NotAuthenticatedError,
  apiGet,
  errorMessage,
  parseErrorEnvelope,
} = await import('@/lib/apiClient')

describe('parseErrorEnvelope', () => {
  it('reads the backend {error, message} envelope', () => {
    expect(parseErrorEnvelope({ error: 'CONFLICT', message: 'Version 7 is stale' }, 409)).toEqual({
      code: 'CONFLICT',
      message: 'Version 7 is stale',
    })
  })

  it('falls back to the status line when there is no body', () => {
    expect(parseErrorEnvelope(null, 500, 'Internal Server Error')).toEqual({
      code: null,
      message: 'HTTP 500 Internal Server Error',
    })
  })

  it('falls back when the body is not the envelope shape', () => {
    expect(parseErrorEnvelope({ detail: 'nope' }, 400, 'Bad Request')).toEqual({
      code: null,
      message: 'HTTP 400 Bad Request',
    })
  })

  it('ignores a blank message rather than rendering an empty error', () => {
    expect(parseErrorEnvelope({ error: 'NOT_FOUND', message: '   ' }, 404).message).toBe('HTTP 404')
  })

  it('keeps the code even when the message needs a fallback', () => {
    expect(parseErrorEnvelope({ error: 'FORBIDDEN' }, 403).code).toBe('FORBIDDEN')
  })

  it('ignores a non-string error field', () => {
    expect(parseErrorEnvelope({ error: 42, message: 'boom' }, 400).code).toBeNull()
  })

  it('omits the status text when there is none', () => {
    expect(parseErrorEnvelope({}, 502).message).toBe('HTTP 502')
  })
})

describe('error classes', () => {
  it('ConflictError is an ApiClientError pinned to 409 CONFLICT', () => {
    const err = new ConflictError('Someone else saved version 8')
    expect(err).toBeInstanceOf(ApiClientError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('CONFLICT')
    expect(err.name).toBe('ConflictError')
  })

  it('ApiClientError carries the status and code through', () => {
    const err = new ApiClientError('Nope', 403, 'FORBIDDEN')
    expect(err.status).toBe(403)
    expect(err.code).toBe('FORBIDDEN')
    expect(err.message).toBe('Nope')
  })
})

describe('errorMessage', () => {
  it('uses an Error message', () => {
    expect(errorMessage(new Error('exploded'))).toBe('exploded')
  })

  it('falls back for a non-Error', () => {
    expect(errorMessage('a string', 'fallback')).toBe('fallback')
    expect(errorMessage(new Error(''), 'fallback')).toBe('fallback')
  })
})

describe('token plumbing', () => {
  const fetchMock = vi.fn<typeof fetch>()

  function response(status: number, body: unknown = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  function authHeader(call: number): string | null {
    const init = fetchMock.mock.calls[call][1] as RequestInit
    return (init.headers as Record<string, string>).Authorization
  }

  beforeEach(() => {
    fetchMock.mockReset()
    provider.getIdToken.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends whatever token the active provider hands over, with no idea which one it is', async () => {
    provider.getIdToken.mockResolvedValue('token-from-provider')
    fetchMock.mockResolvedValue(response(200, { ok: true }))

    await apiGet('/api/users/me')

    expect(authHeader(0)).toBe('Bearer token-from-provider')
    expect(provider.getIdToken).toHaveBeenCalledWith(false)
  })

  it('refuses to call the API at all when nobody is signed in', async () => {
    provider.getIdToken.mockResolvedValue(null)

    await expect(apiGet('/api/users/me')).rejects.toBeInstanceOf(NotAuthenticatedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forces one refresh on a 401 and retries with the new token', async () => {
    provider.getIdToken.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh')
    fetchMock
      .mockResolvedValueOnce(response(401, { error: 'UNAUTHORIZED', message: 'Token expired' }))
      .mockResolvedValueOnce(response(200, { id: 'u1' }))

    await expect(apiGet<{ id: string }>('/api/users/me')).resolves.toEqual({ id: 'u1' })

    expect(provider.getIdToken).toHaveBeenNthCalledWith(2, true)
    expect(authHeader(0)).toBe('Bearer stale')
    expect(authHeader(1)).toBe('Bearer fresh')
  })

  it('gives up after one retry rather than looping on a revoked session', async () => {
    provider.getIdToken.mockResolvedValue('token')
    fetchMock.mockResolvedValue(response(401, { error: 'UNAUTHORIZED', message: 'Nope' }))

    await expect(apiGet('/api/users/me')).rejects.toMatchObject({ status: 401, message: 'Nope' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces the original 401 when the refresh itself fails', async () => {
    provider.getIdToken.mockResolvedValueOnce('stale').mockRejectedValueOnce(new Error('idp down'))
    fetchMock.mockResolvedValueOnce(response(401, { error: 'UNAUTHORIZED', message: 'Expired' }))

    await expect(apiGet('/api/users/me')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 403, which a new token cannot fix', async () => {
    provider.getIdToken.mockResolvedValue('token')
    fetchMock.mockResolvedValue(response(403, { error: 'FORBIDDEN', message: 'Not your org' }))

    await expect(apiGet('/api/flags')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
