/**
 * Any chat-completions-compatible endpoint over fetch. Sections are joined into one system message,
 * and thinking blocks are dropped, since the format has no place for them.
 */
import type { AssistantMessage, Block, ImageBlock, Message, Provider, ProviderRequest, Stop, TextBlock } from '../types.ts';
import { postJson } from './http.ts';

type ChatMessage = Record<string, unknown> & { role: string };

export function openaiProvider(options: { apiKey: string; baseUrl?: string }): Provider {
  const url = `${options.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
  const headers = { authorization: `Bearer ${options.apiKey}` };
  return {
    async complete(request) {
      const response = await postJson(url, headers, openaiRequest(request), request.signal);
      return fromOpenai(response as OpenaiResponse, request.model);
    },
  };
}

/** The request body. Exported for the adapter's tests. */
export function openaiRequest(request: ProviderRequest): Record<string, unknown> {
  const system = request.sections.map((s) => s.text).join('\n\n');
  const tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...request.messages.flatMap(toOpenai)],
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.effort === undefined ? {} : { reasoning_effort: request.effort }),
    ...(request.outputSchema
      ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: request.outputSchema, strict: true } } }
      : {}),
  };
}

const part = (block: TextBlock | ImageBlock) =>
  block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } };

function toOpenai(message: Message): ChatMessage[] {
  if (message.role === 'user') return [{ role: 'user', content: message.content.map(part) }];
  if (message.role === 'tool') {
    // Tool messages take text only; an image in a result is described rather than sent.
    const text = message.content.map((b) => (b.type === 'text' ? b.text : `[image ${b.mimeType}]`)).join('\n');
    return [{ role: 'tool', tool_call_id: message.callId, content: message.isError ? `Error: ${text}` : text }];
  }
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const calls = message.content.flatMap((b) =>
    b.type === 'toolCall' ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
  );
  if (text === '' && calls.length === 0) return [];
  return [{ role: 'assistant', content: text === '' ? null : text, ...(calls.length > 0 ? { tool_calls: calls } : {}) }];
}

type OpenaiResponse = {
  choices: {
    message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
};

/** The assistant message for a response. Exported for the adapter's tests. */
export function fromOpenai(response: OpenaiResponse, model: string): AssistantMessage {
  const choice = response?.choices?.[0];
  if (choice === undefined) throw new Error('The response had no choices.');
  const content: Block[] = [];
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    // Input that is not JSON fails the call, which the loop records as a failed model call.
    const input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    content.push({ type: 'toolCall', id: call.id, name: call.function.name, input });
  }
  // Any other reason maps to end.
  const stops: Record<string, Stop> = { tool_calls: 'toolUse', length: 'maxTokens', content_filter: 'refusal' };
  const cached = response.usage?.prompt_tokens_details?.cached_tokens;
  return {
    role: 'assistant',
    content,
    model: `openai/${model}`,
    usage: {
      // OpenAI counts cached tokens inside prompt_tokens; flatbed counts them apart.
      input: (response.usage?.prompt_tokens ?? 0) - (cached ?? 0),
      output: response.usage?.completion_tokens ?? 0,
      ...(cached ? { cacheRead: cached } : {}),
    },
    stop: stops[choice.finish_reason] ?? 'end',
  };
}
