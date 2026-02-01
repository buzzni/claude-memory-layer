/**
 * API Router
 * Central router for all API endpoints
 */

import { Hono } from 'hono';
import { sessionsRouter } from './sessions.js';
import { eventsRouter } from './events.js';
import { searchRouter } from './search.js';
import { statsRouter } from './stats.js';
import { citationsRouter } from './citations.js';

export const apiRouter = new Hono()
  .route('/sessions', sessionsRouter)
  .route('/events', eventsRouter)
  .route('/search', searchRouter)
  .route('/stats', statsRouter)
  .route('/citations', citationsRouter);
