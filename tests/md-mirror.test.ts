import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { buildMirrorPath, MarkdownMirror } from '../src/core/md-mirror.js';
import type { MemoryEventInput } from '../src/core/types.js';

function makeEvent(): MemoryEventInput {
  return {
    eventType: 'user_prompt',
    sessionId: 'agent:main:test',
    timestamp: new Date('2026-02-24T01:00:00.000Z'),
    content: '아침 브리핑 포맷 기억해줘',
    metadata: {
      namespace: 'Briefing',
      categoryPath: ['Preferences', 'Morning']
    }
  };
}

describe('MarkdownMirror', () => {
  it('builds sanitized categorized path', () => {
    const p = buildMirrorPath('/tmp/demo', makeEvent());
    expect(p).toContain(path.join('memory', 'briefing', 'preferences', 'morning', '2026-02-24.md'));
  });

  it('appends without overwrite', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-md-mirror-'));
    const mirror = new MarkdownMirror(tmp);
    const ev = makeEvent();

    await mirror.append(ev, 'e1');
    await mirror.append({ ...ev, content: '두번째 기록' }, 'e2');

    const out = buildMirrorPath(tmp, ev);
    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain('e1');
    expect(text).toContain('e2');
    expect(text).toContain('두번째 기록');
  });
});
