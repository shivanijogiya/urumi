// OPTIONAL live smoke test against the real Anthropic API (#19). Skipped unless CHAT_LIVE=1 and
// ANTHROPIC_API_KEY are set. Prints only the reply length and the model ids containing 'sonnet';
// never the key.
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from '../src/chat/anthropic.js';
import { createChatService } from '../src/chat/service.js';

const key = process.env.ANTHROPIC_API_KEY;
const live = process.env.CHAT_LIVE === '1' && Boolean(key);

describe.skipIf(!live)('chat against the live Anthropic API', () => {
  it('answers "Reply with OK" with no tools', async () => {
    const service = createChatService({
      anthropic: createAnthropicClient(key!),
      listTools: async () => [],
      callTool: () => Promise.reject(new Error('no tools in the smoke test')),
      ...(process.env.CHAT_MODEL ? { model: process.env.CHAT_MODEL } : {}),
    });
    const log = { warn: () => undefined, error: (obj: unknown) => console.error(obj) };

    const res = await service.chat(
      { id: '00000000-0000-4000-8000-000000000000', email: 'smoke@example.com' },
      [{ role: 'user', content: 'Reply with OK' }],
      log,
    );

    console.log(`live reply: ${JSON.stringify(res.reply.slice(0, 40))}`);
    expect(res.reply).toMatch(/OK/i);
    expect(res.toolCalls).toEqual([]);
  }, 90_000);

  it('lists the available sonnet model ids', async () => {
    const client = new Anthropic({ apiKey: key!, logLevel: 'off' });
    const ids: string[] = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    const sonnet = ids.filter((id) => id.includes('sonnet'));
    console.log(`sonnet model ids (newest first): ${sonnet.join(', ')}`);
    expect(ids.length).toBeGreaterThan(0);
  }, 30_000);
});
