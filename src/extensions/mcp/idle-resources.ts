export const DEFAULT_MCP_IDLE_RELEASE_MS = 10 * 60 * 1000;

export interface McpIdleResourceControllerOptions {
  release: () => Promise<void>;
  idleMs?: number;
  now?: () => number;
}

export interface McpIdleResourceController {
  run<T>(operation: () => Promise<T>): Promise<T>;
  releaseIfIdle(): Promise<boolean>;
  stopAccepting(): void;
  waitForIdle(): Promise<void>;
  waitForRelease(): Promise<void>;
}

export function parseMcpIdleReleaseMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_MCP_IDLE_RELEASE_MS;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 60_000 || parsed > 24 * 60 * 60 * 1000) {
    return DEFAULT_MCP_IDLE_RELEASE_MS;
  }
  return parsed;
}

/** Release model/native resources after inactivity while keeping the MCP stdio process available. */
export function createMcpIdleResourceController(
  options: McpIdleResourceControllerOptions
): McpIdleResourceController {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? DEFAULT_MCP_IDLE_RELEASE_MS;
  let activeCalls = 0;
  let lastActivityAt = now();
  let releasePromise: Promise<void> | null = null;
  let accepting = true;
  const idleWaiters = new Set<() => void>();

  const waitForIdle = (): Promise<void> => {
    if (activeCalls === 0) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.add(resolve));
  };

  const waitForRelease = async (): Promise<void> => {
    await releasePromise;
  };

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (!accepting) throw new Error('MCP server is shutting down');
    // Reserve the call synchronously when there is no release in progress;
    // an unconditional await here would create a microtask-sized window where
    // the idle timer could start disposing resources for a call already handed
    // to this controller.
    if (releasePromise) await releasePromise;
    if (!accepting) throw new Error('MCP server is shutting down');
    activeCalls += 1;
    lastActivityAt = now();
    try {
      return await operation();
    } finally {
      activeCalls -= 1;
      lastActivityAt = now();
      if (activeCalls === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  };

  const releaseIfIdle = async (): Promise<boolean> => {
    if (activeCalls > 0 || releasePromise || now() - lastActivityAt < idleMs) return false;
    releasePromise = options.release();
    try {
      await releasePromise;
      return true;
    } finally {
      lastActivityAt = now();
      releasePromise = null;
    }
  };

  return {
    run,
    releaseIfIdle,
    stopAccepting: () => { accepting = false; },
    waitForIdle,
    waitForRelease
  };
}
