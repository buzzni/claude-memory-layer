#!/usr/bin/env node
/**
 * Code Memory CLI
 * Command-line interface for memory operations
 */

import { Command } from 'commander';
import { getDefaultMemoryService } from '../services/memory-service.js';

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
  .action(async (query: string, options) => {
    const service = getDefaultMemoryService();

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
  .action(async (options) => {
    const service = getDefaultMemoryService();

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
  .action(async () => {
    const service = getDefaultMemoryService();

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
  .action(async (eventId: string | undefined, options) => {
    const service = getDefaultMemoryService();

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
  .action(async () => {
    const service = getDefaultMemoryService();

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

program.parse();
