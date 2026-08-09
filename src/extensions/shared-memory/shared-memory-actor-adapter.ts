import { z } from 'zod';

import {
  type SharedActorIdentity,
  type SharedStore
} from '../../core/shared-store.js';
import type { SharedTroubleshootingEntry } from '../../core/types.js';

const NonEmptyIdSchema = z.string().trim().min(1).max(240);

export interface SharedMemoryActorSearchResult {
  identity: SharedActorIdentity | null;
  sourceProjectHashes: string[];
  entries: SharedTroubleshootingEntry[];
}

/**
 * Deliberately narrow adapter for cross-project reads.  It makes an actor's
 * project memberships explicit before delegating to the shared store and is
 * kept separate from legacy retrieval so existing includeShared behavior does
 * not silently gain a new identity policy.
 */
export class SharedMemoryActorAdapter {
  constructor(private readonly store: SharedStore) {}

  async link(input: { projectHash: string; actorId: string; sharedPrincipalId: string }): Promise<SharedActorIdentity> {
    return this.store.linkActorIdentity({
      projectHash: NonEmptyIdSchema.parse(input.projectHash),
      actorId: NonEmptyIdSchema.parse(input.actorId),
      sharedPrincipalId: NonEmptyIdSchema.parse(input.sharedPrincipalId)
    });
  }

  async status(input: { projectHash: string; actorId: string }): Promise<SharedActorIdentity | null> {
    return this.store.getActorIdentity(
      NonEmptyIdSchema.parse(input.projectHash),
      NonEmptyIdSchema.parse(input.actorId)
    );
  }

  async scope(input: { projectHash: string; actorId: string }): Promise<{
    identity: SharedActorIdentity | null;
    linkedProjectCount: number;
  }> {
    const identity = await this.status(input);
    if (!identity) return { identity: null, linkedProjectCount: 0 };
    const projectHashes = await this.store.listProjectHashesForPrincipal(identity.sharedPrincipalId);
    return { identity, linkedProjectCount: projectHashes.length };
  }

  async unlink(input: { projectHash: string; actorId: string }): Promise<boolean> {
    return this.store.unlinkActorIdentity(
      NonEmptyIdSchema.parse(input.projectHash),
      NonEmptyIdSchema.parse(input.actorId)
    );
  }

  /**
   * The caller supplies the source actor deliberately. Matching a principal
   * by project alone would allow a different actor in the source project to
   * become an accidental deputy for a private grant.
   */
  async sharesPrincipalWith(input: {
    projectHash: string;
    actorId: string;
    sourceProjectHash: string;
    sourceActorId: string;
  }): Promise<boolean> {
    const identity = await this.status({ projectHash: input.projectHash, actorId: input.actorId });
    if (!identity) return false;
    const sourceIdentity = await this.status({
      projectHash: input.sourceProjectHash,
      actorId: input.sourceActorId
    });
    return sourceIdentity?.sharedPrincipalId === identity.sharedPrincipalId;
  }

  async search(input: {
    projectHash: string;
    actorId: string;
    query: string;
    topK?: number;
    minConfidence?: number;
  }): Promise<SharedMemoryActorSearchResult> {
    const identity = await this.status({ projectHash: input.projectHash, actorId: input.actorId });
    if (!identity) return { identity: null, sourceProjectHashes: [], entries: [] };
    const result = await this.store.searchForPrincipal(identity.sharedPrincipalId, NonEmptyIdSchema.parse(input.query), {
      topK: input.topK,
      minConfidence: input.minConfidence
    });
    return { identity, ...result };
  }
}
