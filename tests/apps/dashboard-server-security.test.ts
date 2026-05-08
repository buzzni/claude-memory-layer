import { beforeEach, describe, expect, it, vi } from 'vitest';

const serveMock = vi.hoisted(() => vi.fn(() => ({ close: vi.fn() })));

vi.mock('@hono/node-server', () => ({
  serve: serveMock
}));

const serverModule = await import('../../src/apps/server/index.js');

describe('dashboard server bind/auth options', () => {
  beforeEach(() => {
    serveMock.mockClear();
    serverModule.stopServer();
  });

  it('binds dashboard to localhost by default', () => {
    serverModule.startServer(37777);

    expect(serveMock).toHaveBeenCalledTimes(1);
    expect(serveMock.mock.calls[0][0]).toMatchObject({
      port: 37777,
      hostname: '127.0.0.1'
    });
  });

  it('allows explicitly binding dashboard to all interfaces', () => {
    serverModule.startServer({ port: 37777, host: '0.0.0.0' });

    expect(serveMock).toHaveBeenCalledTimes(1);
    expect(serveMock.mock.calls[0][0]).toMatchObject({
      port: 37777,
      hostname: '0.0.0.0'
    });
  });

  it('rejects unsupported bind hosts instead of silently exposing the dashboard', () => {
    expect(() => serverModule.startServer({ port: 37777, host: '192.168.0.10' })).toThrow(
      /Invalid dashboard host/
    );
    expect(serveMock).not.toHaveBeenCalled();
  });

  it('requires login before serving dashboard or API when password is configured', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const pageRes = await app.request('/');
    expect(pageRes.status).toBe(401);
    expect(await pageRes.text()).toContain('Dashboard Login');

    const apiRes = await app.request('/api/projects');
    expect(apiRes.status).toBe(401);
    expect(await apiRes.json()).toEqual({ error: 'Authentication required' });
  });

  it('sets an HttpOnly session cookie after password login and accepts it on later dashboard requests', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' })
    });

    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('cml_dashboard_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('pw');

    const cookie = setCookie.split(';')[0];
    const statusRes = await app.request('/api/auth/status', {
      headers: { Cookie: cookie }
    });
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ enabled: true, authenticated: true });

    const dashboardRes = await app.request('/', {
      headers: { Cookie: cookie }
    });
    expect(dashboardRes.status).toBe(200);
    expect(await dashboardRes.text()).toContain('Code Memory');
  });

  it('does not set a session cookie for an incorrect password', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    });

    expect(loginRes.status).toBe(401);
    expect(loginRes.headers.get('set-cookie')).toBeNull();
    expect(await loginRes.json()).toEqual({ error: 'Invalid password' });
  });

  it('redirects browser form login back to the dashboard after setting the session cookie', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html'
      },
      body: new URLSearchParams({ password: 'pw' }).toString()
    });

    expect(loginRes.status).toBe(303);
    expect(loginRes.headers.get('location')).toBe('/');
    expect(loginRes.headers.get('set-cookie')).toContain('cml_dashboard_session=');
  });

  it('renders the login page again for incorrect browser form passwords', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html'
      },
      body: new URLSearchParams({ password: 'wrong' }).toString()
    });

    expect(loginRes.status).toBe(401);
    expect(await loginRes.text()).toContain('Invalid password');
    expect(loginRes.headers.get('set-cookie')).toBeNull();
  });

  it('uses only dashboard-specific environment variables for direct server startup options', () => {
    expect(serverModule.resolveDashboardServerEnv({ PORT: '38888', HOST: '0.0.0.0' })).toEqual({
      port: 38888,
      host: 'localhost',
      password: undefined
    });
    expect(serverModule.resolveDashboardServerEnv({ DASHBOARD_HOST: '0.0.0.0', DASHBOARD_PASSWORD: 'pw' })).toEqual({
      port: 37777,
      host: '0.0.0.0',
      password: 'pw'
    });
  });
});
