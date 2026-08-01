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

describe('source code is not mistaken for credentials', () => {
  // Found on live data: `getAccessToken: () => storage.get(…)` was rewritten to
  // `getAccess[REDACTED] => storage.get(…)`, corrupting 22 stored discussions
  // of real source files. The keyword rules had no word boundary, so the
  // `Token:` inside a camelCase identifier looked like `token=value`.
  it.each([
    ['type annotation', 'export async function sync(accessToken: Promise<CloudSyncResult>)'],
    ['arrow function', 'authInterceptors(base, { getAccessToken: () => storage.get(K.ACCESS_TOKEN) })'],
    ['destructuring', 'const { mode, cloudAccessToken } = useAppModeStore((s) => ({ mode: s.mode, cloudAccessToken }))'],
    ['interface fields', 'interface Cfg { clientSecret: string; apiKey: string }'],
    ['optional fields', 'type T = { apiKey?: string; token?: number }'],
    ['quoted type name', 'apiKey: "string"'],
    ['prose', 'token 만료 시간을 어떻게 늘리지?']
  ])('leaves %s untouched', (_label, source) => {
    expect(applyPrivacyFilter(source, privacy).content).toBe(source);
  });

  // The discriminator is the value, not the key: a camelCase key with a long
  // quoted literal is still a credential.
  it.each([
    ['double-quoted jwt', 'accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"'],
    ['single-quoted secret', "clientSecret: 'abc123def456ghi'"],
    ['snake_case assignment', 'access_token=eyJhbGciOiJIUzI1NiJ9abc'],
    ['bare password', 'password: Zt9wQx2027@']
  ])('still redacts %s', (_label, source) => {
    expect(applyPrivacyFilter(source, privacy).content).toContain('[REDACTED]');
  });
});

describe('documentation prose is not mistaken for credentials', () => {
  // On a real store the loose bearer rule matched 29 documentation phrases
  // against a single actual token.
  it.each([
    ['scheme description', 'Auth: Bearer token (Header/Cookie)'],
    ['jwt description', 'All sync endpoints require Bearer JWT auth'],
    ['python assignment', 'if token = json.dumps(payload):'],
    ['js assignment', 'const token = getToken(user)']
  ])('leaves %s untouched', (_label, source) => {
    expect(applyPrivacyFilter(source, privacy).content).toBe(source);
  });

  it('still redacts a real bearer credential', () => {
    const header = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef';
    expect(applyPrivacyFilter(header, privacy).content).toContain('[REDACTED]');
  });

  // The config-driven excludePatterns loop mirrors the built-in keyword rules,
  // so it needs the same value guard or it silently reintroduces every false
  // positive the built-ins were taught to avoid.
  it('applies the same guard to config-driven patterns', () => {
    const custom: typeof privacy = { ...privacy, excludePatterns: ['token'] };
    expect(applyPrivacyFilter('if token = json.dumps(payload):', custom).content)
      .toBe('if token = json.dumps(payload):');
    expect(applyPrivacyFilter('token: Zt9wQx2027abc', custom).content)
      .toContain('[REDACTED]');
  });
});
