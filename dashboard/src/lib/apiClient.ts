import { auth } from './firebase'
import { env } from './env'
import { classifyWriteResponse, type WriteResult } from './writeResult'
import type { ApiErrorBody, ApiErrorCode } from '@/types/api'

const API_BASE = env.apiBaseUrl

/**
 * Every non-OK backend response carries `{ error, message }` (the `ApiError` schema).
 * Parsing it is separated from throwing so it can be unit-tested against raw bodies.
 */
export function parseErrorEnvelope(
  body: unknown,
  status: number,
  statusText = '',
): { code: ApiErrorCode | null; message: string } {
  const envelope = (body ?? {}) as Partial<ApiErrorBody>
  const code = typeof envelope.error === 'string' ? (envelope.error as ApiErrorCode) : null
  const message =
    typeof envelope.message === 'string' && envelope.message.trim().length > 0
      ? envelope.message
      : `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
  return { code, message }
}

/** Any non-OK response from the management API. */
export class ApiClientError extends Error {
  readonly status: number
  /** The `error` field of the envelope, when the backend sent one. */
  readonly code: ApiErrorCode | null

  constructor(message: string, status: number, code: ApiErrorCode | null) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
  }
}

/**
 * 409 from an optimistic-concurrency write: someone else changed this config since we read
 * it. This is a first-class flow in Switchboard, not an error to toast and forget — the
 * targeting editor catches it specifically and offers to reload the current config.
 */
export class ConflictError extends ApiClientError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

/** The network itself failed (backend down, DNS, CORS preflight refused). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'NotAuthenticatedError'
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser
  if (!user) throw new NotAuthenticatedError()
  const token = await user.getIdToken()
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function throwForResponse(res: Response): Promise<never> {
  const body = await res.json().catch(() => null)
  const { code, message } = parseErrorEnvelope(body, res.status, res.statusText)
  if (res.status === 409) throw new ConflictError(message)
  throw new ApiClientError(message, res.status, code)
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers = await authHeaders()
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new NetworkError(
      `Could not reach the Switchboard API at ${API_BASE}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) await throwForResponse(res)
  return res
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await request('GET', path)
  return res.json() as Promise<T>
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await request('POST', path, body)
  return res.json() as Promise<T>
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await request('PUT', path, body)
  return res.json() as Promise<T>
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await request('PATCH', path, body)
  return res.json() as Promise<T>
}

/**
 * A write the backend may refuse to perform and park as a change request instead.
 *
 * The three gated flag endpoints answer 200 with the new config OR 202 with the PENDING
 * change request that now stands in for the write. Both are successes, so neither throws;
 * the difference is returned as a `WriteResult` the caller has to destructure. Keeping the
 * status-code sniffing in this one function is the whole point — no component should ever
 * see a `Response`.
 */
export async function apiSendGated<T>(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<WriteResult<T>> {
  const res = await request(method, path, body)
  const json = await res.json()
  return classifyWriteResponse<T>(res.status, json, res.headers.get('Location'))
}

/** DELETE endpoints return 204 with no body. */
export async function apiDelete(path: string): Promise<void> {
  await request('DELETE', path)
}

/** Human-readable message for anything thrown by this client (or any other error). */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}
