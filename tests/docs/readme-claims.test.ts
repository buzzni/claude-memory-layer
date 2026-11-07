import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

// README makes concrete claims: npm scripts, CLI bin/subcommand names and
// CLAUDE_MEMORY_* env vars. This checks that each cited name still exists in
// the code. Names are read from package.json and src/, not hardcoded here.
// Out of scope: benchmark/grounding numbers and wording.

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  bin: Record<string, string>;
};
const readme = read('README.md');

// Fenced blocks and inline code spans only: prose may mention names loosely.
function codeText(markdown: string): string {
  const parts: string[] = [];
  const rest = markdown.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, (_m, _f, body: string) => {
    parts.push(body);
    return '';
  });
  for (const m of rest.matchAll(/`([^`\n]+)`/g)) parts.push(m[1]);
  return parts.join('\n');
}
const code = codeText(readme);

// Command tree from src/apps/cli/index.ts. Statements look like
//   const xCmd = parentCmd\n  .command('x [arg]')   or   xCmd\n  .command('y')
// so a column-0 identifier starts a chain and each .command() nests under it.
function readCommandTree(): Set<string> {
  const lines = read('src/apps/cli/index.ts').split('\n');
  const pathOf = new Map<string, string>([['program', '']]);
  const commands = new Set<string>();
  let parent: string | undefined;
  let alias: string | undefined;
  for (const line of lines) {
    const start = line.match(/^(?:const (\w+) = )?(\w+)$/);
    if (start && pathOf.has(start[2])) {
      parent = pathOf.get(start[2]);
      alias = start[1];
      continue;
    }
    const cmd = line.match(/^\s+\.command\('([^' ]+)/);
    if (cmd && parent !== undefined) {
      parent = parent ? `${parent} ${cmd[1]}` : cmd[1];
      commands.add(parent);
      if (alias) pathOf.set(alias, parent);
      alias = undefined;
    }
  }
  return commands;
}

// A README command line is `[npx ]claude-memory-layer word word ...`. Words
// stop at the first flag, quote, placeholder or path.
function citedCommands(): string[] {
  const cited = new Set<string>();
  for (const m of code.matchAll(/(?<![\w/.-])claude-memory-layer((?:[ \t]+[a-z][a-z-]*)+)(?![\w:/.-])/g)) {
    cited.add(m[1].trim().replace(/\s+/g, ' '));
  }
  return [...cited];
}

describe('README claims', () => {
  it('cites only npm scripts that exist in package.json', () => {
    const cited = [...code.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((name) => !(name in pkg.scripts))).toEqual([]);
  });

  it('cites only bin names declared in package.json', () => {
    const cited = new Set(
      [...code.matchAll(/(?<![\w/.-])(claude-memory-layer-[a-z-]+)(?![\w/.-])/g)].map((m) => m[1])
    );
    expect(cited.size).toBeGreaterThan(0);
    expect([...cited].filter((name) => !(name in pkg.bin))).toEqual([]);
    expect(pkg.bin).toHaveProperty('claude-memory-layer');
  });

  it('cites only CLI subcommands that are registered in src/apps/cli', () => {
    const tree = readCommandTree();
    expect(tree).toContain('maintenance run');
    expect(tree).toContain('codex hooks install');

    const missing: string[] = [];
    for (const words of citedCommands()) {
      const [first, ...tail] = words.split(' ');
      if (!tree.has(first)) {
        missing.push(words);
        continue;
      }
      // Walk down while the next word is a registered child; a word that is not
      // a child of a group command is a bad subcommand, under a leaf it is an argument.
      let current = first;
      for (const word of tail) {
        const next = `${current} ${word}`;
        if (tree.has(next)) {
          current = next;
        } else {
          if ([...tree].some((c) => c.startsWith(`${current} `))) missing.push(words);
          break;
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('cites only CLAUDE_MEMORY_* env vars that src/ actually mentions', () => {
    const cited = new Set(code.match(/\bCLAUDE_MEMORY_[A-Z0-9_]+\b/g) ?? []);
    expect([...cited].some((name) => name.endsWith('_EXPERIMENT'))).toBe(true);

    const sources = readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file))
      .map((file) => read(`src/${file}`))
      .join('\n');
    expect([...cited].filter((name) => !new RegExp(`\\b${name}\\b`).test(sources))).toEqual([]);
  });
});
