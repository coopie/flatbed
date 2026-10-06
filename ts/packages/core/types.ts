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
export type Stop = 'end' | 'toolUse' | 'maxTokens' | 'error';

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
  parent?: { session: string; reason: 'reset' | 'fork' | 'dispatch'; entry?: string };
};

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
};

export type PluginContext = {
  agent: AgentConfig;
  session: Session;
  /** Adds a `custom` entry, or an `event`, to the open session. */
  append(entry: EntryBody<CustomEntry | EventEntry>): Promise<void>;
  /** Queues an event for the next delivery point. */
  deliver(event: Event): void;
};

export type ToolContext = PluginContext & { requestReset(reason?: string): void };

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
