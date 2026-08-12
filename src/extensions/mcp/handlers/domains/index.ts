import type { McpHandlerDomain } from '../domain-handler.js';
import { contextSearchDomain } from './context-search.js';
import { governanceAssetsDomain } from './governance-assets.js';
import { graphLessonsDomain } from './graph-lessons.js';
import { operationsDomain } from './operations.js';
import { perspectiveSharedDomain } from './perspective-shared.js';
import { sourceImportDomain } from './source-import.js';

export const mcpHandlerDomains: readonly McpHandlerDomain[] = [
  contextSearchDomain,
  sourceImportDomain,
  operationsDomain,
  graphLessonsDomain,
  governanceAssetsDomain,
  perspectiveSharedDomain
];
