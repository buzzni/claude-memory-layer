/**
 * Web Viewer HTTP Server
 * Provides REST API and serves static UI files
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import * as path from 'path';
import * as fs from 'fs';

import { apiRouter } from './api/index.js';

const app = new Hono();

// Middleware
app.use('/*', cors());
app.use('/*', logger());

// API routes
app.route('/api', apiRouter);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Static files (UI)
const uiPath = path.join(import.meta.dir, '../../dist/ui');
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

let serverInstance: ReturnType<typeof Bun.serve> | null = null;

/**
 * Start the HTTP server
 */
export function startServer(port: number = 37777): ReturnType<typeof Bun.serve> {
  if (serverInstance) {
    return serverInstance;
  }

  serverInstance = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: app.fetch
  });

  console.log(`🧠 Code Memory viewer started at http://localhost:${port}`);

  return serverInstance;
}

/**
 * Stop the HTTP server
 */
export function stopServer(): void {
  if (serverInstance) {
    serverInstance.stop();
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
if (import.meta.main) {
  const port = parseInt(process.env.PORT || '37777', 10);
  startServer(port);
}
