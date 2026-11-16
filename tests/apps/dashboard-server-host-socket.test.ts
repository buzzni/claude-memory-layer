import { once } from 'node:events';
import type { AddressInfo, Server } from 'node:net';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startServer, stopServer } from '../../src/apps/server/index.js';

// Real HTTP adapter on an OS-assigned port: covers request parsing that the
// in-process Hono tests (with `serve` mocked) cannot see.

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(port: number, request: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(request));
    let data = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      const status = Number(head.split(' ')[1]);
      const chunked = /transfer-encoding: chunked/i.test(head);
      const body = rest.join('\r\n\r\n');
      resolve({ status, body: chunked ? body.replace(/^0\r\n\r\n$/, '') : body });
    });
  });
}

function get(path: string, headers: string[], version = 'HTTP/1.1'): string {
  return [`GET ${path} ${version}`, ...headers, 'Connection: close', '', ''].join('\r\n');
}

describe('dashboard Host allow-list over a real socket', () => {
  let port: number;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = startServer({ port: 0 }) as Server;
    if (!server.listening) await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    stopServer();
    vi.restoreAllMocks();
  });

  it('allows loopback names on the port the OS assigned for port 0', async () => {
    expect(port).toBeGreaterThan(0);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const res = await rawRequest(port, get('/health', [`Host: ${host}`]));
      expect(res.status, host).toBe(200);
      expect(res.body).toContain('"status":"ok"');
    }

    expect((await rawRequest(port, get('/health', ['Host: localhost:0']))).status).toBe(403);
  });

  it('rejects a foreign Host with an empty 403', async () => {
    const res = await rawRequest(port, get('/', [`Host: evil.example:${port}`]));

    expect(res).toEqual({ status: 403, body: '' });
  });

  it.each([
    ['allowed first', (p: number) => [`Host: localhost:${p}`, `Host: evil.example:${p}`]],
    ['foreign first', (p: number) => [`Host: evil.example:${p}`, `Host: localhost:${p}`]]
  ])('rejects duplicate Host headers (%s)', async (_label, headers) => {
    const res = await rawRequest(port, get('/health', headers(port)));

    expect(res).toEqual({ status: 403, body: '' });
  });

  it('rejects an HTTP/1.0 request without a Host header', async () => {
    const res = await rawRequest(port, get('/health', [], 'HTTP/1.0'));

    expect(res).toEqual({ status: 403, body: '' });
  });

  it('checks the Host header even when the request target is an absolute URI', async () => {
    const res = await rawRequest(port, get(`http://localhost:${port}/health`, [`Host: evil.example:${port}`]));

    expect(res).toEqual({ status: 403, body: '' });
  });

  it('leaves syntactically invalid Host headers to the adapter, which answers 400', async () => {
    for (const host of [`local host:${port}`, `evil@localhost:${port}`]) {
      const res = await rawRequest(port, get('/health', [`Host: ${host}`]));
      expect(res.status, host).toBe(400);
    }
  });
});
