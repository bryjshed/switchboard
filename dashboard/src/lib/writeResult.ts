import type { ChangeRequest, FlagEnvConfig } from '@/types/api'

/**
 * What actually happened to a flag write.
 *
 * Three endpoints — the targeting PUT, the kill switch and the rollback — answer either
 * 200 with a new config version or **202 with a change request and nothing written at all**,
 * depending on whether the environment requires approval. The two outcomes are not variants
 * of "saved": one changed what users are being served, the other did not touch the flag.
 *
 * Components must never learn that difference by reading a status code. The api layer
 * classifies it once, here, into a discriminated union, so a caller that forgets to handle
 * `queued` is a type error rather than a screen that says "Saved" about a write that did not
 * happen.
 */
export type WriteResult<T = FlagEnvConfig> =
  | { outcome: 'applied'; config: T }
  | {
      outcome: 'queued'
      changeRequest: ChangeRequest
      /** The `Location` header the backend pointed at the new request with, when it sent one. */
      location: string | null
    }

export function appliedResult<T>(config: T): WriteResult<T> {
  return { outcome: 'applied', config }
}

export function queuedResult<T>(
  changeRequest: ChangeRequest,
  location: string | null = null,
): WriteResult<T> {
  return { outcome: 'queued', changeRequest, location }
}

export function isQueued<T>(
  result: WriteResult<T>,
): result is Extract<WriteResult<T>, { outcome: 'queued' }> {
  return result.outcome === 'queued'
}

export function isApplied<T>(
  result: WriteResult<T>,
): result is Extract<WriteResult<T>, { outcome: 'applied' }> {
  return result.outcome === 'applied'
}

/**
 * Status + body → the typed outcome. Pure, so the 202-vs-200 contract is unit-testable
 * without a fetch.
 *
 * Anything that is not a 202 is treated as an applied write: the api client has already
 * thrown for every non-2xx, so the remaining codes (200, and a 201 no endpoint currently
 * sends) all mean "the config in this body is live".
 */
export function classifyWriteResponse<T>(
  status: number,
  body: unknown,
  location: string | null = null,
): WriteResult<T> {
  if (status === 202) return queuedResult<T>(body as ChangeRequest, location)
  return appliedResult<T>(body as T)
}

/** The change request id a queued result refers to. */
export function queuedChangeRequestId<T>(result: WriteResult<T>): string | null {
  return isQueued(result) ? result.changeRequest.id : null
}
