import { screen, waitFor, within } from '@testing-library/react';
import { UserSchema, type User } from '@urumi/contracts';
import { describe, expect, it, vi } from 'vitest';
import { KEY_ID, MEMBER_ID, admin, apiKey, member } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

const TEMP = 'Temp-Password-For-New-Member-1';

function setup() {
  let users: User[] = [admin, member];
  const stub = stubApi({
    'GET /api/auth/me': json({ user: admin }),
    'GET /api/users': () => json({ users }),
    'POST /api/users': (req) => {
      const body = req.body as { email: string; name: string; role: 'admin' | 'member' };
      const user = UserSchema.parse({
        ...member,
        ...body,
        id: crypto.randomUUID(),
      });
      users = [...users, user];
      return json({ user, tempPassword: TEMP }, 201);
    },
    'PATCH /api/users/:id': (req) => {
      const patch = req.body as { role?: 'admin' | 'member'; disabled?: boolean };
      users = users.map((u) =>
        u.id !== req.params.id
          ? u
          : {
              ...u,
              ...(patch.role ? { role: patch.role } : {}),
              ...(patch.disabled !== undefined
                ? { disabledAt: patch.disabled ? '2026-10-21T00:00:00.000Z' : null }
                : {}),
            },
      );
      return json({ user: users.find((u) => u.id === req.params.id) });
    },
    'GET /api/users/:id/keys': json({ keys: [apiKey()] }),
    'DELETE /api/users/:id/keys/:keyId': { status: 204 },
  });
  return { ...stub, ...renderApp('/members') };
}

describe('members page (admin)', () => {
  it('creates a member and shows the temp password once', async () => {
    const { user, callsTo } = setup();
    await screen.findByText('member@example.com');
    const form = screen.getByRole('form', { name: 'Create member' });
    await user.type(within(form).getByLabelText('Email'), 'new@example.com');
    await user.type(within(form).getByLabelText('Name'), 'New Person');
    await user.click(within(form).getByRole('button', { name: 'Create member' }));

    const panel = await screen.findByRole('region', { name: 'Temporary password' });
    expect(within(panel).getByText(TEMP)).toBeTruthy();
    expect(within(panel).getByText(/shown only once/)).toBeTruthy();
    expect(callsTo('POST', '/api/users')[0]!.body).toEqual({
      email: 'new@example.com',
      name: 'New Person',
      role: 'member',
    });
    expect(await screen.findByText('new@example.com')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'Dismiss' }));
    expect(document.body.textContent).not.toContain(TEMP);
  });

  it('changes role and disables/enables a member', async () => {
    const { user, callsTo } = setup();
    const row = (await screen.findByText('member@example.com')).closest('tr')!;
    await user.selectOptions(within(row).getByLabelText('Role for member@example.com'), 'admin');
    await waitFor(() => expect(callsTo('PATCH', `/api/users/${MEMBER_ID}`)).toHaveLength(1));
    expect(callsTo('PATCH', `/api/users/${MEMBER_ID}`)[0]!.body).toEqual({ role: 'admin' });

    await user.click(within(row).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(callsTo('PATCH', `/api/users/${MEMBER_ID}`)).toHaveLength(2));
    expect(callsTo('PATCH', `/api/users/${MEMBER_ID}`)[1]!.body).toEqual({ disabled: true });
    expect(await within(row).findByRole('button', { name: 'Enable' })).toBeTruthy();
  });

  it("views a member's keys and revokes one", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, callsTo } = setup();
    const row = (await screen.findByText('member@example.com')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Show keys' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke laptop' }));
    await waitFor(() =>
      expect(callsTo('DELETE', `/api/users/${MEMBER_ID}/keys/${KEY_ID}`)).toHaveLength(1),
    );
  });
});
