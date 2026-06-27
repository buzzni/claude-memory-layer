/**
 * Web Viewer HTTP Server
 * Provides REST API and serves static UI files
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as path from 'path';
import * as fs from 'fs';
import { createHmac, timingSafeEqual } from 'crypto';
import { fileURLToPath as fileUrlToPath } from 'url';

import { apiRouter } from './api/index.js';

export type DashboardBindHost = '127.0.0.1' | '0.0.0.0';

export interface DashboardAppOptions {
  password?: string;
  cookieMaxAgeSeconds?: number;
  now?: () => number;
  /**
   * Cross-origin allow-list for the dashboard API. Empty (the default) means
   * same-origin only — no CORS headers are emitted, so browsers block any
   * cross-origin reads of the API. Falls back to DASHBOARD_ALLOWED_ORIGINS.
   */
  allowedOrigins?: string[];
}

export interface DashboardServerOptions extends DashboardAppOptions {
  port?: number;
  host?: string;
}

export interface DashboardServerEnv {
  [key: string]: string | undefined;
  PORT?: string;
  DASHBOARD_HOST?: string;
  DASHBOARD_PASSWORD?: string;
  CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD?: string;
}

const moduleDir = path.dirname(fileUrlToPath(import.meta.url));
const DASHBOARD_SESSION_COOKIE = 'cml_dashboard_session';
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function resolveUiPath(): string {
  const candidates = [
    // Built server: dist/server/index.js -> dist/ui
    path.resolve(moduleDir, '../ui'),
    // Source/dev server: src/apps/server/index.ts -> src/apps/dashboard
    path.resolve(moduleDir, '../dashboard'),
    // Fallback when running from a repository root.
    path.resolve(process.cwd(), 'dist/ui'),
    path.resolve(process.cwd(), 'src/apps/dashboard')
  ];

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) ?? candidates[0];
}

export function normalizeDashboardHost(host: string | undefined = 'localhost'): DashboardBindHost {
  const normalized = host.trim().toLowerCase();
  if (normalized === '' || normalized === 'localhost' || normalized === '127.0.0.1') {
    return '127.0.0.1';
  }
  if (normalized === '0.0.0.0') {
    return '0.0.0.0';
  }
  throw new Error('Invalid dashboard host: expected localhost, 127.0.0.1, or 0.0.0.0');
}

function displayHost(hostname: DashboardBindHost): string {
  return hostname === '0.0.0.0' ? '0.0.0.0' : 'localhost';
}

function normalizeServerOptions(portOrOptions?: number | DashboardServerOptions): Required<Pick<DashboardServerOptions, 'port' | 'host'>> & DashboardAppOptions {
  if (typeof portOrOptions === 'number') {
    return { port: portOrOptions, host: 'localhost' };
  }

  return {
    port: portOrOptions?.port ?? 37777,
    host: portOrOptions?.host ?? 'localhost',
    password: portOrOptions?.password,
    cookieMaxAgeSeconds: portOrOptions?.cookieMaxAgeSeconds,
    now: portOrOptions?.now
  };
}

function parseDashboardServerPort(portOption: string | undefined): number {
  const normalized = (portOption ?? '37777').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Invalid PORT: expected a positive integer');
  }

  const port = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('Invalid PORT: expected a TCP port between 1 and 65535');
  }

  return port;
}

export function resolveDashboardServerEnv(env: DashboardServerEnv): Required<Pick<DashboardServerOptions, 'port' | 'host'>> & Pick<DashboardServerOptions, 'password'> {
  const hostname = normalizeDashboardHost(env.DASHBOARD_HOST ?? 'localhost');
  const password = env.DASHBOARD_PASSWORD || env.CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD;

  return {
    port: parseDashboardServerPort(env.PORT),
    host: displayHost(hostname),
    password: password || undefined
  };
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

function signSessionPayload(payload: string, password: string): string {
  return createHmac('sha256', password)
    .update(`claude-memory-layer-dashboard:${payload}`)
    .digest('base64url');
}

function createDashboardSessionToken(password: string, now: () => number): string {
  const payload = String(nowSeconds(now));
  return `${payload}.${signSessionPayload(payload, password)}`;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyDashboardSessionToken(
  token: string | undefined,
  password: string,
  maxAgeSeconds: number,
  now: () => number
): boolean {
  if (!token) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !/^\d+$/.test(payload)) return false;

  const expectedSignature = signSessionPayload(payload, password);
  if (!timingSafeStringEqual(signature, expectedSignature)) return false;

  const issuedAt = Number.parseInt(payload, 10);
  const age = nowSeconds(now) - issuedAt;
  return Number.isSafeInteger(issuedAt) && age >= 0 && age <= maxAgeSeconds;
}

function isDashboardAuthenticated(c: Context, options: Required<DashboardAppOptions>): boolean {
  if (!options.password) return true;
  return verifyDashboardSessionToken(
    getCookie(c, DASHBOARD_SESSION_COOKIE),
    options.password,
    options.cookieMaxAgeSeconds,
    options.now
  );
}

function isApiRequest(c: Context): boolean {
  return c.req.path.startsWith('/api/');
}

function wantsAuthJson(c: Context): boolean {
  const accept = c.req.header('accept') ?? '';
  const contentType = c.req.header('content-type') ?? '';
  return accept.includes('application/json') || contentType.includes('application/json');
}

function isSecureRequest(c: Context): boolean {
  const forwardedProto = c.req.header('x-forwarded-proto');
  return forwardedProto === 'https' || c.req.url.startsWith('https://');
}

function renderLoginPage(message?: string): string {
  const errorBlock = message ? `<div class="error">${message}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard Login</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: radial-gradient(circle at top, #243b55 0%, #141e30 42%, #070b12 100%); color: #f8fafc; }
    .card { width: min(420px, calc(100vw - 40px)); padding: 32px; border: 1px solid rgba(148,163,184,.25); border-radius: 20px; background: rgba(15,23,42,.78); box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { margin: 0 0 24px; color: #cbd5e1; }
    label { display: block; margin-bottom: 8px; color: #e2e8f0; font-size: 14px; }
    input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(148,163,184,.35); background: rgba(2,6,23,.72); color: #f8fafc; font-size: 16px; }
    button { width: 100%; margin-top: 16px; padding: 12px 14px; border: 0; border-radius: 12px; background: linear-gradient(135deg, #38bdf8, #818cf8); color: #020617; font-weight: 700; cursor: pointer; }
    .error { margin-bottom: 16px; padding: 10px 12px; border-radius: 10px; background: rgba(248,113,113,.14); color: #fecaca; border: 1px solid rgba(248,113,113,.35); }
  </style>
</head>
<body>
  <main class="card">
    <h1>Dashboard Login</h1>
    <p>Enter the dashboard password to continue.</p>
    ${errorBlock}
    <form method="post" action="/api/auth/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Unlock dashboard</button>
    </form>
  </main>
</body>
</html>`;
}

async function readSubmittedPassword(c: Context): Promise<string> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    return typeof body.password === 'string' ? body.password : '';
  }

  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const password = body.password;
  return typeof password === 'string' ? password : '';
}

function createAuthOptions(options: DashboardAppOptions): Required<DashboardAppOptions> {
  return {
    password: options.password ?? '',
    cookieMaxAgeSeconds: options.cookieMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS,
    now: options.now ?? Date.now,
    allowedOrigins: options.allowedOrigins ?? []
  };
}

/**
 * Resolve the cross-origin allow-list, preferring an explicit option and
 * falling back to the comma-separated DASHBOARD_ALLOWED_ORIGINS env var. An
 * empty result means same-origin only (no CORS headers emitted).
 */
function resolveAllowedOrigins(explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return explicit;
  const raw = process.env.DASHBOARD_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

/**
 * The server's own origin(s): the request URL origin and, when present, the
 * scheme+Host-header origin (covers reverse-proxy setups). Either may match a
 * legitimate same-origin request.
 */
function selfOrigins(c: Context): string[] {
  const origins: string[] = [];
  try {
    origins.push(new URL(c.req.url).origin);
  } catch {
    // Non-absolute URL; fall through to the host header.
  }
  const host = c.req.header('host');
  if (host) origins.push(`${isSecureRequest(c) ? 'https' : 'http'}://${host}`);
  return origins;
}

/** True when a mutating request's Origin is same-origin or explicitly allowed. */
function isAllowedMutationOrigin(c: Context, origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes(origin) || selfOrigins(c).includes(origin);
}

export function createDashboardApp(options: DashboardAppOptions = {}): Hono {
  const app = new Hono();
  const authOptions = createAuthOptions(options);

  // Middleware
  //
  // The dashboard UI is served from the same origin as the API, so cross-origin
  // CORS access is never needed for normal use. A permissive `cors()` (which
  // emits `Access-Control-Allow-Origin: *`) would let any website the user
  // visits read the unauthenticated localhost API and exfiltrate their memory
  // data. So we lock down to same-origin by default and only enable CORS for an
  // explicit, operator-provided allow-list (DASHBOARD_ALLOWED_ORIGINS).
  const allowedOrigins = resolveAllowedOrigins(options.allowedOrigins);
  if (allowedOrigins.length > 0) {
    app.use('*', cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
      credentials: true
    }));
  }
  app.use('*', logger());

  // CSRF / cross-origin guard for state-changing API requests. Because the API
  // is unauthenticated by default, a malicious page could otherwise drive-by
  // POST to mutating endpoints (recover/backfill/graduation-run/chat). Browsers
  // always attach an Origin header to such cross-origin requests; if present it
  // must match the server's own origin or an explicit allow-list entry.
  // Non-browser callers (CLI, curl) omit Origin and remain allowed for local use.
  app.use('/api/*', async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }
    const origin = c.req.header('origin');
    if (origin && !isAllowedMutationOrigin(c, origin, allowedOrigins)) {
      return c.json({ error: 'Cross-origin request blocked' }, 403);
    }
    return next();
  });

  // Health check stays unauthenticated for local readiness checks.
  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/api/auth/status', (c) => c.json({
    enabled: Boolean(authOptions.password),
    authenticated: isDashboardAuthenticated(c, authOptions)
  }));

  app.post('/api/auth/login', async (c) => {
    if (!authOptions.password) {
      return c.json({ enabled: false, authenticated: true });
    }

    const submittedPassword = await readSubmittedPassword(c);
    if (!timingSafeStringEqual(submittedPassword, authOptions.password)) {
      if (wantsAuthJson(c)) return c.json({ error: 'Invalid password' }, 401);
      return c.html(renderLoginPage('Invalid password'), 401);
    }

    const token = createDashboardSessionToken(authOptions.password, authOptions.now);
    setCookie(c, DASHBOARD_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(c),
      path: '/',
      maxAge: authOptions.cookieMaxAgeSeconds
    });

    if (wantsAuthJson(c)) return c.json({ authenticated: true });
    return c.redirect('/', 303);
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, DASHBOARD_SESSION_COOKIE, { path: '/' });
    if (wantsAuthJson(c)) return c.json({ authenticated: false });
    return c.redirect('/', 303);
  });

  if (authOptions.password) {
    app.use('*', async (c, next) => {
      if (isDashboardAuthenticated(c, authOptions)) {
        await next();
        return;
      }

      if (isApiRequest(c)) return c.json({ error: 'Authentication required' }, 401);
      return c.html(renderLoginPage(), 401);
    });
  }

  // API routes
  app.route('/api', apiRouter);

  // Static files (UI)
  const uiPath = resolveUiPath();
  if (fs.existsSync(uiPath)) {
    app.use('/*', serveStatic({ root: uiPath }));
  }

  // Fallback for SPA routing
  app.get('*', (c) => {
    const indexPath = path.join(uiPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return c.html(fs.readFileSync(indexPath, 'utf-8'));
    }
    return c.text('UI not built. Run "npm run build:ui" first.', 404);
  });

  return app;
}

export const app = createDashboardApp();

let serverInstance: ReturnType<typeof serve> | null = null;

/**
 * Start the HTTP server
 */
export function startServer(portOrOptions: number | DashboardServerOptions = 37777): NonNullable<ReturnType<typeof serve>> {
  if (serverInstance) {
    return serverInstance;
  }

  const options = normalizeServerOptions(portOrOptions);
  const hostname = normalizeDashboardHost(options.host);
  const port = options.port;

  serverInstance = serve({
    fetch: createDashboardApp(options).fetch,
    port,
    hostname
  });

  console.log(`🧠 Code Memory viewer started at http://${displayHost(hostname)}:${port}`);

  return serverInstance;
}

/**
 * Stop the HTTP server
 */
export function stopServer(): void {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
}

/**
 * Check if server is running on given port
 */
export async function isServerRunning(port: number = 37777): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

// Start server if run directly
// Check if this file is being run directly (not imported)
const isMainModule = process.argv[1]?.includes('server/index') ||
                     process.argv[1]?.endsWith('server.js');
if (isMainModule) {
  startServer(resolveDashboardServerEnv(process.env));
}
