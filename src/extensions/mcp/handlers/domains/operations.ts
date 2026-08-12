import { createMcpHandlerDomain } from '../domain-handler.js';

export const operationsDomain = createMcpHandlerDomain('operations', [
  'mem-facet-query',
  'mem-facet-tag',
  'mem-action-list',
  'mem-action-update',
  'mem-frontier',
  'mem-checkpoint-create',
  'mem-checkpoint-list',
  'mem-retention-audit'
]);
