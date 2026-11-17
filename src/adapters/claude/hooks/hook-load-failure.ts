/**
 * A hook entry that cannot load the file it hands its work to reports it the
 * way hook-launcher.cjs reports a hook file that cannot load: one line on
 * stderr and exit code 1, which Claude Code shows as a non-blocking error.
 * Errors while a loaded hook runs still fail open with exit 0 (hook-runtime).
 * No imports, so the light entries stay light.
 */
export function reportHookLoadFailure(hook: string, file: string, consequence: string, error: unknown): void {
  const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  process.stderr.write(`claude-memory-layer ${hook}: cannot load ${file} (${reason}), so ${consequence}. `
    + 'Run: claude-memory-layer doctor\n');
  process.exitCode = 1;
}
