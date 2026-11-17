'use strict';
// Preload for hook cold-start breakdown. Loaded with NODE_OPTIONS=--require.
// Records: preload start/end, first process.stdin access (≈ hook main() start,
// i.e. all bundle modules evaluated), time inside better-sqlite3 open/exec/pragma,
// time inside sync child_process calls, and the exit time. Only the hook
// launcher process writes a record (detached daemon children are ignored).
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const marks = {
  preloadStart: performance.now(),
  preloadEnd: null,
  stdinAt: null,
  sqliteOpens: 0,
  sqliteOpenMs: 0,
  sqliteExecMs: 0,
  firstSqliteOpenAt: null,
  cpSyncMs: 0,
  cpSyncCalls: [],
  exitAt: null
};
const out = process.env.CML_TRACE_OUT;
const isHook = (process.argv[1] || '').endsWith('hook-launcher.cjs');

if (isHook && out) {
  if (process.env.CML_TRACE_SQLITE !== '0') {
    try {
      // better-sqlite3 loads its addon through require('bindings') on the first
      // open; wrap that (native load) and addon.Database (the open itself).
      // Requiring only the JS wrappers here costs well under 1 ms.
      const resolved = require.resolve('better-sqlite3', { paths: [process.env.CML_TRACE_PKG] });
      const bindingsPath = require.resolve('bindings', { paths: [path.dirname(resolved)] });
      const bindings = require(bindingsPath);
      require.cache[bindingsPath].exports = function tracedBindings(...args) {
        const s = performance.now();
        if (marks.firstSqliteOpenAt === null) marks.firstSqliteOpenAt = s;
        // bindings() finds the module root from its caller's stack frame, which
        // is this file now; name the root explicitly.
        const opts = typeof args[0] === 'string' ? { bindings: args[0] } : { ...args[0] };
        opts.module_root = path.dirname(path.dirname(resolved));
        const addon = bindings(opts);
        marks.sqliteOpenMs += performance.now() - s;
        const NativeDb = addon.Database;
        addon.Database = new Proxy(NativeDb, {
          construct(target, a, nt) {
            const t = performance.now();
            try { return Reflect.construct(target, a, nt); } finally {
              marks.sqliteOpenMs += performance.now() - t;
              marks.sqliteOpens += 1;
            }
          }
        });
        return addon;
      };
      const D = require(path.join(path.dirname(resolved), 'database.js'));
      for (const k of ['exec', 'pragma']) {
        const orig = D.prototype[k];
        D.prototype[k] = function patched(...args) {
          const s = performance.now();
          try { return orig.apply(this, args); } finally { marks.sqliteExecMs += performance.now() - s; }
        };
      }
    } catch (e) {
      marks.sqlitePatchError = String(e && e.message);
    }
  }
  const cp = require('node:child_process');
  for (const k of ['execFileSync', 'execSync', 'spawnSync']) {
    const orig = cp[k];
    cp[k] = function patched(...args) {
      const s = performance.now();
      try { return orig.apply(this, args); } finally {
        const d = performance.now() - s;
        marks.cpSyncMs += d;
        marks.cpSyncCalls.push(`${k}:${String(args[0]).split('/').pop()} ${Array.isArray(args[1]) ? args[1].slice(0, 2).join(' ') : ''}:${d.toFixed(1)}`);
      }
    };
  }
  Module.syncBuiltinESMExports();

  const desc = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      if (marks.stdinAt === null) marks.stdinAt = performance.now();
      return desc.get.call(process);
    }
  });
  process.on('exit', () => {
    marks.exitAt = performance.now();
    marks.hook = process.argv[2];
    fs.appendFileSync(out, `${JSON.stringify(marks)}\n`);
  });
}
marks.preloadEnd = performance.now();
