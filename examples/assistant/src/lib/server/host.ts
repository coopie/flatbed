/**
 * The host: everything the web app does with agents, kept free of SvelteKit so the tests can drive
 * it without a browser.
 *
 * Each person has one agent, with the docs plugin for its memory, read tools for mail and calendar,
 * proposals, the supervisor's guard on email proposals, and a plugin that streams every entry to
 * the person's open pages. The host decides when an agent runs: when the person sends a message,
 * when they decide a proposal, and on a tick. A Postgres advisory lock keeps two processes from
 * running one agent at once; within a process, a wake during a run asks for one more run after it.
 */
import { EventEmitter } from 'node:events';
import { anthropicProvider, createAgent, type Agent, type Entry, type Event, type Provider } from '@flatbed/core';
import { docsPlugin, type DocStore } from '@flatbed/docs';
import type { Sql } from './db.ts';
import { demoModel } from './demo-model.ts';
import { demoPeople, demoPerson } from './fixtures.ts';
import { demoGoogle } from './google/demo.ts';
import type { Google } from './google/google.ts';
import { liveGoogle } from './google/live.ts';
import { decide, listProposals, mailAndCalendar, proposals, type Decision, type Proposal } from './plugins.ts';
import { seeds } from './seeds.ts';
import { pgDocStore, pgStore } from './stores.ts';
import { emailGuard } from './supervision.ts';

export type Person = { id: string; email: string; name: string };

/** What the person's open pages hear: each new entry, a new or decided proposal, and whether the agent is working. */
export type Update = { type: 'entry'; entry: Entry } | { type: 'proposal'; proposal: Proposal } | { type: 'working'; working: boolean };

export type HostOptions = {
  sql: Sql;
  /** `demo` uses the invented people and fixtures; `google` uses each person's own Gmail and Calendar. */
  mode: 'demo' | 'google';
  /** `<provider>/<model-name>`, from FLATBED_MODEL. `faux/demo` is the scripted demo model. */
  model: string;
  anthropicKey?: string;
};

export type Host = ReturnType<typeof createHost>;

export function createHost(options: HostOptions) {
  const { sql, mode, model } = options;
  const providers: Record<string, Provider> = { faux: demoModel() };
  if (options.anthropicKey) providers.anthropic = anthropicProvider({ apiKey: options.anthropicKey });
  const provider = providers[model.slice(0, model.indexOf('/'))];
  if (provider === undefined) throw new Error(`No provider for ${model}. Set ANTHROPIC_API_KEY, or FLATBED_MODEL=faux/demo.`);
  // The supervisor reads more than it writes, so a smaller model does; the demo model plays both.
  const supervisorModel = model.startsWith('anthropic/') ? 'claude-sonnet-5-5' : 'demo';

  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const publish = (person: string, update: Update) => bus.emit(person, update);
  const agents = new Map<string, { agent: Agent; wanted: boolean; running: Promise<void> | undefined }>();

  const google = (person: string): Google => {
    if (mode === 'google') return liveGoogle(sql, person);
    return demoGoogle(sql, demoPerson(person)!);
  };
  const docs = (person: string): DocStore => pgDocStore(sql, person);

  async function person(id: string): Promise<Person | undefined> {
    const [row] = await sql<Person[]>`select id, email, name from people where id = ${id}`;
    return row;
  }

  function seedsFor(who: Person) {
    const demo = demoPerson(who.id);
    const profile = demo?.profile ?? `# ${who.name}\n\nNothing written yet. Add how ${who.name.split(' ')[0]} writes and what they care about as you learn it.`;
    return seeds({ ...who, assistant: demo?.assistant ?? 'Juniper', profile });
  }

  function slotFor(who: Person) {
    let slot = agents.get(who.id);
    if (slot !== undefined) return slot;
    const agent = createAgent(
      {
        id: who.id,
        model,
        plugins: [
          docsPlugin({ store: docs(who.id), seeds: seedsFor(who) }),
          mailAndCalendar(google(who.id)),
          proposals({ sql, onProposed: (proposal) => publish(who.id, { type: 'proposal', proposal }) }),
          emailGuard(provider!, supervisorModel),
          { name: 'stream', onEntry: (entry) => publish(who.id, { type: 'entry', entry }) },
        ],
      },
      { store: pgStore(sql), providers },
    );
    slot = { agent, wanted: false, running: undefined };
    agents.set(who.id, slot);
    return slot;
  }

  /**
   * Runs the agent until no wake is waiting, holding a transaction-level advisory lock on its id.
   * The lock is per transaction, not per connection, because Supabase's pooler hands a connection's
   * statements to whichever server it likes between transactions; a session lock taken there can
   * be left held on a server nobody is using. The transaction stays open for the whole run.
   */
  async function runWhileWanted(who: Person, slot: ReturnType<typeof slotFor>) {
    publish(who.id, { type: 'working', working: true });
    try {
      await sql.begin(async (tx) => {
        // Keyed by schema too, so a test schema never waits on the app.
        await tx`select pg_advisory_xact_lock(hashtext(current_schema() || ${`:run:${who.id}`}))`;
        while (slot.wanted) {
          slot.wanted = false;
          await slot.agent.run();
        }
      });
    } finally {
      publish(who.id, { type: 'working', working: false });
    }
  }

  /**
   * Delivers an event to the person's agent and runs it. Resolves when the agent is idle again.
   * A wake during a run delivers at the run's next delivery point, and asks for one more run in
   * case the run had already passed it.
   */
  function wake(who: Person, event: Event): Promise<void> {
    const slot = slotFor(who);
    slot.agent.deliver(event);
    slot.wanted = true;
    slot.running ??= runWhileWanted(who, slot)
      .catch((error) => console.error(`The agent ${who.id} failed:`, error))
      .finally(() => (slot.running = undefined));
    return slot.running;
  }

  return {
    sql,
    mode,
    bus,
    docs,
    person,
    sessions: pgStore(sql),
    isWorking: (id: string) => agents.get(id)?.running !== undefined,

    /** In demo mode, the invented people; with Google, the people who have signed in. */
    async people(): Promise<Person[]> {
      return sql<Person[]>`select id, email, name from people order by name`;
    },

    /** Writes the demo people's rows, so they can sign in. */
    async seedDemoPeople() {
      for (const p of demoPeople()) {
        await sql`insert into people (id, email, name) values (${p.id}, ${p.email}, ${p.name}) on conflict (id) do nothing`;
      }
    },

    /**
     * Writes the agent's seed documents if it has none, as the docs plugin does when a session
     * opens, so the documents page has something to show before the first run.
     */
    async seedDocs(who: Person) {
      const store = docs(who.id);
      for (const seed of seedsFor(who)) {
        if ((await store.get(seed.name)) === undefined) await store.put({ ...seed, pinned: seed.pinned ?? true, writtenBy: 'seed' });
      }
    },

    send(who: Person, text: string) {
      return wake(who, { kind: 'message', attrs: { from: who.name }, text });
    },

    tick(who: Person) {
      return wake(who, { kind: 'tick', attrs: { from: 'scheduler', at: new Date().toISOString() }, text: 'Check for new mail that needs the person.' });
    },

    proposals: (who: Person) => listProposals(sql, who.id),

    /** Sends what was accepted, then wakes the agent. `run` resolves when the agent is idle again. */
    async decide(who: Person, id: string, decision: Decision): Promise<{ run: Promise<void> }> {
      const proposal = (await listProposals(sql, who.id)).find((p) => p.id === id);
      if (proposal === undefined) throw new Error(`No proposal ${id}.`);
      const event = await decide(sql, google(who.id), proposal, decision);
      const decided = (await listProposals(sql, who.id)).find((p) => p.id === id)!;
      publish(who.id, { type: 'proposal', proposal: decided });
      return { run: wake(who, event) };
    },

    async outbox(who: Person) {
      return sql<{ id: number; kind: string; input: Record<string, string>; sent_at: Date }[]>`
        select id, kind, input, sent_at from outbox where agent = ${who.id} order by sent_at desc`;
    },
  };
}
