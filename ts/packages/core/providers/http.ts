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
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
