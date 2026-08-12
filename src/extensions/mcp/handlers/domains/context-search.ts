import { createMcpHandlerDomain } from '../domain-handler.js';

export const contextSearchDomain = createMcpHandlerDomain('context-search', [
  'external-market-context',
  'mem-search',
  'mem-timeline',
  'mem-details',
  'mem-stats',
  'mem-context-pack'
]);
