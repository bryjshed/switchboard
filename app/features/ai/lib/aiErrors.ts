import { ApiClientError } from '@shared/api/client';

/**
 * The backend answers 503 AI_UNAVAILABLE whenever ANTHROPIC_API_KEY is unset,
 * which is the DEFAULT state of a local stack. It is a configuration fact, not
 * a failure, so screens branch on this instead of showing an error.
 */
export function isAiUnavailable(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'AI_UNAVAILABLE';
}

/** Apply/ack raced someone else: the proposal or finding already moved on. */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 409;
}
