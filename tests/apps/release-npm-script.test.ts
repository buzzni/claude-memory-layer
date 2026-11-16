import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const { VERSION_MANIFESTS } = createRequire(import.meta.url)('../../scripts/sync-manifest-versions.cjs') as {
  VERSION_MANIFESTS: string[];
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
      expect(releaseCommitAdd).toContain(manifest);
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

  it('skips an existing GitHub Release so a re-run does not fail', () => {
    const workflow = readFileSync('.github/workflows/publish-npm.yml', 'utf8');
    const releaseJob = workflow.split(/\n {2}github-release:\n/)[1] ?? '';
    const viewIndex = releaseJob.indexOf('gh release view "$TAG"');
    const createIndex = releaseJob.indexOf('gh release create "$TAG"');

    expect(viewIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(viewIndex);
    expect(releaseJob.slice(viewIndex, createIndex)).toContain('exit 0');
    expect(releaseJob).toContain('--generate-notes');
    expect(releaseJob).toContain('--verify-tag');
  });
});
