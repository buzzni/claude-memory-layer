import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  CoreMemoryBlockSchema,
  GetCoreMemoryBlockInputSchema,
  UpsertCoreMemoryBlockInputSchema,
  type CoreMemoryBlock,
  type CoreMemoryBlockKey
} from '../types.js';
import {
  sanitizeGovernanceAuditValue,
  writeGovernanceAuditEntry
} from './governance-audit.js';

interface CoreMemoryBlockRow {
  project_hash: string;
  block_key: string;
  content: string;
  source_event_ids_json: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function projectHashToStorage(projectHash: string | undefined): string {
  return projectHash ?? '';
}

function projectHashFromStorage(projectHash: string): string | undefined {
  return projectHash.length > 0 ? projectHash : undefined;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function rowToCoreMemoryBlock(row: CoreMemoryBlockRow): CoreMemoryBlock {
  return CoreMemoryBlockSchema.parse({
    projectHash: projectHashFromStorage(row.project_hash),
    blockKey: row.block_key,
    content: row.content,
    sourceEventIds: parseStringArray(row.source_event_ids_json),
    updatedBy: row.updated_by ?? undefined,
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  });
}

function sanitizedBlockSnapshot(block: CoreMemoryBlock): Record<string, unknown> {
  return sanitizeGovernanceAuditValue({
    projectHash: block.projectHash,
    blockKey: block.blockKey,
    content: block.content,
    sourceEventIds: block.sourceEventIds,
    updatedBy: block.updatedBy,
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString()
  }) as Record<string, unknown>;
}

export class CoreMemoryBlockRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async upsert(input: unknown): Promise<CoreMemoryBlock> {
    const parsed = UpsertCoreMemoryBlockInputSchema.parse(input);
    const projectHash = projectHashToStorage(parsed.projectHash);
    const before = this.getByKey(projectHash, parsed.blockKey);
    const now = new Date().toISOString();
    const createdAt = before?.createdAt.toISOString() ?? now;

    if (before) {
      sqliteRun(
        this.db,
        `UPDATE core_memory_blocks
         SET content = ?, source_event_ids_json = ?, updated_by = ?, updated_at = ?
         WHERE project_hash = ? AND block_key = ?`,
        [
          parsed.content,
          JSON.stringify(parsed.sourceEventIds),
          parsed.updatedBy ?? null,
          now,
          projectHash,
          parsed.blockKey
        ]
      );
    } else {
      sqliteRun(
        this.db,
        `INSERT INTO core_memory_blocks (
          project_hash, block_key, content, source_event_ids_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          projectHash,
          parsed.blockKey,
          parsed.content,
          JSON.stringify(parsed.sourceEventIds),
          parsed.updatedBy ?? null,
          createdAt,
          now
        ]
      );
    }

    const saved = this.getByKey(projectHash, parsed.blockKey);
    if (!saved) throw new Error('core memory block was not saved');
    await this.writeAudit(parsed, before, saved);
    return saved;
  }

  async get(input: unknown): Promise<CoreMemoryBlock | null> {
    const parsed = GetCoreMemoryBlockInputSchema.parse(input);
    if (!parsed.blockKey) return null;
    return this.getByKey(projectHashToStorage(parsed.projectHash), parsed.blockKey);
  }

  /** All blocks for a project, for unconditional session-start injection. */
  async listByProject(projectHash: string | undefined): Promise<CoreMemoryBlock[]> {
    const rows = sqliteAll<CoreMemoryBlockRow>(
      this.db,
      `SELECT * FROM core_memory_blocks WHERE project_hash = ? ORDER BY block_key ASC`,
      [projectHashToStorage(projectHash)]
    );
    return rows.map(rowToCoreMemoryBlock);
  }

  private getByKey(projectHash: string, blockKey: CoreMemoryBlockKey): CoreMemoryBlock | null {
    const row = sqliteGet<CoreMemoryBlockRow>(
      this.db,
      `SELECT * FROM core_memory_blocks WHERE project_hash = ? AND block_key = ?`,
      [projectHash, blockKey]
    );
    return row ? rowToCoreMemoryBlock(row) : null;
  }

  private async writeAudit(
    parsed: { projectHash?: string; blockKey: CoreMemoryBlockKey; updatedBy?: string; sourceEventIds: string[] },
    before: CoreMemoryBlock | null,
    after: CoreMemoryBlock
  ): Promise<void> {
    await writeGovernanceAuditEntry(this.db, {
      operation: 'core_memory_block_update',
      actor: parsed.updatedBy ?? 'unknown',
      projectHash: parsed.projectHash,
      targetType: 'core_memory_block',
      targetId: `${projectHashToStorage(parsed.projectHash)}:${parsed.blockKey}`,
      beforeJson: before ? sanitizedBlockSnapshot(before) : undefined,
      afterJson: sanitizedBlockSnapshot(after),
      sourceEventIds: parsed.sourceEventIds
    });
  }
}
