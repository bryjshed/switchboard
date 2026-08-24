import { describe, expect, it, vi } from 'vitest'

// apiClient imports the Firebase app for its token source. Stubbing the module keeps these
// tests to the pure error-handling surface, with no SDK init in jsdom.
vi.mock('@/lib/firebase', () => ({ auth: { currentUser: null } }))

const { ApiClientError, ConflictError, errorMessage, parseErrorEnvelope } = await import(
  '@/lib/apiClient'
)

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
