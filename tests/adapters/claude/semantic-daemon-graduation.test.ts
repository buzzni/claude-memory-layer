import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AutoGraduationScheduler,
  isAutoGraduationEnabled
} from '../../../src/adapters/claude/hooks/semantic-daemon-graduation.js';

describe('AutoGraduationScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs after the response delay and deduplicates burst requests per project', async () => {
    let now = 1_000;
    const task = vi.fn(async () => undefined);
    const scheduler = new AutoGraduationScheduler({ enabled: true, cooldownMs: 300_000, delayMs: 50, now: () => now });

    expect(scheduler.schedule('project-a', task)).toBe('scheduled');
    expect(scheduler.schedule('project-a', task)).toBe('in_flight');
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(task).toHaveBeenCalledTimes(1);

    expect(scheduler.schedule('project-a', task)).toBe('cooldown');
    now += 300_000;
    expect(scheduler.schedule('project-a', task)).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(50);
    expect(task).toHaveBeenCalledTimes(2);
    await scheduler.shutdown();
  });

  it('keeps evaluation and disabled requests non-mutating', async () => {
    const task = vi.fn(async () => undefined);
    const enabled = new AutoGraduationScheduler({ enabled: true, cooldownMs: 1_000, delayMs: 0 });
    const disabled = new AutoGraduationScheduler({ enabled: false, cooldownMs: 1_000, delayMs: 0 });

    expect(enabled.schedule('project', task, { evaluation: true })).toBe('evaluation');
    expect(disabled.schedule('project', task)).toBe('disabled');
    await vi.runAllTimersAsync();
    expect(task).not.toHaveBeenCalled();
    await enabled.shutdown();
    await disabled.shutdown();
  });

  it('swallows worker failures and permits a retry after cooldown', async () => {
    let now = 0;
    const task = vi.fn(async () => { throw new Error('private failure'); });
    const scheduler = new AutoGraduationScheduler({ enabled: true, cooldownMs: 1_000, delayMs: 0, now: () => now });

    expect(scheduler.schedule('project', task)).toBe('scheduled');
    await vi.runAllTimersAsync();
    now = 1_000;
    expect(scheduler.schedule('project', task)).toBe('scheduled');
    await vi.runAllTimersAsync();
    expect(task).toHaveBeenCalledTimes(2);
    await scheduler.shutdown();
  });

  it('parses the opt-out environment flag conservatively', () => {
    expect(isAutoGraduationEnabled({})).toBe(true);
    expect(isAutoGraduationEnabled({ CLAUDE_MEMORY_AUTO_GRADUATION: 'false' })).toBe(false);
    expect(isAutoGraduationEnabled({ CLAUDE_MEMORY_AUTO_GRADUATION: '0' })).toBe(false);
    expect(isAutoGraduationEnabled({ CLAUDE_MEMORY_AUTO_GRADUATION: 'off' })).toBe(false);
    expect(isAutoGraduationEnabled({ CLAUDE_MEMORY_AUTO_GRADUATION: 'true' })).toBe(true);
  });
});
