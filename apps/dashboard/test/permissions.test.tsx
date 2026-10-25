import { screen, waitFor, within } from '@testing-library/react';
import { PermissionRuleSchema, type PermissionRule } from '@urumi/contracts';
import { describe, expect, it } from 'vitest';
import { MEMBER_ID, admin, member, tool } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

const rule = (r: Partial<PermissionRule>): PermissionRule =>
  PermissionRuleSchema.parse({
    id: crypto.randomUUID(),
    role: 'member',
    userId: null,
    userEmail: null,
    serverSlug: 'woo',
    tool: 'list_orders',
    effect: 'allow',
    createdAt: '2026-10-21T00:00:00.000Z',
    ...r,
  });

function setup(me = admin) {
  let rules: PermissionRule[] = [
    rule({ role: 'admin', serverSlug: '*', tool: '*' }),
    rule({ tool: 'list_orders' }),
  ];
  const stub = stubApi({
    'GET /api/auth/me': json({ user: me }),
    'GET /api/users': json({ users: [admin, member] }),
    'GET /api/tools': json({
      tools: [tool(), tool({ name: 'woo__create_product', description: 'Create' })],
    }),
    'GET /api/permissions': () => json({ rules }),
    'POST /api/permissions': (req) => {
      const body = req.body as Partial<PermissionRule>;
      const r = rule({
        role: null,
        userEmail: member.email,
        ...body,
      });
      rules = [...rules, r];
      return json({ rule: r });
    },
    'DELETE /api/permissions/:id': (req) => {
      rules = rules.filter((r) => r.id !== req.params.id);
      return { status: 204 };
    },
    'GET /api/upstreams': json({ upstreams: [] }),
  });
  return { ...stub, ...renderApp('/permissions') };
}

const accessOf = (name: string) =>
  within(screen.getByRole('list', { name: 'Effective tools' }))
    .getByText(name)
    .closest('li')!.textContent;

describe('permissions page (admin)', () => {
  it('lists rules and previews effective access with the shared evaluator', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Rules' });
    expect(within(table).getByText('role: admin')).toBeTruthy();
    await screen.findByRole('list', { name: 'Effective tools' });
    expect(accessOf('woo__list_orders')).toContain('ok');
    expect(accessOf('woo__create_product')).toContain('denied');
  });

  it('adds a per-user grant, which the preview reflects, and deletes it', async () => {
    const { user, callsTo } = setup();
    const form = await screen.findByRole('form', { name: 'Add rule' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: `user: ${member.email}` })).toBeTruthy(),
    );
    await user.selectOptions(within(form).getByLabelText('Subject'), `user:${MEMBER_ID}`);
    await user.type(within(form).getByLabelText('Server'), 'woo');
    await user.type(within(form).getByLabelText('Tool'), 'create_product');
    await user.click(within(form).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(callsTo('POST', '/api/permissions')).toHaveLength(1));
    expect(callsTo('POST', '/api/permissions')[0]!.body).toEqual({
      userId: MEMBER_ID,
      serverSlug: 'woo',
      tool: 'create_product',
      effect: 'allow',
    });
    const table = screen.getByRole('table', { name: 'Rules' });
    expect(await within(table).findByText(`user: ${member.email}`)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Preview as'), `user:${MEMBER_ID}`);
    expect(accessOf('woo__create_product')).toContain('ok');

    await user.click(
      within(table).getByRole('button', {
        name: `Delete user: ${member.email} woo create_product`,
      }),
    );
    await waitFor(() => expect(within(table).queryByText(`user: ${member.email}`)).toBeNull());
  });

  it('is admin-only: members are sent to /upstreams and see no Permissions link', async () => {
    setup(member);
    expect(await screen.findByRole('heading', { name: 'Upstreams' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Tool permissions' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Permissions' })).toBeNull();
  });
});
