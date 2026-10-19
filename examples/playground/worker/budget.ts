/**
 * The day's spend, kept by one Durable Object so that checking the budget and adding to it happen
 * in one step. A Durable Object runs one request handler at a time against memory it owns, so two
 * calls that arrive together cannot both read the old total, as they could with a KV key, and every
 * location sees the same total.
 *
 * Amounts are in millionths of a dollar. The Worker reserves a call's likely cost before it calls
 * Anthropic, which is refused once the day's total would pass the limit, and settles the difference
 * when the call's usage comes back. So a rush of calls in flight together cannot each see room under
 * the cap and all go ahead.
 *
 * It speaks plain HTTP to the Worker, through its `fetch`, so it needs nothing from the Workers
 * runtime and the tests can run it in Node:
 *
 * - `POST /reserve` with `{ day, amount, limit }` adds `amount` when the total stays within `limit`,
 *   and answers `{ ok, spent }`.
 * - `POST /settle` with `{ day, amount }` adds `amount`, which may be negative, and answers `{ spent }`.
 * - `GET /spent?day=` answers `{ spent }`.
 */

/** The part of `DurableObjectState` this uses, so the tests can give it a fake. */
export type BudgetState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
    delete(key: string): Promise<boolean>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
};

const KEEP_DAYS = 3;

export class Budget {
  #state: BudgetState;
  #spent = new Map<string, number>();
  #ready: Promise<void>;

  constructor(state: BudgetState) {
    this.#state = state;
    this.#ready = state.blockConcurrencyWhile(async () => {
      const oldest = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      for (const [key, value] of await state.storage.list<number>({ prefix: 'spend:' })) {
        if (key.slice('spend:'.length) < oldest) await state.storage.delete(key);
        else this.#spent.set(key, value);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready;
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/spent') {
      return Response.json({ spent: this.#spent.get(`spend:${url.searchParams.get('day')}`) ?? 0 });
    }
    const body = (await request.json()) as { day: string; amount: number; limit?: number };
    const key = `spend:${body.day}`;
    const spent = this.#spent.get(key) ?? 0;
    // From here to the update there is no await, so no other request sees the total in between.
    if (url.pathname === '/reserve') {
      if (spent + body.amount > (body.limit ?? 0)) return Response.json({ ok: false, spent });
      return this.#add(key, spent + body.amount, { ok: true });
    }
    if (url.pathname === '/settle') return this.#add(key, Math.max(0, spent + body.amount), {});
    return new Response('Not found', { status: 404 });
  }

  async #add(key: string, total: number, extra: Record<string, unknown>): Promise<Response> {
    this.#spent.set(key, total);
    await this.#state.storage.put(key, total);
    return Response.json({ ...extra, spent: total });
  }
}
