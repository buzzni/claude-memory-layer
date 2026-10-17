import { describe, expect, it } from 'vitest';

import {
  lessonCommandAnchors,
  observeLessonFollowThrough as observeParsed,
  parseToolObservation
} from '../../src/core/lesson-follow-through.js';

const observeLessonFollowThrough = (target: Parameters<typeof observeParsed>[0], contents: string[]) =>
  observeParsed(target, contents.map(parseToolObservation));

const lesson = {
  lessonId: '11111111-1111-4111-8111-111111111111',
  name: 'sqlite-backup-before-probe',
  steps: [
    '원본은 `sqlite3 events.sqlite ".backup \'<대상>\'"` 로 복사한다(cp 는 WAL 을 놓친다).',
    '프로브 전에 `npm run build` 로 dist/ 를 갱신한다.',
    '`retrieval_traces` 와 `memory_helpfulness.event_id` 를 조인한다.',
    '`store.getDatabase().prepare(\'SELECT 1\')` 로 직접 조회한다.'
  ],
  validation: ['`npx vitest run tests/core/lesson-follow-through.test.ts` 가 통과한다']
};

function bash(command: string): string {
  return JSON.stringify({ toolName: 'Bash', toolInput: { command }, toolOutput: 'ok' });
}

function lessonGet(input: Record<string, unknown>, found: boolean): string {
  const output = JSON.stringify([{ type: 'text', text: JSON.stringify({ operation: 'mem-lesson-get', found }) }]);
  return JSON.stringify({ toolName: 'mcp__claude-memory-layer__mem-lesson-get', toolInput: input, toolOutput: output });
}

describe('lessonCommandAnchors', () => {
  it('keeps distinctive shell commands from steps and validation, cut before placeholders', () => {
    expect(lessonCommandAnchors(lesson)).toEqual([
      'sqlite3 events.sqlite ".backup \'',
      'npx vitest run tests/core/lesson-follow-through.test.ts'
    ]);
  });

  it('drops generic project gates that every session runs anyway', () => {
    expect(lessonCommandAnchors({ steps: ['`npm run build`', '`npm test`', '`git status`'], validation: [] })).toEqual([]);
  });

  it('drops identifiers and code expressions that are not commands', () => {
    expect(lessonCommandAnchors({ steps: ['`retrieval_traces`', '`foo.bar(\'x y\')`', '`a`'], validation: [] })).toEqual([]);
    expect(lessonCommandAnchors({ steps: ['`import { x } from \'./a.js\'`', '`limit === undefined`'], validation: [] })).toEqual([]);
  });

  // Measured on the Desktop store: these matched in nearly every session,
  // because sessions run them whether or not a lesson is involved.
  it('drops commands without a specific file or path argument', () => {
    expect(lessonCommandAnchors({
      steps: ['`git status --short`', '`gh pr create`', '`git show origin/main:<path>`',
        '`git rev-list --left-right --count origin/main...HEAD`', '`git checkout A || git checkout -B A`',
        '`git status --short 2>/dev/null`', '`npm test > /tmp/out.log`'],
      validation: []
    })).toEqual([]);
  });

  it('keeps a command whose argument names a specific script or directory', () => {
    expect(lessonCommandAnchors({
      steps: ['`node scripts/check-max-lines.mjs --base-ref=origin/main`', '`git diff origin/main -- config/`'],
      validation: []
    })).toEqual(['node scripts/check-max-lines.mjs --base-ref=origin/main', 'git diff origin/main -- config/']);
  });
});

describe('observeLessonFollowThrough', () => {
  it('counts a found mem-lesson-get by name as a body read', () => {
    const result = observeLessonFollowThrough(lesson, [lessonGet({ name: lesson.name }, true)]);
    expect(result.bodyRead).toBe(true);
  });

  it('counts a found mem-lesson-get by lessonId as a body read', () => {
    expect(observeLessonFollowThrough(lesson, [lessonGet({ lessonId: lesson.lessonId }, true)]).bodyRead).toBe(true);
  });

  it('does not count a lookup that missed, or a lookup of another lesson', () => {
    expect(observeLessonFollowThrough(lesson, [lessonGet({ name: lesson.name }, false)]).bodyRead).toBe(false);
    expect(observeLessonFollowThrough(lesson, [lessonGet({ name: 'other-lesson' }, true)]).bodyRead).toBe(false);
  });

  it('does not treat a mention of the tool in some other command as a lookup', () => {
    expect(observeLessonFollowThrough(lesson, [bash(`echo mem-lesson-get ${lesson.name}`)]).bodyRead).toBe(false);
  });

  it('reports how many distinct command anchors a later command ran', () => {
    const result = observeLessonFollowThrough(lesson, [
      bash('cd /tmp && sqlite3   events.sqlite ".backup \'/tmp/copy.sqlite\'"'),
      bash('sqlite3 events.sqlite ".backup \'/tmp/again.sqlite\'"'),
      bash('npm run build')
    ]);
    expect(result).toEqual({ bodyRead: false, commandAnchors: 2, matchedAnchors: 1 });
  });

  it('ignores unparseable observations instead of throwing', () => {
    expect(observeLessonFollowThrough(lesson, ['{not json', ''])).toEqual({
      bodyRead: false, commandAnchors: 2, matchedAnchors: 0
    });
  });
});
