/**
 * The Anthropic Messages API over fetch. Sections become system blocks, `tool` messages become
 * `tool_result` blocks in user messages, and `outputSchema` and `effort` go in `output_config`.
 * Empty text blocks are dropped everywhere, since the API rejects them.
 */
import type { AssistantMessage, Block, ImageBlock, Message, Provider, ProviderRequest, Stop, TextBlock } from '../types.ts';
import { postJson, type ProviderOptions } from './http.ts';

type ApiBlock = Record<string, unknown> & { type: string };
type ApiMessage = { role: 'user' | 'assistant'; content: ApiBlock[] };

const EPHEMERAL = { type: 'ephemeral' } as const;
/** The API allows at most four cache breakpoints in a request. */
const MAX_BREAKPOINTS = 4;

export function anthropicProvider(options: ProviderOptions): Provider {
  const url = `${options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
  const headers = { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' };
  return {
    async complete(request) {
      const response = await postJson(url, headers, anthropicRequest(request), request.signal, options.timeout);
      return fromAnthropic(response as AnthropicResponse, request.model);
    },
  };
}

/** The request body. Exported for the adapter's tests. */
export function anthropicRequest(request: ProviderRequest): Record<string, unknown> {
  const tools = request.tools.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(i === request.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
  // One breakpoint goes on the history, through the top-level `cache_control`, and one after the
  // tools when there are any. The earliest sections marked `cache: true` get the rest.
  let sectionBreakpoints = MAX_BREAKPOINTS - 1 - (tools.length > 0 ? 1 : 0);
  const system = request.sections
    .filter((s) => s.text !== '')
    .map((s) => {
      const cache = s.cache === true && sectionBreakpoints-- > 0;
      return { type: 'text', text: s.text, ...(cache ? { cache_control: EPHEMERAL } : {}) };
    });
  const outputConfig = {
    ...(request.outputSchema ? { format: { type: 'json_schema', schema: request.outputSchema } } : {}),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
  };
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    cache_control: EPHEMERAL,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    messages: toAnthropicMessages(request.messages),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

function toAnthropicMessages(messages: Message[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  const push = (role: ApiMessage['role'], content: ApiBlock[]) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      const content = message.content.flatMap(toAnthropicBlock);
      const result = content.length > 0 ? content : [{ type: 'text', text: '(no output)' }];
      push('user', [{ type: 'tool_result', tool_use_id: message.callId, content: result, is_error: message.isError }]);
    } else {
      const content = message.role === 'user' ? message.content.flatMap(toAnthropicBlock) : message.content.flatMap(toAnthropicAssistantBlock);
      // A message left empty, such as the assistant message a failed call leaves, has nothing to send.
      if (content.length > 0) push(message.role, content);
    }
  }
  // The API wants a user message's tool results before anything else in it.
  for (const message of out) {
    if (message.role === 'user') message.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  }
  return out;
}

function toAnthropicBlock(block: TextBlock | ImageBlock): ApiBlock[] {
  if (block.type === 'text') return block.text === '' ? [] : [{ type: 'text', text: block.text }];
  return [{ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }];
}

function toAnthropicAssistantBlock(block: Block): ApiBlock[] {
  switch (block.type) {
    case 'text':
    case 'image':
      return toAnthropicBlock(block);
    case 'toolCall':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
    case 'thinking':
      // Thinking goes back only to the provider that made it.
      if (block.provider !== 'anthropic') return [];
      return [{ type: 'thinking', thinking: block.text, ...(block.signature === undefined ? {} : { signature: block.signature }) }];
  }
}

type AnthropicResponse = {
  content: ApiBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
};

/** The assistant message for a response. Exported for the adapter's tests. */
export function fromAnthropic(response: AnthropicResponse, model: string): AssistantMessage {
  if (!Array.isArray(response?.content) || typeof response.usage?.input_tokens !== 'number') {
    throw new Error('The Anthropic response had no content or usage.');
  }
  const content: Block[] = response.content.flatMap((block): Block[] => {
    if (block.type === 'text') return [{ type: 'text', text: String(block.text) }];
    if (block.type === 'tool_use') return [{ type: 'toolCall', id: String(block.id), name: String(block.name), input: block.input as Record<string, unknown> }];
    if (block.type === 'thinking') {
      // A missing signature is left out, never stored as the string "undefined".
      const signature = typeof block.signature === 'string' ? { signature: block.signature } : {};
      return [{ type: 'thinking', text: String(block.thinking), ...signature, provider: 'anthropic' }];
    }
    return [];
  });
  const { usage } = response;
  // Any other reason, such as end_turn or pause_turn, maps to end.
  const stops: Record<string, Stop> = { tool_use: 'toolUse', max_tokens: 'maxTokens', refusal: 'refusal' };
  return {
    role: 'assistant',
    content,
    model: `anthropic/${model}`,
    usage: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      ...(typeof usage.cache_read_input_tokens === 'number' ? { cacheRead: usage.cache_read_input_tokens } : {}),
      ...(typeof usage.cache_creation_input_tokens === 'number' ? { cacheWrite: usage.cache_creation_input_tokens } : {}),
    },
    stop: stops[response.stop_reason] ?? 'end',
  };
}
