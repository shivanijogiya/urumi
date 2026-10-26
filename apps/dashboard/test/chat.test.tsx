import { screen, within } from '@testing-library/react';
import type { ChatRequest } from '@urumi/contracts';
import { describe, expect, it } from 'vitest';
import { member } from './fixtures.js';
import { envelope, json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

describe('chat page', () => {
  it('sends the full history and renders each reply with the tools used', async () => {
    const replies = [
      {
        reply: 'You have 3 orders today.',
        toolCalls: [
          {
            name: 'woo__list_orders',
            serverSlug: 'woo',
            outcome: 'ok',
            durationMs: 120,
            errorCode: null,
          },
        ],
      },
      { reply: 'Order 42 is processing.', toolCalls: [] },
    ];
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'POST /api/chat': () => json(replies.shift()),
    });
    const { user } = renderApp('/chat');

    await user.type(await screen.findByLabelText('Message'), 'How many orders today?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('You have 3 orders today.')).toBeTruthy();
    const tools = screen.getByRole('list', { name: 'Tools used' });
    expect(within(tools).getByText('woo__list_orders')).toBeTruthy();
    expect(within(tools).getByText('woo')).toBeTruthy();
    expect(within(tools).getByText('ok')).toBeTruthy();
    expect(within(tools).getByText('120 ms')).toBeTruthy();

    await user.type(screen.getByLabelText('Message'), 'And order 42?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Order 42 is processing.')).toBeTruthy();

    const bodies = callsTo('POST', '/api/chat').map((c) => c.body as ChatRequest);
    expect(bodies[0]!.messages).toEqual([{ role: 'user', content: 'How many orders today?' }]);
    expect(bodies[1]!.messages).toEqual([
      { role: 'user', content: 'How many orders today?' },
      { role: 'assistant', content: 'You have 3 orders today.' },
      { role: 'user', content: 'And order 42?' },
    ]);
  });

  it('disables send while a reply is pending', async () => {
    let release: () => void = () => {};
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'POST /api/chat': () =>
        new Promise((resolve) => {
          release = () => resolve(json({ reply: 'done', toolCalls: [] }));
        }),
    });
    const { user } = renderApp('/chat');
    await user.type(await screen.findByLabelText('Message'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Thinking…')).toBeTruthy();
    // Even with new text in the box, sending waits for the pending reply.
    await user.type(screen.getByLabelText('Message'), 'second');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await screen.findByText('done')).toBeTruthy();
  });

  it('shows the envelope error, e.g. chat not configured', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'POST /api/chat': envelope(503, 'INTERNAL', 'Chat is not configured'),
    });
    const { user } = renderApp('/chat');
    await user.type(await screen.findByLabelText('Message'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Chat is not configured');
    // The unanswered message goes back into the box instead of into the history.
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('discovery mode: says so, shows the searches and the real tools executed (ADR 012)', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'POST /api/chat': json({
        reply: 'Refunded.',
        toolMode: 'discovery',
        discoverySearches: [
          { query: 'refund payment', resultCount: 1, top: ['synth__refund_payment'] },
        ],
        toolCalls: [
          {
            name: 'synth__refund_payment',
            serverSlug: 'synth',
            outcome: 'ok',
            durationMs: 40,
            errorCode: null,
            via: 'discovery',
          },
        ],
      }),
    });
    const { user } = renderApp('/chat');
    await user.type(await screen.findByLabelText('Message'), 'Refund order 1');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Refunded.')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('Discovery mode');
    const searches = screen.getByRole('list', { name: 'Tool searches' });
    expect(searches.textContent).toContain('refund payment');
    expect(searches.textContent).toContain('1 match');
    const tools = screen.getByRole('list', { name: 'Tools used' });
    expect(within(tools).getByText('synth__refund_payment')).toBeTruthy();
    expect(within(tools).getByText('via gateway__call_tool')).toBeTruthy();
    expect(screen.getByText('Tools executed')).toBeTruthy();
  });
});
