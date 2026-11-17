import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

// The READMEs and the user docs they link to make concrete claims: npm
// scripts, CLI bin/subcommand names and CLAUDE_MEMORY_* env vars. This checks
// that each cited name still exists in the code. Names are read from
// package.json and src/, not hardcoded here.
// Out of scope: benchmark/grounding numbers and wording.

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  bin: Record<string, string>;
};
const USER_DOCS = [
  'README.md',
  'README.ko.md',
  'docs/INSTALL.md',
  'docs/CLI.md',
  'docs/CONFIGURATION.md',
  'docs/IMPORT_AND_MIGRATION.md',
  'docs/CODEX_AND_HERMES.md',
  'docs/MCP.md',
  'docs/DASHBOARD.md',
  'docs/HOW_IT_WORKS.md',
  'docs/MONGO_SYNC.md',
  'docs/EXTERNAL_MARKET_CONTEXT.md',
  'docs/BENCHMARKS.md'
];
const readme = USER_DOCS.map(read).join('\n');

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
    const cited = [...code.matchAll(/npm run (?:--?[\w-]+[ \t]+)*(\w(?:[\w:-]*\w)?)/g)].map((m) => m[1]);
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

  it('cites only CLAUDE_MEMORY_* and DASHBOARD_* env vars that src/ actually mentions', () => {
    const cited = new Set(code.match(/\b(?:CLAUDE_MEMORY|DASHBOARD)_[A-Z0-9_]+\b/g) ?? []);
    expect([...cited].some((name) => name.endsWith('_EXPERIMENT'))).toBe(true);
    expect(cited).toContain('DASHBOARD_ALLOWED_HOSTS');

    const sources = readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file))
      .map((file) => read(`src/${file}`))
      .join('\n');
    expect([...cited].filter((name) => !new RegExp(`\\b${name}\\b`).test(sources))).toEqual([]);
  });
});

// Command lines of fenced blocks, with backslash continuations joined.
function fencedCommandBlocks(markdown: string): string[][] {
  return [...markdown.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)]
    .map((m) => m[2].replace(/\\\n\s*/g, ' ').split('\n'));
}
const blocks = fencedCommandBlocks(readme);

// The TypeScript file a documented command runs and the arguments it gets:
// `npm run [npm flags] <script> [-- args]` through package.json, or `tsx <file> args`.
function commandTarget(line: string): { file: string; args: string } | undefined {
  const npm = line.match(/\bnpm run (?:--?[\w-]+[ \t]+)*(\w(?:[\w:-]*\w)?)(?:\s+--\s+(.*))?/);
  if (npm) {
    const script = pkg.scripts[npm[1]]?.match(/^tsx (\S+\.ts)(.*)$/);
    return script ? { file: script[1], args: `${script[2]} ${npm[2] ?? ''}` } : undefined;
  }
  const tsx = line.match(/\btsx ((?:scripts|benchmarks)\/\S+\.ts)(.*)/);
  return tsx ? { file: tsx[1], args: tsx[2] } : undefined;
}

describe('README procedures', () => {
  it('passes only options that the documented TypeScript scripts parse', () => {
    const targets = blocks.flat().map(commandTarget).filter((target) => target !== undefined);
    expect(targets.some((target) => target.file === 'benchmarks/public/run.ts')).toBe(true);

    const unknown = targets.flatMap(({ file, args }) => {
      const source = read(file);
      return [...args.matchAll(/(?<!\S)--[a-z][\w-]*/g)]
        .map(([flag]) => flag)
        .filter((flag) => !source.includes(`'${flag}'`))
        .map((flag) => `${file} ${flag}`);
    });
    expect(unknown).toEqual([]);
  });

  it('shows forget only with --before while event-id and --session forget are unimplemented', () => {
    const cli = read('src/apps/cli/index.ts');
    if (!cli.includes('Forget functionality requires additional implementation')) return;

    const unsupported = blocks.flat()
      .filter((line) => /\bclaude-memory-layer forget\b|\/memory-forget\b/.test(line))
      .filter((line) => !line.includes('--before'));
    expect(unsupported).toEqual([]);
  });

  it('takes Codex/Hermes session paths and ids from a JSON validate report, since the Markdown one has only totals', () => {
    for (const formatter of ['codex', 'hermes']) {
      expect(read(`src/apps/cli/${formatter}-validation-output.ts`)).not.toMatch(/filePath|\.sessionId/);
    }

    // An import of one --session after a validate in the same block must follow a JSON validate.
    const fromMarkdown: string[] = [];
    for (const lines of blocks) {
      const lastValidate = new Map<string, string>();
      for (const line of lines) {
        const command = line.match(/\bclaude-memory-layer (codex|hermes) (validate|import)\b/);
        if (!command) continue;
        const [, agent, verb] = command;
        if (verb === 'validate') lastValidate.set(agent, line);
        else if (line.includes('--session') && lastValidate.get(agent)?.includes('--format markdown')) fromMarkdown.push(line);
      }
    }
    expect(fromMarkdown).toEqual([]);
  });
});
