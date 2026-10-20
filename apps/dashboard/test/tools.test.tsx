import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { member, tool } from './fixtures.js';
import { json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

describe('tools page', () => {
  it('lists all my tools; descriptions are literal text, never HTML', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/tools': json({
        tools: [tool(), tool({ name: 'crm__find', serverSlug: 'crm', description: xss })],
      }),
    });
    const { container } = renderApp('/tools');
    expect(await screen.findByText('woo__list_orders')).toBeTruthy();
    expect(screen.getByText('crm__find')).toBeTruthy();
    expect(screen.getByText(xss)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
});
