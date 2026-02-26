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
  getProjectStoragePath
} from '../services/memory-service.js';
import { createSessionHistoryImporter, type ProgressEvent } from '../services/session-history-importer.js';
import { bootstrapKnowledgeBase } from '../services/bootstrap-organizer.js';
import { startServer, stopServer, isServerRunning } from '../server/index.js';
import { SQLiteEventStore } from '../core/sqlite-event-store.js';
import { MongoSyncWorker } from '../core/mongo-sync-worker.js';

// ============================================================
// Hook Installation Utilities
// ============================================================

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    PostToolUse?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    SessionStart?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    Stop?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
  };
  [key: string]: unknown;
}

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

function getHooksConfig(pluginPath: string): ClaudeSettings['hooks'] {
  return {
    UserPromptSubmit: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `node ${path.join(pluginPath, 'hooks', 'user-prompt-submit.js')}`
          }
        ]
      }
    ],
    PostToolUse: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `node ${path.join(pluginPath, 'hooks', 'post-tool-use.js')}`
          }
        ]
      }
    ]
  };
}

const program = new Command();

program
  .name('claude-memory-layer')
  .description('Claude Code Memory Plugin CLI')
  .version(process.env.CLAUDE_MEMORY_LAYER_VERSION || '0.0.0');

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
      const userPromptHook = path.join(pluginPath, 'hooks', 'user-prompt-submit.js');
      if (!fs.existsSync(userPromptHook)) {
        console.error(`\n❌ Hook files not found at: ${pluginPath}`);
        console.error('   Make sure you have built the plugin with "npm run build"');
        process.exit(1);
      }

      // Load existing settings
      const settings = loadClaudeSettings();

      // Add hooks (merge with existing)
      const newHooks = getHooksConfig(pluginPath);
      settings.hooks = {
        ...settings.hooks,
        ...newHooks
      };

      // Save settings
      saveClaudeSettings(settings);

      console.log('\n✅ Claude Memory Layer installed!\n');
      console.log('Hooks registered:');
      console.log('  - UserPromptSubmit: Memory retrieval on user input');
      console.log('  - PostToolUse: Store tool observations\n');
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

      // Remove our hooks
      delete settings.hooks.UserPromptSubmit;
      delete settings.hooks.PostToolUse;

      // Clean up empty hooks object
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      // Save settings
      saveClaudeSettings(settings);

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
      const hasUserPromptHook = settings.hooks?.UserPromptSubmit?.some(h =>
        h.hooks?.some(hook => hook.command?.includes('user-prompt-submit'))
      );
      const hasPostToolHook = settings.hooks?.PostToolUse?.some(h =>
        h.hooks?.some(hook => hook.command?.includes('post-tool-use'))
      );

      console.log('Hooks:');
      console.log(`  UserPromptSubmit: ${hasUserPromptHook ? '✅ Installed' : '❌ Not installed'}`);
      console.log(`  PostToolUse: ${hasPostToolHook ? '✅ Installed' : '❌ Not installed'}`);

      // Check plugin files
      const hooksExist = fs.existsSync(path.join(pluginPath, 'hooks', 'user-prompt-submit.js'));
      console.log(`\nPlugin files: ${hooksExist ? '✅ Found' : '❌ Not found'}`);
      console.log(`  Path: ${pluginPath}`);

      // Check dashboard
      const dashboardRunning = await isServerRunning(37777);
      console.log(`\nDashboard: ${dashboardRunning ? '✅ Running at http://localhost:37777' : '⏹️  Not running'}`);

      if (!hasUserPromptHook || !hasPostToolHook) {
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
  .action(async (query: string, options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
      const result = await service.retrieveMemories(query, {
        topK: parseInt(options.topK),
        minScore: parseFloat(options.minScore),
        sessionId: options.session
      });

      console.log('\n📚 Search Results\n');
      console.log(`Confidence: ${result.matchResult.confidence}`);
      console.log(`Total memories found: ${result.memories.length}\n`);

      for (const memory of result.memories) {
        const date = memory.event.timestamp.toISOString().split('T')[0];
        console.log(`---`);
        console.log(`📌 ${memory.event.eventType} (${date})`);
        console.log(`   Score: ${memory.score.toFixed(3)}`);
        console.log(`   Session: ${memory.event.sessionId.slice(0, 8)}...`);
        console.log(`   Content: ${memory.event.content.slice(0, 200)}${memory.event.content.length > 200 ? '...' : ''}`);
        console.log('');
      }

      await service.shutdown();
    } catch (error) {
      console.error('Search failed:', error);
      process.exit(1);
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
    const service = getMemoryServiceForProject(projectPath);

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
  .action(async (options) => {
    const projectPath = options.project || process.cwd();
    const service = getMemoryServiceForProject(projectPath);

    try {
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
    const direction = String(options.direction || 'both').toLowerCase();

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

function printImportSummary(result: import('../services/session-history-importer.js').ImportResult, embedCount: number): void {
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
  .option('-f, --force', 'Force reimport: delete existing events and reimport with turn_id grouping')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options) => {
    const startTime = Date.now();

    // Determine target project path for storage
    const targetProjectPath = options.project || process.cwd();

    // Use project-specific memory service
    const service = getMemoryServiceForProject(targetProjectPath);
    const importer = createSessionHistoryImporter(service);

    const importOpts = {
      limit: options.limit ? parseInt(options.limit) : undefined,
      force: options.force,
      verbose: options.verbose,
      onProgress: renderProgress
    };

    try {
      console.log('\n⏳ Initializing memory service...');
      await service.initialize();
      console.log('  ✅ Ready\n');

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
 * Dashboard command - start web dashboard
 */
program
  .command('dashboard')
  .description('Open memory dashboard in browser')
  .option('-p, --port <port>', 'Server port', '37777')
  .option('--no-open', 'Do not auto-open browser')
  .action(async (options) => {
    const port = parseInt(options.port, 10);

    try {
      // Check if server is already running
      const running = await isServerRunning(port);
      if (running) {
        console.log(`\n🧠 Dashboard already running at http://localhost:${port}\n`);
        if (options.open) {
          openBrowser(`http://localhost:${port}`);
        }
        return;
      }

      // Start the server
      console.log('\n🧠 Starting Code Memory Dashboard...\n');
      startServer(port);

      // Open browser
      if (options.open) {
        setTimeout(() => {
          openBrowser(`http://localhost:${port}`);
        }, 500);
      }

      console.log(`\n📊 Dashboard: http://localhost:${port}`);
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
