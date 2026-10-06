/**
 * The slice of flatbed's session and provider types the supervisor reads, as
 * docs/spec/sessions.md and docs/spec/providers.md define them.
 *
 * These are local copies because @flatbed/core was built at the same time. Replace them with
 * imports from @flatbed/core once it lands; the shapes are the spec's, so nothing else changes.
 */

export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; mimeType: string; data: string }
	| { type: 'thinking'; text: string; signature?: string; provider?: string }
	| { type: 'toolCall'; id: string; name: string; input: unknown };

export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export type UserMessage = { role: 'user'; content: ContentBlock[] };
export type AssistantMessage = {
	role: 'assistant';
	content: ContentBlock[];
	model: string;
	usage: Usage;
	stop: 'end' | 'toolUse' | 'maxTokens' | 'error';
};
export type ToolMessage = {
	role: 'tool';
	callId: string;
	name: string;
	content: ContentBlock[];
	isError: boolean;
};
export type Message = UserMessage | AssistantMessage | ToolMessage;

export type Section = { name: string; text: string; cache?: boolean };
export type ToolDefinition = { name: string; description: string; inputSchema: object };

type EntryBase = { id: string; parentId: string | null; at: string };
export type Entry = EntryBase &
	(
		| { type: 'context'; sections: Section[]; tools: ToolDefinition[] }
		| { type: 'message'; message: Message }
		| { type: 'event'; kind: string; attrs?: Record<string, string>; text: string }
		| { type: 'reset'; by: 'agent' | 'harness'; reason: string }
		| { type: 'custom'; plugin: string; data: unknown }
	);

export type CompleteRequest = {
	model: string;
	sections: Section[];
	tools: ToolDefinition[];
	messages: Message[];
	maxTokens: number;
	outputSchema?: object;
	signal?: AbortSignal;
};

/** One provider call, as docs/spec/providers.md describes it. */
export type Complete = (request: CompleteRequest) => Promise<AssistantMessage>;
