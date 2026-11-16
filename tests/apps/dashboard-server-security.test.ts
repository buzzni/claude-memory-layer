import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serveMock = vi.hoisted(() => vi.fn(() => ({ close: vi.fn() })));

vi.mock('@hono/node-server', () => ({
  serve: serveMock
}));

const serverModule = await import('../../src/apps/server/index.js');

// In-process requests carry no Host header unless one is set; the dashboard
// rejects requests whose Host is not on its allow-list (default port 37777).
const LOCAL_HOST = 'localhost:37777';

function withHost(init: RequestInit = {}, host = LOCAL_HOST): RequestInit {
  return { ...init, headers: { Host: host, ...(init.headers as Record<string, string> | undefined) } };
}

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

    const pageRes = await app.request('/', withHost());
    expect(pageRes.status).toBe(401);
    expect(await pageRes.text()).toContain('Dashboard Login');

    const apiRes = await app.request('/api/projects', withHost());
    expect(apiRes.status).toBe(401);
    expect(await apiRes.json()).toEqual({ error: 'Authentication required' });
  });

  it('sets an HttpOnly session cookie after password login and accepts it on later dashboard requests', async () => {
    const password = ['dashboard', 'password', 'sentinel'].join('-');
    const app = serverModule.createDashboardApp({ password });

    const loginRes = await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    }));

    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('cml_dashboard_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain(password);

    const cookie = setCookie.split(';')[0];
    const statusRes = await app.request('/api/auth/status', withHost({
      headers: { Cookie: cookie }
    }));
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ enabled: true, authenticated: true });

    const dashboardRes = await app.request('/', withHost({
      headers: { Cookie: cookie }
    }));
    expect(dashboardRes.status).toBe(200);
    expect(await dashboardRes.text()).toContain('Code Memory');
  });

  it('does not set a session cookie for an incorrect password', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const loginRes = await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    }));

    expect(loginRes.status).toBe(401);
    expect(loginRes.headers.get('set-cookie')).toBeNull();
    expect(await loginRes.json()).toEqual({ error: 'Invalid password' });
  });

  it('redirects browser form login back to the dashboard after setting the session cookie', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const loginRes = await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html'
      },
      body: new URLSearchParams({ password: 'pw' }).toString()
    }));

    expect(loginRes.status).toBe(303);
    expect(loginRes.headers.get('location')).toBe('/');
    expect(loginRes.headers.get('set-cookie')).toContain('cml_dashboard_session=');
  });

  it('renders the login page again for incorrect browser form passwords', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    const loginRes = await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html'
      },
      body: new URLSearchParams({ password: 'wrong' }).toString()
    }));

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

  it('blocks cross-origin state-changing API requests by default', async () => {
    const app = serverModule.createDashboardApp();

    const res = await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({})
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Cross-origin request blocked' });
  });

  it('allows same-origin and non-browser state-changing API requests', async () => {
    const app = serverModule.createDashboardApp();

    const sameOrigin = await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:37777' },
      body: JSON.stringify({})
    }));
    expect(sameOrigin.status).not.toBe(403);

    const noOrigin = await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }));
    expect(noOrigin.status).not.toBe(403);
  });

  it('does not emit a wildcard CORS header by default (same-origin lockdown)', async () => {
    const app = serverModule.createDashboardApp();

    const res = await app.request('/health', withHost({
      headers: { Origin: 'https://evil.example' }
    }));

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('emits CORS headers only for an explicitly allowed origin', async () => {
    const app = serverModule.createDashboardApp({ allowedOrigins: ['https://trusted.example'] });

    const allowed = await app.request('/health', withHost({
      headers: { Origin: 'https://trusted.example' }
    }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://trusted.example');

    const disallowed = await app.request('/health', withHost({
      headers: { Origin: 'https://evil.example' }
    }));
    expect(disallowed.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});

describe('dashboard Host allow-list (DNS rebinding defense)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function expectRejected(res: Response): Promise<void> {
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  }

  it('rejects a foreign Host on read APIs, static pages, health and mutating APIs without a body', async () => {
    const app = serverModule.createDashboardApp();
    const evil = 'evil.example:37777';

    await expectRejected(await app.request('/api/projects', withHost({}, evil)));
    await expectRejected(await app.request('/api/auth/status', withHost({}, evil)));
    await expectRejected(await app.request('/', withHost({}, evil)));
    await expectRejected(await app.request('/index.html', withHost({}, evil)));
    await expectRejected(await app.request('/health', withHost({}, evil)));
    // The rebound page's own Origin used to pass because it was compared with the Host header.
    await expectRejected(await app.request('/api/auth/logout', withHost({
      method: 'POST',
      headers: { Accept: 'application/json', Origin: `http://${evil}` }
    }, evil)));
  });

  it('rejects a foreign Host even when the password gate is on', async () => {
    const app = serverModule.createDashboardApp({ password: 'pw' });

    await expectRejected(await app.request('/api/auth/login', withHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' })
    }, 'evil.example:37777')));
  });

  it.each([
    'localhost:37777',
    '127.0.0.1:37777',
    '[::1]:37777',
    'LOCALHOST:37777',
    'LocalHost.:37777',
    '127.0.0.1.:37777'
  ])('accepts the loopback Host %s on the serving port', async (host) => {
    const app = serverModule.createDashboardApp();

    const res = await app.request('/health', withHost({}, host));
    expect(res.status).toBe(200);
  });

  it.each([
    ['a different port', 'localhost:37778'],
    ['no port (implies 80)', 'localhost'],
    ['an empty port', 'localhost:'],
    ['a foreign name', 'evil.example'],
    ['a loopback-looking subdomain', '127.0.0.1.evil.example:37777'],
    ['a localhost subdomain', 'evil.localhost:37777'],
    ['another IPv6 address', '[::2]:37777'],
    ['an unbracketed IPv6 address', '::1'],
    ['a non-canonical IPv6 spelling', '[0:0:0:0:0:0:0:1]:37777'],
    ['two trailing dots', 'localhost..:37777'],
    ['userinfo', 'evil@localhost:37777'],
    ['a path', 'localhost:37777/x'],
    ['the unspecified address', '0.0.0.0:37777'],
    ['an empty value', '']
  ])('rejects a Host with %s', async (_label, host) => {
    const app = serverModule.createDashboardApp();

    await expectRejected(await app.request('/health', withHost({}, host)));
  });

  it('rejects a request without a Host header', async () => {
    const app = serverModule.createDashboardApp();

    await expectRejected(await app.request('/health'));
  });

  it('uses the configured port for the default loopback names', async () => {
    const app = serverModule.createDashboardApp({ port: 38888 });

    expect((await app.request('/health', withHost({}, 'localhost:38888'))).status).toBe(200);
    await expectRejected(await app.request('/health', withHost({}, 'localhost:37777')));
  });

  it('treats a Host without a port as port 80', async () => {
    const app = serverModule.createDashboardApp({ port: 80 });

    expect((await app.request('/health', withHost({}, 'localhost'))).status).toBe(200);
    expect((await app.request('/health', withHost({}, 'localhost:80'))).status).toBe(200);
  });

  it('accepts explicitly allowed hosts in addition to the loopback names', async () => {
    const app = serverModule.createDashboardApp({ allowedHosts: ['Memory.Example.com', '192.168.0.10:37777'] });

    for (const host of ['memory.example.com', 'memory.example.com:8443', 'MEMORY.example.com.', '192.168.0.10:37777', 'localhost:37777']) {
      expect((await app.request('/health', withHost({}, host))).status, host).toBe(200);
    }
    for (const host of ['192.168.0.10:9999', '192.168.0.10', 'evil.memory.example.com', 'evil.example:37777']) {
      await expectRejected(await app.request('/health', withHost({}, host)));
    }
  });

  it('never matches malformed allow-list entries', async () => {
    const app = serverModule.createDashboardApp({ allowedHosts: ['http://memory.example.com', 'memory.example.com/'] });

    await expectRejected(await app.request('/health', withHost({}, 'memory.example.com')));
  });

  it('falls back to DASHBOARD_ALLOWED_HOSTS when no explicit list is given', async () => {
    vi.stubEnv('DASHBOARD_ALLOWED_HOSTS', ' memory.example.com , ,192.168.0.10:37777 ');
    const app = serverModule.createDashboardApp();

    expect((await app.request('/health', withHost({}, 'memory.example.com'))).status).toBe(200);
    expect((await app.request('/health', withHost({}, '192.168.0.10:37777'))).status).toBe(200);
    await expectRejected(await app.request('/health', withHost({}, 'evil.example:37777')));
  });

  describe('Origin check for state-changing API requests', () => {
    function postLogout(app: ReturnType<typeof serverModule.createDashboardApp>, origin: string, host = LOCAL_HOST) {
      return app.request('/api/auth/logout', withHost({
        method: 'POST',
        headers: { Accept: 'application/json', Origin: origin }
      }, host));
    }

    it('accepts an Origin whose host is on the allow-list, not only the one matching the Host header', async () => {
      const app = serverModule.createDashboardApp({ allowedHosts: ['memory.example.com'] });

      expect((await postLogout(app, 'http://localhost:37777')).status).toBe(200);
      expect((await postLogout(app, 'http://127.0.0.1:37777')).status).toBe(200);
      expect((await postLogout(app, 'http://[::1]:37777')).status).toBe(200);
      expect((await postLogout(app, 'https://memory.example.com', 'memory.example.com')).status).toBe(200);
    });

    it.each([
      ['a different port', 'http://localhost:9999'],
      ['no port (implies 80)', 'http://localhost'],
      ['a foreign host', 'http://evil.example:37777'],
      ['an opaque origin', 'null'],
      ['a non-http scheme', 'file://localhost:37777'],
      ['userinfo', 'http://evil@localhost:37777']
    ])('rejects an Origin with %s', async (_label, origin) => {
      const app = serverModule.createDashboardApp();

      const res = await postLogout(app, origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Cross-origin request blocked' });
    });

    it('still accepts origins listed in DASHBOARD_ALLOWED_ORIGINS', async () => {
      const app = serverModule.createDashboardApp({ allowedOrigins: ['https://trusted.example'] });

      expect((await postLogout(app, 'https://trusted.example')).status).toBe(200);
    });
  });

  describe('startServer', () => {
    beforeEach(() => {
      serveMock.mockClear();
      serverModule.stopServer();
    });

    function servedFetch(): (request: Request) => Promise<Response> {
      const options = serveMock.mock.calls[0][0] as unknown as { fetch: (request: Request) => Promise<Response> };
      return options.fetch;
    }

    function hostRequest(host: string): Request {
      return new Request(`http://${host}/health`, { headers: { Host: host } });
    }

    it('derives the default loopback names from the serving port', async () => {
      serverModule.startServer({ port: 37816 });

      expect((await servedFetch()(hostRequest('127.0.0.1:37816'))).status).toBe(200);
      expect((await servedFetch()(hostRequest('evil.example:37816'))).status).toBe(403);
    });

    it('only accepts loopback names on a 0.0.0.0 bind until other hosts are allowed, and says so', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        serverModule.startServer({ port: 37816, host: '0.0.0.0' });

        expect((await servedFetch()(hostRequest('localhost:37816'))).status).toBe(200);
        expect((await servedFetch()(hostRequest('192.168.0.10:37816'))).status).toBe(403);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_ALLOWED_HOSTS'));
      } finally {
        warn.mockRestore();
      }
    });

    it('still warns on a 0.0.0.0 bind when every allow-list entry is malformed', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        serverModule.startServer({ port: 37816, host: '0.0.0.0', allowedHosts: ['http://192.168.0.10:37816'] });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_ALLOWED_HOSTS'));
      } finally {
        warn.mockRestore();
      }
    });

    it('passes an explicit allow-list through on a 0.0.0.0 bind', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        serverModule.startServer({ port: 37816, host: '0.0.0.0', allowedHosts: ['192.168.0.10'] });

        expect((await servedFetch()(hostRequest('192.168.0.10:37816'))).status).toBe(200);
        expect((await servedFetch()(hostRequest('evil.example:37816'))).status).toBe(403);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
