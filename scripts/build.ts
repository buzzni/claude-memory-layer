/**
 * Build script for claude-memory-layer plugin
 * Uses esbuild for fast bundling
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const outdir = 'dist';

// Clean output directory
if (fs.existsSync(outdir)) {
  fs.rmSync(outdir, { recursive: true });
}
fs.mkdirSync(outdir, { recursive: true });

// Common build options
const commonOptions: esbuild.BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  external: [
    '@hono/node-server',
    '@hono/node-server/serve-static',
    '@lancedb/lancedb',
    '@xenova/transformers',
    'duckdb',
    'better-sqlite3',
    'commander',
    'zod',
    'hono',
    'hono/cors',
    'hono/logger'
  ],
  banner: {
    js: `import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);`
  }
};

async function build() {
  console.log('🔨 Building claude-memory-layer plugin...\n');

  // Build CLI
  console.log('📦 Building CLI...');
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/cli/index.ts'],
    outfile: 'dist/cli/index.js'
  });

  // Build hooks
  console.log('📦 Building hooks...');
  const hooks = [
    'session-start',
    'user-prompt-submit',
    'post-tool-use',
    'stop',
    'session-end'
  ];

  for (const hook of hooks) {
    await esbuild.build({
      ...commonOptions,
      entryPoints: [`src/hooks/${hook}.ts`],
      outfile: `dist/hooks/${hook}.js`
    });
  }

  // Build core modules as library
  console.log('📦 Building core modules...');
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/core/index.ts'],
    outfile: 'dist/core/index.js'
  });

  // Build services
  console.log('📦 Building services...');
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/services/memory-service.ts'],
    outfile: 'dist/services/memory-service.js'
  });

  // Build server
  console.log('📦 Building server...');
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/server/index.ts'],
    outfile: 'dist/server/index.js',
    external: [...(commonOptions.external || []), 'hono']
  });

  // Build server API
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/server/api/index.ts'],
    outfile: 'dist/server/api/index.js',
    external: [...(commonOptions.external || []), 'hono']
  });

  // Copy plugin manifest
  console.log('📋 Copying plugin files...');
  fs.cpSync('.claude-plugin', path.join(outdir, '.claude-plugin'), { recursive: true });

  // Copy UI files
  console.log('📋 Copying UI files...');
  if (fs.existsSync('src/ui')) {
    fs.cpSync('src/ui', path.join(outdir, 'ui'), { recursive: true });
  }

  console.log('\n✅ Build complete!');
  console.log(`\nOutput: ${outdir}/`);
  console.log('  - cli/index.js');
  console.log('  - hooks/*.js');
  console.log('  - core/index.js');
  console.log('  - services/memory-service.js');
  console.log('  - server/index.js');
  console.log('  - ui/index.html');
  console.log('  - .claude-plugin/');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
