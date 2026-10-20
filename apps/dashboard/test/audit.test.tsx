import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MEMBER_ID, admin, auditEntry, member } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

describe('audit page', () => {
  it('turns filters into the query string (admin can filter by user)', async () => {
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/users': json({ users: [admin, member] }),
      'GET /api/audit': json({ items: [auditEntry('1')], nextCursor: null }),
    });
    const { user } = renderApp('/audit');
    await screen.findByText('list_orders');

    await user.selectOptions(screen.getByLabelText('User'), MEMBER_ID);
    await user.type(screen.getByLabelText('Server'), 'woo');
    await user.type(screen.getByLabelText('Tool'), 'list_orders');
    await user.selectOptions(screen.getByLabelText('Outcome'), 'error');
    // user-event cannot type into datetime-local inputs; set them the way the picker does.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20T09:30' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-21T18:00' } });
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => expect(callsTo('GET', '/api/audit')).toHaveLength(2));
    const q = callsTo('GET', '/api/audit')[1]!.query;
    expect(q.get('userId')).toBe(MEMBER_ID);
    expect(q.get('serverSlug')).toBe('woo');
    expect(q.get('tool')).toBe('list_orders');
    expect(q.get('outcome')).toBe('error');
    expect(q.get('from')).toBe(new Date('2026-10-20T09:30').toISOString());
    expect(q.get('to')).toBe(new Date('2026-10-21T18:00').toISOString());
    expect(q.has('cursor')).toBe(false);
  });

  it('member has no user filter', async () => {
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/audit': json({ items: [], nextCursor: null }),
    });
    renderApp('/audit');
    expect(await screen.findByText('No audit entries.')).toBeTruthy();
    expect(screen.queryByLabelText('User')).toBeNull();
    expect(callsTo('GET', '/api/audit')[0]!.query.has('userId')).toBe(false);
  });

  it('"Load more" requests the next page with nextCursor and appends it', async () => {
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/audit': (req) =>
        req.query.get('cursor') === 'page-2'
          ? json({ items: [auditEntry('1', { tool: 'get_order' })], nextCursor: null })
          : json({ items: [auditEntry('2')], nextCursor: 'page-2' }),
    });
    const { user } = renderApp('/audit');
    await screen.findByText('list_orders');

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('get_order')).toBeTruthy();
    expect(screen.getByText('list_orders')).toBeTruthy();
    expect(callsTo('GET', '/api/audit')[1]!.query.get('cursor')).toBe('page-2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
