/**
 * A scripted fake model for tests. It answers each request with the next scripted message, or calls
 * the next scripted function with the request, and records every request it receives.
 */
import type { AssistantMessage, Provider, ProviderRequest } from '../types.ts';

export type Scripted = Partial<Omit<AssistantMessage, 'role'>> & Pick<AssistantMessage, 'content'>;
export type ScriptStep = Scripted | ((request: ProviderRequest) => Scripted | Promise<Scripted>);

export type FauxProvider = Provider & { requests: ProviderRequest[] };

export function fauxProvider(script: ScriptStep[]): FauxProvider {
  const steps = [...script];
  const requests: ProviderRequest[] = [];
  return {
    requests,
    async complete(request) {
      const { signal, ...recorded } = request;
      requests.push(structuredClone(recorded));
      const step = steps.shift();
      if (step === undefined) throw new Error('No more scripted responses.');
      const scripted = typeof step === 'function' ? await step(request) : step;
      return {
        role: 'assistant',
        content: scripted.content,
        model: `faux/${request.model}`,
        usage: scripted.usage ?? { input: 0, output: 0 },
        stop: scripted.stop ?? (scripted.content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'end'),
      };
    },
  };
}
