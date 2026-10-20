import { screen, waitFor, within } from '@testing-library/react';
import type { ApiKey } from '@urumi/contracts';
import { describe, expect, it, vi } from 'vitest';
import { KEY_ID, SECRET, apiKey, member } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

function setup(initial: ApiKey[] = []) {
  let keys = initial;
  const stub = stubApi({
    'GET /api/auth/me': json({ user: member }),
    'GET /api/keys': () => json({ keys }),
    'POST /api/keys': (req) => {
      const key = apiKey({ name: (req.body as { name: string }).name });
      keys = [...keys, key];
      return json({ key, secret: SECRET }, 201);
    },
    'DELETE /api/keys/:id': () => {
      keys = keys.map((k) => ({ ...k, revokedAt: '2026-10-21T00:00:00.000Z' }));
      return { status: 204 };
    },
  });
  return { ...stub, ...renderApp('/keys') };
}

describe('my keys', () => {
  it('shows the secret once with an MCP snippet, then forgets it', async () => {
    const { user, callsTo } = setup();
    await user.type(await screen.findByLabelText('Key name'), 'laptop');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    const dialog = await screen.findByRole('dialog', { name: 'Your new API key' });
    expect(within(dialog).getAllByText(SECRET, { exact: false }).length).toBeGreaterThan(0);
    const snippet = within(dialog).getByTestId('mcp-snippet').textContent!;
    expect(snippet).toContain(`${window.location.origin}/mcp`);
    expect(snippet).toContain(`"Authorization": "Bearer ${SECRET}"`);
    expect(within(dialog).getByText(/will not be shown again/)).toBeTruthy();
    expect(callsTo('POST', '/api/keys')[0]!.body).toEqual({ name: 'laptop' });

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
    // The list shows only the prefix.
    expect(await screen.findByText('urk_abcd')).toBeTruthy();
  });

  it('lists keys with prefix, dates and status', async () => {
    setup([
      apiKey(),
      apiKey({
        id: crypto.randomUUID(),
        name: 'old',
        revokedAt: '2026-10-20T12:00:00.000Z',
        lastUsedAt: '2026-10-20T11:00:00.000Z',
      }),
    ]);
    const row = (await screen.findByText('laptop')).closest('tr')!;
    expect(within(row).getByText('urk_abcd')).toBeTruthy();
    expect(within(row).getByText('never')).toBeTruthy();
    expect(within(row).getByText('active')).toBeTruthy();
    const old = screen.getByText('old').closest('tr')!;
    expect(within(old).getByText(/revoked/)).toBeTruthy();
    expect(within(old).queryByRole('button', { name: /Revoke/ })).toBeNull();
  });

  it('revokes after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { user, callsTo } = setup([apiKey()]);
    const revoke = await screen.findByRole('button', { name: 'Revoke laptop' });

    await user.click(revoke);
    expect(callsTo('DELETE', `/api/keys/${KEY_ID}`)).toHaveLength(0);

    await user.click(revoke);
    await waitFor(() => expect(callsTo('DELETE', `/api/keys/${KEY_ID}`)).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/revoked/)).toBeTruthy();
  });
});
