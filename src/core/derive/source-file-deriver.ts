/**
 * Codify-lite: links tool_observation events to lightweight SourceFile
 * entities in the existing entity/edge graph, so retrieval can surface
 * memories tied to the files a session is actually touching instead of
 * relying on recency alone.
 */

import { EdgeRepo } from '../edge-repo.js';
import { EntityRepo } from '../entity-repo.js';
import { normalizeFilePath } from '../canonical-key.js';
import type { MemoryEvent, ToolObservationPayload } from '../types.js';

export interface SourceFileDeriverLike {
  deriveFromToolObservation(
    event: MemoryEvent,
    payload: ToolObservationPayload,
    context?: { projectHash?: string | null; projectPath?: string | null }
  ): Promise<void>;
}

export interface SourceFileDeriverDeps {
  entities: EntityRepo;
  edges: EdgeRepo;
}

export function createSourceFileDeriver(deps: SourceFileDeriverDeps): SourceFileDeriverLike {
  return {
    async deriveFromToolObservation(event, payload, context) {
      const rawPath = extractFilePath(payload);
      if (!rawPath) return;

      const relativePath = toProjectRelativePath(rawPath, context?.projectPath ?? undefined);
      const project = context?.projectHash ?? 'default';

      const { entity } = await deps.entities.findOrCreate({
        entityType: 'source_file',
        title: relativePath,
        project,
        currentJson: { path: relativePath }
      });

      await deps.edges.upsert({
        srcType: 'event',
        srcId: event.id,
        relType: 'touched_in',
        dstType: 'entity',
        dstId: entity.entityId,
        metaJson: {
          sessionId: event.sessionId,
          toolName: payload.toolName,
          action: isWriteTool(payload.toolName) ? 'write' : 'read',
          // Above GraphPathService's DEFAULT_WEIGHT (0.5) so a same-file link
          // outranks a generic 1-hop traversal when competing for topK slots.
          weight: 0.8
        }
      });
    }
  };
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

function extractFilePath(payload: ToolObservationPayload): string | undefined {
  const fromMetadata = payload.metadata?.filePath;
  if (typeof fromMetadata === 'string' && fromMetadata.trim().length > 0) {
    return fromMetadata;
  }
  const fromInput = payload.toolInput?.file_path;
  return typeof fromInput === 'string' && fromInput.trim().length > 0 ? fromInput : undefined;
}

function toProjectRelativePath(filePath: string, projectPath?: string): string {
  const normalized = normalizeFilePath(filePath);
  if (!projectPath) return normalized;
  const normalizedProject = normalizeFilePath(projectPath).replace(/\/$/, '');
  return normalized.startsWith(`${normalizedProject}/`)
    ? normalized.slice(normalizedProject.length + 1)
    : normalized;
}
