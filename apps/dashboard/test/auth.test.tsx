import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { admin, member, upstream } from './fixtures.js';
import { envelope, json, stubApi } from './fetch-stub.js';
import { renderApp } from './render.js';

const signedOut = envelope(401, 'UNAUTHENTICATED', 'Not signed in');

describe('login and session', () => {
  it('signs in and lands on the dashboard', async () => {
    let session = false;
    const { callsTo } = stubApi({
      'GET /api/auth/me': () => (session ? json({ user: admin }) : signedOut),
      'POST /api/auth/login': () => {
        session = true;
        return json({ user: admin });
      },
      'GET /api/upstreams': json({ upstreams: [upstream()] }),
    });
    const { user } = renderApp('/login');

    await user.type(screen.getByLabelText('Email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Upstreams' })).toBeTruthy();
    expect(callsTo('POST', '/api/auth/login')[0]!.body).toEqual({
      email: 'admin@example.com',
      password: 'correct horse',
    });
    expect(screen.getByText('admin@example.com')).toBeTruthy();
  });

  it('shows one generic message on failure (no user enumeration)', async () => {
    stubApi({
      'POST /api/auth/login': envelope(401, 'UNAUTHENTICATED', 'Invalid email or password'),
    });
    const { user } = renderApp('/login');

    await user.type(screen.getByLabelText('Email'), 'nobody@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Invalid email or password.');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('redirects to /login when the session is missing', async () => {
    stubApi({ 'GET /api/auth/me': signedOut });
    renderApp('/upstreams');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('redirects to /login on any later 401', async () => {
    stubApi({ 'GET /api/auth/me': json({ user: member }), 'GET /api/upstreams': signedOut });
    renderApp('/upstreams');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('signs out', async () => {
    let session = true;
    const { callsTo } = stubApi({
      'GET /api/auth/me': () => (session ? json({ user: member }) : signedOut),
      'POST /api/auth/logout': () => {
        session = false;
        return { status: 204 };
      },
      'GET /api/upstreams': json({ upstreams: [] }),
    });
    const { user } = renderApp('/upstreams');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(callsTo('POST', '/api/auth/logout')).toHaveLength(1);
  });
});

describe('role-appropriate navigation', () => {
  it('admin sees admin pages', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: admin }),
      'GET /api/upstreams': json({ upstreams: [] }),
    });
    renderApp('/upstreams');
    expect(await screen.findByRole('link', { name: 'Members' })).toBeTruthy();
  });

  it('member has no admin nav, and /members redirects', async () => {
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'GET /api/upstreams': json({ upstreams: [] }),
      'GET /api/users': json({ users: [] }),
    });
    renderApp('/members');
    expect(await screen.findByRole('heading', { name: 'Upstreams' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Members' })).toBeNull();
    expect(callsTo('GET', '/api/users')).toHaveLength(0);
  });
});

describe('change password', () => {
  it('posts current + new password and clears the form', async () => {
    const { callsTo } = stubApi({
      'GET /api/auth/me': json({ user: member }),
      'POST /api/auth/password': { status: 204 },
    });
    const { user } = renderApp('/password');
    await user.type(await screen.findByLabelText('Current password'), 'old-password');
    await user.type(screen.getByLabelText('New password'), 'a-much-longer-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-much-longer-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText(/Password changed/)).toBeTruthy();
    expect(callsTo('POST', '/api/auth/password')[0]!.body).toEqual({
      currentPassword: 'old-password',
      newPassword: 'a-much-longer-password',
    });
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
  });

  it('shows the gateway error for a wrong current password', async () => {
    stubApi({
      'GET /api/auth/me': json({ user: member }),
      'POST /api/auth/password': envelope(
        400,
        'VALIDATION_FAILED',
        'Current password is incorrect',
      ),
    });
    const { user } = renderApp('/password');
    await user.type(await screen.findByLabelText('Current password'), 'nope');
    await user.type(screen.getByLabelText('New password'), 'a-much-longer-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-much-longer-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Current password is incorrect'),
    );
  });
});
