export interface McpProcessLifecycleOptions {
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
  getParentPid: () => number;
  initialParentPid?: number;
}

export interface McpProcessLifecycle {
  requestShutdown(code?: number): Promise<void>;
  checkParent(): void;
  isShuttingDown(): boolean;
}

/**
 * Coordinate one idempotent MCP shutdown path for stdio close, signals, and
 * parent-process loss. StdioServerTransport does not subscribe to stdin
 * end/close itself, so relying on the SDK alone can leave model-heavy servers
 * orphaned after their client disappears.
 */
export function createMcpProcessLifecycle(options: McpProcessLifecycleOptions): McpProcessLifecycle {
  const initialParentPid = options.initialParentPid ?? options.getParentPid();
  let shutdownPromise: Promise<void> | null = null;

  const requestShutdown = (code = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        await options.shutdown();
      } finally {
        options.exit(code);
      }
    })();
    return shutdownPromise;
  };

  const checkParent = (): void => {
    if (initialParentPid > 1 && options.getParentPid() === 1) {
      void requestShutdown(0);
    }
  };

  return {
    requestShutdown,
    checkParent,
    isShuttingDown: () => shutdownPromise !== null
  };
}
