import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface BootstrapKnowledgeOptions {
  repoPath: string;
  outDir: string;
  since?: string;
  maxCommits?: number;
}

interface CommitInfo {
  hash: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
}

interface ModuleSummary {
  name: string;
  root: string;
  fileCount: number;
  languages: string[];
  entryCandidates: string[];
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', 'memory']);
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php', '.cs',
  '.scala', '.sh', '.zsh', '.yaml', '.yml', '.json', '.sql', '.md'
]);

function safeRel(base: string, target: string): string {
  return path.relative(base, target).replaceAll('\\', '/');
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function walkCodeFiles(root: string): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) out.push(full);
      }
    }
  }

  walk(root);
  return out.sort();
}

function detectLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.rb': 'Ruby', '.php': 'PHP',
    '.cs': 'C#', '.scala': 'Scala', '.sh': 'Shell', '.zsh': 'Shell', '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON', '.sql': 'SQL', '.md': 'Markdown'
  };
  return map[ext] || 'Other';
}

function summarizeModules(repoPath: string, files: string[]): ModuleSummary[] {
  const modules = new Map<string, { files: string[]; langs: Map<string, number> }>();

  for (const abs of files) {
    const rel = safeRel(repoPath, abs);
    const seg = rel.split('/').filter(Boolean);
    const top = seg[0] || 'root';

    if (!modules.has(top)) modules.set(top, { files: [], langs: new Map() });

    const bucket = modules.get(top)!;
    bucket.files.push(rel);

    const lang = detectLanguage(abs);
    bucket.langs.set(lang, (bucket.langs.get(lang) || 0) + 1);
  }

  return [...modules.entries()]
    .map(([name, data]) => ({
      name,
      root: name,
      fileCount: data.files.length,
      languages: [...data.langs.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 5),
      entryCandidates: data.files.filter((f) => /(index|main|app|server|cli)\./i.test(path.basename(f))).slice(0, 10)
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
}

function runGit(repoPath: string, command: string): string {
  return execSync(`git -C ${JSON.stringify(repoPath)} ${command}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function getGitCommits(repoPath: string, since = '180 days ago', maxCommits = 1000): CommitInfo[] {
  try {
    const raw = runGit(
      repoPath,
      `log --since=${JSON.stringify(since)} -n ${Math.max(1, maxCommits)} --date=short --pretty=format:%H%x09%ad%x09%an%x09%s --name-only --reverse`
    );

    const lines = raw.split(/\r?\n/);
    const commits: CommitInfo[] = [];
    let current: CommitInfo | null = null;

    for (const line of lines) {
      if (!line.trim()) {
        if (current) {
          commits.push(current);
          current = null;
        }
        continue;
      }

      if (line.includes('\t') && line.split('\t').length >= 4) {
        if (current) commits.push(current);
        const [hash, date, author, ...subjectRest] = line.split('\t');
        current = { hash, date, author, subject: subjectRest.join('\t').trim(), files: [] };
      } else if (current) {
        current.files.push(line.trim());
      }
    }

    if (current) commits.push(current);
    return commits;
  } catch {
    return [];
  }
}

function extractDecisions(commits: CommitInfo[]): CommitInfo[] {
  const decisionPattern = /(refactor|migrate|deprecat|remove|replace|introduce|adopt|switch|upgrade|breaking|architecture|feat|fix)/i;
  return commits.filter((c) => decisionPattern.test(c.subject));
}

function buildTimeline(commits: CommitInfo[]): Map<string, CommitInfo[]> {
  const timeline = new Map<string, CommitInfo[]>();
  for (const c of commits) {
    const key = (c.date || '').slice(0, 7) || 'unknown';
    if (!timeline.has(key)) timeline.set(key, []);
    timeline.get(key)!.push(c);
  }
  return new Map([...timeline.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function buildGlossary(files: string[]): string[] {
  const stop = new Set(['src', 'test', 'dist', 'lib', 'core', 'index', 'main', 'app', 'server', 'client', 'utils']);
  const freq = new Map<string, number>();

  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const tokens = base
      .split(/[^a-zA-Z0-9]+/)
      .flatMap((t) => t.split(/(?=[A-Z])/))
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 3 && !stop.has(t));

    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 80)
    .map(([term]) => term);
}

function writeFile(filePath: string, content: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function confidenceByEvidence(sourceCount: number): 'high' | 'mid' | 'low' {
  if (sourceCount >= 3) return 'high';
  if (sourceCount >= 1) return 'mid';
  return 'low';
}

function sourceLine(source: string): string {
  return `- source: ${source}`;
}

export async function bootstrapKnowledgeBase(options: BootstrapKnowledgeOptions): Promise<{
  outDir: string;
  fileCount: number;
  moduleCount: number;
  commitCount: number;
  generatedFiles: string[];
}> {
  const repoPath = path.resolve(options.repoPath);
  const outDir = path.resolve(options.outDir);
  const since = options.since || '180 days ago';
  const maxCommits = options.maxCommits ?? 1000;

  const codeFiles = walkCodeFiles(repoPath);
  const modules = summarizeModules(repoPath, codeFiles);
  const commits = getGitCommits(repoPath, since, maxCommits);
  const decisions = extractDecisions(commits);
  const timeline = buildTimeline(commits);
  const glossary = buildGlossary(codeFiles);

  const generatedFiles: string[] = [];

  const sections = {
    overview: path.join(outDir, 'overview'),
    modules: path.join(outDir, 'modules'),
    decisions: path.join(outDir, 'decisions'),
    timeline: path.join(outDir, 'timeline'),
    glossary: path.join(outDir, 'glossary'),
    sources: path.join(outDir, 'sources')
  };

  for (const sectionDir of Object.values(sections)) {
    mkdirp(sectionDir);
  }

  const overviewPath = path.join(sections.overview, 'overview.md');
  const overview = [
    '# Codebase Overview',
    '',
    `- generatedAt: ${new Date().toISOString()}`,
    '- deterministicPipeline: true',
    `- repo: ${repoPath}`,
    `- filesAnalyzed: ${codeFiles.length}`,
    `- commitsAnalyzed: ${commits.length}`,
    `- confidence: ${confidenceByEvidence(modules.length > 0 ? 3 : 0)}`,
    '',
    '## Directory / Module Map',
    ...modules.slice(0, 50).map((m) => `- ${m.name}: ${m.fileCount} files (${m.languages.join(', ') || 'n/a'})`),
    '',
    '## Fact',
    '- Generated from deterministic file scan and git history parsing.',
    '',
    '## Inference',
    '- Module responsibilities should be reviewed by maintainers for nuanced boundaries.',
    '',
    '## Sources',
    sourceLine(`repo-scan:${repoPath}`),
    sourceLine(`git-log:since=${since};max=${maxCommits}`),
    ''
  ].join('\n');
  writeFile(overviewPath, overview);
  generatedFiles.push(overviewPath);

  for (const m of modules.slice(0, 200)) {
    const relatedCommits = commits.filter((c) => c.files.some((f) => f.startsWith(`${m.root}/`))).slice(0, 15);
    const content = [
      `# Module: ${m.name}`,
      '',
      `- responsibility: inferred from top-level path \`${m.root}/\``,
      `- files: ${m.fileCount}`,
      `- languages: ${m.languages.join(', ') || 'n/a'}`,
      `- confidence: ${confidenceByEvidence(relatedCommits.length)}`,
      '',
      '## Entry Candidates',
      ...(m.entryCandidates.length > 0 ? m.entryCandidates.map((f) => `- ${f}`) : ['- none detected']),
      '',
      '## Related Commits (recent sample)',
      ...(relatedCommits.length > 0
        ? relatedCommits.map((c) => `- ${c.date} ${c.hash.slice(0, 8)} ${c.subject}`)
        : ['- none in selected range']),
      '',
      '## Sources',
      sourceLine(`repo-path:${m.root}/**`),
      ...relatedCommits.map((c) => sourceLine(`commit:${c.hash}`)),
      ''
    ].join('\n');

    const modulePath = path.join(sections.modules, `${m.name.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}.md`);
    writeFile(modulePath, content);
    generatedFiles.push(modulePath);
  }

  const decisionsPath = path.join(sections.decisions, 'decisions.md');
  const decisionsMd = [
    '# Decisions (extracted)',
    '',
    `- confidence: ${confidenceByEvidence(decisions.length)}`,
    '',
    ...(decisions.length > 0
      ? decisions.slice(0, 500).map((d) => [
        `## ${d.date} | ${d.subject}`,
        '- status: active (inferred)',
        sourceLine(`commit:${d.hash}`),
        `- author: ${d.author}`,
        `- changedFiles: ${d.files.length}`,
        `- confidence: ${confidenceByEvidence(d.files.length > 0 ? 2 : 1)}`,
        ''
      ].join('\n'))
      : ['- No decision-like commits found in selected range.', '']),
    '## Sources',
    sourceLine(`git-log:since=${since};max=${maxCommits}`),
    ''
  ].join('\n');
  writeFile(decisionsPath, decisionsMd);
  generatedFiles.push(decisionsPath);

  const timelinePath = path.join(sections.timeline, 'timeline.md');
  const timelineMd = [
    '# Timeline',
    '',
    `- confidence: ${confidenceByEvidence(commits.length > 0 ? 2 : 0)}`,
    '',
    ...[...timeline.entries()].flatMap(([month, list]) => [
      `## ${month}`,
      ...list.slice(0, 40).map((c) => `- ${c.date} ${c.hash.slice(0, 8)} ${c.subject}`),
      ''
    ]),
    '## Sources',
    sourceLine(`git-log:since=${since};max=${maxCommits}`),
    ''
  ].join('\n');
  writeFile(timelinePath, timelineMd);
  generatedFiles.push(timelinePath);

  const glossaryPath = path.join(sections.glossary, 'glossary.md');
  const glossaryMd = [
    '# Glossary (auto-extracted)',
    '',
    `- confidence: ${confidenceByEvidence(glossary.length > 0 ? 1 : 0)}`,
    '',
    ...glossary.map((t) => `- ${t}`),
    '',
    '## Sources',
    sourceLine(`repo-scan:${repoPath}`),
    ''
  ].join('\n');
  writeFile(glossaryPath, glossaryMd);
  generatedFiles.push(glossaryPath);

  const outputs = generatedFiles.map((f) => safeRel(outDir, f)).sort((a, b) => a.localeCompare(b));

  const sourceItems = [
    ...codeFiles.slice(0, 200).map((f) => ({ type: 'file', ref: safeRel(repoPath, f) })),
    ...commits.slice(0, 400).map((c) => ({ type: 'commit', ref: c.hash, date: c.date, subject: c.subject }))
  ];

  const manifest = {
    generatedAt: new Date().toISOString(),
    deterministicPipeline: true,
    repoPath,
    options: { since, maxCommits },
    stats: {
      filesAnalyzed: codeFiles.length,
      modules: modules.length,
      commits: commits.length,
      decisions: decisions.length,
      glossaryTerms: glossary.length
    },
    outputs,
    sources: sourceItems
  };

  const manifestJsonPath = path.join(sections.sources, 'manifest.json');
  writeFile(manifestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  generatedFiles.push(manifestJsonPath);

  const manifestMdPath = path.join(sections.sources, 'manifest.md');
  const manifestMd = [
    '# Sources Manifest',
    '',
    '- deterministicPipeline: true',
    `- sourceCount: ${sourceItems.length}`,
    '',
    '## Outputs',
    ...outputs.map((o) => `- ${o}`),
    '',
    '## Sources (sample)',
    ...sourceItems.slice(0, 300).map((s) => `- ${s.type}:${s.ref}`),
    ''
  ].join('\n');
  writeFile(manifestMdPath, manifestMd);
  generatedFiles.push(manifestMdPath);

  return {
    outDir,
    fileCount: codeFiles.length,
    moduleCount: modules.length,
    commitCount: commits.length,
    generatedFiles: generatedFiles.sort((a, b) => a.localeCompare(b))
  };
}
