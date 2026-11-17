// How many PostToolUse calls the capture filter drops, estimated from local
// Claude Code transcripts. Prints counts only, never content.
// node count-tool-calls.mjs [--days 7] [--max-files 400] [--root ~/.claude/projects]
//
// Not reproducible elsewhere: the result depends on whose transcripts are read.
// Two different denominators, both printed:
// - tool calls by name (assistant tool_use blocks), for the excluded-tool share;
// - Bash results (toolUseResult with stdout), for the share the Bash significance
//   rule drops. Transcripts keep results for fewer calls than they keep tool_use
//   blocks, so the two counts differ.
// The rules mirror src/adapters/claude/hooks/post-tool-use-filter.ts (defaults,
// no CLAUDE_MEMORY_TOOL_BLOCKLIST); keep them in step when that file changes.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]]);
  return acc;
}, []));
const days = Number(args.days ?? 7);
const maxFiles = Number(args['max-files'] ?? 400);
const root = args.root ?? path.join(os.homedir(), '.claude', 'projects');

const EXCLUDED = new Set(['TodoWrite', 'TodoRead', 'Read', 'Grep', 'Glob', 'ToolSearch', 'WebFetch', 'WebSearch', 'NotebookRead', 'Skill', 'EnterPlanMode']);
const KEYWORDS = ['error', 'failed', 'exception', 'traceback', 'panic', 'warning', 'deprecated', 'test passed', 'test failed',
  'tests passed', 'tests failed', 'coverage', 'assert', 'published', 'deployed', 'built successfully', 'build complete',
  'successfully installed', 'successfully created'];

function bashSignificant(result) {
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
  const output = parts.join('\n');
  if (result.stderr && result.stderr.trim().length > 20) return true;
  if (KEYWORDS.some((keyword) => output.toLowerCase().includes(keyword))) return true;
  return output.trim().length > 2000;
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.jsonl') && fs.statSync(full).mtimeMs >= cutoff) files.push(full);
  }
})(root);
const sample = files.slice(0, maxFiles);

const byName = new Map();
let calls = 0;
let bashResults = 0;
let bashDropped = 0;
for (const file of sample) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const content = record?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        const name = String(block.name).startsWith('mcp__') ? 'mcp__*' : String(block.name);
        byName.set(name, (byName.get(name) ?? 0) + 1);
        calls += 1;
      }
    }
    const result = record?.toolUseResult;
    if (result && typeof result === 'object' && result.stdout !== undefined) {
      bashResults += 1;
      if (!bashSignificant(result)) bashDropped += 1;
    }
  }
}

const excluded = [...byName].filter(([name]) => EXCLUDED.has(name)).reduce((sum, [, count]) => sum + count, 0);
const bash = byName.get('Bash') ?? 0;
const pct = (part, whole) => (whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`);
console.log(`transcripts: ${sample.length} of ${files.length} modified in the last ${days} days`);
console.log(`tool calls: ${calls}; excluded by name: ${excluded} (${pct(excluded, calls)}); Bash: ${bash} (${pct(bash, calls)})`);
console.log(`Bash results: ${bashResults}; dropped by the significance rule: ${bashDropped} (${pct(bashDropped, bashResults)})`);
console.log(`estimated dropped share of calls: (excluded + Bash x dropped share) / calls = ${pct(excluded + bash * (bashResults ? bashDropped / bashResults : 0), calls)}`);
console.log(`top tools: ${[...byName].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => `${name}:${count}`).join('  ')}`);
