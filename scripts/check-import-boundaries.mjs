#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DEFAULT_BASELINE = path.join('scripts', 'import-boundary-baseline.json');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const CORE_FORBIDDEN_LAYERS = [
  'src/extensions',
  'src/adapters',
  'src/apps',
  'src/services'
];

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

export async function scanImportBoundaries(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const baselinePath = path.resolve(rootDir, options.baselinePath ?? DEFAULT_BASELINE);
  const baseline = await loadBaseline(baselinePath, { required: options.baselinePath !== undefined, rootDir });
  const files = await collectSourceFiles(path.join(rootDir, 'src'), rootDir);
  const baselineByKey = new Map(baseline.entries.map((entry) => [baselineKey(entry), entry]));
  const usedBaselineKeys = new Set();
  const violations = [];

  for (const fileRel of files) {
    const fileAbs = path.join(rootDir, fileRel);
    const source = await readFile(fileAbs, 'utf8');
    const imports = extractStaticImports(source, fileRel);
    for (const importRef of imports) {
      const targetRel = resolveSourceSpecifier(rootDir, fileRel, importRef.specifier);
      if (!targetRel) continue;
      const rule = classifyBoundaryRule(fileRel, targetRel);
      if (!rule) continue;

      const violation = {
        rule,
        from: fileRel,
        to: targetRel,
        line: lineNumberForIndex(source, importRef.index),
        specifier: importRef.specifier,
        kind: importRef.kind
      };
      const key = baselineKey(violation);
      if (baselineByKey.has(key)) {
        usedBaselineKeys.add(key);
      } else {
        violations.push(violation);
      }
    }
  }

  const staleBaselineEntries = baseline.entries.filter((entry) => !usedBaselineKeys.has(baselineKey(entry)));
  return {
    ok: violations.length === 0 && staleBaselineEntries.length === 0,
    rootDir,
    scannedFiles: files.length,
    violations,
    baselineEntries: baseline.entries,
    activeBaselineEntries: baseline.entries.filter((entry) => usedBaselineKeys.has(baselineKey(entry))),
    staleBaselineEntries
  };
}

export async function loadBaseline(baselinePath, { required = false, rootDir = process.cwd() } = {}) {
  const exists = await fileExists(baselinePath);
  if (!exists) {
    if (required) throw new CliError(`Baseline file not found: ${toRepoRelative(rootDir, baselinePath)}`);
    return { version: 1, entries: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (error) {
    throw new CliError(`Unable to parse baseline JSON: ${toRepoRelative(rootDir, baselinePath)}`);
  }

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new CliError('Baseline must be a JSON object with version: 1 and entries: []');
  }

  const entries = parsed.entries.map((entry, index) => normalizeBaselineEntry(entry, index));
  return { version: 1, entries };
}

function normalizeBaselineEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new CliError(`Baseline entry ${index} must be an object`);
  }
  const rule = normalizeRel(entry.rule ?? '');
  const from = normalizeRel(entry.from ?? '');
  const to = normalizeRel(entry.to ?? '');
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  if (!rule || !from || !to) {
    throw new CliError(`Baseline entry ${index} must include rule, from, and to`);
  }
  if (reason.length < 20) {
    throw new CliError(`Baseline entry ${index} must include a documented removal reason`);
  }
  return { rule, from, to, reason };
}

async function collectSourceFiles(startDir, rootDir) {
  if (!(await fileExists(startDir))) return [];
  const results = [];
  async function visit(dirAbs) {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        results.push(toRepoRelative(rootDir, abs));
      }
    }
  }
  await visit(startDir);
  return results.sort();
}

function isSourceFile(fileName) {
  if (fileName.endsWith('.d.ts')) return false;
  return SOURCE_EXTENSIONS.has(path.extname(fileName));
}

export function extractStaticImports(source, fileName = 'source.ts') {
  const refs = [];
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForFile(fileName)
  );

  function visit(node) {
    if (ts.isImportDeclaration(node) && hasStringModuleSpecifier(node)) {
      refs.push({
        kind: 'import',
        specifier: node.moduleSpecifier.text,
        index: node.getStart(sourceFile)
      });
    } else if (ts.isExportDeclaration(node) && hasStringModuleSpecifier(node)) {
      refs.push({
        kind: 'export',
        specifier: node.moduleSpecifier.text,
        index: node.getStart(sourceFile)
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs.sort((a, b) => a.index - b.index || a.specifier.localeCompare(b.specifier));
}

function hasStringModuleSpecifier(node) {
  return node.moduleSpecifier && typeof node.moduleSpecifier.text === 'string';
}

function scriptKindForFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function resolveSourceSpecifier(rootDir, importerRel, specifier) {
  if (!specifier || specifier.startsWith('node:')) return null;
  let resolvedAbs;
  if (specifier.startsWith('.')) {
    resolvedAbs = path.resolve(rootDir, path.dirname(importerRel), specifier);
  } else if (specifier.startsWith('/')) {
    resolvedAbs = path.resolve(rootDir, `.${specifier}`);
  } else if (specifier === 'src' || specifier.startsWith('src/')) {
    resolvedAbs = path.resolve(rootDir, specifier);
  } else {
    return null;
  }
  const rel = toRepoRelative(rootDir, resolvedAbs);
  if (rel.startsWith('../') || rel === '..') return null;
  return rel;
}

function classifyBoundaryRule(fromRel, toRel) {
  if (fromRel.startsWith('src/core/') && CORE_FORBIDDEN_LAYERS.some((root) => isWithinRel(toRel, root))) {
    return 'core-no-forbidden-imports';
  }
  if (fromRel.startsWith('src/extensions/') && isMemoryServiceFacade(toRel)) {
    return 'extensions-no-memory-service';
  }
  return null;
}

function isWithinRel(value, root) {
  return value === root || value.startsWith(`${root}/`);
}

function isMemoryServiceFacade(toRel) {
  return toRel === 'src/services/memory-service'
    || toRel === 'src/services/memory-service.js'
    || toRel === 'src/services/memory-service.ts';
}

function baselineKey(entry) {
  return `${entry.rule}\u0000${normalizeRel(entry.from)}\u0000${normalizeRel(entry.to)}`;
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split('\n').length;
}

function formatReport(result) {
  if (result.ok) {
    return [
      'Import boundary check passed.',
      `Scanned files: ${result.scannedFiles}`,
      `Baseline entries still active: ${result.activeBaselineEntries.length}`,
      ''
    ].join('\n');
  }

  const lines = ['Import boundary check failed.'];
  if (result.violations.length > 0) {
    lines.push('', 'New or unlisted violations:');
    for (const violation of result.violations) {
      lines.push(`- [${violation.rule}] ${violation.from} -> ${violation.to} (line ${violation.line}; ${violation.kind} '${violation.specifier}')`);
    }
  }
  if (result.staleBaselineEntries.length > 0) {
    lines.push('', 'Stale baseline entries no longer observed; remove them from scripts/import-boundary-baseline.json:');
    for (const entry of result.staleBaselineEntries) {
      lines.push(`- [${entry.rule}] ${entry.from} -> ${entry.to}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { rootDir: process.cwd(), baselinePath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.rootDir = readOptionValue(argv, ++index, arg);
    } else if (arg === '--baseline') {
      options.baselinePath = readOptionValue(argv, ++index, arg);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new CliError(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`Missing value for ${optionName}`);
  }
  return value;
}

function usage() {
  return [
    'Usage: node scripts/check-import-boundaries.mjs [--root <repo>] [--baseline <json>]',
    '',
    'Checks Packet A architecture boundaries:',
    '- src/core/** must not import src/extensions/**, src/adapters/**, src/apps/**, or src/services/**.',
    '- src/extensions/** must not import the legacy src/services/memory-service facade.',
    '',
    'Known legacy debt must be documented narrowly in scripts/import-boundary-baseline.json.'
  ].join('\n');
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function toRepoRelative(rootDir, absPath) {
  return normalizeRel(path.relative(rootDir, absPath));
}

function normalizeRel(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await scanImportBoundaries(options);
  const report = formatReport(result);
  if (result.ok) {
    process.stdout.write(report);
  } else {
    process.stderr.write(report);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    } else {
      process.stderr.write(`${String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
