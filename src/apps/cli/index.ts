#!/usr/bin/env node
/**
 * Code Memory CLI
 * Command-line interface for memory operations
 */

import { Command } from 'commander';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getDefaultMemoryService,
  getMemoryServiceForProject,
  getLightweightMemoryServiceForProject
} from '../../services/memory-service.js';
import { getProjectStoragePath, resolveProjectStoragePath, hashProjectPath } from '../../core/registry/project-path.js';
import { createSessionHistoryImporter, type ProgressEvent } from '../../services/session-history-importer.js';
import {
  createCodexSessionHistoryImporter,
  validateCodexSessions
} from '../../services/codex-session-history-importer.js';
import {
  createHermesSessionHistoryImporter,
  validateHermesSessions
} from '../../services/hermes-session-history-importer.js';
import { bootstrapKnowledgeBase } from '../../services/bootstrap-organizer.js';
import { startServer, stopServer, isServerRunning } from '../server/index.js';
import { SQLiteEventStore } from '../../core/sqlite-event-store.js';
import { createSQLiteDatabase, sqliteClose, sqliteGet, type SQLiteDatabase } from '../../core/sqlite-wrapper.js';
import { MongoSyncWorker, type MongoSyncDirection } from '../../core/mongo-sync-worker.js';
import { applyPrivacyFilter, maskSensitiveInput } from '../../core/privacy/filter.js';
import type { Config } from '../../core/types.js';
import {
  ActionRepository,
  CheckpointRepository,
  FacetRepository,
  FrontierService,
  type FrontierItem,
  type MemoryAction,
  type MemoryCheckpoint,
  type MemoryFacetAssignment
} from '../../core/operations/index.js';
import {
  CreateCheckpointInputSchema,
  ListActionsInputSchema,
  ListCheckpointsInputSchema,
  UpdateActionInputSchema
} from '../../core/operations/actions.js';
import { parseFacetAssignmentInput, parseFacetQuery } from '../../core/operations/facets.js';
import {
  formatDisclosureExpansion,
  formatDisclosureSearch,
  formatDisclosureSource,
  formatPlainSearchResults
} from './retrieval-disclosure-output.js';
import { installMcpServer } from './mcp-install.js';
import {
  hasHook,
  mergePluginHooksIntoSettings,
  removePluginHooksFromSettings,
  REQUIRED_HOOK_FILES,
  type ClaudeSettingsWithHooks
} from './claude-settings-hooks.js';
import {
  formatCodexValidationReport,
  writeCodexValidationReport,
  type CodexValidationReportFormat
} from './codex-validation-output.js';
import {
  formatHermesValidationReport,
  writeHermesValidationReport,
  type HermesValidationReportFormat
} from './hermes-validation-output.js';
import { runCodexImportOnce } from './codex-import-runner.js';
import { runHermesImportOnce } from './hermes-import-runner.js';
import { resolveDashboardCommandOptions } from './dashboard-command.js';
import {
  formatLegacyProjectScopeRepairResult,
  resolveLegacyProjectScopeRepairOptions
} from './repair-command.js';
import {
  formatRetentionAuditReport,
  resolveRetentionAuditOptions
} from './retention-audit-command.js';
import {
  emptyRetentionAuditReport,
  runRetentionAudit
} from '../../core/operations/retention-audit.js';
import {
  fetchExternalMarketContext,
  renderExternalMarketContextReport,
  type ExternalMarketProvider
} from '../../core/external-market-context.js';
import {
  DEFAULT_EMBEDDING_FALLBACK_MODEL,
  DEFAULT_EMBEDDING_MODEL
} from '../../extensions/vector/embedder.js';

// ============================================================
// Hook Installation Utilities
// ============================================================

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

type ClaudeSettings = ClaudeSettingsWithHooks;

function getPluginPath(): string {
  // Try to find the dist directory
  const possiblePaths = [
    path.join(__dirname, '..'),  // When running from dist/cli
    path.join(__dirname, '../..', 'dist'),  // When running from src
    path.join(process.cwd(), 'dist'),  // Current working directory
  ];

  for (const p of possiblePaths) {
    const hooksPath = path.join(p, 'hooks', 'user-prompt-submit.js');
    if (fs.existsSync(hooksPath)) {
      return p;
    }
  }

  // Fallback to npm global installation path
  return path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'claude-memory-layer', 'dist');
}

function loadClaudeSettings(): ClaudeSettings {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Warning: Could not read existing settings:', error);
  }
  return {};
}

function saveClaudeSettings(settings: ClaudeSettings): void {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write
  const tempPath = CLAUDE_SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tempPath, CLAUDE_SETTINGS_PATH);
}

type CodexValidateCommandOptions = {
  project?: string;
  sessionsDir?: string;
  limit?: string;
  format?: string;
  output?: string;
  dryRun?: boolean;
  anonymizeProjects?: boolean;
};

type HermesValidateCommandOptions = {
  project?: string;
  stateDb?: string;
  limit?: string;
  format?: string;
  output?: string;
  dryRun?: boolean;
};

type MarketContextCommandOptions = {
  company?: string;
  dartCorpCode?: string;
  symbol?: string;
  providers?: string;
  fredSeries?: string;
  json?: boolean;
  snapshot?: boolean;
};

function parseCommaList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const selected = value.split(',').map((item) => item.trim()).filter(Boolean);
  return selected.length > 0 ? Array.from(new Set(selected)) : undefined;
}

function parseMarketProviders(value: string | undefined): ExternalMarketProvider[] | undefined {
  const entries = parseCommaList(value);
  if (!entries) return undefined;
  const allowed = new Set<ExternalMarketProvider>(['dart', 'fred', 'finnhub']);
  const selected: ExternalMarketProvider[] = [];
  for (const entry of entries) {
    const normalized = entry.toLowerCase() as ExternalMarketProvider;
    if (!allowed.has(normalized)) throw new Error('Invalid --providers: expected comma-separated dart,fred,finnhub');
    if (!selected.includes(normalized)) selected.push(normalized);
  }
  return selected;
}

function parsePositiveIntegerOption(value: string | undefined, optionName: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid --${optionName}: expected a positive integer`);
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${optionName}: expected a positive integer`);
  }
  return parsed;
}

function parseCodexValidationReportFormat(value: string | undefined): CodexValidationReportFormat {
  const normalized = (value ?? 'markdown').toLowerCase();
  if (normalized !== 'json' && normalized !== 'markdown') {
    throw new Error('Invalid --format: expected json or markdown');
  }
  return normalized;
}

function parseHermesValidationReportFormat(value: string | undefined): HermesValidationReportFormat {
  const normalized = (value ?? 'markdown').toLowerCase();
  if (normalized !== 'json' && normalized !== 'markdown') {
    throw new Error('Invalid --format: expected json or markdown');
  }
  return normalized;
}

async function runCodexValidationCommand(options: CodexValidateCommandOptions): Promise<void> {
  if (options.dryRun === false) {
    throw new Error('Codex validation is read-only; use explicit import commands for mutation');
  }

  const format = parseCodexValidationReportFormat(options.format);
  const report = await validateCodexSessions({
    sessionsDir: options.sessionsDir,
    projectPath: options.project,
    limit: parsePositiveIntegerOption(options.limit, 'limit'),
    anonymizeProjects: options.anonymizeProjects === true
  });

  const rendered = formatCodexValidationReport(report, format);
  process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);

  if (options.output) {
    const outputPath = path.resolve(options.output);
    writeCodexValidationReport(outputPath, report, format);
    console.log(`\nReport written to ${outputPath}`);
  }
}

async function runHermesValidationCommand(options: HermesValidateCommandOptions): Promise<void> {
  if (options.dryRun === false) {
    throw new Error('Hermes validation is read-only; use explicit import commands for mutation');
  }

  const format = parseHermesValidationReportFormat(options.format);
  const report = await validateHermesSessions({
    stateDbPath: options.stateDb,
    projectPath: options.project,
    limit: parsePositiveIntegerOption(options.limit, 'limit')
  });

  const rendered = formatHermesValidationReport(report, format);
  process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);

  if (options.output) {
    const outputPath = path.resolve(options.output);
    writeHermesValidationReport(outputPath, report, format);
    console.log(`\nReport written to ${outputPath}`);
  }
}

async function runMarketContextCommand(options: MarketContextCommandOptions): Promise<void> {
  const report = await fetchExternalMarketContext({
    company: options.company,
    dartCorpCode: options.dartCorpCode,
    symbol: options.symbol,
    providers: parseMarketProviders(options.providers),
    fredSeries: parseCommaList(options.fredSeries),
    includeSnapshot: options.snapshot !== false
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderExternalMarketContextReport(report)}\n`);
  }
}

type OperationProjectContext = {
  projectPath: string;
  projectHash: string;
  storagePath: string;
  dbPath: string;
};

type OperationJsonOption = { json?: boolean };

const OPERATION_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'api-key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[REDACTED]',
    preserveLineCount: false,
    supportedFormats: ['xml', 'bracket', 'comment']
  }
};

function resolveOperationProject(project: string | undefined): OperationProjectContext {
  const projectPath = path.resolve(project ?? process.cwd());
  const projectHash = hashProjectPath(projectPath);
  const storagePath = getProjectStoragePath(projectPath);
  return {
    projectPath,
    projectHash,
    storagePath,
    dbPath: path.join(storagePath, 'events.sqlite')
  };
}

function openOperationReadDatabase(context: OperationProjectContext): SQLiteDatabase | null {
  if (!fs.existsSync(context.dbPath)) return null;
  return createSQLiteDatabase(context.dbPath, { readonly: true, walMode: false });
}

async function withOperationWriteDatabase<T>(
  context: OperationProjectContext,
  callback: (db: SQLiteDatabase) => Promise<T>
): Promise<T> {
  const store = new SQLiteEventStore(context.dbPath, { markdownMirrorRoot: context.storagePath });
  await store.initialize();
  try {
    return await callback(store.getDatabase());
  } finally {
    await store.close();
  }
}

async function withOperationExistingDatabase<T>(
  context: OperationProjectContext,
  emptyValue: T,
  requiredTables: string[],
  callback: (db: SQLiteDatabase) => Promise<T>
): Promise<T> {
  const db = openOperationReadDatabase(context);
  if (!db) return emptyValue;
  try {
    if (!requiredTables.every((table) => operationTableExists(db, table))) {
      return emptyValue;
    }
    return await callback(db);
  } finally {
    sqliteClose(db);
  }
}

function operationTableExists(db: SQLiteDatabase, table: string): boolean {
  const row = sqliteGet<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  );
  return Boolean(row?.name);
}

function parseOperationLimit(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`limit must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`limit must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseOperationNumber(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function requiredOperationOption(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalOperationOption(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function splitOperationList(value: string | string[] | undefined, maxItems: number): string[] {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return Array.from(new Set(
    raw.flatMap((item) => item.split(','))
      .map((item) => sanitizeOperationString(item.trim(), 120))
      .filter(Boolean)
  )).slice(0, maxItems);
}

function parseOperationStateJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!isOperationRecord(parsed)) {
    throw new Error('state-json must be a JSON object');
  }
  return sanitizeOperationRecord(parsed);
}

function isOperationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function omitUndefinedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isoOperationDate(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function compactOperationArray(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.max(0, maxItems)).map((item) => sanitizeOperationOutput(item, 1));
}

function compactOperationStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, Math.max(0, maxItems))
    .map((item) => sanitizeOperationString(String(item), maxLength))
    .filter(Boolean);
}

function compactOperationRecord(input: unknown, maxEntries: number): Record<string, unknown> {
  if (!isOperationRecord(input)) return {};
  const entries = Object.entries(input);
  const compacted = Object.fromEntries(
    entries
      .slice(0, Math.max(0, maxEntries))
      .map(([key, value]) => [sanitizeOperationKey(key), sanitizeOperationOutput(value, 1)])
  );
  if (entries.length > maxEntries) {
    compacted.__truncated = entries.length - maxEntries;
  }
  return compacted;
}

function sanitizeOperationRecord(input: Record<string, unknown>): Record<string, unknown> {
  return compactOperationRecord(maskSensitiveInput(input), 30);
}

function sanitizeOperationOutput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeOperationString(value, 1000);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizeOperationOutput(item, depth + 1));
  if (isOperationRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, item]) => [sanitizeOperationKey(key), sanitizeOperationOutput(item, depth + 1)])
    );
  }
  return value;
}

function sanitizeOperationKey(key: string): string {
  if (/(api.*key|api.*token|access.*token|refresh.*token|client.*secret|private.*key|secret|password|passwd)/i.test(key)) {
    return '[REDACTED_KEY]';
  }
  return sanitizeOperationString(key, 120);
}

function sanitizeOperationString(value: string, maxLength: number): string {
  const masked = maskSensitiveInput({ value }).value;
  const asString = typeof masked === 'string' ? masked : String(value);
  const privacyFiltered = applyPrivacyFilter(asString, OPERATION_PRIVACY_CONFIG).content;
  const scrubbed = privacyFiltered
    .replace(/[A-Za-z]:[\\/][^\s'"`<>)]*/g, '[path]')
    .replace(/~[\\/][^\s'"`<>)]*/g, '[path]')
    .replace(/(^|[\s([{=,:;])\/(?!\/)[^\s'"`<>)]*/g, '$1[path]');
  const normalized = scrubbed.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatOperationFacet(facet: MemoryFacetAssignment): Record<string, unknown> {
  return {
    id: facet.id,
    targetType: facet.targetType,
    targetId: facet.targetId,
    dimension: facet.dimension,
    value: facet.value,
    confidence: facet.confidence,
    source: facet.source,
    evidenceEventIds: compactOperationStringArray(facet.evidenceEventIds, 10, 120),
    projectHash: facet.projectHash,
    createdAt: isoOperationDate(facet.createdAt),
    updatedAt: isoOperationDate(facet.updatedAt)
  };
}

function formatOperationAction(action: MemoryAction): Record<string, unknown> {
  return {
    actionId: action.actionId,
    projectHash: action.projectHash,
    title: action.title,
    status: action.status,
    priority: action.priority,
    sourceEventIds: compactOperationStringArray(action.sourceEventIds, 10, 120),
    relatedEntityIds: compactOperationStringArray(action.relatedEntityIds, 10, 120),
    currentCheckpointId: action.currentCheckpointId,
    leaseId: action.leaseId,
    createdAt: isoOperationDate(action.createdAt),
    updatedAt: isoOperationDate(action.updatedAt)
  };
}

function formatOperationFrontierItem(item: FrontierItem): Record<string, unknown> {
  return {
    action: formatOperationAction(item.action),
    score: item.score,
    reasons: compactOperationStringArray(item.reasons, 10, 300),
    sourceRefs: compactOperationArray(item.sourceRefs, 10)
  };
}

function formatOperationCheckpoint(checkpoint: MemoryCheckpoint): Record<string, unknown> {
  return {
    checkpointId: checkpoint.checkpointId,
    projectHash: checkpoint.projectHash,
    actionId: checkpoint.actionId,
    sessionId: checkpoint.sessionId,
    title: checkpoint.title,
    summary: checkpoint.summary,
    stateJson: compactOperationRecord(checkpoint.stateJson, 8),
    sourceEventIds: compactOperationStringArray(checkpoint.sourceEventIds, 10, 120),
    createdAt: isoOperationDate(checkpoint.createdAt),
    expiresAt: isoOperationDate(checkpoint.expiresAt)
  };
}

function writeOperationOutput(payload: Record<string, unknown>, options: OperationJsonOption): void {
  const safePayload = sanitizeOperationOutput(payload) as Record<string, unknown>;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(safePayload, null, 2)}\n`);
    return;
  }
  const operation = typeof safePayload.operation === 'string' ? safePayload.operation : 'memory-operation';
  const count = typeof safePayload.count === 'number' ? ` (${safePayload.count} item${safePayload.count === 1 ? '' : 's'})` : '';
  process.stdout.write(`${operation}${count}\n${JSON.stringify(safePayload, null, 2)}\n`);
}

async function runOperationCli(action: () => Promise<void>, label: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${label} failed: ${sanitizeOperationString(message, 500)}`);
    process.exit(1);
  }
}

const program = new Command();

program
  .name('claude-memory-layer')
  .description('Claude Code Memory Plugin CLI')
  .version(process.env.CLAUDE_MEMORY_LAYER_VERSION || '0.0.0');

program
  .command('market-context')
  .description('Fetch read-only DART/FRED/Finnhub context with structured MarketContextSnapshot bull/bear/risk/catalyst analysis')
  .option('--company <name>', 'Company name for DART fallback search and report subject')
  .option('--dart-corp-code <code>', 'Exact DART corp_code for issuer-specific filings')
  .option('--symbol <ticker>', 'Listed ticker for Finnhub company profile')
  .option('--providers <list>', 'Comma-separated providers: dart,fred,finnhub')
  .option('--fred-series <list>', 'Comma-separated FRED series IDs')
  .option('--json', 'Print structured JSON including analysis.marketSnapshot')
  .option('--no-snapshot', 'Disable MarketContextSnapshot and DART company snapshot analysis')
  .action(async (options: MarketContextCommandOptions) => {
    try {
      await runMarketContextCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ============================================================
// Install / Uninstall Commands
// ============================================================

/**
 * Install command - register hooks with Claude Code
 */
program
  .command('install')
  .description('Install hooks into Claude Code settings')
  .option('--path <path>', 'Custom plugin path (defaults to auto-detect)')
  .action(async (options) => {
    try {
      const pluginPath = options.path || getPluginPath();

      // Verify hooks exist
      const missingHooks = REQUIRED_HOOK_FILES.filter((file) =>
        !fs.existsSync(path.join(pluginPath, 'hooks', file))
      );
      if (missingHooks.length > 0) {
        console.error(`\n❌ Hook files not found at: ${pluginPath}`);
        console.error(`   Missing: ${missingHooks.join(', ')}`);
        console.error('   Make sure you have built the plugin with "npm run build"');
        process.exit(1);
      }

      // Load existing settings
      const settings = loadClaudeSettings();

      // Add hooks while preserving unrelated Claude Code hooks in the same categories.
      const nextSettings = mergePluginHooksIntoSettings(settings, pluginPath);

      // Save settings
      saveClaudeSettings(nextSettings);

      console.log('\n✅ Claude Memory Layer installed!\n');
      console.log('Hooks registered:');
      console.log('  - SessionStart: Register session -> project mapping');
      console.log('  - UserPromptSubmit: Memory retrieval on user input');
      console.log('  - PostToolUse: Store tool observations');
      console.log('  - Stop: Store assistant responses');
      console.log('  - SessionEnd: Persist session summary\n');
      console.log('Plugin path:', pluginPath);
      console.log('\n⚠️  Restart Claude Code for changes to take effect.\n');
      console.log('Commands:');
      console.log('  claude-memory-layer dashboard  - Open web dashboard');
      console.log('  claude-memory-layer search     - Search memories');
      console.log('  claude-memory-layer stats      - View statistics');
      console.log('  claude-memory-layer uninstall  - Remove hooks\n');
    } catch (error) {
      console.error('Install failed:', error);
      process.exit(1);
    }
  });

/**
 * Uninstall command - remove hooks from Claude Code
 */
program
  .command('uninstall')
  .description('Remove hooks from Claude Code settings')
  .action(async () => {
    try {
      // Load existing settings
      const settings = loadClaudeSettings();

      if (!settings.hooks) {
        console.log('\n📋 No hooks installed.\n');
        return;
      }

      const nextSettings = removePluginHooksFromSettings(settings, getPluginPath());

      // Save settings
      saveClaudeSettings(nextSettings);

      console.log('\n✅ Claude Memory Layer uninstalled!\n');
      console.log('Hooks removed from Claude Code settings.');
      console.log('Your memory data is preserved and can be accessed with:');
      console.log('  claude-memory-layer dashboard\n');
      console.log('⚠️  Restart Claude Code for changes to take effect.\n');
    } catch (error) {
      console.error('Uninstall failed:', error);
      process.exit(1);
    }
  });

/**
 * Status command - check installation status
 */
program
  .command('status')
  .description('Check plugin installation status')
  .action(async () => {
    try {
      const settings = loadClaudeSettings();
      const pluginPath = getPluginPath();

      console.log('\n🧠 Claude Memory Layer Status\n');

      // Check hooks
      const hasSessionStartHook = hasHook(settings, 'SessionStart', 'session-start');
      const hasUserPromptHook = hasHook(settings, 'UserPromptSubmit', 'user-prompt-submit');
      const hasPostToolHook = hasHook(settings, 'PostToolUse', 'post-tool-use');
      const hasStopHook = hasHook(settings, 'Stop', 'stop');
      const hasSessionEndHook = hasHook(settings, 'SessionEnd', 'session-end');

      console.log('Hooks:');
      console.log(`  SessionStart: ${hasSessionStartHook ? '✅ Installed' : '❌ Not installed'}`);
      console.log(`  UserPromptSubmit: ${hasUserPromptHook ? '✅ Installed' : '❌ Not installed'}`);
      console.log(`  PostToolUse: ${hasPostToolHook ? '✅ Installed' : '❌ Not installed'}`);
      console.log(`  Stop: ${hasStopHook ? '✅ Installed' : '❌ Not installed'}`);
      console.log(`  SessionEnd: ${hasSessionEndHook ? '✅ Installed' : '❌ Not installed'}`);

      // Check plugin files
      const hooksExist = REQUIRED_HOOK_FILES
        .every((file) => fs.existsSync(path.join(pluginPath, 'hooks', file)));
      console.log(`\nPlugin files: ${hooksExist ? '✅ Found' : '❌ Not found'}`);
      console.log(`  Path: ${pluginPath}`);

      // Check dashboard
      const dashboardRunning = await isServerRunning(37777);
      console.log(`\nDashboard: ${dashboardRunning ? '✅ Running at http://localhost:37777' : '⏹️  Not running'}`);

      if (!hasSessionStartHook || !hasUserPromptHook || !hasPostToolHook || !hasStopHook || !hasSessionEndHook) {
        console.log('\n💡 Run "claude-memory-layer install" to set up hooks.\n');
      } else {
        console.log('\n✅ Plugin is fully installed and configured.\n');
      }
    } catch (error) {
      console.error('Status check failed:', error);
      process.exit(1);
    }
  });

/**
 * Search command
 */
program
  .command('search <query>')
  .description('Search memories using semantic search')
  .option('-k, --top-k <number>', 'Number of results', '5')
  .option('-s, --min-score <number>', 'Minimum similarity score', '0.7')
  .option('--session <id>', 'Filter by session ID')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .option('--disclosure', 'Use progressive search -> expand -> source output')
  .option('--include-shared', 'Include shared cross-project memory results')
  .option('--strategy <mode>', 'Retrieval strategy: auto, fast, or deep', 'auto')
  .action(async (query: string, options) => {
    const projectPath = options.project || process.cwd();
    const useLightweightRead = options.strategy === 'fast' && options.includeShared !== true;
    const service = useLightweightRead
      ? getLightweightMemoryServiceForProject(projectPath)
      : getMemoryServiceForProject(projectPath);

    try {
      if (options.disclosure) {
        const result = await service.searchDisclosure(query, {
          topK: parseInt(options.topK),
          minScore: parseFloat(options.minScore),
          sessionId: options.session,
          includeShared: options.includeShared === true,
          strategy: options.strategy
        });

        console.log(formatDisclosureSearch(result));
        return;
      }

      const result = await service.retrieveMemories(query, {
        topK: parseInt(options.topK),
        minScore: parseFloat(options.minScore),
        sessionId: options.session,
        includeShared: options.includeShared === true,
        strategy: options.strategy
      });

      console.log(formatPlainSearchResults(result));
    } catch (error) {
      console.error('Search failed:', error);
      process.exitCode = 1;
    } finally {
      await service.shutdown();
    }
  });

/**
 * Expand command - progressive retrieval layer 2
 */
program
  .command('expand <resultId>')
  .description('Expand a progressive retrieval result with surrounding context')
  .option('-w, --window-size <number>', 'Number of surrounding events on each side', '3')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (resultId: string, options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      const expansion = await service.expandDisclosure(resultId, {
        windowSize: parseInt(options.windowSize)
      });

      if (!expansion) {
        console.error(`Expansion target not found: ${resultId}`);
        process.exitCode = 1;
        return;
      }

      console.log(formatDisclosureExpansion(expansion));
    } catch (error) {
      console.error('Expand failed:', error);
      process.exitCode = 1;
    } finally {
      await service.shutdown();
    }
  });

/**
 * Source command - progressive retrieval layer 3
 */
program
  .command('source <resultId>')
  .description('Show raw source details for a progressive retrieval result')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (resultId: string, options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      const source = await service.sourceDisclosure(resultId);

      if (!source) {
        console.error(`Source not found: ${resultId}`);
        process.exitCode = 1;
        return;
      }

      console.log(formatDisclosureSource(source));
    } catch (error) {
      console.error('Source failed:', error);
      process.exitCode = 1;
    } finally {
      await service.shutdown();
    }
  });

/**
 * History command
 */
program
  .command('history')
  .description('View conversation history')
  .option('-l, --limit <number>', 'Number of events', '20')
  .option('--session <id>', 'Filter by session ID')
  .option('--type <type>', 'Filter by event type')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      let events;

      if (options.session) {
        events = await service.getSessionHistory(options.session);
      } else {
        events = await service.getRecentEvents(parseInt(options.limit));
      }

      if (options.type) {
        events = events.filter(e => e.eventType === options.type);
      }

      console.log('\n📜 Memory History\n');
      console.log(`Total events: ${events.length}\n`);

      for (const event of events.slice(0, parseInt(options.limit))) {
        const date = event.timestamp.toISOString();
        const icon = event.eventType === 'user_prompt' ? '👤' :
                    event.eventType === 'agent_response' ? '🤖' : '📝';

        console.log(`${icon} [${date}] ${event.eventType}`);
        console.log(`   Session: ${event.sessionId.slice(0, 8)}...`);
        console.log(`   ${event.content.slice(0, 150)}${event.content.length > 150 ? '...' : ''}`);
        console.log('');
      }

      await service.shutdown();
    } catch (error) {
      console.error('History failed:', error);
      process.exit(1);
    }
  });

/**
 * Stats command
 */
program
  .command('stats')
  .description('View memory statistics')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getLightweightMemoryServiceForProject(projectPath);

    try {
      const stats = await service.getStats();

      console.log('\n📊 Memory Statistics\n');
      console.log(`Total Events: ${stats.totalEvents}`);
      console.log(`Vector Count: ${stats.vectorCount}`);
      console.log('\nMemory Levels:');

      for (const level of stats.levelStats) {
        const bar = '█'.repeat(Math.min(20, Math.ceil(level.count / 10)));
        console.log(`  ${level.level}: ${bar} ${level.count}`);
      }

      await service.shutdown();
    } catch (error) {
      console.error('Stats failed:', error);
      process.exit(1);
    }
  });

/**
 * Forget command
 */
program
  .command('forget [eventId]')
  .description('Remove memories from storage')
  .option('--session <id>', 'Forget all events from a session')
  .option('--before <date>', 'Forget events before date (YYYY-MM-DD)')
  .option('--confirm', 'Skip confirmation')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (eventId: string | undefined, options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      if (!eventId && !options.session && !options.before) {
        console.error('Please specify an event ID, --session, or --before option');
        process.exit(1);
      }

      if (!options.confirm) {
        console.log('⚠️  This will remove memories from storage.');
        console.log('Add --confirm to proceed.');
        process.exit(0);
      }

      // Note: Full forget implementation would require additional EventStore methods
      console.log('🗑️  Forget functionality requires additional implementation.');
      console.log('Events are append-only; soft-delete markers would be added.');

      await service.shutdown();
    } catch (error) {
      console.error('Forget failed:', error);
      process.exit(1);
    }
  });

/**
 * Process command - manually process pending embeddings
 */
program
  .command('process')
  .description('Process pending embeddings')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .option('--no-recover-stuck', 'Skip stale processing outbox recovery before processing')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      await service.initialize();
      if (options.recoverStuck !== false) {
        const recovered = await service.recoverStuckOutboxItems();
        const recoveredCount = recovered.embedding.recoveredProcessing + recovered.embedding.retriedFailed + recovered.vector.recoveredProcessing + recovered.vector.retriedFailed;
        if (recoveredCount > 0) {
          console.log(`♻️  Recovered stuck outbox work: embedding=${recovered.embedding.recoveredProcessing}/${recovered.embedding.retriedFailed}, vector=${recovered.vector.recoveredProcessing}/${recovered.vector.retriedFailed}`);
        }
      }
      console.log('⏳ Processing pending embeddings...');
      const count = await service.processPendingEmbeddings();
      console.log(`✅ Processed ${count} embeddings`);

      await service.shutdown();
    } catch (error) {
      console.error('Process failed:', error);
      process.exit(1);
    }
  });

/**
 * Repair command - maintenance operations for legacy memory data
 */
const repairCommand = program
  .command('repair')
  .description('Repair or quarantine legacy memory metadata');

repairCommand
  .command('legacy-project-scope')
  .description('Dry-run or apply project-scope repair/quarantine for legacy imported events')
  .option('-p, --project <path>', 'Project path (defaults to cwd unless --project-hash is used)')
  .option('--project-hash <hash>', 'Project storage hash for hash-only repair flows')
  .option('--apply', 'Apply metadata changes (default is dry-run)')
  .action(async (options) => {
    try {
      const projectPath = options.project !== undefined
        ? options.project
        : (!options.projectHash ? process.cwd() : undefined);
      const repairOptions = resolveLegacyProjectScopeRepairOptions({
        project: projectPath,
        projectHash: options.projectHash,
        apply: options.apply
      });
      const storagePath = projectPath
        ? getProjectStoragePath(projectPath)
        : resolveProjectStoragePath(repairOptions.projectHash!);
      const dbPath = path.join(storagePath, 'events.sqlite');
      if (repairOptions.dryRun && !fs.existsSync(dbPath)) {
        const projectHash = repairOptions.projectHash || hashProjectPath(repairOptions.projectPath!);
        console.log(formatLegacyProjectScopeRepairResult({
          dryRun: true,
          projectHash,
          scanned: 0,
          repaired: 0,
          quarantined: 0,
          alreadyScoped: 0,
          skipped: 0,
          samples: []
        }));
        return;
      }
      const store = new SQLiteEventStore(dbPath, {
        readonly: repairOptions.dryRun
      });
      try {
        const result = await store.repairLegacyProjectScope(repairOptions);
        console.log(formatLegacyProjectScopeRepairResult(result));
      } finally {
        await store.close().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Repair failed: ${message}`);
      process.exit(1);
    }
  });

/**
 * Memory operation commands - CLI equivalents for MCP operation tools
 */
const facetCommand = program
  .command('facet')
  .description('Query and tag project-scoped memory facets');

facetCommand
  .command('query')
  .description('Query project-scoped memory facets')
  .requiredOption('-p, --project <path>', 'Project path')
  .option('--target-type <type>', 'Facet target type')
  .option('--target-id <id>', 'Facet target id')
  .option('--dimension <dimension>', 'Facet dimension')
  .option('--value <value>', 'Facet value')
  .option('--source <source>', 'Facet source')
  .option('--limit <count>', 'Maximum facets to return', '50')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => runOperationCli(async () => {
    const context = resolveOperationProject(options.project);
    const query = parseFacetQuery(omitUndefinedRecord({
      projectHash: context.projectHash,
      targetType: optionalOperationOption(options.targetType),
      targetId: optionalOperationOption(options.targetId),
      dimension: optionalOperationOption(options.dimension),
      value: optionalOperationOption(options.value),
      source: optionalOperationOption(options.source),
      limit: parseOperationLimit(options.limit, 50, 1, 100)
    }));
    const emptyPayload = { operation: 'mem-facet-query', projectHash: context.projectHash, count: 0, facets: [] as unknown[] };
    const payload = await withOperationExistingDatabase(context, emptyPayload, ['memory_facets'], async (db) => {
      const facets = await new FacetRepository(db).query(query);
      return {
        operation: 'mem-facet-query',
        projectHash: context.projectHash,
        count: facets.length,
        facets: facets.map(formatOperationFacet)
      };
    });
    writeOperationOutput(payload, options);
  }, 'Facet query'));

facetCommand
  .command('tag')
  .description('Assign a project-scoped facet; dry-run unless --apply is supplied')
  .requiredOption('-p, --project <path>', 'Project path')
  .requiredOption('--target-type <type>', 'Facet target type')
  .requiredOption('--target-id <id>', 'Facet target id')
  .requiredOption('--dimension <dimension>', 'Facet dimension')
  .requiredOption('--value <value>', 'Facet value')
  .option('--confidence <number>', 'Facet confidence between 0 and 1', '1')
  .option('--source <source>', 'Facet source', 'manual')
  .option('--source-event-ids <ids>', 'Comma-separated source/evidence event ids')
  .option('--actor <actor>', 'Actor for governance audit', 'cml-cli')
  .option('--apply', 'Apply the mutation; omitted means dry-run')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => runOperationCli(async () => {
    const context = resolveOperationProject(options.project);
    const input = parseFacetAssignmentInput({
      projectHash: context.projectHash,
      targetType: requiredOperationOption(options.targetType, 'targetType'),
      targetId: sanitizeOperationString(requiredOperationOption(options.targetId, 'targetId'), 120),
      dimension: sanitizeOperationString(requiredOperationOption(options.dimension, 'dimension'), 120),
      value: sanitizeOperationString(requiredOperationOption(options.value, 'value'), 240),
      confidence: parseOperationNumber(options.confidence, 1, 0, 1, 'confidence'),
      source: sanitizeOperationString(optionalOperationOption(options.source) ?? 'manual', 80),
      evidenceEventIds: splitOperationList(options.sourceEventIds, 20),
      actor: sanitizeOperationString(optionalOperationOption(options.actor) ?? 'cml-cli', 120)
    });
    if (!options.apply) {
      writeOperationOutput({ operation: 'mem-facet-tag', projectHash: context.projectHash, dryRun: true, wouldAssign: input }, options);
      return;
    }
    const facet = await withOperationWriteDatabase(context, async (db) => new FacetRepository(db).assign(input));
    writeOperationOutput({
      operation: 'mem-facet-tag',
      projectHash: context.projectHash,
      dryRun: false,
      facet: formatOperationFacet(facet)
    }, options);
  }, 'Facet tag'));

const actionCommand = program
  .command('action')
  .description('List and update project-scoped memory actions');

actionCommand
  .command('list')
  .description('List project-scoped memory actions')
  .requiredOption('-p, --project <path>', 'Project path')
  .option('--status <status>', 'Filter by action status')
  .option('--include-terminal', 'Include terminal statuses such as done/cancelled')
  .option('--limit <count>', 'Maximum actions to return', '50')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => runOperationCli(async () => {
    const context = resolveOperationProject(options.project);
    const listInput = ListActionsInputSchema.parse(omitUndefinedRecord({
      projectHash: context.projectHash,
      status: optionalOperationOption(options.status),
      includeTerminal: Boolean(options.includeTerminal),
      limit: parseOperationLimit(options.limit, 50, 1, 100)
    }));
    const emptyPayload = { operation: 'mem-action-list', projectHash: context.projectHash, count: 0, actions: [] as unknown[] };
    const payload = await withOperationExistingDatabase(context, emptyPayload, ['memory_actions'], async (db) => {
      const actions = await new ActionRepository(db).list(listInput);
      return {
        operation: 'mem-action-list',
        projectHash: context.projectHash,
        count: actions.length,
        actions: actions.map(formatOperationAction)
      };
    });
    writeOperationOutput(payload, options);
  }, 'Action list'));

actionCommand
  .command('update')
  .description('Update a project-scoped memory action; dry-run unless --apply is supplied')
  .requiredOption('-p, --project <path>', 'Project path')
  .requiredOption('--action-id <id>', 'Action id to update')
  .requiredOption('--status <status>', 'Next action status')
  .option('--note <note>', 'Governance audit note')
  .option('--source-event-ids <ids>', 'Comma-separated source/evidence event ids')
  .option('--actor <actor>', 'Actor for governance audit', 'cml-cli')
  .option('--apply', 'Apply the mutation; omitted means dry-run')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => runOperationCli(async () => {
    const context = resolveOperationProject(options.project);
    const sourceEventIds = splitOperationList(options.sourceEventIds, 20);
    const note = optionalOperationOption(options.note);
    const input = UpdateActionInputSchema.parse(omitUndefinedRecord({
      actionId: requiredOperationOption(options.actionId, 'actionId'),
      projectHash: context.projectHash,
      status: requiredOperationOption(options.status, 'status'),
      actor: sanitizeOperationString(optionalOperationOption(options.actor) ?? 'cml-cli', 120),
      sourceEventIds: sourceEventIds.length > 0 ? sourceEventIds : undefined,
      note: note ? sanitizeOperationString(note, 500) : undefined
    }));
    if (!options.apply) {
      writeOperationOutput({ operation: 'mem-action-update', projectHash: context.projectHash, dryRun: true, wouldUpdate: input }, options);
      return;
    }
    const action = await withOperationWriteDatabase(context, async (db) => new ActionRepository(db).update(input));
    writeOperationOutput({
      operation: 'mem-action-update',
      projectHash: context.projectHash,
      dryRun: false,
      action: formatOperationAction(action)
    }, options);
  }, 'Action update'));

program
  .command('frontier')
  .description('Rank the project-scoped operational action frontier')
  .requiredOption('-p, --project <path>', 'Project path')
  .option('--include-blocked', 'Do not penalize blocked actions')
  .option('--limit <count>', 'Maximum frontier items to return', '50')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => runOperationCli(async () => {
    const context = resolveOperationProject(options.project);
    const rankInput = {
      projectHash: context.projectHash,
      includeBlocked: Boolean(options.includeBlocked),
      limit: parseOperationLimit(options.limit, 50, 1, 100)
    };
    const emptyPayload = { operation: 'mem-frontier', projectHash: context.projectHash, count: 0, frontier: [] as unknown[] };
    const payload = await withOperationExistingDatabase(
      context,
      emptyPayload,
      ['memory_actions', 'memory_action_edges', 'memory_leases', 'memory_facets'],
      async (db) => {
        const frontier = await new FrontierService(db).rank(rankInput);
        return {
          operation: 'mem-frontier',
          projectHash: context.projectHash,
          count: frontier.length,
          frontier: frontier.map(formatOperationFrontierItem)
        };
      }
    );
    writeOperationOutput(payload, options);
  }, 'Frontier'));

const checkpointCommand = program
  .command('checkpoint')
  .description('Create and list project-scoped memory checkpoints');

checkpointCommand
  .command('create')
  .description('Create an action/session checkpoint; dry-run unless --apply is supplied')
  .requiredOption('-p, --project <path>', 'Project path')
  .requiredOption('--target-type <type>', 'Checkpoint target type: action or session')
  .requiredOption('--target-id <id>', 'Checkpoint target id')
  .requiredOption('--label <label>', 'Checkpoint label')
  .option('--state-json <json>', 'Checkpoint state JSON object')
  .option('--source-event-ids <ids>', 'Comma-separated source/evidence event ids')
  .option('--actor <actor>', 'Actor for governance audit', 'cml-cli')
  .option('--apply', 'Apply the mutation; omitted means dry-run')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => runOperationCli(async () => {
    const context = resolveOperationProject(options.project);
    const targetType = requiredOperationOption(options.targetType, 'targetType');
    if (targetType !== 'action' && targetType !== 'session') {
      throw new Error('targetType must be action or session');
    }
    const targetId = sanitizeOperationString(requiredOperationOption(options.targetId, 'targetId'), 120);
    const label = sanitizeOperationString(requiredOperationOption(options.label, 'label'), 240);
    const input = CreateCheckpointInputSchema.parse(omitUndefinedRecord({
      projectHash: context.projectHash,
      actionId: targetType === 'action' ? targetId : undefined,
      sessionId: targetType === 'session' ? targetId : undefined,
      title: label,
      summary: label,
      stateJson: parseOperationStateJson(options.stateJson),
      sourceEventIds: splitOperationList(options.sourceEventIds, 20),
      actor: sanitizeOperationString(optionalOperationOption(options.actor) ?? 'cml-cli', 120)
    }));
    if (!options.apply) {
      writeOperationOutput({ operation: 'mem-checkpoint-create', projectHash: context.projectHash, dryRun: true, wouldCreate: input }, options);
      return;
    }
    const checkpoint = await withOperationWriteDatabase(context, async (db) => new CheckpointRepository(db).create(input));
    writeOperationOutput({
      operation: 'mem-checkpoint-create',
      projectHash: context.projectHash,
      dryRun: false,
      checkpoint: formatOperationCheckpoint(checkpoint)
    }, options);
  }, 'Checkpoint create'));

checkpointCommand
  .command('list')
  .description('List project-scoped memory checkpoints')
  .requiredOption('-p, --project <path>', 'Project path')
  .option('--target-type <type>', 'Checkpoint target type: action or session')
  .option('--target-id <id>', 'Checkpoint target id')
  .option('--limit <count>', 'Maximum checkpoints to return', '50')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => runOperationCli(async () => {
    const context = resolveOperationProject(options.project);
    const targetType = optionalOperationOption(options.targetType);
    const targetId = optionalOperationOption(options.targetId);
    const listInputDraft: Record<string, unknown> = { projectHash: context.projectHash, limit: parseOperationLimit(options.limit, 50, 1, 100) };
    if (targetType || targetId) {
      if (targetType !== 'action' && targetType !== 'session') {
        throw new Error('targetType must be action or session when targetId is provided');
      }
      if (!targetId) throw new Error('targetId is required when targetType is provided');
      if (targetType === 'action') listInputDraft.actionId = targetId;
      if (targetType === 'session') listInputDraft.sessionId = targetId;
    }
    const listInput = ListCheckpointsInputSchema.parse(listInputDraft);
    const emptyPayload = { operation: 'mem-checkpoint-list', projectHash: context.projectHash, count: 0, checkpoints: [] as unknown[] };
    const payload = await withOperationExistingDatabase(context, emptyPayload, ['memory_checkpoints'], async (db) => {
      const checkpoints = await new CheckpointRepository(db).list(listInput);
      return {
        operation: 'mem-checkpoint-list',
        projectHash: context.projectHash,
        count: checkpoints.length,
        checkpoints: checkpoints.map(formatOperationCheckpoint)
      };
    });
    writeOperationOutput(payload, options);
  }, 'Checkpoint list'));

/**
 * Retention command - dry-run lifecycle audits for project-scoped memory
 */
const retentionCommand = program
  .command('retention')
  .description('Audit retention/governance lifecycle state without mutating memory data');

retentionCommand
  .command('audit')
  .description('Run a dry-run retention audit for project-scoped memories')
  .option('-p, --project <path>', 'Project path (defaults to cwd unless --project-hash is used)')
  .option('--project-hash <hash>', 'Project storage hash for hash-only audit flows')
  .option('--dry-run', 'Dry-run only; accepted for explicitness and enabled by default')
  .option('--limit <count>', 'Maximum event rows to scan', '100')
  .option('--json', 'Print machine-readable JSON')
  .action(async (options) => {
    try {
      const projectPath = options.project !== undefined
        ? options.project
        : (!options.projectHash ? process.cwd() : undefined);
      const auditOptions = resolveRetentionAuditOptions({
        project: projectPath,
        projectHash: options.projectHash,
        dryRun: true,
        limit: options.limit,
        json: options.json
      });
      const projectHash = auditOptions.projectHash ?? hashProjectPath(auditOptions.projectPath!);
      const storagePath = auditOptions.projectPath
        ? getProjectStoragePath(auditOptions.projectPath)
        : resolveProjectStoragePath(projectHash);
      const dbPath = path.join(storagePath, 'events.sqlite');

      if (!fs.existsSync(dbPath)) {
        const emptyReport = emptyRetentionAuditReport(projectHash, auditOptions.limit);
        console.log(formatRetentionAuditReport(emptyReport, { json: auditOptions.json }));
        return;
      }

      const db = createSQLiteDatabase(dbPath, { readonly: true, walMode: false });
      try {
        const report = runRetentionAudit(db, {
          projectHash,
          projectPath: auditOptions.projectPath,
          dryRun: true,
          limit: auditOptions.limit
        });
        console.log(formatRetentionAuditReport(report, { json: auditOptions.json }));
      } finally {
        sqliteClose(db);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Retention audit failed: ${message}`);
      process.exit(1);
    }
  });

/**
 * Mongo Sync command - sync local SQLite events with a shared MongoDB database (optional)
 */
program
  .command('mongo-sync')
  .description('Sync events with MongoDB for multi-server collaboration (optional)')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .option('--mongo-uri <uri>', 'MongoDB connection URI (env: CLAUDE_MEMORY_MONGO_URI)')
  .option('--mongo-db <name>', 'MongoDB database name (env: CLAUDE_MEMORY_MONGO_DB)')
  .option('--mongo-project <key>', 'Remote project key (env: CLAUDE_MEMORY_MONGO_PROJECT, default: basename(projectPath))')
  .option('--direction <dir>', 'push|pull|both', 'both')
  .option('--batch-size <n>', 'Batch size', '500')
  .option('--interval <ms>', 'Watch interval ms', '30000')
  .option('--watch', 'Run continuously')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const mongoUri = options.mongoUri || process.env.CLAUDE_MEMORY_MONGO_URI;
    const mongoDb = options.mongoDb || process.env.CLAUDE_MEMORY_MONGO_DB;
    const projectKey = options.mongoProject || process.env.CLAUDE_MEMORY_MONGO_PROJECT || path.basename(projectPath);
    const direction = String(options.direction || 'both').toLowerCase() as MongoSyncDirection;

    if (!mongoUri || !mongoDb) {
      console.error('\n❌ MongoDB sync is not configured.');
      console.error('   Set --mongo-uri/--mongo-db or env CLAUDE_MEMORY_MONGO_URI/CLAUDE_MEMORY_MONGO_DB.\n');
      process.exit(1);
    }

    if (!['push', 'pull', 'both'].includes(direction)) {
      console.error('\n❌ Invalid --direction. Use: push | pull | both\n');
      process.exit(1);
    }

    const storagePath = getProjectStoragePath(projectPath);
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    const batchSizeParsed = parseInt(options.batchSize, 10);
    const intervalParsed = parseInt(options.interval, 10);
    const batchSize = (Number.isFinite(batchSizeParsed) && batchSizeParsed > 0) ? batchSizeParsed : 500;
    const intervalMs = (Number.isFinite(intervalParsed) && intervalParsed > 0) ? intervalParsed : 30000;

    const sqliteStore = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    const worker = new MongoSyncWorker(sqliteStore, {
      uri: mongoUri,
      dbName: mongoDb,
      projectKey,
      direction,
      batchSize,
      intervalMs
    });

    const runOnce = async () => {
      const { pushed, pulled } = await worker.syncNow();
      const ts = new Date().toISOString();
      process.stdout.write(`[mongo-sync] ${ts} project=${projectKey} pushed=${pushed} pulled=${pulled}\n`);
    };

    try {
      if (!options.watch) {
        await runOnce();
        await worker.shutdown();
        sqliteStore.close();
        return;
      }

      console.log(`[mongo-sync] Watch mode started (interval=${intervalMs}ms, project=${projectKey})`);

      const handle = setInterval(() => {
        runOnce().catch((err) => {
          console.error('[mongo-sync] Sync failed:', err);
        });
      }, intervalMs);

      const shutdown = async () => {
        clearInterval(handle);
        console.log('\n[mongo-sync] Shutting down...');
        try {
          await worker.shutdown();
        } finally {
          sqliteStore.close();
        }
        process.exit(0);
      };

      process.on('SIGINT', () => { void shutdown(); });
      process.on('SIGTERM', () => { void shutdown(); });

      // Run immediately, then keep alive
      await runOnce();
      await new Promise(() => {});
    } catch (error) {
      console.error('[mongo-sync] Failed:', error);
      process.exit(1);
    }
  });

/**
 * Render import progress to terminal
 */
function renderProgress(event: ProgressEvent): void {
  switch (event.phase) {
    case 'scan':
      console.log(`  🔍 ${event.message}`);
      break;
    case 'session-start': {
      const pct = Math.round(((event.sessionIndex) / event.totalSessions) * 100);
      const sessionName = path.basename(event.filePath, '.jsonl').slice(0, 8);
      process.stdout.write(
        `\r  📄 [${event.sessionIndex + 1}/${event.totalSessions}] ${pct}% | Session ${sessionName}... `
      );
      break;
    }
    case 'session-progress': {
      process.stdout.write(
        `\r  📄 [${event.sessionIndex + 1}/...] ${event.messagesProcessed} msgs | +${event.imported} imported, ~${event.skipped} skipped `
      );
      break;
    }
    case 'session-done': {
      const imported = event.importedPrompts + event.importedResponses;
      if (imported > 0) {
        process.stdout.write(
          `\r  ✅ [${event.sessionIndex + 1}] +${event.importedPrompts} prompts, +${event.importedResponses} responses${event.skipped > 0 ? `, ~${event.skipped} skipped` : ''}     \n`
        );
      } else if (event.skipped > 0) {
        process.stdout.write(
          `\r  ⏭️  [${event.sessionIndex + 1}] All ${event.skipped} already imported                          \n`
        );
      } else {
        process.stdout.write(
          `\r  ⏭️  [${event.sessionIndex + 1}] Empty session                                              \n`
        );
      }
      break;
    }
    case 'embedding':
      process.stdout.write(
        `\r  🧠 Embeddings: ${event.processed}/${event.total} processed `
      );
      if (event.processed >= event.total) {
        process.stdout.write('\n');
      }
      break;
    case 'done':
      break;
  }
}

function printImportSummary(result: import('../../services/session-history-importer.js').ImportResult, embedCount: number): void {
  console.log('\n┌─────────────────────────────────┐');
  console.log('│       ✅ Import Complete         │');
  console.log('├─────────────────────────────────┤');
  console.log(`│  Sessions processed:  ${String(result.totalSessions).padStart(8)} │`);
  console.log(`│  Total messages:      ${String(result.totalMessages).padStart(8)} │`);
  console.log(`│  Imported prompts:    ${String(result.importedPrompts).padStart(8)} │`);
  console.log(`│  Imported responses:  ${String(result.importedResponses).padStart(8)} │`);
  console.log(`│  Skipped duplicates:  ${String(result.skippedDuplicates).padStart(8)} │`);
  console.log(`│  Embeddings queued:   ${String(embedCount).padStart(8)} │`);
  console.log('└─────────────────────────────────┘');

  if (result.errors.length > 0) {
    console.log(`\n⚠️  Errors (${result.errors.length}):`);
    for (const error of result.errors.slice(0, 5)) {
      console.log(`  - ${error}`);
    }
    if (result.errors.length > 5) {
      console.log(`  ... and ${result.errors.length - 5} more`);
    }
  }
}

function sanitizeSegment(input: string | undefined, fallback: string): string {
  const v = (input || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return v || fallback;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md') out.push(full);
    }
  }

  return out.sort();
}

function deriveNamespaceCategory(sourceRoot: string, filePath: string): { namespace: string; categoryPath: string[] } {
  const rel = path.relative(sourceRoot, filePath);
  const dirSeg = path.dirname(rel).split(path.sep).filter(Boolean);

  if (dirSeg.length >= 2) {
    const namespace = sanitizeSegment(dirSeg[0], 'default');
    const categoryPath = dirSeg.slice(1).map((s) => sanitizeSegment(s, 'uncategorized'));
    return { namespace, categoryPath: categoryPath.length > 0 ? categoryPath : ['uncategorized'] };
  }

  return { namespace: 'default', categoryPath: ['uncategorized'] };
}

function extractImportEvidence(markdown: string): { confidence?: string; sources: string[] } {
  const confidenceMatch = markdown.match(/^-\s*confidence:\s*([^\n]+)/m);
  const sources = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- source:'))
    .map((line) => line.replace(/^-\s*source:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 30);

  return {
    confidence: confidenceMatch ? confidenceMatch[1].trim() : undefined,
    sources
  };
}

/**
 * Organize-import command - import legacy markdown memories into structured mirror
 */
program
  .command('organize-import [sourceDir]')
  .description('Import existing markdown memory files, or bootstrap knowledge docs from codebase/git when markdown is missing')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .option('--session <id>', 'Session id for imported events (default: import:organized)')
  .option('--limit <n>', 'Limit number of files to import')
  .option('--dry-run', 'Preview mapping without writing')
  .option('--bootstrap', 'Force-generate structured markdown from codebase + git history before import')
  .option('--bootstrap-if-empty', 'Auto-bootstrap when source has no markdown files (default: true)', true)
  .option('--no-bootstrap-if-empty', 'Disable auto-bootstrap when source has no markdown files')
  .option('--force-bootstrap', 'Run bootstrap even when markdown files exist')
  .option('--repo <path>', 'Repository root for bootstrap analysis (default: project path)')
  .option('--out <path>', 'Output directory for generated bootstrap markdown (default: <sourceDir>/bootstrap-kb)')
  .option('--since <range>', 'Git history range for bootstrap (default: "180 days ago")')
  .option('--max-commits <n>', 'Max commits to analyze for bootstrap (default: 1000)')
  .option('--incremental', 'Use previous bootstrap manifest as baseline for incremental updates (default: true)', true)
  .option('--no-incremental', 'Disable incremental bootstrap; regenerate full snapshot')
  .action(async (sourceDir: string | undefined, options) => {
    const projectPath = options.project || process.cwd();
    const sessionId = options.session || 'import:organized';
    const sourceRoot = path.resolve(sourceDir || options.out || projectPath);
    const repoPath = path.resolve(options.repo || projectPath);

    if (!fs.existsSync(sourceRoot)) {
      fs.mkdirSync(sourceRoot, { recursive: true });
    }

    const service = getMemoryServiceForProject(projectPath);

    try {
      let activeSourceRoot = sourceRoot;
      let importRoot = sourceRoot;
      let files = await listMarkdownFiles(importRoot);
      const hasMarkdown = files.length > 0;
      const shouldBootstrap = Boolean(options.forceBootstrap || options.bootstrap || (!hasMarkdown && options.bootstrapIfEmpty));

      if (shouldBootstrap) {
        const outDir = path.resolve(options.out || path.join(sourceRoot, 'bootstrap-kb'));
        const since = options.since || '180 days ago';
        const maxCommits = options.maxCommits ? Math.max(1, parseInt(options.maxCommits, 10)) : 1000;

        console.log('\n🧠 Bootstrapping markdown knowledge base...');
        const bootstrap = await bootstrapKnowledgeBase({
          repoPath,
          outDir,
          since,
          maxCommits,
          incremental: options.incremental
        });
        console.log(`  Repo: ${repoPath}`);
        console.log(`  Output: ${bootstrap.outDir}`);
        console.log(`  Files analyzed: ${bootstrap.fileCount}`);
        console.log(`  Commits analyzed: ${bootstrap.commitCount}`);
        console.log(`  Modules: ${bootstrap.moduleCount}`);

        activeSourceRoot = outDir;
        importRoot = outDir;
        files = await listMarkdownFiles(importRoot);
      }

      if (files.length === 0) {
        console.error('\n❌ organize-import found no markdown files to import.\n');
        process.exit(1);
      }

      const limit = options.limit ? Math.max(1, parseInt(options.limit, 10)) : files.length;
      const targets = files.slice(0, limit);

      console.log(`\n📦 organize-import`);
      console.log(`  Source: ${activeSourceRoot}`);
      console.log(`  Project: ${projectPath}`);
      console.log(`  Files: ${targets.length}${targets.length < files.length ? `/${files.length}` : ''}`);
      console.log(`  Dry-run: ${options.dryRun ? 'yes' : 'no'}\n`);

      if (!options.dryRun) {
        await service.initialize();
      }

      let imported = 0;
      let skipped = 0;

      for (const file of targets) {
        const text = await fs.promises.readFile(file, 'utf8');
        if (!text.trim()) {
          skipped += 1;
          continue;
        }

        const { namespace, categoryPath } = deriveNamespaceCategory(activeSourceRoot, file);
        const rel = path.relative(activeSourceRoot, file);
        const evidence = extractImportEvidence(text);

        if (options.dryRun) {
          console.log(`- ${rel} -> namespace=${namespace} category=${categoryPath.join('/')} confidence=${evidence.confidence || 'n/a'} sources=${evidence.sources.length}`);
          continue;
        }

        await service.storeSessionSummary(sessionId, text, {
          namespace,
          categoryPath,
          confidence: evidence.confidence,
          sources: evidence.sources,
          import: {
            sourceFile: rel,
            importedAt: new Date().toISOString(),
            bootstrap: shouldBootstrap === true
          }
        });
        imported += 1;
      }

      if (!options.dryRun) {
        const embed = await service.processPendingEmbeddings();
        await service.shutdown();
        console.log(`\n✅ Imported: ${imported}, skipped-empty: ${skipped}, embeddings: ${embed}\n`);
      } else {
        console.log(`\n✅ Dry-run complete (planned imports: ${targets.length - skipped}, skipped-empty: ${skipped})\n`);
      }
    } catch (error) {
      console.error('\n❌ organize-import failed:', error);
      process.exit(1);
    }
  });

/**
 * Import command - import existing Claude Code sessions
 */
program
  .command('import')
  .description('Import existing Claude Code conversation history')
  .option('-p, --project <path>', 'Import from specific project path')
  .option('-s, --session <file>', 'Import specific session file (JSONL)')
  .option('-a, --all', 'Import all sessions from all projects')
  .option('-l, --limit <number>', 'Limit messages per session')
  .option('--session-limit <number>', 'Limit recent matching sessions to import')
  .option('-f, --force', 'Force reimport: delete existing events and reimport with turn_id grouping')
  .option('--embedding-model <name>', `Embedding model override (default: ${DEFAULT_EMBEDDING_MODEL}, or env CLAUDE_MEMORY_EMBEDDING_MODEL; fallback: ${DEFAULT_EMBEDDING_FALLBACK_MODEL} or env CLAUDE_MEMORY_EMBEDDING_FALLBACK_MODEL)`)
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options) => {
    const startTime = Date.now();

    // Determine target project path for storage
    const targetProjectPath = options.project || process.cwd();

    if (options.embeddingModel) {
      process.env.CLAUDE_MEMORY_EMBEDDING_MODEL = options.embeddingModel;
    }

    // Use project-specific memory service
    const service = getMemoryServiceForProject(targetProjectPath);
    const importer = createSessionHistoryImporter(service);

    const importOpts = {
      limit: parsePositiveIntegerOption(options.limit, 'limit'),
      sessionLimit: parsePositiveIntegerOption(options.sessionLimit, 'session-limit'),
      force: options.force,
      verbose: options.verbose,
      onProgress: renderProgress
    };

    try {
      console.log('\n⏳ Initializing memory service...');
      await service.initialize();
      console.log(`  ✅ Ready (embedder: ${service.getEmbeddingModelName()})\n`);

      const migration = await service.ensureEmbeddingModelForImport({ autoMigrate: true });
      if (migration.changed) {
        console.log('🔁 Embedding model migration detected/required');
        console.log(`   Previous: ${migration.previousModel || 'legacy-unknown'}`);
        console.log(`   Current:  ${migration.currentModel}`);
        console.log(`   Re-queued embeddings: ${migration.enqueued}`);
        console.log('   (Import will continue and process embeddings with the new model)\n');
      }

      if (options.force) {
        console.log('🔄 Force mode: existing events will be deleted and reimported with turn_id grouping\n');
      }

      let result;

      if (options.session) {
        // Import specific session file
        console.log(`📥 Importing session: ${options.session}`);
        console.log(`   Target: ${targetProjectPath}\n`);
        result = await importer.importSessionFile(options.session, {
          ...importOpts,
          projectPath: targetProjectPath,
        });
      } else if (options.project) {
        // Import all sessions from a project
        console.log(`📥 Importing project: ${options.project}\n`);
        result = await importer.importProject(options.project, importOpts);
      } else if (options.all) {
        // Import all sessions from all projects
        console.log('📥 Importing all sessions from all projects');
        console.log('   ⚠️  Using global storage (use -p for project-specific)\n');
        const globalService = getDefaultMemoryService();
        const globalImporter = createSessionHistoryImporter(globalService);
        await globalService.initialize();
        console.log(`  ✅ Global service ready (embedder: ${globalService.getEmbeddingModelName()})`);
        const globalMigration = await globalService.ensureEmbeddingModelForImport({ autoMigrate: true });
        if (globalMigration.changed) {
          console.log('🔁 Global embedding migration detected');
          console.log(`   Previous: ${globalMigration.previousModel || 'legacy-unknown'}`);
          console.log(`   Current:  ${globalMigration.currentModel}`);
          console.log(`   Re-queued embeddings: ${globalMigration.enqueued}`);
        }
        result = await globalImporter.importAll(importOpts);

        // Process embeddings
        console.log('\n🧠 Processing embeddings...');
        const embedCount = await globalService.processPendingEmbeddings();

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        printImportSummary(result, embedCount);
        console.log(`\n⏱️  Completed in ${elapsed}s`);

        await globalService.shutdown();
        return;
      } else {
        // Default: import current project
        const cwd = process.cwd();
        console.log(`📥 Importing sessions for: ${cwd}\n`);
        result = await importer.importProject(cwd, {
          ...importOpts,
          projectPath: cwd,
        });
      }

      // Process embeddings
      console.log('\n🧠 Processing embeddings...');
      const embedCount = await service.processPendingEmbeddings();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      printImportSummary(result, embedCount);
      console.log(`\n⏱️  Completed in ${elapsed}s`);

      await service.shutdown();
    } catch (error) {
      console.error('\n❌ Import failed:', error);
      process.exit(1);
    }
  });

/**
 * List command - list available sessions for import
 */
program
  .command('list')
  .description('List available Claude Code sessions')
  .option('-p, --project <path>', 'Filter by project path')
  .action(async (options) => {
    const service = getDefaultMemoryService();
    const importer = createSessionHistoryImporter(service);

    try {
      const sessions = await importer.listAvailableSessions(options.project);

      console.log('\n📋 Available Sessions\n');
      console.log(`Found ${sessions.length} session(s)\n`);

      for (const session of sessions.slice(0, 20)) {
        const date = session.modifiedAt.toISOString().split('T')[0];
        const sizeKB = (session.size / 1024).toFixed(1);
        console.log(`📝 ${session.sessionId.slice(0, 16)}...`);
        console.log(`   Modified: ${date}`);
        console.log(`   Size: ${sizeKB} KB`);
        console.log(`   Path: ${session.filePath}`);
        console.log('');
      }

      if (sessions.length > 20) {
        console.log(`... and ${sessions.length - 20} more sessions`);
      }

      console.log('\nUse "claude-memory-layer import --session <path>" to import a specific session');
    } catch (error) {
      console.error('List failed:', error);
      process.exit(1);
    }
  });

// ============================================================
// Codex Validation Commands
// ============================================================

const codexCmd = program
  .command('codex')
  .description('Read-only Codex session scan/replay validation');

codexCmd
  .command('validate')
  .description('Dry-run validate Codex JSONL sessions without importing or mutating memory')
  .option('-p, --project <path>', 'Filter sessions by session_meta.payload.cwd')
  .option('--sessions-dir <path>', 'Codex sessions directory (default: ~/.codex/sessions)')
  .option('-l, --limit <number>', 'Limit number of session files to scan')
  .option('--format <format>', 'Report format: json or markdown', 'markdown')
  .option('-o, --output <path>', 'Write report to file')
  .option('--dry-run', 'Read-only validation mode (default; no imports or writes)', true)
  .option('--anonymize-projects', 'Show hashed project labels instead of raw cwd paths')
  .action(async (options: CodexValidateCommandOptions) => {
    try {
      await runCodexValidationCommand(options);
    } catch (error) {
      console.error('Codex validation failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

codexCmd
  .command('replay')
  .description('Alias for read-only Codex validation/replay report')
  .option('-p, --project <path>', 'Filter sessions by session_meta.payload.cwd')
  .option('--sessions-dir <path>', 'Codex sessions directory (default: ~/.codex/sessions)')
  .option('-l, --limit <number>', 'Limit number of session files to scan')
  .option('--format <format>', 'Report format: json or markdown', 'markdown')
  .option('-o, --output <path>', 'Write report to file')
  .option('--dry-run', 'Read-only validation mode (default; no imports or writes)', true)
  .option('--anonymize-projects', 'Show hashed project labels instead of raw cwd paths')
  .action(async (options: CodexValidateCommandOptions) => {
    try {
      await runCodexValidationCommand(options);
    } catch (error) {
      console.error('Codex replay failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

codexCmd
  .command('import')
  .description('Explicitly import Codex JSONL sessions into claude-memory-layer memory (mutates memory)')
  .option('-p, --project <path>', 'Import sessions whose session_meta.payload.cwd matches this project (default: cwd)')
  .option('-s, --session <file>', 'Import one Codex session JSONL file')
  .option('-a, --all', 'Import all Codex sessions into global memory unless --project is supplied')
  .option('--sessions-dir <path>', 'Codex sessions directory (default: ~/.codex/sessions)')
  .option('-l, --limit <number>', 'Limit memories imported across selected matching sessions')
  .option('--session-limit <number>', 'Limit recent matching sessions to import')
  .option('-f, --force', 'Delete existing events for each imported session before reimporting')
  .option('-v, --verbose', 'Show detailed progress')
  .option('--no-process-embeddings', 'Skip processing pending embeddings after import')
  .action(async (options) => {
    const startTime = Date.now();
    try {
      if (options.all && !options.project && !options.session) {
        console.log('\n📥 Importing all Codex sessions into global memory');
        console.log('   ⚠️  Use --project to keep memory scoped to one project.\n');
      } else {
        console.log(`\n📥 Importing Codex sessions for: ${options.project || process.cwd()}\n`);
      }

      const outcome = await runCodexImportOnce(options, {
        cwd: () => process.cwd(),
        getDefaultMemoryService,
        getMemoryServiceForProject,
        createImporter: createCodexSessionHistoryImporter,
        onProgress: renderProgress
      });

      printImportSummary(outcome.result, outcome.embedCount);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n⏱️  Codex import completed in ${elapsed}s (${outcome.mode}, ${outcome.storageScope} storage)`);
    } catch (error) {
      console.error('Codex import failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ============================================================
// Hermes Validation Commands
// ============================================================

const hermesCmd = program
  .command('hermes')
  .description('Read-only Hermes SessionDB scan/replay validation and explicit import');

hermesCmd
  .command('validate')
  .description('Dry-run validate Hermes ~/.hermes/state.db sessions without importing or mutating memory')
  .option('-p, --project <path>', 'Filter sessions by project path in Hermes session context')
  .option('--state-db <path>', 'Hermes state database path (default: ~/.hermes/state.db)')
  .option('-l, --limit <number>', 'Limit number of matching sessions to scan')
  .option('--format <format>', 'Report format: json or markdown', 'markdown')
  .option('-o, --output <path>', 'Write report to file')
  .option('--dry-run', 'Read-only validation mode (default; no imports or writes)', true)
  .action(async (options: HermesValidateCommandOptions) => {
    try {
      await runHermesValidationCommand(options);
    } catch (error) {
      console.error('Hermes validation failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

hermesCmd
  .command('replay')
  .description('Alias for read-only Hermes SessionDB validation/replay report')
  .option('-p, --project <path>', 'Filter sessions by project path in Hermes session context')
  .option('--state-db <path>', 'Hermes state database path (default: ~/.hermes/state.db)')
  .option('-l, --limit <number>', 'Limit number of matching sessions to scan')
  .option('--format <format>', 'Report format: json or markdown', 'markdown')
  .option('-o, --output <path>', 'Write report to file')
  .option('--dry-run', 'Read-only validation mode (default; no imports or writes)', true)
  .action(async (options: HermesValidateCommandOptions) => {
    try {
      await runHermesValidationCommand(options);
    } catch (error) {
      console.error('Hermes replay failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

hermesCmd
  .command('import')
  .description('Explicitly import Hermes SessionDB sessions into claude-memory-layer memory (mutates memory)')
  .option('-p, --project <path>', 'Import sessions whose Hermes context matches this project (default: cwd)')
  .option('-s, --session <id>', 'Import one Hermes session id')
  .option('-a, --all', 'Import all Hermes sessions into global memory unless --project is supplied')
  .option('--state-db <path>', 'Hermes state database path (default: ~/.hermes/state.db)')
  .option('-l, --limit <number>', 'Limit messages imported per selected Hermes session')
  .option('--session-limit <number>', 'Limit recent matching sessions to import')
  .option('-f, --force', 'Delete existing events for each imported session before reimporting')
  .option('-v, --verbose', 'Show detailed progress')
  .option('--no-process-embeddings', 'Skip processing pending embeddings after import')
  .action(async (options) => {
    const startTime = Date.now();
    try {
      if (options.all && !options.project && !options.session) {
        console.log('\n📥 Importing all Hermes sessions into global memory');
        console.log('   ⚠️  Use --project to keep memory scoped to one project.\n');
      } else {
        console.log(`\n📥 Importing Hermes sessions for: ${options.project || process.cwd()}\n`);
      }

      const outcome = await runHermesImportOnce(options, {
        cwd: () => process.cwd(),
        getDefaultMemoryService,
        getMemoryServiceForProject,
        createImporter: createHermesSessionHistoryImporter,
        onProgress: renderProgress
      });

      printImportSummary(outcome.result, outcome.embedCount);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n⏱️  Hermes import completed in ${elapsed}s (${outcome.mode}, ${outcome.storageScope} storage)`);
    } catch (error) {
      console.error('Hermes import failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ============================================================
// Endless Mode Commands
// ============================================================

/**
 * Endless Mode parent command
 */
const endlessCmd = program
  .command('endless')
  .description('Manage Endless Mode (biomimetic continuous memory)');

/**
 * Enable Endless Mode
 */
endlessCmd
  .command('enable')
  .description('Enable Endless Mode')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      await service.initialize();
      await service.setMode('endless');

      console.log('\n♾️  Endless Mode Enabled\n');
      console.log('Your conversations will now be continuously integrated');
      console.log('across session boundaries.\n');
      console.log('Features:');
      console.log('  - Working Set: Recent context kept active');
      console.log('  - Consolidation: Automatic memory integration');
      console.log('  - Continuity: Seamless context transitions\n');
      console.log('Use "claude-memory-layer endless status" to view current state');

      await service.shutdown();
    } catch (error) {
      console.error('Enable failed:', error);
      process.exit(1);
    }
  });

/**
 * Disable Endless Mode
 */
endlessCmd
  .command('disable')
  .description('Disable Endless Mode (return to Session Mode)')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      await service.initialize();
      await service.setMode('session');

      console.log('\n📋 Session Mode Enabled\n');
      console.log('Returned to traditional session-based memory.');
      console.log('Existing Endless Mode data is preserved for future use.');

      await service.shutdown();
    } catch (error) {
      console.error('Disable failed:', error);
      process.exit(1);
    }
  });

/**
 * Endless Mode Status
 */
endlessCmd
  .command('status')
  .description('Show Endless Mode status')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      await service.initialize();
      const status = await service.getEndlessModeStatus();

      const modeIcon = status.mode === 'endless' ? '♾️' : '📋';
      const modeName = status.mode === 'endless' ? 'Endless Mode' : 'Session Mode';

      console.log(`\n${modeIcon} ${modeName}\n`);

      if (status.mode === 'endless') {
        // Continuity score bar
        const continuityBars = '█'.repeat(Math.round(status.continuityScore * 10));
        const continuityEmpty = '░'.repeat(10 - Math.round(status.continuityScore * 10));

        console.log('📊 Status:');
        console.log(`   Working Set: ${status.workingSetSize} events`);
        console.log(`   Continuity:  [${continuityBars}${continuityEmpty}] ${(status.continuityScore * 100).toFixed(0)}%`);
        console.log(`   Consolidated: ${status.consolidatedCount} memories`);

        if (status.lastConsolidation) {
          const ago = Math.round((Date.now() - status.lastConsolidation.getTime()) / 60000);
          console.log(`   Last Consolidation: ${ago} minutes ago`);
        } else {
          console.log('   Last Consolidation: Never');
        }
      } else {
        console.log('Endless Mode is disabled.');
        console.log('Use "claude-memory-layer endless enable" to activate.');
      }

      await service.shutdown();
    } catch (error) {
      console.error('Status failed:', error);
      process.exit(1);
    }
  });

/**
 * Consolidate command - manually trigger consolidation
 */
endlessCmd
  .command('consolidate')
  .description('Manually trigger memory consolidation')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      await service.initialize();

      if (!service.isEndlessModeActive()) {
        console.log('\n⚠️  Endless Mode is not active');
        console.log('Use "claude-memory-layer endless enable" first');
        process.exit(1);
      }

      console.log('\n⏳ Running memory consolidation...');
      const count = await service.forceConsolidation();

      if (count > 0) {
        console.log(`\n✅ Consolidated ${count} memory group(s)`);
      } else {
        console.log('\n📋 No memories to consolidate');
        console.log('(Working set may not have enough events yet)');
      }

      await service.shutdown();
    } catch (error) {
      console.error('Consolidation failed:', error);
      process.exit(1);
    }
  });

/**
 * Working Set command - view current working set
 */
endlessCmd
  .command('working-set')
  .alias('ws')
  .description('View current working set')
  .option('-l, --limit <number>', 'Number of events to show', '10')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      await service.initialize();

      if (!service.isEndlessModeActive()) {
        console.log('\n⚠️  Endless Mode is not active');
        console.log('Use "claude-memory-layer endless enable" first');
        process.exit(1);
      }

      const workingSet = await service.getWorkingSet();

      if (!workingSet || workingSet.recentEvents.length === 0) {
        console.log('\n📋 Working Set is empty');
        console.log('Events will be added as you interact with Claude');
        process.exit(0);
      }

      console.log('\n🧠 Working Set\n');
      console.log(`Total events: ${workingSet.recentEvents.length}`);
      console.log(`Continuity score: ${(workingSet.continuityScore * 100).toFixed(0)}%`);
      console.log(`Last activity: ${workingSet.lastActivity.toISOString()}\n`);

      const limit = parseInt(options.limit);
      const events = workingSet.recentEvents.slice(0, limit);

      for (const event of events) {
        const icon = event.eventType === 'user_prompt' ? '👤' :
                    event.eventType === 'agent_response' ? '🤖' :
                    event.eventType === 'tool_observation' ? '🔧' : '📝';
        const time = event.timestamp.toLocaleTimeString();
        const preview = event.content.slice(0, 80) + (event.content.length > 80 ? '...' : '');

        console.log(`${icon} [${time}] ${event.eventType}`);
        console.log(`   ${preview}`);
        console.log('');
      }

      if (workingSet.recentEvents.length > limit) {
        console.log(`... and ${workingSet.recentEvents.length - limit} more events`);
      }

      await service.shutdown();
    } catch (error) {
      console.error('Working set failed:', error);
      process.exit(1);
    }
  });

/**
 * Consolidated memories command
 */
endlessCmd
  .command('memories')
  .description('View consolidated memories')
  .option('-l, --limit <number>', 'Number of memories to show', '10')
  .option('-q, --query <text>', 'Search consolidated memories')
  .option('-p, --project <path>', 'Project path (defaults to cwd)')
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      await service.initialize();

      let memories;

      if (options.query) {
        memories = await service.searchConsolidated(options.query, {
          topK: parseInt(options.limit)
        });
        console.log(`\n🔍 Searching for: "${options.query}"\n`);
      } else {
        memories = await service.getConsolidatedMemories(parseInt(options.limit));
        console.log('\n💾 Consolidated Memories\n');
      }

      if (memories.length === 0) {
        console.log('No consolidated memories found.');
        if (!service.isEndlessModeActive()) {
          console.log('Enable Endless Mode to start consolidating memories.');
        }
        process.exit(0);
      }

      console.log(`Showing ${memories.length} memory(ies)\n`);

      for (const memory of memories) {
        const date = memory.createdAt.toISOString().split('T')[0];
        const confidenceBars = '█'.repeat(Math.round(memory.confidence * 5));

        console.log(`📚 ${memory.topics.slice(0, 3).join(', ')}`);
        console.log(`   Created: ${date}`);
        console.log(`   Confidence: [${confidenceBars}] ${(memory.confidence * 100).toFixed(0)}%`);
        console.log(`   Sources: ${memory.sourceEvents.length} events`);
        console.log(`   Access count: ${memory.accessCount}`);
        console.log(`   Summary: ${memory.summary.slice(0, 200)}${memory.summary.length > 200 ? '...' : ''}`);
        console.log('');
      }

      await service.shutdown();
    } catch (error) {
      console.error('Memories failed:', error);
      process.exit(1);
    }
  });

/**
 * MCP command - configure Claude Desktop MCP integration
 */
const mcpCmd = program
  .command('mcp')
  .description('Manage MCP Desktop integration');

mcpCmd
  .command('install')
  .description('Install claude-memory-layer MCP server into Claude Desktop config')
  .option('-c, --config-path <path>', 'Claude Desktop config path')
  .option('-n, --server-name <name>', 'MCP server name', 'claude-memory-layer')
  .option('--command <command>', 'MCP server command', 'claude-memory-layer-mcp')
  .option('--arg <arg...>', 'Arguments for the MCP server command')
  .option('--dry-run', 'Print the updated config without writing it')
  .action((options: { configPath?: string; serverName: string; command: string; arg?: string[]; dryRun?: boolean }) => {
    try {
      const { configPath, config } = installMcpServer({
        configPath: options.configPath,
        serverName: options.serverName,
        command: options.command,
        args: options.arg ?? [],
        dryRun: options.dryRun ?? false
      });

      if (options.dryRun) {
        console.log(JSON.stringify(config, null, 2));
        console.log(`\nDry run only. No changes written to ${configPath}`);
        return;
      }

      console.log(`\n✅ Installed MCP server '${options.serverName}' into Claude Desktop config.`);
      console.log(`   Config: ${configPath}`);
      console.log('   Restart Claude Desktop to load the new MCP server.\n');
    } catch (error) {
      console.error('MCP install failed:', error);
      process.exit(1);
    }
  });

/**
 * Dashboard command - start web dashboard
 */
program
  .command('dashboard')
  .description('Open memory dashboard in browser')
  .option('-p, --port <port>', 'Server port', '37777')
  .option('--bind <host>', 'Bind host: localhost (default) or 0.0.0.0')
  .option('--host <host>', 'Alias for --bind <host>')
  .option('--password <password>', 'Require this password before serving the dashboard')
  .option('--no-open', 'Do not auto-open browser')
  .action(async (options) => {
    const dashboard = resolveDashboardCommandOptions(options);
    const { port, host, password, dashboardUrl } = dashboard;

    try {
      // Check if server is already running
      const running = await isServerRunning(port);
      if (running) {
        console.log(`\n🧠 Dashboard already running at ${dashboardUrl}\n`);
        if (options.open) {
          openBrowser(dashboardUrl);
        }
        return;
      }

      // Start the server
      console.log('\n🧠 Starting Code Memory Dashboard...\n');
      startServer({ port, host, password });

      // Open browser
      if (options.open) {
        setTimeout(() => {
          openBrowser(dashboardUrl);
        }, 500);
      }

      console.log(`\n📊 Dashboard: ${dashboardUrl}`);
      console.log(`🔌 Bind: ${host}`);
      console.log(`🔐 Password: ${password ? 'enabled' : 'disabled'}`);
      if (host === '0.0.0.0' && !password) {
        console.log('⚠️  Bound to 0.0.0.0 without --password; anyone on the reachable network can access it.');
      }
      console.log('Press Ctrl+C to stop the server\n');

      // Handle graceful shutdown
      const shutdown = () => {
        console.log('\n\n👋 Shutting down dashboard...');
        stopServer();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep process alive
      await new Promise(() => {});
    } catch (error) {
      console.error('Dashboard failed:', error);
      process.exit(1);
    }
  });

/**
 * Open URL in default browser
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`\n⚠️  Could not open browser automatically.`);
      console.log(`   Please open ${url} manually.\n`);
    }
  });
}

program.parse();
