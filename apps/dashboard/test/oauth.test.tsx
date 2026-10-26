// OAuth consent page, login → consent return, and Connected apps (ADR 013).
import { screen, waitFor, within } from '@testing-library/react';
import type { ConnectedApp } from '@urumi/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeNext } from '../src/auth.js';
import { navigation } from '../src/pages/Consent.js';
import { MEMBER_ID, admin, member } from './fixtures.js';
import { envelope, json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

const REQ = 'R'.repeat(43);
const TOKEN = 'T'.repeat(43);
const INFO = {
  client: { id: crypto.randomUUID(), name: 'Claude Code' },
  redirectHost: 'localhost:33418',
  redirectUri: 'http://localhost:33418/callback',
  scope: 'mcp',
  consentToken: TOKEN,
};

afterEach(() => vi.restoreAllMocks());

describe('consent page', () => {
  it('names the client and redirect host; Approve posts the consent token and follows redirectTo', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => undefined);
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/oauth/requests/:id': json(INFO),
      'POST /api/oauth/requests/:id': json({
        redirectTo: 'http://localhost:33418/callback?code=abc&state=s',
      }),
    });
    const { user } = renderApp(`/consent?request=${REQ}`);
    expect(await screen.findByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('localhost:33418')).toBeTruthy();
    expect(screen.getByText(/not verified/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('http://localhost:33418/callback?code=abc&state=s'),
    );
    expect(callsTo('POST', `/api/oauth/requests/${REQ}`)[0]!.body).toEqual({
      approve: true,
      consentToken: TOKEN,
    });
  });

  it('Deny posts approve=false', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => undefined);
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/oauth/requests/:id': json(INFO),
      'POST /api/oauth/requests/:id': json({
        redirectTo: 'http://localhost:33418/callback?error=access_denied',
      }),
    });
    const { user } = renderApp(`/consent?request=${REQ}`);
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(callsTo('POST', `/api/oauth/requests/${REQ}`)[0]!.body).toEqual({
      approve: false,
      consentToken: TOKEN,
    });
  });

  it('an expired request shows the error and no buttons', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/oauth/requests/:id': envelope(404, 'NOT_FOUND', 'Authorization request not found'),
    });
    renderApp(`/consent?request=${REQ}`);
    expect(await screen.findByText('Authorization request not found')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('signed out: login, then back to the same consent page', async () => {
    let signedIn = false;
    stubApi({
      'GET /api/auth/me': () =>
        signedIn ? json({ user: member }) : envelope(401, 'UNAUTHENTICATED', 'Not signed in'),
      'POST /api/auth/login': () => {
        signedIn = true;
        return json({ user: member });
      },
      'GET /api/oauth/requests/:id': json(INFO),
    });
    const { user } = renderApp(`/consent?request=${REQ}`);
    expect(await screen.findByText('Sign in to connect an app to Urumi.')).toBeTruthy();
    await user.type(screen.getByLabelText('Email'), 'member@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Claude Code')).toBeTruthy();
  });

  it('login `next` accepts only the consent page (no open redirect)', () => {
    expect(safeNext(`/consent?request=${REQ}`)).toBe(`/consent?request=${REQ}`);
    expect(safeNext('https://evil.example.com')).toBeNull();
    expect(safeNext('//evil.example.com')).toBeNull();
    expect(safeNext(`/consent?request=${REQ}&x=//evil`)).toBeNull();
    expect(safeNext('/members')).toBeNull();
  });
});

function app(overrides: Partial<ConnectedApp> = {}): ConnectedApp {
  return {
    id: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    clientName: 'Cursor',
    redirectHosts: ['127.0.0.1:5000'],
    userId: MEMBER_ID,
    userEmail: 'member@example.com',
    scope: 'mcp',
    authorizedAt: '2026-10-26T01:00:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

describe('connected apps', () => {
  it('lists the member’s apps and disconnects one', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const first = app();
    let apps = [first];
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/connected-apps': () => json({ apps }),
      'DELETE /api/connected-apps/:id': () => {
        apps = [];
        return { status: 204 };
      },
    });
    const { user } = renderApp('/connected-apps');
    const row = (await screen.findByText('Cursor')).closest('tr')!;
    expect(within(row).getByText('127.0.0.1:5000')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'User' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('No connected apps.')).toBeTruthy();
    expect(callsTo('DELETE', `/api/connected-apps/${first.id}`)).toHaveLength(1);
  });

  it('admins see the user column', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/connected-apps': json({ apps: [app({ userEmail: 'bob@example.com' })] }),
    });
    renderApp('/connected-apps');
    expect(await screen.findByText('bob@example.com')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'User' })).toBeTruthy();
  });
});
