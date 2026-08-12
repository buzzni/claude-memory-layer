import { describe, expect, it, vi } from 'vitest';

import { createMcpProcessLifecycle } from '../../src/extensions/mcp/process-lifecycle.js';

describe('MCP process lifecycle', () => {
  it('runs shutdown and exit only once across duplicate close signals', async () => {
    const shutdown = vi.fn(async () => undefined);
    const exit = vi.fn();
    const lifecycle = createMcpProcessLifecycle({
      shutdown,
      exit,
      getParentPid: () => 42,
      initialParentPid: 42
    });

    await Promise.all([
      lifecycle.requestShutdown(0),
      lifecycle.requestShutdown(1),
      lifecycle.requestShutdown(0)
    ]);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(lifecycle.isShuttingDown()).toBe(true);
  });

  it('shuts down when a previously attached parent is replaced by init', async () => {
    let parentPid = 77;
    const shutdown = vi.fn(async () => undefined);
    const exit = vi.fn();
    const lifecycle = createMcpProcessLifecycle({
      shutdown,
      exit,
      getParentPid: () => parentPid,
      initialParentPid: parentPid
    });

    lifecycle.checkParent();
    expect(shutdown).not.toHaveBeenCalled();

    parentPid = 1;
    lifecycle.checkParent();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('does not treat an intentionally init-owned process as newly orphaned', () => {
    const lifecycle = createMcpProcessLifecycle({
      shutdown: vi.fn(async () => undefined),
      exit: vi.fn(),
      getParentPid: () => 1,
      initialParentPid: 1
    });

    lifecycle.checkParent();
    expect(lifecycle.isShuttingDown()).toBe(false);
  });
});
