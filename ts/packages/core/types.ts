/**
 * The types flatbed holds: sessions and their entries, messages in flatbed's own format, and the
 * shapes of plugins, tools, providers and stores. docs/spec/ is the contract these follow.
 */

export type JsonSchema = Record<string, unknown>;

// Content blocks and messages, as docs/spec/sessions.md describes.

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; mimeType: string; data: string };
export type ThinkingBlock = { type: 'thinking'; text: string; signature?: string; provider?: string };
export type ToolCall = { type: 'toolCall'; id: string; name: string; input: Record<string, unknown> };
export type Block = TextBlock | ImageBlock | ThinkingBlock | ToolCall;

export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
export type Stop = 'end' | 'toolUse' | 'maxTokens' | 'refusal' | 'error';

export type UserMessage = { role: 'user'; content: (TextBlock | ImageBlock)[] };
export type AssistantMessage = { role: 'assistant'; content: Block[]; model: string; usage: Usage; stop: Stop };
export type ToolMessage = { role: 'tool'; callId: string; name: string; content: (TextBlock | ImageBlock)[]; isError: boolean };
export type Message = UserMessage | AssistantMessage | ToolMessage;

// Sessions.

export type Section = { name: string; text: string; cache?: boolean };
export type ToolDefinition = { name: string; description: string; inputSchema: JsonSchema };
export type Event = { kind: string; attrs?: Record<string, string>; text: string };

export type Header = {
  type: 'session';
  version: 1;
  id: string;
  agent: string;
  createdAt: string;
  parent?: ParentLink;
};

/** Links a session to the one it came from. `agent` names the parent session's agent when it is another. */
export type ParentLink = { session: string; reason: 'reset' | 'fork' | 'dispatch' | 'supervise'; entry?: string; agent?: string };

type EntryBase = { id: string; parentId: string | null; at: string };
export type ContextEntry = EntryBase & { type: 'context'; sections: Section[]; tools: ToolDefinition[] };
export type MessageEntry = EntryBase & { type: 'message'; message: Message };
export type EventEntry = EntryBase & { type: 'event' } & Event;
export type ResetEntry = EntryBase & { type: 'reset'; by: 'agent' | 'harness'; reason?: string };
export type CustomEntry = EntryBase & { type: 'custom'; plugin: string; data: unknown };
export type Entry = ContextEntry | MessageEntry | EventEntry | ResetEntry | CustomEntry;

/** An entry before the store gives it an id, a parent and a time. */
export type EntryBody<E extends Entry = Entry> = E extends Entry ? Omit<E, keyof EntryBase> : never;

export type Session = { header: Header; entries: Entry[] };

/**
 * Where sessions live. The file store and the memory store implement it here; a Postgres store
 * can implement it elsewhere. Sessions are only ever created and appended to.
 */
export type Store = {
  /** The agent's session ids, oldest first. */
  list(agent: string): Promise<string[]>;
  read(agent: string, session: string): Promise<Session>;
  create(header: Header): Promise<void>;
  append(agent: string, session: string, entry: Entry): Promise<void>;
};

// Providers, as docs/spec/providers.md describes.

export type ProviderRequest = {
  model: string;
  sections: Section[];
  tools: ToolDefinition[];
  messages: Message[];
  maxTokens: number;
  outputSchema?: JsonSchema;
  /** How much effort the model should spend, for providers that take it, such as `low` or `high`. */
  effort?: string;
  signal?: AbortSignal;
};

export type Provider = { complete(request: ProviderRequest): Promise<AssistantMessage> };

// Agents, plugins and tools, as docs/spec/plugins.md describes.

export type AgentConfig = {
  id: string;
  /** `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5`. */
  model: string;
  plugins?: Plugin[];
  softLimit?: number;
  hardLimit?: number;
  maxTokens?: number;
  /** Passed through to providers that take it. */
  effort?: string;
  /** Whether a turn's tool calls run together or one after another. `concurrent` by default. */
  toolExecution?: 'concurrent' | 'serial';
  /** The most of a turn's tool calls that run at once when concurrent. 4 by default, and at least 1. */
  maxConcurrentTools?: number;
  /** The parent of the agent's first session, such as the session that dispatched it. */
  parent?: ParentLink;
};

export type PluginContext = {
  agent: AgentConfig;
  session: Session;
  /** Adds a `custom` entry to the open session. Events go through `deliver`. */
  append(entry: EntryBody<CustomEntry>): Promise<void>;
  /** Queues an event for the next delivery point, which is never between a call and its result. */
  deliver(event: Event): void;
  /** The run's stop signal, so that a long hook or tool can stop when the run is stopped. */
  signal: AbortSignal;
};

export type ToolContext = PluginContext & {
  requestReset(reason?: string): void;
  /**
   * Runs another call as the loop runs the model's calls, through the same hooks and under the turn's
   * limit, and returns its result without appending a `tool` message. The calling tool gives up its
   * place under the limit while it waits.
   */
  runTool(call: ToolCall): Promise<ToolResult>;
};

export type ToolResult = { content: (TextBlock | ImageBlock)[]; isError: boolean };

export type Tool = ToolDefinition & {
  run(input: Record<string, unknown>, ctx: ToolContext): ToolResult | string | Promise<ToolResult | string>;
};

type Maybe<T> = T | undefined | void | Promise<T | undefined | void>;

export type Plugin = {
  name: string;
  context?(ctx: PluginContext): Maybe<{ sections?: Section[]; tools?: Tool[] }>;
  beforeTool?(call: ToolCall, ctx: ToolContext): Maybe<ToolResult>;
  afterTool?(call: ToolCall, result: ToolResult, ctx: ToolContext): Maybe<ToolResult>;
  onEntry?(entry: Entry, ctx: PluginContext): unknown;
  onSessionEnd?(session: Session, ctx: PluginContext): unknown;
};

export type RunOutcome = 'idle' | 'reset' | 'stopped' | 'error';
