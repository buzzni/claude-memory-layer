import { createMcpHandlerDomain } from '../domain-handler.js';

export const sourceImportDomain = createMcpHandlerDomain('source-import', [
  'mem-import-latest',
  'mem-project-timeline',
  'mem-source-ref'
]);
