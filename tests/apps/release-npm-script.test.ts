import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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
  });
});
