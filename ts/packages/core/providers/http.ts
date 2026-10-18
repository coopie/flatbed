/**
 * POSTs JSON to a provider, as docs/spec/providers.md asks: it retries three times, waiting 1, 2 and
 * then 4 seconds, when the request got no response, such as a refused connection or a timeout, and
 * on HTTP 408, 409, 429 and 500 and above. Shared by the Anthropic and OpenAI adapters.
 */

const RETRIES = 3;
/** Seconds to wait for a response, unless the provider's options say otherwise. */
export const DEFAULT_TIMEOUT = 600;
const RETRIED_STATUSES = new Set([408, 409, 429]);

/** The options every provider that calls an API takes. */
export type ProviderOptions = { apiKey: string; baseUrl?: string; timeout?: number };

export async function postJson(
  url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const deadline = AbortSignal.timeout(timeout * 1000);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (response.ok) return await response.json();
      const text = await response.text();
      failure = `HTTP ${response.status}: ${text.slice(0, 500)}`;
      if (!RETRIED_STATUSES.has(response.status) && response.status < 500) throw new Error(failure);
    } catch (error) {
      // A stop and a response not worth retrying are final; no response at all is worth another try.
      if (signal?.aborted || !noResponse(error)) throw error;
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

/** Waits, but ends early and throws when the signal is aborted, so that a stop does not wait out a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
