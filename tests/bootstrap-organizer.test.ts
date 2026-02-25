import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { bootstrapKnowledgeBase } from '../src/services/bootstrap-organizer.js';

async function makeTempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-bootstrap-'));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name test-bot', { cwd: root, stdio: 'ignore' });

  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });

  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const hello = () => "world";\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'worker.ts'), 'export const runWorker = () => true;\n', 'utf8');
  await fs.writeFile(path.join(root, 'tests', 'index.test.ts'), 'describe("x", () => {});\n', 'utf8');

  execSync('git add .', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "feat: initial project scaffolding"', { cwd: root, stdio: 'ignore' });

  await fs.writeFile(path.join(root, 'src', 'worker.ts'), 'export const runWorker = () => "ok";\n', 'utf8');
  execSync('git add src/worker.ts', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "refactor: stabilize worker return type"', { cwd: root, stdio: 'ignore' });

  return root;
}

describe('bootstrapKnowledgeBase', () => {
  it('generates structured bootstrap outputs with metadata', async () => {
    const repo = await makeTempRepo();
    const outDir = path.join(repo, '.generated-kb');

    const result = await bootstrapKnowledgeBase({
      repoPath: repo,
      outDir,
      since: '365 days ago',
      maxCommits: 50
    });

    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.commitCount).toBeGreaterThan(0);

    const expected = [
      path.join(outDir, 'overview.md'),
      path.join(outDir, 'decisions.md'),
      path.join(outDir, 'timeline.md'),
      path.join(outDir, 'glossary.md'),
      path.join(outDir, 'sources', 'manifest.json')
    ];

    for (const file of expected) {
      const stat = await fs.stat(file);
      expect(stat.isFile()).toBe(true);
    }

    const overview = await fs.readFile(path.join(outDir, 'overview.md'), 'utf8');
    expect(overview).toContain('deterministicPipeline: true');
    expect(overview).toContain('- confidence:');
    expect(overview).toContain('- source:');

    const decisions = await fs.readFile(path.join(outDir, 'decisions.md'), 'utf8');
    expect(decisions).toContain('commit:');

    const manifestJson = JSON.parse(await fs.readFile(path.join(outDir, 'sources', 'manifest.json'), 'utf8')) as {
      deterministicPipeline: boolean;
      outputs: string[];
    };
    expect(manifestJson.deterministicPipeline).toBe(true);
    expect(manifestJson.outputs.length).toBeGreaterThan(0);
  });
});
