import type {
  BootstrapResponse,
  EvalContext,
  EvalEventItem,
  MetricEventItem,
  ServerBulkEvalResponse,
  ServerEvalResult,
} from '../types.js';
import type { ResolvedConfig } from './config.js';

/** An HTTP failure the SDK understands. Never escapes into the host application. */
export class SwitchboardHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'SwitchboardHttpError';
  }

  /** 401/403: the SDK key is wrong or revoked. Retrying cannot fix it. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export function authHeaders(config: ResolvedConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.sdkKey}` };
}

/**
 * Runs `fetch` with a timeout, combining the caller's abort signal with a timer.
 *
 * `AbortSignal.timeout` alone cannot be combined with an external signal on every supported
 * runtime, so the timer is wired manually.
 */
async function fetchWithTimeout(
  config: ResolvedConfig,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
      : undefined;
  try {
    return await config.fetch(url, { ...init, signal: controller.signal });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    signal?.removeEventListener('abort', onAbort);
  }
}

export type BootstrapResult =
  | { status: 200; payload: BootstrapResponse; etag: string | null }
  | { status: 304 };

/**
 * `GET /api/eval/bootstrap`.
 *
 * Sends `If-None-Match` when an ETag is known; the server answers 304 when the environment's
 * state version has not moved, which is what makes polling mode cheap.
 */
export async function fetchBootstrap(
  config: ResolvedConfig,
  etag: string | null,
  signal?: AbortSignal,
): Promise<BootstrapResult> {
  const headers: Record<string, string> = {
    ...authHeaders(config),
    Accept: 'application/json',
  };
  if (etag !== null) {
    headers['If-None-Match'] = etag;
  }
  const response = await fetchWithTimeout(
    config,
    `${config.baseUrl}/api/eval/bootstrap`,
    { method: 'GET', headers },
    config.bootstrapTimeoutMs,
    signal,
  );
  if (response.status === 304) {
    return { status: 304 };
  }
  if (!response.ok) {
    throw new SwitchboardHttpError(
      `bootstrap failed with HTTP ${response.status}`,
      response.status,
      await safeText(response),
    );
  }
  const payload = (await response.json()) as BootstrapResponse;
  return { status: 200, payload, etag: response.headers.get('etag') };
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return (await response.text()).slice(0, 512);
  } catch {
    return undefined;
  }
}

async function postJson<T>(
  config: ResolvedConfig,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  parse: boolean,
): Promise<T | undefined> {
  const response = await fetchWithTimeout(
    config,
    `${config.baseUrl}${path}`,
    {
      method: 'POST',
      headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    config.bootstrapTimeoutMs,
    signal,
  );
  if (!response.ok) {
    throw new SwitchboardHttpError(
      `POST ${path} failed with HTTP ${response.status}`,
      response.status,
      await safeText(response),
    );
  }
  return parse ? ((await response.json()) as T) : undefined;
}

/** `POST /api/eval/{flagKey}`: server-side evaluation, kept as a fallback and a verification path. */
export async function serverEvaluate(
  config: ResolvedConfig,
  flagKey: string,
  context: EvalContext,
  defaultValue: string,
  signal?: AbortSignal,
): Promise<ServerEvalResult> {
  const result = await postJson<ServerEvalResult>(
    config,
    `/api/eval/${encodeURIComponent(flagKey)}`,
    { context, default: defaultValue },
    signal,
    true,
  );
  return result as ServerEvalResult;
}

/** `POST /api/eval`: every non-archived flag in the key's environment, evaluated server-side. */
export async function serverEvaluateAll(
  config: ResolvedConfig,
  context: EvalContext,
  signal?: AbortSignal,
): Promise<ServerBulkEvalResponse> {
  const result = await postJson<ServerBulkEvalResponse>(
    config,
    '/api/eval',
    { context },
    signal,
    true,
  );
  return result as ServerBulkEvalResponse;
}

/** `POST /api/events/eval`, 202 on success. */
export async function sendEvalEvents(
  config: ResolvedConfig,
  events: EvalEventItem[],
  signal?: AbortSignal,
): Promise<void> {
  await postJson(config, '/api/events/eval', { events }, signal, false);
}

/** `POST /api/events/metrics`, 202 on success. */
export async function sendMetricEvents(
  config: ResolvedConfig,
  events: MetricEventItem[],
  signal?: AbortSignal,
): Promise<void> {
  await postJson(config, '/api/events/metrics', { events }, signal, false);
}
