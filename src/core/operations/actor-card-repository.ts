import { randomUUID } from 'crypto';
import { z } from 'zod';

import {
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  ActorCardSchema,
  GetActorCardInputSchema,
  UpsertActorCardInputSchema,
  type ActorCard
} from '../types.js';
import {
  sanitizeGovernanceAuditValue,
  writeGovernanceAuditEntry
} from './governance-audit.js';

interface ActorCardRow {
  card_id: string;
  project_hash: string;
  observer_actor_id: string;
  observed_actor_id: string;
  entries_json: string;
  source_event_ids_json: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

type ParsedActorCardUpsert = z.output<typeof UpsertActorCardInputSchema>;

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

function rowToActorCard(row: ActorCardRow): ActorCard {
  return ActorCardSchema.parse({
    cardId: row.card_id,
    projectHash: projectHashFromStorage(row.project_hash),
    observerActorId: row.observer_actor_id,
    observedActorId: row.observed_actor_id,
    entries: parseStringArray(row.entries_json),
    sourceEventIds: parseStringArray(row.source_event_ids_json),
    updatedBy: row.updated_by ?? undefined,
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  });
}

function sanitizedCardSnapshot(card: ActorCard): Record<string, unknown> {
  return sanitizeGovernanceAuditValue({
    cardId: card.cardId,
    projectHash: card.projectHash,
    observerActorId: card.observerActorId,
    observedActorId: card.observedActorId,
    entries: card.entries,
    sourceEventIds: card.sourceEventIds,
    updatedBy: card.updatedBy,
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString()
  }) as Record<string, unknown>;
}

export class ActorCardRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async upsert(input: unknown): Promise<ActorCard> {
    const parsed = UpsertActorCardInputSchema.parse(input);
    const projectHash = projectHashToStorage(parsed.projectHash);
    const before = this.getByPerspective(projectHash, parsed.observerActorId, parsed.observedActorId);
    const now = new Date().toISOString();
    const cardId = before?.cardId ?? randomUUID();
    const createdAt = before?.createdAt.toISOString() ?? now;

    if (before) {
      sqliteRun(
        this.db,
        `UPDATE actor_cards
         SET entries_json = ?, source_event_ids_json = ?, updated_by = ?, updated_at = ?
         WHERE project_hash = ? AND observer_actor_id = ? AND observed_actor_id = ?`,
        [
          JSON.stringify(parsed.entries),
          JSON.stringify(parsed.sourceEventIds),
          parsed.updatedBy ?? null,
          now,
          projectHash,
          parsed.observerActorId,
          parsed.observedActorId
        ]
      );
    } else {
      sqliteRun(
        this.db,
        `INSERT INTO actor_cards (
          card_id, project_hash, observer_actor_id, observed_actor_id, entries_json,
          source_event_ids_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cardId,
          projectHash,
          parsed.observerActorId,
          parsed.observedActorId,
          JSON.stringify(parsed.entries),
          JSON.stringify(parsed.sourceEventIds),
          parsed.updatedBy ?? null,
          createdAt,
          now
        ]
      );
    }

    const saved = this.getByPerspective(projectHash, parsed.observerActorId, parsed.observedActorId);
    if (!saved) throw new Error('actor card was not saved');
    await this.writeAudit(parsed, before, saved);
    return saved;
  }

  async get(input: unknown): Promise<ActorCard | null> {
    const parsed = GetActorCardInputSchema.parse(input);
    return this.getByPerspective(
      projectHashToStorage(parsed.projectHash),
      parsed.observerActorId,
      parsed.observedActorId
    );
  }

  private getByPerspective(projectHash: string, observerActorId: string, observedActorId: string): ActorCard | null {
    const row = sqliteGet<ActorCardRow>(
      this.db,
      `SELECT * FROM actor_cards
       WHERE project_hash = ? AND observer_actor_id = ? AND observed_actor_id = ?`,
      [projectHash, observerActorId, observedActorId]
    );
    return row ? rowToActorCard(row) : null;
  }

  private async writeAudit(
    parsed: ParsedActorCardUpsert,
    before: ActorCard | null,
    after: ActorCard
  ): Promise<void> {
    await writeGovernanceAuditEntry(this.db, {
      operation: 'actor_card_upsert',
      actor: parsed.updatedBy ?? 'unknown',
      projectHash: parsed.projectHash,
      targetType: 'actor_card',
      targetId: after.cardId,
      beforeJson: before ? sanitizedCardSnapshot(before) : undefined,
      afterJson: sanitizedCardSnapshot(after),
      sourceEventIds: parsed.sourceEventIds
    });
  }
}
