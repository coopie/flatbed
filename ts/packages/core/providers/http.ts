/**
 * POSTs JSON to a provider, retrying rate limits, server errors and network failures three times
 * with backoff, as docs/spec/providers.md asks. Shared by the Anthropic and OpenAI adapters.
 */

const RETRIES = 3;

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return await response.json();
      const text = await response.text();
      failure = `HTTP ${response.status}: ${text.slice(0, 500)}`;
      if (response.status !== 429 && response.status < 500) throw new Error(failure);
    } catch (error) {
      // A cancelled request and a client error are final; a network failure is worth another try.
      if (signal?.aborted || !(error instanceof TypeError)) throw error;
      failure = error.message;
    }
    if (attempt === RETRIES) throw new Error(`${failure} (after ${RETRIES} retries)`);
    await sleep(1000 * 2 ** attempt, signal);
  }
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
