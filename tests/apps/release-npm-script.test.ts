import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const { VERSION_MANIFESTS } = createRequire(import.meta.url)('../../scripts/sync-manifest-versions.cjs') as {
  VERSION_MANIFESTS: Array<{ path: string }>;
};

describe('release npm script safety gates', () => {
  it('smoke-tests the exact packed tarball before npm publish', () => {
    const script = readFileSync('scripts/release-npm.sh', 'utf8');
    const dryRunPackIndex = script.indexOf('npm pack --dry-run --json');
    const publicOutputPrivacyIndex = script.indexOf('npm run check:public-output-privacy -- --json');
    const realPackIndex = script.indexOf('npm pack --json >"$PACK_PUBLISH_JSON"');
    const tarballInstallIndex = script.indexOf('npm install "$PACK_TGZ"');
    const publishIndex = script.indexOf('npm publish "${PUBLISH_ARGS[@]}"');

    expect(dryRunPackIndex).toBeGreaterThan(-1);
    expect(publicOutputPrivacyIndex).toBeGreaterThan(dryRunPackIndex);
    expect(publicOutputPrivacyIndex).toBeLessThan(realPackIndex);
    expect(realPackIndex).toBeGreaterThan(dryRunPackIndex);
    expect(tarballInstallIndex).toBeGreaterThan(realPackIndex);
    expect(tarballInstallIndex).toBeLessThan(publishIndex);
    expect(script).toContain('PACK_TGZ=');
    expect(script).toContain('npm audit --omit=dev --prefix "$MANAGED_BACKEND_DIR"');
    expect(script).toContain('npm ls --prefix "$MANAGED_BACKEND_DIR" @huggingface/transformers sharp');
    expect(script).toContain('retry_npm_view "${PACKAGE_NAME}@${NEW_VERSION}" version');
  });

  it('checks manifest versions after the bump and commits the synced manifest', () => {
    const script = readFileSync('scripts/release-npm.sh', 'utf8');
    const bumpIndex = script.indexOf('npm version "$BUMP" --no-git-tag-version');
    const guardIndex = script.indexOf('node scripts/guard-release-artifact.cjs manifest-versions');
    const publishIndex = script.indexOf('npm publish "${PUBLISH_ARGS[@]}"');

    expect(guardIndex).toBeGreaterThan(bumpIndex);
    expect(guardIndex).toBeLessThan(publishIndex);
    const releaseCommitAdd = script.split('\n').find((line) => line.trim().startsWith('git add package.json'));
    expect(releaseCommitAdd).toBeDefined();
    for (const manifest of VERSION_MANIFESTS) {
      expect(releaseCommitAdd).toContain(manifest.path);
    }
  });

  it('runs the manifest version guard in the tag-triggered publish workflow', () => {
    const workflow = readFileSync('.github/workflows/publish-npm.yml', 'utf8');
    const guardIndex = workflow.indexOf('node scripts/guard-release-artifact.cjs manifest-versions');
    const publishIndex = workflow.indexOf('npm publish "${{ steps.pack.outputs.tarball }}"');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(publishIndex);
  });

  it('creates the GitHub Release in its own job, after publish, with the only write permission', () => {
    const workflow = readFileSync('.github/workflows/publish-npm.yml', 'utf8');
    const [publishJob, releaseJob] = workflow.split(/\n {2}github-release:\n/);

    expect(releaseJob).toBeDefined();
    expect(releaseJob).toMatch(/\n {4}needs: publish\n/);
    expect(releaseJob).toMatch(/\n {6}contents: write\b/);
    expect(publishJob).toMatch(/\n {6}contents: read\b/);
    expect(publishJob).not.toContain('contents: write');
    expect(publishJob).not.toContain('gh release');
  });

  it('runs the Release job when publish failed only for a deliberate workflow_dispatch re-run', () => {
    const workflow = readFileSync('.github/workflows/publish-npm.yml', 'utf8');
    const releaseJob = workflow.split(/\n {2}github-release:\n/)[1] ?? '';
    const condition = releaseJob.match(/\n {4}if: \$\{\{ (.+) \}\}\n/)?.[1];

    expect(condition).toBe("!cancelled() && (needs.publish.result == 'success' || github.event_name == 'workflow_dispatch')");
  });

  it('keeps the publish job failing on a version that is already on npm', () => {
    const workflow = readFileSync('.github/workflows/publish-npm.yml', 'utf8');
    const publishJob = workflow.split(/\n {2}github-release:\n/)[0];
    const guard = publishJob.slice(publishJob.indexOf('- name: Verify version is not already published'));

    expect(guard).toMatch(/already exists on npm; versions are immutable"\n\s+exit 1\n/);
  });
});

/**
 * The Release step is shell inside YAML, so it is pulled out and run for real
 * against a throwaway tagged repository, with `gh` and `npm` replaced by stubs
 * that record their calls.
 */
describe('GitHub Release step', () => {
  function releaseStepScript(): string {
    const workflow = readFileSync('.github/workflows/publish-npm.yml', 'utf8');
    const releaseJob = workflow.split(/\n {2}github-release:\n/)[1] ?? '';
    const lines = releaseJob.slice(releaseJob.indexOf('- name: Create GitHub Release')).split('\n');
    const start = lines.findIndex((line) => line.trim() === 'run: |') + 1;
    const body: string[] = [];
    for (const line of lines.slice(start)) {
      if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
      body.push(line.slice(10));
    }
    return body.join('\n');
  }

  type Scenario = { tag: string; packageVersion: string; releaseExists?: boolean; npm: 'published' | 'missing' | 'down' };

  function runReleaseStep({ tag, packageVersion, releaseExists = false, npm }: Scenario) {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-release-step-'));
    const bin = path.join(root, 'bin');
    const repo = path.join(root, 'repo');
    const calls = path.join(root, 'calls.log');
    mkdirSync(bin);
    mkdirSync(repo);
    writeStub(path.join(bin, 'gh'), [
      `echo "gh $*" >> ${JSON.stringify(calls)}`,
      'if [ "$1 $2" = "release view" ]; then [ -n "$RELEASE_EXISTS" ]; exit $?; fi'
    ]);
    writeStub(path.join(bin, 'npm'), [
      `echo "npm $*" >> ${JSON.stringify(calls)}`,
      'case "$NPM_STATE" in',
      '  published) echo "${2#*@}" | sed "s/ .*//" ;;',
      '  missing) echo "npm error code E404" >&2; exit 1 ;;',
      '  *) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;',
      'esac'
    ]);

    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      TAG: tag,
      NPM_STATE: npm,
      RELEASE_EXISTS: releaseExists ? '1' : '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'cml-test',
      GIT_AUTHOR_EMAIL: 'cml-test@example.invalid',
      GIT_COMMITTER_NAME: 'cml-test',
      GIT_COMMITTER_EMAIL: 'cml-test@example.invalid'
    };
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    git('init', '-q');
    for (const version of ['2.5.7', '2.5.8']) {
      git('commit', '-q', '--allow-empty', '-m', `chore(release): v${version}`);
      git('tag', '-a', `v${version}`, '-m', `v${version}`);
    }
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'cml-fixture', version: packageVersion }));

    const result = spawnSync('bash', ['-e', '-c', releaseStepScript()], { cwd: repo, env, encoding: 'utf8' });
    const log = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    return { ...result, created: log.split('\n').find((line) => line.startsWith('gh release create')) };
  }

  function writeStub(filePath: string, body: string[]): void {
    writeFileSync(filePath, ['#!/bin/bash', ...body, ''].join('\n'));
    chmodSync(filePath, 0o755);
  }

  it('creates the Release with notes starting at the previous v* tag', () => {
    const result = runReleaseStep({ tag: 'v2.5.8', packageVersion: '2.5.8', npm: 'published' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.created).toBe('gh release create v2.5.8 --verify-tag --title v2.5.8 --generate-notes --notes-start-tag v2.5.7');
  });

  it('skips a tag that already has a Release, so a re-run does not fail', () => {
    const result = runReleaseStep({ tag: 'v2.5.8', packageVersion: '2.5.8', releaseExists: true, npm: 'published' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.created).toBeUndefined();
  });

  it('does not create a Release for a version npm does not have', () => {
    const result = runReleaseStep({ tag: 'v2.5.8', packageVersion: '2.5.8', npm: 'missing' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.created).toBeUndefined();
  });

  it('fails instead of skipping when the registry cannot be reached', () => {
    const result = runReleaseStep({ tag: 'v2.5.8', packageVersion: '2.5.8', npm: 'down' });

    expect(result.status).not.toBe(0);
    expect(result.created).toBeUndefined();
  });

  it('refuses a tag that does not match package.json', () => {
    const result = runReleaseStep({ tag: 'v2.5.9', packageVersion: '2.5.8', npm: 'published' });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('tag/version mismatch');
    expect(result.created).toBeUndefined();
  });
});
