#!/usr/bin/env node
/**
 * Code Memory CLI
 * Command-line interface for memory operations
 */

import { Command } from 'commander';
import {
  getDefaultMemoryService,
  getMemoryServiceForProject
} from '../services/memory-service.js';
import { createSessionHistoryImporter } from '../services/session-history-importer.js';

const program = new Command();

program
  .name('code-memory')
  .description('Claude Code Memory Plugin CLI')
  .version('1.0.0');

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
 * Import command - import existing Claude Code sessions
 */
program
  .command('import')
  .description('Import existing Claude Code conversation history')
  .option('-p, --project <path>', 'Import from specific project path')
  .option('-s, --session <file>', 'Import specific session file (JSONL)')
  .option('-a, --all', 'Import all sessions from all projects')
  .option('-l, --limit <number>', 'Limit messages per session')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options) => {
    // Determine target project path for storage
    const targetProjectPath = options.project || process.cwd();

    // Use project-specific memory service
    const service = getMemoryServiceForProject(targetProjectPath);
    const importer = createSessionHistoryImporter(service);

    try {
      await service.initialize();

      let result;

      if (options.session) {
        // Import specific session file
        console.log(`\n📥 Importing session: ${options.session}`);
        console.log(`   Target project: ${targetProjectPath}\n`);
        result = await importer.importSessionFile(options.session, {
          projectPath: targetProjectPath,
          limit: options.limit ? parseInt(options.limit) : undefined,
          verbose: options.verbose
        });
      } else if (options.project) {
        // Import all sessions from a project
        console.log(`\n📥 Importing project: ${options.project}\n`);
        result = await importer.importProject(options.project, {
          limit: options.limit ? parseInt(options.limit) : undefined,
          verbose: options.verbose
        });
      } else if (options.all) {
        // Import all sessions from all projects
        // Note: --all imports to global storage for backward compatibility
        console.log('\n📥 Importing all sessions from all projects');
        console.log('   ⚠️  Using global storage (use -p for project-specific)\n');
        const globalService = getDefaultMemoryService();
        const globalImporter = createSessionHistoryImporter(globalService);
        await globalService.initialize();
        result = await globalImporter.importAll({
          limit: options.limit ? parseInt(options.limit) : undefined,
          verbose: options.verbose
        });

        // Process embeddings
        console.log('\n⏳ Processing embeddings...');
        const embedCount = await globalService.processPendingEmbeddings();

        // Show results
        console.log('\n✅ Import Complete\n');
        console.log(`Sessions processed: ${result.totalSessions}`);
        console.log(`Total messages: ${result.totalMessages}`);
        console.log(`Imported prompts: ${result.importedPrompts}`);
        console.log(`Imported responses: ${result.importedResponses}`);
        console.log(`Skipped duplicates: ${result.skippedDuplicates}`);
        console.log(`Embeddings processed: ${embedCount}`);

        if (result.errors.length > 0) {
          console.log(`\n⚠️  Errors (${result.errors.length}):`);
          for (const error of result.errors.slice(0, 5)) {
            console.log(`  - ${error}`);
          }
          if (result.errors.length > 5) {
            console.log(`  ... and ${result.errors.length - 5} more`);
          }
        }

        await globalService.shutdown();
        return;
      } else {
        // Default: import current project
        const cwd = process.cwd();
        console.log(`\n📥 Importing sessions for current project: ${cwd}\n`);
        result = await importer.importProject(cwd, {
          projectPath: cwd,
          limit: options.limit ? parseInt(options.limit) : undefined,
          verbose: options.verbose
        });
      }

      // Process embeddings
      console.log('\n⏳ Processing embeddings...');
      const embedCount = await service.processPendingEmbeddings();

      // Show results
      console.log('\n✅ Import Complete\n');
      console.log(`Sessions processed: ${result.totalSessions}`);
      console.log(`Total messages: ${result.totalMessages}`);
      console.log(`Imported prompts: ${result.importedPrompts}`);
      console.log(`Imported responses: ${result.importedResponses}`);
      console.log(`Skipped duplicates: ${result.skippedDuplicates}`);
      console.log(`Embeddings processed: ${embedCount}`);

      if (result.errors.length > 0) {
        console.log(`\n⚠️  Errors (${result.errors.length}):`);
        for (const error of result.errors.slice(0, 5)) {
          console.log(`  - ${error}`);
        }
        if (result.errors.length > 5) {
          console.log(`  ... and ${result.errors.length - 5} more`);
        }
      }

      await service.shutdown();
    } catch (error) {
      console.error('Import failed:', error);
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

      console.log('\nUse "code-memory import --session <path>" to import a specific session');
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
      console.log('Use "code-memory endless status" to view current state');

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
        console.log('Use "code-memory endless enable" to activate.');
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
        console.log('Use "code-memory endless enable" first');
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
        console.log('Use "code-memory endless enable" first');
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

program.parse();
