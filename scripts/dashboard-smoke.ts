import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, stopServer } from '../src/apps/server/index.js';

function assertContains(name: string, haystack: string, needle: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${name} is missing expected dashboard contract: ${needle}`);
  }
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${url} returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response;
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetchOk(`${baseUrl}/health`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Dashboard health check timed out');
}

async function main(): Promise<void> {
  const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');
  const views = readFileSync(join(process.cwd(), 'src/apps/dashboard/assets/js/views.js'), 'utf-8');
  const disclosure = readFileSync(join(process.cwd(), 'src/apps/dashboard/assets/js/disclosure.js'), 'utf-8');

  for (const needle of [
    'scope-context-bar',
    'global-empty-state',
    'disclosure-search-btn',
    'disclosure-scope-badge',
    'Search → Expand → Source'
  ]) {
    assertContains('dashboard HTML', html, needle);
  }
  assertContains('session inspector JS', views, 'Open in Sessions');
  assertContains('session inspector JS', views, 'Jump target');
  assertContains('disclosure JS', disclosure, 'Inspect evidence');
  assertContains('disclosure JS', disclosure, 'Safe preview');

  const port = Number(process.env.PORT || 39000 + Math.floor(Math.random() * 1000));
  const baseUrl = `http://127.0.0.1:${port}`;
  startServer({ port, host: '127.0.0.1' });
  try {
    await waitForHealth(baseUrl);
    await fetchOk(`${baseUrl}/api/projects`);
    const page = await fetchOk(baseUrl).then(response => response.text());
    assertContains('served dashboard HTML', page, 'scope-context-bar');
    assertContains('served dashboard HTML', page, 'disclosure-search-btn');
    assertContains('served dashboard HTML', page, 'Search → Expand → Source');
    console.log(`dashboard smoke passed: ${baseUrl} /health /api/projects shell contracts OK`);
  } finally {
    stopServer();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
