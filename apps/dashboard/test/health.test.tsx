import { screen, waitFor, within } from '@testing-library/react';
import { MetricsSummaryResponseSchema, type MetricsSummaryResponse } from '@urumi/contracts';
import { describe, expect, it } from 'vitest';
import { admin, member, UPSTREAM_ID } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

const T = '2026-10-26T00:00:00.000Z';

function summary(): MetricsSummaryResponse {
  return MetricsSummaryResponseSchema.parse({
    windowMinutes: 60,
    generatedAt: T,
    healthLeader: 'urumi-gateway-abc-1',
    totals: { calls: 12, errors: 3, errorRate: 0.25, rateLimited: 2 },
    servers: [
      {
        serverSlug: 'everything',
        calls: 2,
        errors: 2,
        errorRate: 1,
        p50Ms: 3000,
        p95Ms: 3000,
        byOutcome: { timeout: 2 },
        topErrors: [
          {
            errorCode: 'UPSTREAM_UNREACHABLE',
            errorDetail: 'Server marked down by the health check',
            reason: 'server_down',
            count: 2,
            lastAt: T,
          },
        ],
        upstream: {
          id: crypto.randomUUID(),
          name: 'Everything',
          enabled: true,
          status: 'down',
          lastError: 'Connection failed (ECONNREFUSED)',
          lastErrorReason: 'connection_refused',
          lastCheckedAt: T,
          lastOkAt: '2026-10-25T23:50:00.000Z',
        },
      },
      {
        serverSlug: 'woo',
        calls: 10,
        errors: 1,
        errorRate: 0.1,
        p50Ms: 120,
        p95Ms: 480,
        byOutcome: { ok: 9, error: 1 },
        topErrors: [
          {
            errorCode: 'UPSTREAM_ERROR',
            errorDetail: 'HTTP 502',
            reason: 'http_status',
            count: 1,
            lastAt: T,
          },
        ],
        upstream: {
          id: UPSTREAM_ID,
          name: 'WooCommerce',
          enabled: true,
          status: 'up',
          lastError: null,
          lastErrorReason: null,
          lastCheckedAt: T,
          lastOkAt: T,
        },
      },
    ],
  });
}

describe('Health / Metrics page', () => {
  it('shows per-server calls, error rate, p50/p95 and why each upstream failed', async () => {
    const seen: string[] = [];
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/metrics/summary': (req) => {
        seen.push(req.query.toString());
        return json(summary());
      },
    });
    renderApp('/health');
    const woo = await screen.findByTestId('server-woo');
    expect(within(woo).getByText('10')).toBeTruthy();
    expect(within(woo).getByText('10% (1)')).toBeTruthy();
    expect(within(woo).getByText('120 ms')).toBeTruthy();
    expect(within(woo).getByText('480 ms')).toBeTruthy();
    expect(within(woo).getByText(/HTTP error status: HTTP 502/)).toBeTruthy();

    const ev = screen.getByTestId('server-everything');
    expect(within(ev).getByText('down')).toBeTruthy();
    expect(within(ev).getByText('connection refused')).toBeTruthy();
    expect(within(ev).getByText(/server marked down by the health check/)).toBeTruthy();
    expect(screen.getByText('urumi-gateway-abc-1')).toBeTruthy();
    expect(screen.getByText(/rate\s+limited/)).toBeTruthy();
    expect(seen[0]).toContain('windowMinutes=60');
  });

  it('is admin-only: no nav link and no page for members', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/upstreams': json({ upstreams: [] }),
    });
    renderApp('/health');
    // The member's layout has rendered (nav links), but neither the link nor the page is there.
    await screen.findAllByRole('link', { name: 'Upstreams' });
    await waitFor(() => expect(screen.queryByText('Health / Metrics')).toBeNull());
    expect(screen.queryByTestId('server-woo')).toBeNull();
  });
});
