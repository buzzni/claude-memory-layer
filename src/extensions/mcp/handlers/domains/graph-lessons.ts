import { createMcpHandlerDomain } from '../domain-handler.js';

export const graphLessonsDomain = createMcpHandlerDomain('graph-lessons', [
  'mem-graph-query',
  'mem-lesson-list',
  'mem-lesson-candidates',
  'mem-lesson-save',
  'mem-entity-supersede'
]);
