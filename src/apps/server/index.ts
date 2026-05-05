/**
 * Web Viewer HTTP Server
 * Provides REST API and serves static UI files
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

import { apiRouter } from './api/index.js';

const app = new Hono();
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use('/*', cors());
app.use('/*', logger());

// API routes
app.route('/api', apiRouter);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

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

export { app };

let serverInstance: ReturnType<typeof serve> | null = null;

/**
 * Start the HTTP server
 */
export function startServer(port: number = 37777): NonNullable<ReturnType<typeof serve>> {
  if (serverInstance) {
    return serverInstance;
  }

  serverInstance = serve({
    fetch: app.fetch,
    port,
    hostname: '127.0.0.1'
  });

  console.log(`🧠 Code Memory viewer started at http://localhost:${port}`);

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
  const port = parseInt(process.env.PORT || '37777', 10);
  startServer(port);
}
