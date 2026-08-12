import { createMcpHandlerDomain } from '../domain-handler.js';

export const perspectiveSharedDomain = createMcpHandlerDomain('perspective-shared', [
  'mem-shared-actor-link',
  'mem-shared-actor-status',
  'mem-shared-actor-unlink',
  'mem-shared-search',
  'mem-shared-asset-get',
  'mem-perspective-query',
  'mem-perspective-context',
  'mem-perspective-observation-create',
  'mem-perspective-observation-delete'
]);
