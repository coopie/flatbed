/**
 * The Anthropic Messages API over fetch. Sections become system blocks, `tool` messages become
 * `tool_result` blocks in user messages, and `outputSchema` becomes `output_config.format`.
 */
import type { AssistantMessage, Block, ImageBlock, Message, Provider, ProviderRequest, Stop, TextBlock } from '../types.ts';
import { postJson } from './http.ts';

type ApiBlock = Record<string, unknown> & { type: string };
type ApiMessage = { role: 'user' | 'assistant'; content: ApiBlock[] };

const EPHEMERAL = { type: 'ephemeral' } as const;

export function anthropicProvider(options: { apiKey: string; baseUrl?: string }): Provider {
  const url = `${options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
  const headers = { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' };
  return {
    async complete(request) {
      const response = await postJson(url, headers, anthropicRequest(request), request.signal);
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
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.sections.map((s) => ({ type: 'text', text: s.text, ...(s.cache ? { cache_control: EPHEMERAL } : {}) })),
    ...(tools.length > 0 ? { tools } : {}),
    messages: toAnthropicMessages(request.messages),
    ...(request.outputSchema ? { output_config: { format: { type: 'json_schema', schema: request.outputSchema } } } : {}),
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
    if (message.role === 'user') push('user', message.content.map(toAnthropicBlock));
    else if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.callId, content: message.content.map(toAnthropicBlock), is_error: message.isError }]);
    } else {
      const content = message.content.flatMap(toAnthropicAssistantBlock);
      // An assistant message left empty by a failed call has nothing to send.
      if (content.length > 0) push('assistant', content);
    }
  }
  return out;
}

function toAnthropicBlock(block: TextBlock | ImageBlock): ApiBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } };
}

function toAnthropicAssistantBlock(block: Block): ApiBlock[] {
  switch (block.type) {
    case 'text':
    case 'image':
      return [toAnthropicBlock(block)];
    case 'toolCall':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
    case 'thinking':
      // Thinking goes back only to the provider that made it.
      return block.provider === 'anthropic' ? [{ type: 'thinking', thinking: block.text, signature: block.signature ?? '' }] : [];
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
    if (block.type === 'thinking') return [{ type: 'thinking', text: String(block.thinking), signature: String(block.signature), provider: 'anthropic' }];
    return [];
  });
  const { usage } = response;
  const stops: Record<string, Stop> = { tool_use: 'toolUse', max_tokens: 'maxTokens' };
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
