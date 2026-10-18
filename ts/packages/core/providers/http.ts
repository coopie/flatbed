/**
 * POSTs JSON to a provider, as docs/spec/providers.md asks: it retries three times, waiting 1, 2 and
 * then 4 seconds, when the request got no response, such as a refused connection or a timeout, and
 * on HTTP 408, 409, 429 and 500 and above. A stop ends a request in flight or a backoff wait at once,
 * with the error `The request was stopped.` Shared by the Anthropic and OpenAI adapters.
 */

const RETRIES = 3;
/** Seconds to wait for a response, unless the provider's options say otherwise. */
export const DEFAULT_TIMEOUT = 600;
const RETRIED_STATUSES = new Set([408, 409, 429]);
const STOPPED = 'The request was stopped.';

/** The options every provider that calls an API takes. */
export type ProviderOptions = { apiKey: string; baseUrl?: string; timeout?: number };

export async function postJson(
  url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const deadline = AbortSignal.timeout(timeout * 1000);
      // Raced against the stop as well as passed to fetch, so that a stop ends the request even
      // while the body is still arriving.
      const response = await untilStopped(fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }), signal);
      if (response.ok) return await untilStopped(response.json(), signal);
      const text = await untilStopped(response.text(), signal);
      failure = `HTTP ${response.status}: ${text.slice(0, 500)}`;
      if (!RETRIED_STATUSES.has(response.status) && response.status < 500) throw new Error(failure);
    } catch (error) {
      // A stop and a response not worth retrying are final; no response at all is worth another try.
      if (signal?.aborted) throw new Error(STOPPED);
      if (!noResponse(error)) throw error;
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt === RETRIES) throw new Error(`${failure} (after ${RETRIES} retries)`);
    await sleep(1000 * 2 ** attempt, signal);
  }
}

/** fetch throws a TypeError when the request got no response, and a TimeoutError at the deadline. */
function noResponse(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
}

/** Settles as the promise does, or rejects with `The request was stopped.` as soon as the signal is set. */
function untilStopped<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error(STOPPED));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Waits, but ends early and throws when the signal is aborted, so that a stop does not wait out a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(STOPPED));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(STOPPED));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
