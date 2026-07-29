import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const spawnedChild = { unref: vi.fn() };
  return {
    existsSync: vi.fn(() => true),
    spawn: vi.fn(() => spawnedChild),
    spawnedChild,
    getProjectStoragePath: vi.fn((projectPath: string) => `/storage/${projectPath.replace(/\//g, '_')}`),
    needsToolObservationVectorAutoHeal: vi.fn(async () => true),
    storeClose: vi.fn(async () => {}),
    storeConstructed: [] as Array<{ dbPath: string; options: unknown }>
  };
});

vi.mock('fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../src/core/registry/project-path.js', () => ({
  getProjectStoragePath: mocks.getProjectStoragePath
}));
vi.mock('../../src/core/operations/tool-observation-vector-auto-heal.js', () => ({
  needsToolObservationVectorAutoHeal: mocks.needsToolObservationVectorAutoHeal
}));
vi.mock('../../src/core/sqlite-event-store.js', () => ({
  SQLiteEventStore: class {
    constructor(dbPath: string, options: unknown) {
      mocks.storeConstructed.push({ dbPath, options });
    }
    close = mocks.storeClose;
  }
}));

const { spawnToolObservationVectorAutoHealIfNeeded } = await import(
  '../../src/adapters/claude/hooks/tool-observation-vector-auto-heal-client.js'
);

describe('spawnToolObservationVectorAutoHealIfNeeded', () => {
  beforeEach(() => {
    mocks.existsSync.mockReset().mockReturnValue(true);
    mocks.spawn.mockClear();
    mocks.spawnedChild.unref.mockClear();
    mocks.getProjectStoragePath.mockClear();
    mocks.needsToolObservationVectorAutoHeal.mockReset().mockResolvedValue(true);
    mocks.storeClose.mockClear();
    mocks.storeConstructed.length = 0;
  });

  it('does nothing when the project has no store yet', async () => {
    mocks.existsSync.mockReturnValue(false);

    await spawnToolObservationVectorAutoHealIfNeeded('/repo/app');

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.storeConstructed).toEqual([]);
  });

  it('opens the store readonly for the check and closes it without spawning when already healed', async () => {
    mocks.needsToolObservationVectorAutoHeal.mockResolvedValue(false);

    await spawnToolObservationVectorAutoHealIfNeeded('/repo/app');

    expect(mocks.storeConstructed).toEqual([
      { dbPath: expect.stringContaining('events.sqlite'), options: { readonly: true } }
    ]);
    expect(mocks.storeClose).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('spawns the CLI detached with the project path when healing is needed', async () => {
    await spawnToolObservationVectorAutoHealIfNeeded('/repo/app');

    expect(mocks.storeClose).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining([
      'repair', 'auto-heal-tool-observation-vectors', '--project', '/repo/app'
    ]));
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(mocks.spawnedChild.unref).toHaveBeenCalledOnce();
  });

  it('never throws when the readonly check itself throws', async () => {
    mocks.needsToolObservationVectorAutoHeal.mockRejectedValue(new Error('db locked'));

    await expect(spawnToolObservationVectorAutoHealIfNeeded('/repo/app')).resolves.toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
