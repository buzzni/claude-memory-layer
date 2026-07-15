#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import {
  buildMemoryFieldDataset,
  evaluateMemoryFieldExecutions,
  type MemoryFieldDataset,
  type MemoryFieldExecution,
  type MemoryFieldLevel,
  type MemoryFieldPair,
  type MemoryFieldStoreSnapshot
} from '../src/core/memory-field-evaluation.js';
import { getProjectStoragePath, hashProjectPath, normalizeProjectPath } from '../src/core/registry/project-path.js';
import { withRegisteredSession } from '../src/core/registry/session-registry.js';

interface Options {
  projectPath: string;
  datasetPath: string;
  reportPath: string;
  hookPath: string;
  fixtureDir?: string;
  freezeTo?: string;
  generate: boolean;
  evaluate: boolean;
  totalCases: number;
  positiveCases: number;
  counterfactualCases: number;
  unrelatedCases: number;
  concurrency: number;
  timeoutMs: number;
  minPositiveHitRate?: number;
  minPositiveTop1Accuracy?: number;
  minNoMatchAccuracy?: number;
}

interface FrozenFieldFixtureManifest {
  schemaVersion: 1;
  localOnly: true;
  createdAt: string;
  sourceProjectHash: string;
  retrievalMode: 'keyword';
  datasetFile: string;
  storeFile: string;
  datasetSha256: string;
  storeSha256: string;
  snapshot: MemoryFieldStoreSnapshot;
}

interface PreparedFixtureRuntime {
  rootDir: string;
  homeDir: string;
  storePath: string;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof CliError ? error.message : 'memory field evaluation failed'}\n`);
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const projectPath = normalizeProjectPath(options.projectPath);
  const projectHash = hashProjectPath(projectPath);
  const fixture = options.fixtureDir
    ? await loadAndValidateFixture(options.fixtureDir, projectHash)
    : undefined;
  const fixtureRuntime = fixture
    ? await prepareFixtureRuntime(fixture.storePath, projectHash)
    : undefined;
  const evalHome = fixtureRuntime?.homeDir;
  const dbPath = fixtureRuntime
    ? fixtureRuntime.storePath
    : path.join(getProjectStoragePath(projectPath), 'events.sqlite');
  if (!existsSync(dbPath)) throw new CliError('project memory store does not exist');
  ensureLocalArtifactPath(options.datasetPath, 'dataset');
  ensureLocalArtifactPath(options.reportPath, 'report');

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (fixtureRuntime) await rm(fixtureRuntime.rootDir, { recursive: true, force: true });
    throw error;
  }
  try {
    if (options.generate) {
      const pairs = loadPairs(db);
      const dataset = buildMemoryFieldDataset(pairs, {
        totalCases: options.totalCases,
        positiveCases: options.positiveCases,
        counterfactualCases: options.counterfactualCases,
        unrelatedCases: options.unrelatedCases,
        name: `project-${hashProjectPath(projectPath)}-memory-field-${options.totalCases}`
      });
      await mkdir(path.dirname(options.datasetPath), { recursive: true });
      await writeFile(options.datasetPath, `${JSON.stringify(dataset, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(options.datasetPath, 0o600);
      process.stderr.write(`Generated local-only field dataset: ${dataset.cases.length} cases, ${dataset.generation.promotedPositiveCases} promoted positives, ${dataset.generation.sourceSessions} source sessions.\n`);
    }

    if (options.freezeTo) {
      if (!existsSync(options.datasetPath)) throw new CliError('local field dataset does not exist; run with --generate first');
      await freezeFieldFixture(db, options.datasetPath, options.freezeTo, projectHash);
      process.stderr.write('Frozen local-only field fixture created.\n');
    }

    if (!options.evaluate) return;
    if (!existsSync(options.datasetPath)) throw new CliError('local field dataset does not exist; run with --generate first');
    if (!existsSync(options.hookPath)) throw new CliError('built UserPromptSubmit hook does not exist; run npm run build first');
    const dataset = parseDataset(JSON.parse(await readFile(options.datasetPath, 'utf8')) as unknown);
    const before = snapshotStore(db);
    const sessionId = `field-eval-${randomUUID()}`;
    await withRegisteredSession(sessionId, projectPath, async () => {
      const executions = await evaluateCases(dataset, {
        projectPath,
        hookPath: options.hookPath,
        sessionId,
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        homeDir: evalHome,
        forceKeyword: Boolean(fixture)
      });
      const after = snapshotStore(db);
      const report = evaluateMemoryFieldExecutions(dataset, executions, before, after);
      await mkdir(path.dirname(options.reportPath), { recursive: true });
      await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      enforceThresholds(report.metrics, report.storeImmutable, options);
    }, evalHome ? { homeDir: evalHome } : undefined);
  } finally {
    db.close();
    if (fixtureRuntime) await rm(fixtureRuntime.rootDir, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): Options {
  let projectPath = '';
  let datasetPath = '';
  let reportPath = '';
  let hookPath = path.resolve('dist/hooks/user-prompt-submit.js');
  let fixtureDir: string | undefined;
  let freezeTo: string | undefined;
  let datasetProvided = false;
  let generate = false;
  let evaluate = false;
  let explicitMode = false;
  let totalCases = 200;
  let positiveCases = 150;
  let counterfactualCases = 25;
  let unrelatedCases = 25;
  let concurrency = 4;
  let timeoutMs = 10000;
  let minPositiveHitRate: number | undefined;
  let minPositiveTop1Accuracy: number | undefined;
  let minNoMatchAccuracy: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') projectPath = readValue(argv, ++index, arg);
    else if (arg === '--dataset') { datasetPath = path.resolve(readValue(argv, ++index, arg)); datasetProvided = true; }
    else if (arg === '--report-out') reportPath = path.resolve(readValue(argv, ++index, arg));
    else if (arg === '--hook') hookPath = path.resolve(readValue(argv, ++index, arg));
    else if (arg === '--fixture') fixtureDir = path.resolve(readValue(argv, ++index, arg));
    else if (arg === '--freeze-to') freezeTo = path.resolve(readValue(argv, ++index, arg));
    else if (arg === '--generate') { generate = true; explicitMode = true; }
    else if (arg === '--evaluate') { evaluate = true; explicitMode = true; }
    else if (arg === '--total') totalCases = readInteger(argv, ++index, arg, 1);
    else if (arg === '--positive') positiveCases = readInteger(argv, ++index, arg, 1);
    else if (arg === '--counterfactual') counterfactualCases = readInteger(argv, ++index, arg, 0);
    else if (arg === '--unrelated') unrelatedCases = readInteger(argv, ++index, arg, 0);
    else if (arg === '--concurrency') concurrency = readInteger(argv, ++index, arg, 1, 16);
    else if (arg === '--timeout-ms') timeoutMs = readInteger(argv, ++index, arg, 250, 60000);
    else if (arg === '--min-positive-hit') minPositiveHitRate = readRate(argv, ++index, arg);
    else if (arg === '--min-positive-top1') minPositiveTop1Accuracy = readRate(argv, ++index, arg);
    else if (arg === '--min-no-match') minNoMatchAccuracy = readRate(argv, ++index, arg);
    else throw new CliError(`unknown option: ${arg}`);
  }
  if (!projectPath) throw new CliError('usage: --project <absolute-project-path> [--generate] [--evaluate]');
  if (!path.isAbsolute(projectPath)) throw new CliError('--project must be an absolute path');
  if (!explicitMode) { generate = fixtureDir ? false : true; evaluate = true; }
  if (fixtureDir && freezeTo) throw new CliError('--fixture and --freeze-to cannot be combined');
  if (fixtureDir && generate) throw new CliError('--generate cannot be used with --fixture');
  if (fixtureDir && datasetProvided) throw new CliError('--dataset cannot override a frozen fixture dataset');
  if (fixtureDir) ensureLocalFixtureDir(fixtureDir, 'fixture');
  if (freezeTo) ensureLocalFixtureDir(freezeTo, 'freeze destination');
  const hash = hashProjectPath(projectPath);
  datasetPath ||= fixtureDir
    ? path.join(fixtureDir, 'dataset.local.json')
    : path.resolve('benchmarks', 'field-memory', `project-${hash}-${totalCases}.local.json`);
  reportPath ||= fixtureDir
    ? path.join(fixtureDir, 'latest.local-report.json')
    : datasetPath.replace(/\.local\.json$/u, '.local-report.json');
  if (positiveCases + counterfactualCases + unrelatedCases !== totalCases) {
    throw new CliError('--positive + --counterfactual + --unrelated must equal --total');
  }
  return {
    projectPath,
    datasetPath,
    reportPath,
    hookPath,
    fixtureDir,
    freezeTo,
    generate,
    evaluate,
    totalCases,
    positiveCases,
    counterfactualCases,
    unrelatedCases,
    concurrency,
    timeoutMs,
    minPositiveHitRate,
    minPositiveTop1Accuracy,
    minNoMatchAccuracy
  };
}

function loadPairs(db: Database.Database): MemoryFieldPair[] {
  const rows = db.prepare(`
    SELECT
      p.id AS prompt_id,
      p.content AS prompt_content,
      a.id AS answer_id,
      a.content AS answer_content,
      (
        SELECT GROUP_CONCAT(a2.id, '|') FROM events a2
        WHERE a2.session_id = a.session_id
          AND a2.turn_id = a.turn_id
          AND a2.event_type = 'agent_response'
      ) AS related_answer_ids,
      COALESCE(ml.level, 'L0') AS answer_level,
      a.session_id,
      a.timestamp
    FROM events a
    JOIN events p
      ON p.session_id = a.session_id
     AND p.turn_id = a.turn_id
     AND p.event_type = 'user_prompt'
    LEFT JOIN memory_levels ml ON ml.event_id = a.id
    WHERE a.event_type = 'agent_response'
      AND a.turn_id IS NOT NULL
      AND p.id = (
        SELECT p2.id FROM events p2
        WHERE p2.session_id = a.session_id
          AND p2.turn_id = a.turn_id
          AND p2.event_type = 'user_prompt'
        ORDER BY p2.timestamp ASC, p2.id ASC
        LIMIT 1
      )
    ORDER BY a.timestamp DESC, a.id ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    promptId: String(row.prompt_id),
    prompt: String(row.prompt_content),
    answerId: String(row.answer_id),
    relatedAnswerIds: String(row.related_answer_ids ?? row.answer_id).split('|').filter(Boolean),
    answer: String(row.answer_content),
    answerLevel: normalizeLevel(row.answer_level),
    sessionId: String(row.session_id),
    timestamp: String(row.timestamp)
  }));
}

function snapshotStore(db: Database.Database): MemoryFieldStoreSnapshot {
  const levels = Object.fromEntries((db.prepare('SELECT level, COUNT(*) AS count FROM memory_levels GROUP BY level ORDER BY level').all() as Array<{ level: string; count: number }>).map((row) => [row.level, Number(row.count)]));
  return {
    events: Number((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count),
    retrievalTraces: Number((db.prepare('SELECT COUNT(*) AS count FROM retrieval_traces').get() as { count: number }).count),
    levels
  };
}

async function evaluateCases(
  dataset: MemoryFieldDataset,
  options: {
    projectPath: string;
    hookPath: string;
    sessionId: string;
    concurrency: number;
    timeoutMs: number;
    homeDir?: string;
    forceKeyword: boolean;
  }
): Promise<MemoryFieldExecution[]> {
  const executions = new Array<MemoryFieldExecution>(dataset.cases.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(options.concurrency, dataset.cases.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      const item = dataset.cases[index];
      if (!item) return;
      const started = performance.now();
      try {
        const stdout = await runHook(
          options.hookPath,
          options.projectPath,
          options.sessionId,
          item.query,
          options.timeoutMs,
          options.homeDir,
          options.forceKeyword
        );
        const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
        const context = parsed.hookSpecificOutput?.additionalContext ?? '';
        executions[index] = {
          caseId: item.caseId,
          selectedEventIds: Array.from(context.matchAll(/\[event:([a-f0-9-]+)\]/giu), (match) => match[1] ?? '').filter(Boolean),
          hasContext: context.trim().length > 0,
          latencyMs: Number((performance.now() - started).toFixed(1))
        };
      } catch (error) {
        executions[index] = {
          caseId: item.caseId,
          selectedEventIds: [],
          hasContext: false,
          latencyMs: Number((performance.now() - started).toFixed(1)),
          errorCode: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'hook_error'
        };
      }
    }
  });
  await Promise.all(workers);
  return executions;
}

function runHook(
  hookPath: string,
  cwd: string,
  sessionId: string,
  prompt: string,
  timeoutMs: number,
  homeDir?: string,
  forceKeyword = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        CLAUDE_MEMORY_EVAL_MODE: 'true',
        CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT: 'true',
        CLAUDE_MEMORY_EVAL_EXCLUDE_SESSION_PREFIXES: 'field-eval-',
        ...(homeDir ? { HOME: homeDir } : {}),
        ...(forceKeyword ? { CLAUDE_MEMORY_RETRIEVAL_MODE: 'keyword' } : {})
      }
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error('hook_error'));
    });
    child.stdin.end(JSON.stringify({ session_id: sessionId, prompt }));
  });
}

function parseDataset(value: unknown): MemoryFieldDataset {
  if (!value || typeof value !== 'object') throw new CliError('invalid field dataset');
  const dataset = value as Partial<MemoryFieldDataset>;
  if (dataset.schemaVersion !== 1 || dataset.localOnly !== true || dataset.rawQueryContentIncluded !== true || !Array.isArray(dataset.cases)) {
    throw new CliError('invalid or non-local field dataset');
  }
  return dataset as MemoryFieldDataset;
}

function enforceThresholds(metrics: MemoryFieldEvaluationReportMetrics, storeImmutable: boolean, options: Options): void {
  const violations: string[] = [];
  if (!storeImmutable) violations.push('storeImmutable=false');
  if (options.minPositiveHitRate !== undefined && metrics.positiveHitRate < options.minPositiveHitRate) violations.push('positiveHitRate');
  if (options.minPositiveTop1Accuracy !== undefined && metrics.positiveTop1Accuracy < options.minPositiveTop1Accuracy) violations.push('positiveTop1Accuracy');
  if (options.minNoMatchAccuracy !== undefined && metrics.noMatchAccuracy < options.minNoMatchAccuracy) violations.push('noMatchAccuracy');
  if (metrics.executionErrorCount > 0) violations.push('executionErrorCount');
  if (violations.length > 0) throw new CliError(`field evaluation gate failed: ${violations.join(', ')}`);
}

type MemoryFieldEvaluationReportMetrics = ReturnType<typeof evaluateMemoryFieldExecutions>['metrics'];

function normalizeLevel(value: unknown): MemoryFieldLevel {
  return value === 'L0' || value === 'L1' || value === 'L2' || value === 'L3' || value === 'L4' ? value : 'unknown';
}

function ensureLocalArtifactPath(filePath: string, label: string): void {
  if (!/\.local(?:-report)?\.json$/u.test(filePath)) {
    throw new CliError(`${label} path must end in .local.json or .local-report.json`);
  }
}

function ensureLocalFixtureDir(dirPath: string, label: string): void {
  if (!path.basename(dirPath).endsWith('.local')) {
    throw new CliError(`${label} directory must end in .local`);
  }
}

async function freezeFieldFixture(
  db: Database.Database,
  datasetPath: string,
  fixtureDir: string,
  projectHash: string
): Promise<void> {
  const datasetFile = 'dataset.local.json';
  const storeFile = path.join('snapshot', 'events.sqlite');
  const targetDataset = path.join(fixtureDir, datasetFile);
  const targetStore = path.join(fixtureDir, storeFile);
  const temporaryStore = `${targetStore}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(targetStore), { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  try {
    await db.backup(temporaryStore);
    await chmod(temporaryStore, 0o600);
    await rename(temporaryStore, targetStore);
  } finally {
    await rm(temporaryStore, { force: true });
  }
  await writeFile(targetDataset, await readFile(datasetPath), { mode: 0o600 });
  await chmod(targetDataset, 0o600);
  const manifest: FrozenFieldFixtureManifest = {
    schemaVersion: 1,
    localOnly: true,
    createdAt: new Date().toISOString(),
    sourceProjectHash: projectHash,
    retrievalMode: 'keyword',
    datasetFile,
    storeFile,
    datasetSha256: await sha256File(targetDataset),
    storeSha256: await sha256File(targetStore),
    snapshot: snapshotStore(db)
  };
  const manifestPath = path.join(fixtureDir, 'manifest.local.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(manifestPath, 0o600);
}

async function loadAndValidateFixture(
  fixtureDir: string,
  projectHash: string
): Promise<{ manifest: FrozenFieldFixtureManifest; storePath: string }> {
  const manifestPath = path.join(fixtureDir, 'manifest.local.json');
  if (!existsSync(manifestPath)) throw new CliError('frozen fixture manifest does not exist');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<FrozenFieldFixtureManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.localOnly !== true ||
    manifest.sourceProjectHash !== projectHash ||
    manifest.retrievalMode !== 'keyword' ||
    typeof manifest.datasetFile !== 'string' ||
    typeof manifest.storeFile !== 'string' ||
    typeof manifest.datasetSha256 !== 'string' ||
    typeof manifest.storeSha256 !== 'string'
  ) {
    throw new CliError('invalid frozen field fixture manifest');
  }
  const datasetPath = safeFixturePath(fixtureDir, manifest.datasetFile);
  const storePath = safeFixturePath(fixtureDir, manifest.storeFile);
  if (!existsSync(datasetPath) || !existsSync(storePath)) throw new CliError('frozen field fixture is incomplete');
  if (await sha256File(datasetPath) !== manifest.datasetSha256) throw new CliError('frozen fixture dataset checksum mismatch');
  if (await sha256File(storePath) !== manifest.storeSha256) throw new CliError('frozen fixture store checksum mismatch');
  return { manifest: manifest as FrozenFieldFixtureManifest, storePath };
}

async function prepareFixtureRuntime(
  fixtureStorePath: string,
  projectHash: string
): Promise<PreparedFixtureRuntime> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'cml-field-fixture-'));
  const homeDir = path.join(rootDir, 'home');
  const storePath = path.join(homeDir, '.claude-code', 'memory', 'projects', projectHash, 'events.sqlite');
  try {
    await mkdir(path.dirname(storePath), { recursive: true });
    await copyFile(fixtureStorePath, storePath);
    await chmod(storePath, 0o600);
    return { rootDir, homeDir, storePath };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function safeFixturePath(fixtureDir: string, relativePath: string): string {
  const root = path.resolve(fixtureDir);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new CliError('frozen fixture path escapes fixture directory');
  return resolved;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new CliError(`missing value for ${option}`);
  return value;
}

function readInteger(argv: string[], index: number, option: string, min: number, max = 10000): number {
  const value = Number(readValue(argv, index, option));
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new CliError(`invalid integer for ${option}`);
  return value;
}

function readRate(argv: string[], index: number, option: string): number {
  const value = Number(readValue(argv, index, option));
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new CliError(`invalid rate for ${option}`);
  return value;
}
