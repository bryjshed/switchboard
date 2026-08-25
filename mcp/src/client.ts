/**
 * A thin typed wrapper over Switchboard's REST API.
 *
 * The MCP server adds no backend surface of its own: every tool below is a call an operator could
 * make with curl, authenticated by a personal access token. That is the whole design — an agent
 * gets exactly the permissions of the person whose token it holds, checked by the same RBAC a
 * browser request goes through, and there is no second authorization path to keep in sync.
 */

export class SwitchboardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'SwitchboardApiError';
  }
}

export interface SwitchboardClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * The outcome of a write that may have been queued for review.
 *
 * This distinction is the single most important thing the MCP layer has to preserve. A gated
 * environment answers a write with **202 and no change**: the flag is untouched and a change
 * request is waiting for a human. An agent that reads 202 as success will tell its user the
 * rollout is done when nothing has happened at all, which is a worse failure than an error would
 * have been.
 */
export type WriteOutcome<T> =
  | { applied: true; value: T }
  | { applied: false; queued: true; changeRequest: unknown };

export class SwitchboardClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: SwitchboardClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /**
   * A write that a gated environment may park for review.
   *
   * Returns the discriminated outcome rather than throwing on 202, because "queued" is a normal,
   * successful result — just not the one the caller asked for.
   */
  async write<T>(method: 'PUT' | 'POST', path: string, body?: unknown): Promise<WriteOutcome<T>> {
    const response = await this.raw(method, path, body);
    if (response.status === 202) {
      return { applied: false, queued: true, changeRequest: await safeJson(response) };
    }
    await this.throwIfError(response, method, path);
    return { applied: true, value: (await safeJson(response)) as T };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, path, body);
    await this.throwIfError(response, method, path);
    return (await safeJson(response)) as T;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async throwIfError(response: Response, method: string, path: string): Promise<void> {
    if (response.ok) return;
    const text = await response.text().catch(() => undefined);
    // The message is what the agent sees, so it names the specific thing that went wrong rather
    // than a status code alone. 409 in particular is a real, recoverable condition here.
    const hint =
      response.status === 409
        ? ' — the flag changed since you read it; re-read it and retry with the new version'
        : response.status === 403
          ? ' — the token owner lacks permission for this'
          : '';
    throw new SwitchboardApiError(
      `${method} ${path} failed with HTTP ${response.status}${hint}`,
      response.status,
      text?.slice(0, 500),
    );
  }
}

async function safeJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
