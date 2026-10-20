import { render, screen, waitFor, within } from '@testing-library/react';
import type { Upstream } from '@urumi/contracts';
import { describe, expect, it, vi } from 'vitest';
import { UpstreamSummary } from '../src/pages/Upstreams.js';
import { UPSTREAM_ID, admin, member, tool, upstream } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

const XSS = '<img src=x onerror=alert(1)>';

describe('upstreams page', () => {
  it('polls the upstream list every 15 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/upstreams': json({ upstreams: [upstream()] }),
    });
    renderApp('/upstreams');
    await screen.findByText('WooCommerce');
    expect(callsTo('GET', '/api/upstreams')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(callsTo('GET', '/api/upstreams')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(callsTo('GET', '/api/upstreams')).toHaveLength(2);
  });

  it('shows status, error, check time, tool count and credential type', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/upstreams': json({
        upstreams: [
          upstream({ status: 'down', lastError: 'Connection refused', toolCount: 0 }),
          upstream({
            id: crypto.randomUUID(),
            slug: 'crm',
            name: 'CRM',
            status: 'unknown',
            credentialType: 'none',
            hasCredential: false,
            lastCheckedAt: null,
          }),
        ],
      }),
    });
    renderApp('/upstreams');
    const woo = (await screen.findByText('WooCommerce')).closest('tr')!;
    expect(within(woo).getByText('down')).toBeTruthy();
    expect(within(woo).getByText('Connection refused')).toBeTruthy();
    expect(within(woo).getByText('0 tools')).toBeTruthy();
    expect(within(woo).getByText('credential: bearer')).toBeTruthy();
    const crm = screen.getByText('CRM').closest('tr')!;
    expect(within(crm).getByText('unknown')).toBeTruthy();
    expect(within(crm).getByText('never')).toBeTruthy();
    expect(within(crm).getByText('credential: none')).toBeTruthy();
  });

  it('member view is read-only and has no URL', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/upstreams': json({ upstreams: [upstream({ url: undefined })] }),
    });
    renderApp('/upstreams');
    await screen.findByText('WooCommerce');
    expect(screen.queryByText(/http:\/\//)).toBeNull();
    for (const name of ['Add upstream', 'Edit', 'Disable', 'Remove', 'Remove credential']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('expands a row to list its tools; descriptions render as plain text', async () => {
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/upstreams': json({ upstreams: [upstream()] }),
      'GET /api/upstreams/:id/tools': json({ tools: [tool({ description: XSS })] }),
    });
    const { user, container } = renderApp('/upstreams');
    await user.click(await screen.findByRole('button', { name: 'Show tools' }));

    expect(await screen.findByText('woo__list_orders')).toBeTruthy();
    expect(screen.getByText(XSS)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(callsTo('GET', `/api/upstreams/${UPSTREAM_ID}/tools`)).toHaveLength(1);
  });
});

describe('upstream summary renderer', () => {
  it('ignores unknown fields such as a stray credential', () => {
    const stray = {
      ...upstream(),
      credential: { type: 'bearer', value: 'leaked-secret-value' },
    } as Upstream;
    render(
      <table>
        <tbody>
          <tr>
            <UpstreamSummary upstream={stray} isAdmin />
          </tr>
        </tbody>
      </table>,
    );
    expect(document.body.textContent).not.toContain('leaked-secret-value');
    expect(screen.getByText('credential: bearer')).toBeTruthy();
  });
});

describe('admin upstream management', () => {
  function setup(initial: Upstream[] = [upstream()]) {
    let list = initial;
    const stub = stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/upstreams': () => json({ upstreams: list }),
      'POST /api/upstreams': (req) => {
        const body = req.body as { slug: string; name: string; url: string };
        const created = upstream({
          id: crypto.randomUUID(),
          slug: body.slug,
          name: body.name,
          url: body.url,
          status: 'unknown',
        });
        list = [...list, created];
        return json({ upstream: created }, 201);
      },
      'PATCH /api/upstreams/:id': (req) => {
        const updated = { ...list[0]!, ...(req.body as object) } as Upstream;
        delete (updated as { credential?: unknown }).credential;
        list = [updated];
        return json({ upstream: updated });
      },
      'DELETE /api/upstreams/:id': () => {
        list = [];
        return { status: 204 };
      },
    });
    return { ...stub, ...renderApp('/upstreams') };
  }

  it('creates an upstream; the credential is sent once and then cleared', async () => {
    const { user, callsTo } = setup([]);
    await user.click(await screen.findByRole('button', { name: 'Add upstream' }));
    const value = screen.getByLabelText('Credential value') as HTMLInputElement;
    expect(value.type).toBe('password');
    expect(value.value).toBe('');

    await user.type(screen.getByLabelText('Slug'), 'crm');
    await user.type(screen.getByLabelText('Name'), 'CRM');
    await user.type(screen.getByLabelText('URL'), 'https://crm.example.com/mcp');
    await user.selectOptions(screen.getByLabelText('Credential'), 'header');
    await user.type(screen.getByLabelText('Header name'), 'X-Api-Key');
    await user.type(screen.getByLabelText('Credential value'), 'super-secret-token');
    await user.click(screen.getByRole('button', { name: 'Create upstream' }));

    await screen.findByText('CRM');
    expect(callsTo('POST', '/api/upstreams')[0]!.body).toEqual({
      slug: 'crm',
      name: 'CRM',
      url: 'https://crm.example.com/mcp',
      enabled: true,
      credential: { type: 'header', headerName: 'X-Api-Key', value: 'super-secret-token' },
    });
    expect(document.body.textContent).not.toContain('super-secret-token');
    for (const input of document.querySelectorAll('input')) {
      expect(input.value).not.toBe('super-secret-token');
    }
  });

  it('edit form: slug immutable, credential never prefilled, cleared after submit', async () => {
    const { user, callsTo } = setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect((screen.getByLabelText('Slug') as HTMLInputElement).disabled).toBe(true);
    const value = screen.getByLabelText('Credential value') as HTMLInputElement;
    expect(value.type).toBe('password');
    expect(value.value).toBe('');

    await user.selectOptions(screen.getByLabelText('Credential'), 'bearer');
    await user.type(screen.getByLabelText('Credential value'), 'rotated-token-123');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(callsTo('PATCH', `/api/upstreams/${UPSTREAM_ID}`)).toHaveLength(1));
    const body = callsTo('PATCH', `/api/upstreams/${UPSTREAM_ID}`)[0]!.body as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('slug');
    expect(body.credential).toEqual({ type: 'bearer', value: 'rotated-token-123' });
    expect(document.body.textContent).not.toContain('rotated-token-123');
    for (const input of document.querySelectorAll('input')) {
      expect(input.value).not.toBe('rotated-token-123');
    }
  });

  it('keeps the current credential when the edit leaves it alone', async () => {
    const { user, callsTo } = setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Woo Store');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(callsTo('PATCH', `/api/upstreams/${UPSTREAM_ID}`)).toHaveLength(1));
    const body = callsTo('PATCH', `/api/upstreams/${UPSTREAM_ID}`)[0]!.body;
    expect(body).not.toHaveProperty('credential');
    expect(body).toMatchObject({ name: 'Woo Store' });
  });

  it('disables, removes the credential, and removes an upstream', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, callsTo } = setup();
    const path = `/api/upstreams/${UPSTREAM_ID}`;

    await user.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(callsTo('PATCH', path)).toHaveLength(1));
    expect(callsTo('PATCH', path)[0]!.body).toEqual({ enabled: false });

    await user.click(await screen.findByRole('button', { name: 'Remove credential' }));
    await waitFor(() => expect(callsTo('PATCH', path)).toHaveLength(2));
    expect(callsTo('PATCH', path)[1]!.body).toEqual({ credential: null });

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callsTo('DELETE', path)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('WooCommerce')).toBeNull());
  });
});
