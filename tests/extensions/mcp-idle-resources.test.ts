import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MCP_IDLE_RELEASE_MS,
  createMcpIdleResourceController,
  parseMcpIdleReleaseMs
} from '../../src/extensions/mcp/idle-resources.js';

describe('MCP idle resource controller', () => {
  it('uses bounded configuration and falls back for unsafe values', () => {
    expect(parseMcpIdleReleaseMs(undefined)).toBe(DEFAULT_MCP_IDLE_RELEASE_MS);
    expect(parseMcpIdleReleaseMs('60000')).toBe(60_000);
    expect(parseMcpIdleReleaseMs('1')).toBe(DEFAULT_MCP_IDLE_RELEASE_MS);
    expect(parseMcpIdleReleaseMs('invalid')).toBe(DEFAULT_MCP_IDLE_RELEASE_MS);
  });

  it('releases resources only after the idle window', async () => {
    let now = 1_000;
    const release = vi.fn(async () => undefined);
    const controller = createMcpIdleResourceController({ release, idleMs: 100, now: () => now });

    expect(await controller.releaseIfIdle()).toBe(false);
    now += 100;
    expect(await controller.releaseIfIdle()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(await controller.releaseIfIdle()).toBe(false);
  });

  it('never releases while a tool call is active', async () => {
    let now = 0;
    let finish!: () => void;
    const release = vi.fn(async () => undefined);
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const controller = createMcpIdleResourceController({ release, idleMs: 100, now: () => now });

    const running = controller.run(() => operation);
    now = 500;
    expect(await controller.releaseIfIdle()).toBe(false);
    finish();
    await running;
    now = 600;
    expect(await controller.releaseIfIdle()).toBe(true);
  });

  it('lets graceful shutdown wait for active tool calls', async () => {
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const controller = createMcpIdleResourceController({
      release: vi.fn(async () => undefined),
      idleMs: 100,
      now: () => 0
    });

    const running = controller.run(() => operation);
    let idle = false;
    const waiting = controller.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);

    finish();
    await running;
    await waiting;
    expect(idle).toBe(true);
  });

  it('rejects new calls once graceful shutdown begins', async () => {
    const controller = createMcpIdleResourceController({
      release: vi.fn(async () => undefined),
      idleMs: 100,
      now: () => 0
    });

    controller.stopAccepting();
    await expect(controller.run(async () => 'unexpected')).rejects.toThrow('shutting down');
  });

  it('makes new tool calls wait for an in-flight release', async () => {
    let now = 0;
    let finishRelease!: () => void;
    const release = vi.fn(() => new Promise<void>((resolve) => { finishRelease = resolve; }));
    const operation = vi.fn(async () => 'ok');
    const controller = createMcpIdleResourceController({ release, idleMs: 100, now: () => now });

    now = 100;
    const releasing = controller.releaseIfIdle();
    const running = controller.run(operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    finishRelease();
    await expect(releasing).resolves.toBe(true);
    await expect(running).resolves.toBe('ok');
  });
});
