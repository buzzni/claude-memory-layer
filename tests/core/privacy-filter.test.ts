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

  it('masks an unclosed comment tag when that format is enabled', () => {
    const allFormats: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, marker: '[REDACTED]', supportedFormats: ['xml', 'bracket', 'comment'] }
    };

    const result = applyPrivacyFilter('a <!-- private -->orchid', allFormats);

    expect(result.content).toBe('a [REDACTED: unclosed]');
    expect(result.metadata.hasUnmatchedTags).toBe(true);
  });

  it('flags a masked unclosed tag even when a stray closing tag evens out the tag count', () => {
    const result = applyPrivacyFilter('a </private> b <private>orchid', privacy);

    expect(result.content).toBe('a </private> b [PRIVATE: unclosed]');
    expect(result.metadata.hasUnmatchedTags).toBe(true);
  });

  it('keeps the text around a closing tag with no opening tag, flagged as unmatched', () => {
    // Nothing says where a section would have started, so nothing is masked.
    const result = applyPrivacyFilter('kept before </private> kept after', privacy);

    expect(result.content).toBe('kept before </private> kept after');
    expect(result.metadata.hasUnmatchedTags).toBe(true);
    expect(result.metadata.hasPrivateTags).toBe(false);
  });

  it('masks several closed sections and keeps the text between them', () => {
    const result = applyPrivacyFilter('a <private>1</private> b <private>2</private> c', privacy);

    expect(result.content).toBe('a [PRIVATE]\nb [PRIVATE]\nc');
    expect(result.metadata.privateTagCount).toBe(2);
    expect(result.metadata.hasUnmatchedTags).toBe(false);
  });

  it('masks an unclosed tag after a code block that holds the tag, and keeps the block', () => {
    const result = applyPrivacyFilter('see\n```\n<private>\n```\nthen <private>orchid', privacy);

    expect(result.content).toBe('see\n```\n<private>\n```\nthen [PRIVATE: unclosed]');
  });

  it('keeps the text after an unclosed tag with maskUnclosed: false, masking the rest as before', () => {
    // How redact-credentials re-filters rows stored before #269: no retroactive masking.
    const result = applyPrivacyFilter('a <private>orchid</private> b <private>lily api_key=fake-key-abcdef', privacy, { maskUnclosed: false });

    expect(result.content).toBe('a [PRIVATE]\nb <private>lily [REDACTED] ');
    expect(result.metadata.privateTagCount).toBe(1);
  });

  // #296: the parser only reported an unclosed tag it masked to the end, and
  // the tag count does not cover the comment format. maskUnclosed: false
  // changes what is masked, not what is flagged.
  it.each([
    ['an unclosed comment tag, which the tag count does not cover', 'comment', 'a <!-- private --> b', 'a [PRIVATE: unclosed]'],
    ['an unclosed comment tag after a stray closing tag', 'comment', 'a <!-- /private --> b <!-- private -->orchid', 'a <!-- /private --> b [PRIVATE: unclosed]'],
    ['an unclosed xml tag evened out by a stray closing tag', 'xml', 'a </private> b <private>orchid', 'a </private> b [PRIVATE: unclosed]'],
    // The bracket format does not fail closed, so only the tag count flags it.
    ['an unclosed bracket tag', 'bracket', 'a [private] b', 'a [private] b']
  ] as const)('flags %s whether or not it is masked', (_kind, format, text, masked) => {
    const config: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, supportedFormats: [format] }
    };

    const kept = applyPrivacyFilter(text, config, { maskUnclosed: false });
    expect(kept.content).toBe(text);
    expect(kept.metadata.hasUnmatchedTags).toBe(true);

    const byDefault = applyPrivacyFilter(text, config);
    expect(byDefault.content).toBe(masked);
    expect(byDefault.metadata.hasUnmatchedTags).toBe(true);
  });

  it('does not flag text whose tags are all closed with maskUnclosed: false', () => {
    // Bracket first, so it does not read the marker another format left as a tag.
    const allFormats: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, supportedFormats: ['bracket', 'xml', 'comment'] }
    };
    const result = applyPrivacyFilter('a <private>o</private> b [private]p[/private] c <!-- private -->q<!-- /private --> d', allFormats, { maskUnclosed: false });

    expect(result.content).toBe('a [PRIVATE]\nb [PRIVATE]\nc [PRIVATE]\nd');
    expect(result.metadata.hasUnmatchedTags).toBe(false);
  });

  // The code is set aside under a placeholder while tags are parsed. The same
  // text typed in the input used to be restored to code that was masked.
  it.each([
    ['inline code', '__INLINE_CODE_0__', '`codename-orchid`'],
    ['fenced code', '__CODE_BLOCK_0__', '```\ncodename-orchid\n```']
  ])('never restores masked %s into placeholder text typed before the tag', (_kind, placeholder, code) => {
    const unclosed = applyPrivacyFilter(`public ${placeholder} <private>${code}`, privacy).content;
    const closed = applyPrivacyFilter(`public ${placeholder} <private>${code}</private> end`, privacy).content;

    expect(unclosed).toBe(`public ${placeholder} [PRIVATE: unclosed]`);
    expect(closed).toBe(`public ${placeholder} [PRIVATE]\nend`);
  });

  it('masks from a tag inside a code fence that is never closed', () => {
    // An unclosed fence is not a code block, so the tag in it counts.
    expect(applyPrivacyFilter('see\n```\n<private>orchid', privacy).content).toBe('see\n```\n[PRIVATE: unclosed]');
  });

  it('does not read a [PRIVATE] marker as an unclosed bracket tag', () => {
    const xmlAndBracket: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, supportedFormats: ['xml', 'bracket'] }
    };

    expect(applyPrivacyFilter('a <private>orchid</private> b', xmlAndBracket).content).toBe('a [PRIVATE]\nb');
  });

  it('keeps the text after a [PRIVATE] marker in a stored row read back with the bracket format enabled', () => {
    const readBack: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, marker: '[REDACTED]', supportedFormats: ['xml', 'bracket', 'comment'] }
    };

    expect(applyPrivacyFilter('Fixed parsing [PRIVATE]\nand moved on to the dashboard', readBack).content)
      .toBe('Fixed parsing [PRIVATE]\nand moved on to the dashboard');
  });
});

describe('a credential right before a private tag', () => {
  // #304: the credential rules run after the tag pass, and their value ran on
  // into the marker it had just inserted.
  it.each([
    ['an unclosed tag', 'deploy token=abc<private>codename-orchid', 'deploy [REDACTED] [PRIVATE: unclosed]'],
    ['a closed tag', 'deploy password=abc<private>x</private> done', 'deploy [REDACTED] [PRIVATE]\ndone'],
    ['a CLI option', 'deploy --token abc<private>codename-orchid', 'deploy --token [REDACTED] [PRIVATE: unclosed]'],
    ['a credential URL', 'db postgres://u:pw@db.internal<private>codename-orchid', 'db [REDACTED] [PRIVATE: unclosed]'],
    ['an AWS secret key', 'AWS_SECRET_ACCESS_KEY=abc<private>codename-orchid', '[REDACTED] [PRIVATE: unclosed]']
  ])('keeps the marker after %s', (_label, input, expected) => {
    expect(applyPrivacyFilter(input, privacy).content).toBe(expected);
  });

  it('still redacts a value that goes on after a closed tag', () => {
    expect(applyPrivacyFilter('deploy token=abc<private>x</private>def done', privacy).content)
      .toBe('deploy [REDACTED] done');
  });

  it('keeps the marker after a custom exclude pattern', () => {
    const custom: Config['privacy'] = { ...privacy, excludePatterns: ['passphrase'] };

    expect(applyPrivacyFilter('use passphrase=abc<private>codename-orchid', custom).content)
      .toBe('use [REDACTED] [PRIVATE: unclosed]');
  });

  it('keeps a [REDACTED] marker whole', () => {
    const redactedMarker: Config['privacy'] = {
      ...privacy,
      privateTags: { ...privacy.privateTags, marker: '[REDACTED]' }
    };

    expect(applyPrivacyFilter('deploy token=abc<private>codename-orchid', redactedMarker).content)
      .toBe('deploy [REDACTED] [REDACTED: unclosed]');
  });
});

describe('nested private tags', () => {
  const allFormats: Config['privacy'] = {
    ...privacy,
    privateTags: { ...privacy.privateTags, marker: '[REDACTED]', supportedFormats: ['xml', 'bracket', 'comment'] }
  };

  // #288: a section used to end at its first closing tag, so the text between
  // an inner and the outer closing tag was stored as written, unflagged.
  it('masks a section up to the closing tag of its outer opening tag', () => {
    const result = applyPrivacyFilter('a <private>outer <private>inner</private> tail-orchid</private> b', privacy);

    expect(result.content).toBe('a [PRIVATE]\nb');
    expect(result.metadata.privateTagCount).toBe(1);
    expect(result.metadata.hasUnmatchedTags).toBe(false);
  });

  it('masks each nesting level and keeps the text between outer sections', () => {
    const result = applyPrivacyFilter(
      'x <private>1 <private>2 <private>3</private> 2b</private> 1b</private> y <private>z</private> w',
      privacy
    );

    expect(result.content).toBe('x [PRIVATE]\ny [PRIVATE]\nw');
    expect(result.metadata.privateTagCount).toBe(2);
  });

  it('masks nested bracket and comment tags the same way', () => {
    expect(applyPrivacyFilter('a [private]o [private]i[/private] tail-orchid[/private] b', allFormats).content)
      .toBe('a [REDACTED] b');
    expect(applyPrivacyFilter('a <!-- private -->o <!-- private -->i<!-- /private --> tail-orchid<!-- /private --> b', allFormats).content)
      .toBe('a [REDACTED] b');
  });

  it('masks from an outer tag that is never closed to the end, even when the tags inside it are closed', () => {
    const result = applyPrivacyFilter('a <private>o <private>i</private> mid-orchid tail-lily', privacy);

    expect(result.content).toBe('a [PRIVATE: unclosed]');
    expect(result.metadata.privateTagCount).toBe(1);
    expect(result.metadata.hasUnmatchedTags).toBe(true);
    expect(applyPrivacyFilter('a <!-- private -->o <!-- private -->i<!-- /private --> mid-orchid', allFormats).content)
      .toBe('a [REDACTED: unclosed]');
  });

  it('masks a bracket section left open up to its last closing tag, never to the end', () => {
    // The bracket format does not fail closed: its opening tag is also the stored [PRIVATE] marker.
    expect(applyPrivacyFilter('a [private]o [private]i[/private] mid-orchid [private]j[/private] tail', allFormats).content)
      .toBe('a [REDACTED] tail');
  });

  it('reads a stored [PRIVATE] marker as a bracket tag that only ever masks more', () => {
    expect(applyPrivacyFilter('Fixed [PRIVATE]\nthen [private]a[/private] mid-orchid [private]b[/private] end', allFormats).content)
      .toBe('Fixed [REDACTED] end');
  });

  it('leaves a closing tag with no opening tag before it as it was', () => {
    expect(applyPrivacyFilter('a <private>s</private> b</private> c', privacy).content)
      .toBe('a [PRIVATE]\nb</private> c');
  });

  it('keeps code and placeholder text out of a nested section', () => {
    const result = applyPrivacyFilter(
      'see `<private>` __INLINE_CODE_0__ <private>o `code-orchid` <private>i</private> tail-lily</private> end',
      privacy
    );

    expect(result.content).toBe('see `<private>` __INLINE_CODE_0__ [PRIVATE]\nend');
  });

  it('masks closed nested sections with maskUnclosed: false, and an outer tag left open only up to its last closing tag', () => {
    // How redact-credentials re-filters stored rows: no masking to the end.
    expect(applyPrivacyFilter('a <private>o <private>i</private> tail-orchid</private> b', privacy, { maskUnclosed: false }).content)
      .toBe('a [PRIVATE]\nb');

    const result = applyPrivacyFilter('a <private>o <private>i</private> mid-orchid <private>j</private> tail', privacy, { maskUnclosed: false });
    expect(result.content).toBe('a [PRIVATE]\ntail');
    expect(result.metadata.hasUnmatchedTags).toBe(true);
  });

  // Formats are matched one after another, so a section that now runs to its
  // outer closing tag can hide the closing tag another format's section used.
  // Nothing the first-closing-tag rule masked may come back.
  it('never reveals what a section ending at the first closing tag masked, across formats', () => {
    const result = applyPrivacyFilter(
      '[private] secret-orchid <private>a <private>b</private> mid-lily [/private] more-iris </private> after',
      allFormats
    );

    expect(result.content).toBe('[REDACTED] after');
    expect(result.metadata.hasPrivateTags).toBe(true);
  });

  it('masks 120,000 sections in one text', () => {
    const result = applyPrivacyFilter('<private>x</private> '.repeat(120_000), privacy, { collapseMarkers: false });

    expect(result.content).toBe('[PRIVATE] '.repeat(120_000));
    expect(result.metadata.privateTagCount).toBe(120_000);
  });

  it('still masks to the end from an unclosed tag that a nested section of another format runs over', () => {
    const result = applyPrivacyFilter('[private] a [private] b [/private] <!-- private --> c [/private] d-orchid', allFormats);

    expect(result.content).toBe('[REDACTED: unclosed]');
    expect(result.metadata.hasUnmatchedTags).toBe(true);
  });
});
