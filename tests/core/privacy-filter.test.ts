import { describe, expect, it } from 'vitest';
import { applyPrivacyFilter } from '../../src/core/privacy/index.js';
import type { Config } from '../../src/core/types.js';

const privacy: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

const fixture = {
  passwordSpace: 'fixturePwForTest',
  passwordEquals: 'fixturePwForEquals',
  barePassword: 'fixtureBarePassword2012',
  dbPassword: 'fixtureDbPassword',
  clientSecret: 'fixtureClientSecret',
  accessToken: 'fixtureAccessToken',
  apiKey: 'fixtureApiKey',
  cliDbPassword: 'fixtureCliDbPassword',
  cliClientSecret: 'fixtureCliClientSecret',
  cliDbPasswordSpace: 'fixtureCliDbPasswordSpace',
  cliAccessTokenSpace: 'fixtureCliAccessTokenSpace'
};

describe('privacy filter', () => {
  it('redacts dashboard --password CLI arguments before memory storage', () => {
    const result = applyPrivacyFilter(
      `Command: node dist/cli/index.js dashboard --port 37780 --bind localhost --password ${fixture.passwordSpace} --no-open`,
      privacy
    );

    expect(result.content).toContain('--password [REDACTED]');
    expect(result.content).not.toContain(fixture.passwordSpace);
    expect(result.metadata.patternMatchCount).toBeGreaterThan(0);
  });

  it('redacts dashboard --password=value CLI arguments before memory storage', () => {
    const result = applyPrivacyFilter(
      `claude-memory-layer dashboard --password=${fixture.passwordEquals} --no-open`,
      privacy
    );

    expect(result.content).toContain('--password=[REDACTED]');
    expect(result.content).not.toContain(fixture.passwordEquals);
    expect(result.metadata.patternMatchCount).toBeGreaterThan(0);
  });

  it('redacts pasted dashboard passwords on the line after a URL before memory storage', () => {
    const result = applyPrivacyFilter(
      `http://172.16.10.204:37777/\n${fixture.barePassword}\n여기 이제 접속이 되는데 확인해줘`,
      privacy
    );

    expect(result.content).toContain('http://172.16.10.204:37777/');
    expect(result.content).toContain('[REDACTED]');
    expect(result.content).not.toContain(fixture.barePassword);
    expect(result.metadata.patternMatchCount).toBeGreaterThan(0);
  });

  it('redacts hyphenated secret keys and CLI options without regressing common forms', () => {
    const result = applyPrivacyFilter(
      [
        `db-password=${fixture.dbPassword}`,
        `client-secret=${fixture.clientSecret}`,
        `access-token=${fixture.accessToken}`,
        `x-api-key: ${fixture.apiKey}`,
        `--db-password=${fixture.cliDbPassword}`,
        `--client-secret ${fixture.cliClientSecret}`,
        `--db-password ${fixture.cliDbPasswordSpace}`,
        `--access-token ${fixture.cliAccessTokenSpace}`
      ].join('\n'),
      privacy
    );

    expect(result.content).not.toContain(fixture.dbPassword);
    expect(result.content).not.toContain(fixture.clientSecret);
    expect(result.content).not.toContain(fixture.accessToken);
    expect(result.content).not.toContain(fixture.apiKey);
    expect(result.content).not.toContain(fixture.cliDbPassword);
    expect(result.content).not.toContain(fixture.cliClientSecret);
    expect(result.content).not.toContain(fixture.cliDbPasswordSpace);
    expect(result.content).not.toContain(fixture.cliAccessTokenSpace);
    expect(result.metadata.patternMatchCount).toBeGreaterThanOrEqual(8);
  });

  it('does not redact benign single-word status text after a URL', () => {
    const result = applyPrivacyFilter('https://example.test/\nsuccess\nconfirmed', privacy);

    expect(result.content).toContain('https://example.test/');
    expect(result.content).toContain('success');
    expect(result.content).toContain('confirmed');
    expect(result.content).not.toContain('[REDACTED]');
  });
});

describe('vendor-prefixed token redaction', () => {
  // The `token\s*[:=]` rule only fires when a token is introduced with a colon
  // or equals sign. A key pasted as prose — which is how a real Hugging Face
  // token reached the store — has neither.
  const prose = (value: string) => `hugging face token ${value} Invalid token. Please check`;

  it.each([
    ['hugging face', 'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['github oauth', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['github fine-grained pat', 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop'],
    ['anthropic', 'sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ01'],
    ['gitlab', 'glpat-ABCDEFGHIJKLMNOPQRSTUV'],
    ['slack', 'xoxb-ABCDEFGHIJKLMNOPQRSTUV'],
    ['aws access key id', 'AKIAABCDEFGHIJKLMNOP']
  ])('redacts a %s token pasted without a key/value separator', (_label, secret) => {
    const result = applyPrivacyFilter(prose(secret), privacy);
    expect(result.content).not.toContain(secret);
    expect(result.content).toContain('[REDACTED]');
  });

  it('leaves ordinary prose containing the word token untouched', () => {
    const benign = '이 API 의 token 만료 시간을 어떻게 늘리지?';
    expect(applyPrivacyFilter(benign, privacy).content).toBe(benign);
  });

  it('does not redact short identifiers that merely start with a vendor prefix', () => {
    const benign = 'hf_small 이라는 변수명을 쓰고 있어';
    expect(applyPrivacyFilter(benign, privacy).content).toBe(benign);
  });
});
