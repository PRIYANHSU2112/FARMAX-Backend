/** Why an upstream call failed (logged; the caller decides the fallback). */
export class UpstreamError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'status',
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(`upstream ${kind}${status === undefined ? '' : ` ${String(status)}`}`, options);
    this.name = 'UpstreamError';
  }
}

export interface GetJsonOptions {
  /** Caller's bearer token, forwarded as-is (customer routes of other services). */
  bearer?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  /** A shared abort signal (one budget for several calls); combined with `timeoutMs`. */
  signal?: AbortSignal;
}

/**
 * GET → parsed JSON body. Throws `UpstreamError` on timeout, network failure or a non-2xx status
 * (404 included, so callers can tell "gone" from "down" by `status`).
 */
export async function getJson<T>(url: string, options: GetJsonOptions): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
        ...options.headers,
      },
      signal,
    });
  } catch (err) {
    const aborted =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new UpstreamError(aborted ? 'timeout' : 'network', undefined, { cause: err });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamError('status', res.status);
  }
  return (await res.json()) as T;
}
