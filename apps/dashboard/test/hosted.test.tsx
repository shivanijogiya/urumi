// Hosted MCP servers (ADR 014) on the Upstreams page: the "Hosted (container image)" add mode, the
// status table (Deploying / Connected / Unreachable / Failed + reason), write-only env values, and
// hosted upstream rows that cannot be edited through the upstream controls.
import { screen, waitFor, within } from '@testing-library/react';
import type { HostedServer } from '@urumi/contracts';
import { describe, expect, it } from 'vitest';
import { admin, member, upstream, UPSTREAM_ID } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

const ENV_VALUE = 'hosted-env-secret-42';

function hosted(overrides: Partial<HostedServer> = {}): HostedServer {
  return {
    id: UPSTREAM_ID,
    slug: 'demo',
    name: 'Demo',
    image: 'k3d-urumi-registry.localhost:5005/urumi-everything:dev',
    imageDigest: null,
    port: 3001,
    mcpPath: '/mcp',
    preset: 'small',
    egress: false,
    envKeys: [],
    phase: 'connected',
    reason: null,
    url: 'http://mcp-demo.urumi-hosted.svc.cluster.local:3001/mcp',
    toolCount: 12,
    createdAt: '2026-10-26T05:00:00.000Z',
    updatedAt: '2026-10-26T05:01:00.000Z',
    ...overrides,
  };
}

const list = (servers: HostedServer[]) =>
  json({
    enabled: true,
    allowedImagePrefixes: ['k3d-urumi-registry.localhost:5005/', 'docker.io/mcp/'],
    requireDigest: false,
    maxServers: 5,
    servers,
  });

describe('hosted servers', () => {
  it('admin deploys a hosted server; env values are sent once and cleared', async () => {
    const created: HostedServer[] = [];
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: admin }),
      // The create also adds the (not yet registered) upstream row.
      'GET /api/upstreams': () =>
        json({
          upstreams: created.map((h) =>
            upstream({ slug: h.slug, name: h.name, hosted: true, enabled: false }),
          ),
        }),
      'GET /api/hosted-servers': () => list(created),
      'POST /api/hosted-servers': (req) => {
        const b = req.body as { slug: string; name: string; env?: Record<string, string> };
        const s = hosted({
          slug: b.slug,
          name: b.name,
          envKeys: Object.keys(b.env ?? {}),
          phase: 'deploying',
          reason: 'Creating Kubernetes objects',
        });
        created.push(s);
        return json({ server: s }, 201);
      },
    });
    const { user: u } = renderApp('/upstreams');
    await u.click(await screen.findByRole('button', { name: 'Add upstream' }));
    await u.click(screen.getByLabelText('Hosted (container image)'));
    const form = await screen.findByRole('form', { name: 'Add hosted server' });
    expect(
      await within(form).findByText(/Allowed: k3d-urumi-registry.localhost:5005\//),
    ).toBeTruthy();

    await u.type(within(form).getByLabelText('Slug'), 'demo');
    await u.type(within(form).getByLabelText('Name'), 'Demo');
    await u.type(
      within(form).getByLabelText('Image'),
      'k3d-urumi-registry.localhost:5005/urumi-everything:dev',
    );
    await u.clear(within(form).getByLabelText('Container port'));
    await u.type(within(form).getByLabelText('Container port'), '3001');
    await u.click(within(form).getByRole('button', { name: 'Add variable' }));
    await u.type(within(form).getByLabelText('Name', { selector: 'fieldset input' }), 'API_TOKEN');
    const value = within(form).getByLabelText('Value') as HTMLInputElement;
    expect(value.type).toBe('password');
    await u.type(value, ENV_VALUE);
    await u.click(within(form).getByRole('button', { name: 'Deploy hosted server' }));

    await waitFor(() => expect(callsTo('POST', '/api/hosted-servers')).toHaveLength(1));
    expect(callsTo('POST', '/api/hosted-servers')[0]!.body).toEqual({
      slug: 'demo',
      name: 'Demo',
      image: 'k3d-urumi-registry.localhost:5005/urumi-everything:dev',
      port: 3001,
      mcpPath: '/mcp',
      preset: 'small',
      egress: false,
      env: { API_TOKEN: ENV_VALUE },
    });
    expect(await screen.findByText('Deploying')).toBeTruthy();
    expect(screen.getByText('env: API_TOKEN')).toBeTruthy();
    expect(document.body.textContent).not.toContain(ENV_VALUE);
    for (const input of document.querySelectorAll('input')) {
      expect(input.value).not.toBe(ENV_VALUE);
    }
  });

  it('shows Failed with the pod reason; hosted upstream rows have no edit controls', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/upstreams': json({
        upstreams: [
          upstream({ slug: 'demo', name: 'Demo upstream', hosted: true, enabled: false }),
        ],
      }),
      'GET /api/hosted-servers': list([
        hosted({
          phase: 'failed',
          reason: 'ImagePullBackOff: the image could not be pulled (missing, private or wrong tag)',
        }),
      ]),
    });
    renderApp('/upstreams');
    const table = await screen.findByRole('region', { name: 'Hosted servers' });
    expect(await within(table).findByText('Failed')).toBeTruthy();
    expect(within(table).getByText(/^ImagePullBackOff: /)).toBeTruthy();
    const row = screen.getByText('Demo upstream').closest('tr')!;
    expect(within(row).getByText('hosted')).toBeTruthy();
    for (const name of ['Edit', 'Disable', 'Enable', 'Remove']) {
      expect(within(row).queryByRole('button', { name })).toBeNull();
    }
  });

  it('members never load hosted servers', async () => {
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/upstreams': json({ upstreams: [upstream({ hosted: true, url: undefined })] }),
    });
    renderApp('/upstreams');
    await screen.findByText('WooCommerce');
    expect(callsTo('GET', '/api/hosted-servers')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Hosted servers' })).toBeNull();
  });
});
