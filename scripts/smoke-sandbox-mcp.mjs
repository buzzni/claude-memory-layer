import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Opt-in macOS smoke: run after npm run build. Only synthetic storage is used.
assert.equal(process.platform, 'darwin', 'This smoke requires macOS sandbox-exec');
const repo = path.resolve(process.argv[2] ?? process.cwd());
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cml-built-sandbox-')));
const home = path.join(root, 'home');
const temp = path.join(root, 'snapshots');
const projectPath = path.join(root, 'project');
for (const directory of [home, temp, projectPath]) fs.mkdirSync(directory);
os.homedir = () => home;
syncBuiltinESMExports();
const core = await import(pathToFileURL(path.join(repo, 'dist/core/index.js')));
const { Client } = await import(pathToFileURL(path.join(repo, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(repo, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const projectHash = core.hashProjectPath(projectPath);
const memoryRoot = path.join(home, '.claude-code', 'memory');
const store = new core.SQLiteEventStore(path.join(core.getProjectStoragePath(projectPath), 'events.sqlite'));
const preload = path.join(root, 'homedir.cjs');
fs.writeFileSync(preload, "const os = require('node:os'); os.homedir = () => process.env.CML_TEST_HOME; require('node:module').syncBuiltinESMExports();");
const profile = path.join(root, 'sandbox.sb');
fs.writeFileSync(profile, `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(temp)}))`);
const env = { ...process.env, CML_TEST_HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, CLAUDE_MEMORY_RECALL_OWNER: 'host', CLAUDE_MEMORY_MCP_READ_ONLY: '', CLAUDE_MEMORY_MCP_PROFILE: 'all', CLAUDE_MEMORY_ASSET_PERMISSION_MODE: 'legacy' };
delete env.NODE_OPTIONS;

function snapshot(directory) {
  const result = {};
  function visit(p) {
    const s = fs.lstatSync(p);
    result[path.relative(directory, p)] = [s.mode, s.size, s.mtimeMs, s.isFile() ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null];
    if (s.isDirectory()) for (const child of fs.readdirSync(p).sort()) visit(path.join(p, child));
  }
  visit(directory);
  return result;
}
function textOf(result) { return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); }
async function connect(profilePath) {
  const transport = new StdioClientTransport({ command: '/usr/bin/sandbox-exec', args: ['-f', profilePath, process.execPath, '--require', preload, path.join(repo, 'dist/mcp/index.js')], cwd: projectPath, env, stderr: 'pipe' });
  const client = new Client({ name: 'sandbox-smoke', version: '1' });
  await client.connect(transport, { timeout: 15000 });
  return client;
}

let client;
try {
  await store.initialize();
  const first = await store.append({ eventType: 'user_prompt', sessionId: 'synthetic', timestamp: new Date(), content: 'Sandbox recall verifies source navigation.', metadata: { scope: { project: { hash: projectHash } } } });
  const neighbor = await store.append({ eventType: 'agent_response', sessionId: 'synthetic', timestamp: new Date(Date.now() + 1), content: 'Sandbox neighbor evidence. api_key=fixture-sensitive-value', metadata: { scope: { project: { hash: projectHash } } } });
  assert(first.success && neighbor.success);
  const lesson = await new core.LessonRepository(store.getDatabase()).upsert({ projectHash, name: 'Synthetic sandbox lesson', trigger: 'Sandbox recall', steps: ['Read source'], sourceEventIds: [first.eventId], sourceClass: 'curated' });
  const vectors = new core.VectorStore(path.join(core.getProjectStoragePath(projectPath), 'vectors'));
  await vectors.upsert({ id: 'fixture-vector', eventId: first.eventId, sessionId: 'synthetic', eventType: 'user_prompt', content: 'Synthetic vector fixture', vector: [0.1, 0.2, 0.3], timestamp: new Date().toISOString() });
  const before = snapshot(memoryRoot);
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', "const fs=require('node:fs'); let denied=false; try {fs.mkdirSync(process.argv[1]);} catch(e) {denied=e.code==='EPERM'||e.code==='EACCES';} if(!denied) process.exit(3); fs.writeFileSync(process.argv[2], 'ok');", path.join(home, 'forbidden-cache'), path.join(temp, 'allowed-probe')], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(probe.status, 0, 'OS sandbox must deny canonical/model writes and permit snapshot temp writes');
  fs.unlinkSync(path.join(temp, 'allowed-probe'));
  client = await connect(profile);
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, ['mem-context-pack','mem-search','mem-timeline','mem-details','mem-project-timeline','mem-source-ref','mem-stats','mem-lesson-get','mem-lesson-list','external-market-context'].sort());
  let reads = 0;
  for (const [name, args, expected] of [
    ['mem-context-pack', { query: 'Sandbox recall' }, 'Project Context Pack'],
    ['mem-search', { query: 'Sandbox recall' }, 'Sandbox recall'],
    ['mem-source-ref', { ids: [first.eventId], includeNeighbors: true }, 'Sandbox neighbor evidence'],
    ['mem-details', { ids: [first.eventId] }, 'Sandbox recall verifies'],
    ['mem-timeline', { ids: [first.eventId] }, 'Timeline Context'],
    ['mem-project-timeline', {}, 'Project Memory Timeline'],
    ['mem-stats', {}, 'Total Events'],
    ['mem-lesson-get', { lessonId: lesson.lessonId }, lesson.name],
    ['mem-lesson-list', {}, lesson.name],
    ['mem-context-pack', { query: 'continue' }, 'Project Context Pack']
  ]) {
    const result = await client.callTool({ name, arguments: { projectPath, ...args } }, undefined, { timeout: 15000 });
    assert(!result.isError, `${name}: ${textOf(result)}`);
    assert(textOf(result).includes(expected), `${name} must return fixture evidence`);
    if (name === 'mem-stats') assert(textOf(result).includes('**Total Vectors**: 1'));
    assert(!textOf(result).includes('fixture-sensitive-value'));
    if (name === 'mem-context-pack') assert(textOf(result).includes('lexical search'));
    reads++;
  }
  for (const [name, args] of [['mem-import-latest', {}], ['mem-lesson-save', {}], ['mem-context-pack', { refreshLatest: true }]]) {
    const result = await client.callTool({ name, arguments: { projectPath, ...args } });
    assert(result.isError);
    assert.equal(result.structuredContent.code, 'read_only_runtime');
  }
  await client.close(); client = undefined;
  assert.deepEqual(snapshot(memoryRoot), before);
  assert.equal(fs.existsSync(path.join(home, '.cache')), false);
  assert.deepEqual(fs.readdirSync(temp), []);
  const deniedProfile = path.join(root, 'read-denied.sb');
  fs.writeFileSync(deniedProfile, fs.readFileSync(profile, 'utf8') + `(deny file-read* (subpath ${JSON.stringify(memoryRoot)}))`);
  client = await connect(deniedProfile);
  const denied = await client.callTool({ name: 'mem-source-ref', arguments: { projectPath, ids: [first.eventId] } });
  assert(denied.isError, 'Read-denied source must remain an error');
  assert(!textOf(denied).includes(root), 'Error must not expose source paths');
  await client.close(); client = undefined;
  assert.deepEqual(snapshot(memoryRoot), before);
  assert.deepEqual(fs.readdirSync(temp), []);
  console.log(JSON.stringify({ osSandbox: 'passed', writesDenied: true, networkDenied: true, reads, unsupportedRejected: 3, supportedTools: names.length, canonicalChanges: 0, snapshotLeaks: 0, sourceReadDenied: 'safe error' }));
} finally {
  if (client) await client.close();
  await store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
