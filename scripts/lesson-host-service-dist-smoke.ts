import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const root = mkdtempSync(join(tmpdir(), 'cml-host-dist-'));
const projectPath = join(root, 'project');
const isolatedStorageRoot = join(root, 'storage');
mkdirSync(projectPath, { recursive: true });

try {
  const module = await import(pathToFileURL(resolve('dist/services/lesson-host-service.js')).href);
  const opened = await module.openLessonHostService({
    projectPath,
    isolatedStorageRoot,
    verifyBinding: (binding: unknown) => {
      if (binding !== 'fixture') throw new Error('untrusted fixture binding');
      return {
        projectHash: opened.projectHash,
        actorId: 'fixture-actor', userId: 'fixture-user', machineId: 'fixture-machine', sessionId: 'fixture-session',
        generation: 1, capabilities: ['lesson.read', 'lesson.review', 'lesson.manage']
      };
    }
  });
  const listed = await opened.service.listLessons({ version: 1, requestId: 'fixture-list', binding: 'fixture', limit: 100, offset: 0 });
  if (listed.outcome !== 'ok' || listed.lessons.length !== 0 || listed.nextOffset !== null) throw new Error('stable lesson host entry returned unexpected fixture snapshot');
  await opened.close();
  process.stdout.write('lesson host dist smoke passed\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
