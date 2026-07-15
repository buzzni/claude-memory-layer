export type AutoGraduationScheduleResult =
  | 'scheduled'
  | 'disabled'
  | 'evaluation'
  | 'cooldown'
  | 'in_flight';

export interface AutoGraduationSchedulerConfig {
  enabled: boolean;
  cooldownMs: number;
  delayMs: number;
  now?: () => number;
}

interface ProjectGraduationState {
  lastScheduledAt: number | null;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
}

/**
 * Schedules bounded graduation outside the semantic retrieval response path.
 * State is project-scoped so a burst of prompt hooks cannot start overlapping
 * passes, while a failed pass becomes retryable after the normal cooldown.
 */
export class AutoGraduationScheduler {
  private readonly states = new Map<string, ProjectGraduationState>();
  private readonly now: () => number;

  constructor(private readonly config: AutoGraduationSchedulerConfig) {
    this.now = config.now ?? Date.now;
  }

  schedule(
    projectKey: string,
    task: () => Promise<unknown>,
    options: { evaluation?: boolean } = {}
  ): AutoGraduationScheduleResult {
    if (!this.config.enabled) return 'disabled';
    if (options.evaluation === true) return 'evaluation';

    const now = this.now();
    const state = this.states.get(projectKey) ?? {
      lastScheduledAt: null,
      timer: null,
      running: null
    };
    this.states.set(projectKey, state);

    if (state.timer || state.running) return 'in_flight';
    if (state.lastScheduledAt !== null && now - state.lastScheduledAt < this.config.cooldownMs) {
      return 'cooldown';
    }

    state.lastScheduledAt = now;
    state.timer = setTimeout(() => {
      state.timer = null;
      const running = Promise.resolve()
        .then(task)
        .then(() => undefined, () => undefined)
        .finally(() => {
          if (state.running === running) state.running = null;
        });
      state.running = running;
    }, this.config.delayMs);
    state.timer.unref?.();
    return 'scheduled';
  }

  async shutdown(): Promise<void> {
    const running: Promise<void>[] = [];
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (state.running) running.push(state.running);
    }
    await Promise.all(running);
    this.states.clear();
  }
}

export function isAutoGraduationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CLAUDE_MEMORY_AUTO_GRADUATION?.trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}
