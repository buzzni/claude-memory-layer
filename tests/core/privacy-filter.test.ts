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

describe('unary/increment expressions are not mistaken for credentials', () => {
  // Found on live data: `var token = ++fitRetryToken` — a JS retry counter,
  // not a secret. A credential literal never starts with an operator.
  it.each([
    ['increment', 'var token = ++fitRetryToken'],
    ['decrement', 'let secret = --remainingAttempts'],
    ['negation', 'const password = !isValid']
  ])('leaves %s untouched', (_label, source) => {
    expect(applyPrivacyFilter(source, privacy).content).toBe(source);
  });
});

describe('process.env references are not mistaken for credentials', () => {
  // Found on live data: `const TOKEN = process.env.TOKEN || randomBytes(32)…`
  // reads the variable, it does not contain the secret.
  it('leaves an env-var reference untouched', () => {
    const source = "const TOKEN = process.env.TOKEN || randomBytes(32).toString('hex')";
    expect(applyPrivacyFilter(source, privacy).content).toBe(source);
  });

  it('still redacts a literal value assigned from a non-env source', () => {
    const source = 'const apiKey = "sk_live_abcdef123456"';
    expect(applyPrivacyFilter(source, privacy).content).toContain('[REDACTED]');
  });
});

describe('marker cleanup', () => {
  const source = '  // password=fixturePwForTest\n  return 42;\n    <private>internal-host</private>\n  done();\n';

  it('merges each marker with the whitespace after it by default, as stored tool output has it', () => {
    expect(applyPrivacyFilter(source, privacy).content)
      .toBe('  // [REDACTED] return 42;\n    [PRIVATE]\ndone();\n');
  });

  it('keeps the lines and indentation around each marker with collapseMarkers: false', () => {
    expect(applyPrivacyFilter(source, privacy, { collapseMarkers: false }).content)
      .toBe('  // [REDACTED]\n  return 42;\n    [PRIVATE]\n  done();\n');
  });
});

describe('unclosed private tags', () => {
  // #269: an opening tag without its end used to be flagged in metadata and
  // nothing else, so everything after it was stored as written.
  it('masks everything from an unclosed <private> tag to the end of the text', () => {
    const result = applyPrivacyFilter('public intro <private>codename-orchid and the rest of the note', privacy);

    expect(result.content).toBe('public intro [PRIVATE: unclosed]');
    expect(result.metadata.hasUnmatchedTags).toBe(true);
    expect(result.metadata.hasPrivateTags).toBe(true);
  });

  it('masks a closed section as before and an unclosed one after it to the end', () => {
    const result = applyPrivacyFilter('a <private>first-orchid</private> b <private>second-orchid tail', privacy);

    expect(result.content).toBe('a [PRIVATE]\nb [PRIVATE: unclosed]');
    expect(result.metadata.privateTagCount).toBe(2);
  });

  it('leaves closed sections and the text after them as they were', () => {
    const result = applyPrivacyFilter('a <private>orchid</private> b', privacy);

    expect(result.content).toBe('a [PRIVATE]\nb');
    expect(result.metadata.hasUnmatchedTags).toBe(false);
  });

  it('keeps the lines before an unclosed tag with collapseMarkers: false', () => {
    expect(applyPrivacyFilter('line 1\n  <private>orchid\nline 3', privacy, { collapseMarkers: false }).content)
      .toBe('line 1\n  [PRIVATE: unclosed]');
  });

  it('does not treat <private> in inline code or a code block as a tag', () => {
    const inline = 'wrap it in `<private>` and the rest is kept';
    const block = 'before\n```\n<private>\n```\nafter';

    expect(applyPrivacyFilter(inline, privacy).content).toBe(inline);
    expect(applyPrivacyFilter(block, privacy).content).toBe(block);
  });

  it('masks an unclosed bracket or comment tag when those formats are enabled', () => {
    const allFormats: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, marker: '[REDACTED]', supportedFormats: ['xml', 'bracket', 'comment'] }
    };

    expect(applyPrivacyFilter('a [private]orchid', allFormats).content).toBe('a [REDACTED: unclosed]');
    expect(applyPrivacyFilter('a <!-- private -->orchid', allFormats).content).toBe('a [REDACTED: unclosed]');
  });

  it('does not read a [PRIVATE] marker as an unclosed bracket tag', () => {
    const xmlAndBracket: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, supportedFormats: ['xml', 'bracket'] }
    };

    expect(applyPrivacyFilter('a <private>orchid</private> b', xmlAndBracket).content).toBe('a [PRIVATE]\nb');
  });
});
