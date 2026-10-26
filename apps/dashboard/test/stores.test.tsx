// Stores page (ADR 015), admin only: built-in store (not deletable), provisioned stores with status
// + reason + storefront, create (slug, name, admin email; no password anywhere), delete with
// confirmation, Retry on a failed store, and the limit.
import { screen, waitFor, within } from '@testing-library/react';
import type { Store } from '@urumi/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admin, member, UPSTREAM_ID } from './fixtures.js';
import { envelope, json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: UPSTREAM_ID,
    slug: 'shop2',
    name: 'Shop Two',
    adminEmail: 'owner@example.com',
    namespace: 'store-shop2',
    storefrontUrl: 'http://shop2.store.localtest.me',
    phase: 'ready',
    reason: null,
    upstreamEnabled: true,
    upstreamStatus: 'up',
    toolCount: 5,
    generation: 1,
    provisionStartedAt: '2026-10-26T05:00:00.000Z',
    createdAt: '2026-10-26T05:00:00.000Z',
    updatedAt: '2026-10-26T05:01:00.000Z',
    ...overrides,
  };
}
const list = (stores: Store[], extra: Record<string, unknown> = {}) =>
  json({
    enabled: true,
    maxStores: 3,
    domainSuffix: 'store.localtest.me',
    builtIn: { name: 'Urumi Store', slug: 'woo', storefrontUrl: 'http://store.localtest.me' },
    stores,
    ...extra,
  });

afterEach(() => vi.restoreAllMocks());

describe('stores page', () => {
  it('shows the built-in store (not deletable) and provisioned stores with their status', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/stores': list([
        store(),
        store({
          id: '55555555-5555-4555-8555-555555555555',
          slug: 'shop3',
          name: 'Shop Three',
          phase: 'failed',
          reason: 'Bootstrap job failed (BackoffLimitExceeded)',
          upstreamEnabled: false,
          upstreamStatus: 'unknown',
        }),
      ]),
    });
    renderApp('/stores');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.textContent).toMatch(/Urumi Store.*Built-in.*Not deletable/);
    expect(within(rows[1]!).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(
      within(rows[2]!).getByRole('link', { name: 'http://shop2.store.localtest.me' }),
    ).toBeTruthy();
    expect(rows[2]!.textContent).toMatch(/Ready/);
    expect(rows[3]!.textContent).toMatch(/Failed.*Bootstrap job failed \(BackoffLimitExceeded\)/);
    expect(within(rows[3]!).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByText(/2 of 3 stores/)).toBeTruthy();
  });

  it('creates a store with slug, name and admin email only', async () => {
    const created: Store[] = [];
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/stores': () => list(created),
      'POST /api/stores': (req) => {
        const b = req.body as { slug: string; name: string; adminEmail: string };
        const s = store({
          ...b,
          phase: 'provisioning',
          reason: 'Starting MariaDB',
          upstreamEnabled: false,
        });
        created.push(s);
        return json({ store: s }, 201);
      },
    });
    const { user: u } = renderApp('/stores');
    await u.click(await screen.findByRole('button', { name: 'Create store' }));
    const form = await screen.findByRole('form', { name: 'Create store' });
    await u.type(within(form).getByLabelText(/^Slug/), 'shop2');
    await u.type(within(form).getByLabelText(/^Display name/), 'Shop Two');
    await u.type(within(form).getByLabelText(/^Admin email/), 'owner@example.com');
    expect(form.querySelector('input[type=password]')).toBeNull();
    await u.click(within(form).getByRole('button', { name: 'Create store' }));
    await waitFor(() => expect(callsTo('POST', '/api/stores')).toHaveLength(1));
    expect(callsTo('POST', '/api/stores')[0]!.body).toEqual({
      slug: 'shop2',
      name: 'Shop Two',
      adminEmail: 'owner@example.com',
    });
    expect(await screen.findByText('Starting MariaDB')).toBeTruthy();
    expect(screen.getByText('Provisioning')).toBeTruthy();
  });

  it('shows the API error (e.g. the limit) and disables Create at the limit', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/stores': list([store()], { maxStores: 1 }),
      'POST /api/stores': envelope(
        400,
        'VALIDATION_FAILED',
        'Store limit reached (1 of 1); delete a store first',
      ),
    });
    renderApp('/stores');
    const btn = await screen.findByRole('button', { name: 'Create store' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/limit reached/)).toBeTruthy();
  });

  it('deletes after confirmation; Retry calls the retry route', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/stores': list([
        store({ phase: 'failed', reason: 'Timed out after 10 min: Starting WordPress' }),
      ]),
      'DELETE /api/stores/:id': json({ store: store({ phase: 'deleting' }) }, 202),
      'POST /api/stores/:id/retry': json({
        store: store({ phase: 'provisioning', generation: 2 }),
      }),
    });
    const { user: u } = renderApp('/stores');
    const del = await screen.findByRole('button', { name: 'Delete' });
    confirm.mockReturnValueOnce(false);
    await u.click(del);
    expect(callsTo('DELETE', `/api/stores/${UPSTREAM_ID}`)).toHaveLength(0);
    expect(confirm.mock.calls[0]![0]).toMatch(/namespace store-shop2 is deleted with all data/);
    confirm.mockReturnValueOnce(true);
    await u.click(del);
    await waitFor(() => expect(callsTo('DELETE', `/api/stores/${UPSTREAM_ID}`)).toHaveLength(1));
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(callsTo('POST', `/api/stores/${UPSTREAM_ID}/retry`)).toHaveLength(1),
    );
  });

  it('says so when multi-store is off; members do not get the page', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/stores': list([], { enabled: false, maxStores: 0 }),
    });
    renderApp('/stores');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringMatching(/not enabled/),
    );
    expect(screen.queryByRole('button', { name: 'Create store' })).toBeNull();
  });

  it('is not offered to members', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/upstreams': json({ upstreams: [] }),
    });
    renderApp('/stores');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Stores' })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Stores' })).toBeNull();
  });
});
