/**
 * Shared runtime for Claude Code hook processes.
 *
 * Hooks are short-lived processes that Claude Code spawns per lifecycle event.
 * They MUST fail safe: on any error (including malformed stdin) they still need
 * to emit a single valid JSON envelope on stdout, and they must never hang the
 * host indefinitely. This module centralizes those guarantees so each hook body
 * can focus on its logic and simply return the JSON string to emit.
 */

const DEFAULT_STDIN_TIMEOUT_MS = 10_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30_000;

/**
 * Parse a numeric environment variable with a guaranteed finite fallback.
 *
 * A non-numeric value (typo like `CLAUDE_MEMORY_MAX_COUNT=five`) would otherwise
 * yield NaN and silently poison every downstream comparison (`x >= NaN` is always
 * false), so retrieval/threshold logic must never accept a raw parse result.
 */
export function readNumberEnv(
  name: string,
  fallback: number,
  options: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = options.integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  let value = parsed;
  if (options.min !== undefined) value = Math.max(options.min, value);
  if (options.max !== undefined) value = Math.min(options.max, value);
  return value;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  return readNumberEnv(name, fallback, { integer: true, min: 1 });
}

/**
 * Read all of stdin as a string, with a hard timeout and an error handler so a
 * parent that never closes the pipe (or half-closes it) cannot wedge the hook
 * forever. On timeout/error it resolves with whatever was buffered so far
 * (usually empty) rather than rejecting; the caller's JSON.parse will then fail
 * and the hook emits its safe fallback.
 */
export function readStdin(options: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? readPositiveIntEnv('CLAUDE_MEMORY_HOOK_STDIN_TIMEOUT_MS', DEFAULT_STDIN_TIMEOUT_MS);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let data = '';
    let settled = false;

    const onData = (chunk: string) => {
      data += chunk;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      resolve(data);
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

/** Write exactly one newline-terminated JSON envelope to stdout. */
function emitHookOutput(json: string): void {
  process.stdout.write(json.endsWith('\n') ? json : `${json}\n`);
}

export interface RunHookOptions {
  /** Hook name, used only for debug logging. */
  name: string;
  /** JSON string emitted to stdout if the hook throws or times out. */
  fallbackOutput: string;
  /** Hard wall-clock ceiling; on expiry the process is forced to exit. */
  timeoutMs?: number;
}

/**
 * Execute a hook body and guarantee exactly one stdout emission plus a bounded
 * lifetime.
 *
 * - `run` returns the JSON string to emit on success.
 * - Any thrown error (including a JSON.parse failure on malformed stdin) is
 *   caught and the `fallbackOutput` is emitted instead — so Claude Code always
 *   receives a valid envelope.
 * - Output is emitted as soon as `run` settles, so the host is never blocked on
 *   best-effort background work. That fire-and-forget work is allowed to finish
 *   during natural event-loop drain.
 * - An unref'd watchdog is the hard ceiling: if some in-process async operation
 *   hangs past `timeoutMs`, the process force-exits (emitting the fallback first
 *   if nothing was emitted yet) instead of lingering with an open DB handle.
 */
export async function runHook(options: RunHookOptions, run: () => Promise<string>): Promise<void> {
  const debug = Boolean(process.env.CLAUDE_MEMORY_DEBUG);
  const timeoutMs = options.timeoutMs ?? readPositiveIntEnv('CLAUDE_MEMORY_HOOK_TIMEOUT_MS', DEFAULT_OVERALL_TIMEOUT_MS);
  let emitted = false;

  const emit = (json: string) => {
    if (emitted) return;
    emitted = true;
    emitHookOutput(json);
  };

  const watchdog = setTimeout(() => {
    if (debug) console.error(`[${options.name}] hook timed out after ${timeoutMs}ms; forcing exit`);
    emit(options.fallbackOutput);
    process.exit(0);
  }, timeoutMs);
  watchdog.unref?.();

  try {
    emit(await run());
  } catch (error) {
    if (debug) console.error(`[${options.name}] hook error:`, error);
    emit(options.fallbackOutput);
  }
  // Intentionally no forced exit here: allow best-effort background work
  // (daemon spawn, summary backfill) to complete during natural drain. The
  // unref'd watchdog above is the only hard ceiling.
}
