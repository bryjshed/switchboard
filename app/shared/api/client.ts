import { config } from '../config';
import type { ApiError, ApiErrorCode } from './types';

/** Typed error for any non-2xx API response. */
export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'UNKNOWN';
  readonly status: number;

  constructor(code: ApiErrorCode | 'UNKNOWN', message: string, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * UPGRADE_REQUIRED seam: plan caps surface as this subclass so callers can
 * route to the upgrade modal instead of a generic error state.
 */
export class CapExceededError extends ApiClientError {
  constructor(message: string, status: number) {
    super('UPGRADE_REQUIRED', message, status);
    this.name = 'CapExceededError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

type TokenProvider = () => string | null;
type UnauthorizedHandler = () => void;

let tokenProvider: TokenProvider = () => null;
let onUnauthorized: UnauthorizedHandler | null = null;

/** Registered by the auth store at module init — avoids an import cycle. */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/**
 * Called on any 401 so the auth store can drop the session (emulator tokens
 * expire; "refresh" is re-login — see features/auth/stores/authStore).
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  body?: unknown;
  /** Skip Bearer injection (e.g. the emulator sign-in call). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 30_000;

async function doFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (init.signal) {
    const outer = init.signal;
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : 'Network request failed');
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${config.apiBaseUrl}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!options.anonymous) {
    const token = tokenProvider();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers, signal: options.signal };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await doFetch(url, init);
  } catch (e) {
    // One retry on network failure, GETs only (idempotent).
    if (method === 'GET' && e instanceof NetworkError && !options.signal?.aborted) {
      response = await doFetch(url, init);
    } else {
      throw e;
    }
  }

  if (!response.ok) {
    let envelope: Partial<ApiError> = {};
    try {
      envelope = (await response.json()) as Partial<ApiError>;
    } catch {
      // non-JSON error body; fall through with UNKNOWN
    }
    const code = envelope.error ?? (response.status === 401 ? 'UNAUTHORIZED' : 'UNKNOWN');
    const message = envelope.message ?? `Request failed (${response.status})`;
    if (response.status === 401) onUnauthorized?.();
    if (code === 'UPGRADE_REQUIRED') throw new CapExceededError(message, response.status);
    throw new ApiClientError(code, message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
};
