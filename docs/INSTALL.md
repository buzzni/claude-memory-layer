# Installation

[← README](../README.md)

Claude Memory Layer requires **Node.js 20.19 or later** (`engines` in `package.json`).

There are two ways to connect it to Claude Code. **Use one of them, not both.**

| | A. npm + `claude-memory-layer install` | B. Claude Code plugin |
|---|---|---|
| What registers the hooks | The CLI writes them into `~/.claude/settings.json` | Claude Code loads them from the `memory-layer` plugin |
| npm package needed | Yes | Yes. The plugin's hooks run the globally installed package |
| Remove with | `claude-memory-layer uninstall` | `claude plugin uninstall memory-layer@claude-memory-layer` |

Both register the same seven hooks: SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PreCompact, Stop and SessionEnd.

## A. npm global install + `install`

```bash
npm install -g claude-memory-layer@latest

# Claude Code hooks only
claude-memory-layer install

# or: hooks plus the periodic maintenance scheduler in one step
claude-memory-layer install --with-maintenance

claude-memory-layer status
claude-memory-layer doctor
```

- A global install is recommended. `install` stores the hook file paths in `~/.claude/settings.json`, so a one-off `npx claude-memory-layer install` is less safe than a global install or a fixed local checkout.
- `install` only needs to be run **once** per machine. Restart Claude Code if it is already running.
- After upgrading, run `install` again: it adds hooks introduced by the new version (for example PreCompact) to an older installation. `claude-memory-layer doctor` fails the hooks check and lists any hook that is not installed.
- `install` / `uninstall` modify `~/.claude/settings.json` and keep your other hooks.
- `npm install` alone does not register any background service; see [Maintenance](#maintenance-optional).

## B. Claude Code plugin marketplace

Inside Claude Code:

```text
/plugin marketplace add buzzni/claude-memory-layer
/plugin install memory-layer@claude-memory-layer
```

On Claude Code 2.1.275 or later this also works in one step:

```text
/plugin install memory-layer --marketplace buzzni/claude-memory-layer
```

Then install the npm package, which the plugin's hooks run:

```bash
npm install -g claude-memory-layer@latest
claude-memory-layer doctor
```

- The plugin is named `memory-layer`, not `claude-memory-layer`, because Claude Code reserves plugin names that start with `claude-`. Its id is `memory-layer@claude-memory-layer` (plugin `memory-layer` from the marketplace `claude-memory-layer`).
- A git-based plugin install has neither `dist/` nor `node_modules`, so the plugin's hook launcher runs the hooks of the `claude-memory-layer` package found on `PATH`. Without the npm package the hooks do nothing; at session start they print one line asking you to run `npm install -g claude-memory-layer`.
- If you previously loaded this repository with `--plugin-dir` under its old plugin name, the key in `enabledPlugins` and the `memory-layer:` prefix of its components change.

## Switching between A and B

- To keep only the plugin, run `claude-memory-layer uninstall` (removes the hooks from `settings.json`).
- To keep only the `settings.json` hooks, run `claude plugin uninstall memory-layer@claude-memory-layer`.
- `claude-memory-layer doctor` (and `status`) checks whether the plugin is installed and warns when the hooks are registered twice. When it finds the same hooks in both places, the plugin skips its copy, but it still runs them if it is not certain they are the same.

## From a local checkout

```bash
git clone https://github.com/buzzni/claude-memory-layer.git
cd claude-memory-layer
npm install
npm run build
npx claude-memory-layer install
npx claude-memory-layer status
npx claude-memory-layer doctor
```

## Embedding backend

The embedding backend is required at runtime. `postinstall` installs `@huggingface/transformers` into an isolated managed directory inside the package, pins a patched `sharp` there, and installs a CPU-only `onnxruntime-node` on CUDA 11 machines. Contributors who do not touch vector features can skip that download with `CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL=1 npm ci` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

`claude-memory-layer doctor` checks Node version, the embedding backend, duplicate installs on `PATH`, hooks, MCP client configs and store access. `doctor --fix` reinstalls the managed embedding backend when that check fails and repairing is safe; otherwise it prints why it declined and the manual command. All other checks stay report-only.

### Embedding model

The default local embedding model is `Xenova/multilingual-e5-small`.

- It runs on `@huggingface/transformers` with the ONNX Runtime CPU backend, so no CUDA is needed.
- The original `intfloat/multilingual-e5-small` is a multilingual model that supports Korean; the Xenova variant provides ONNX files for Transformers.js.
- It produces 384-dimensional vectors, which keeps CPU and memory cost low for large session imports.
- The model files are downloaded once, on first use, into `~/.claude-code/memory/models/`. That is outside the package directory, so reinstalling or upgrading does not download them again.
- To experiment with other Transformers.js/ONNX models such as `onnx-community/Qwen3-Embedding-0.6B-ONNX` or `onnx-community/embeddinggemma-300m-ONNX`, use `--embedding-model <hf-model>` or `CLAUDE_MEMORY_EMBEDDING_MODEL`. They cost more to download and run, and their model/license maturity needs its own review.

```bash
claude-memory-layer import --project "$PWD" --embedding-model Xenova/multilingual-e5-small
CLAUDE_MEMORY_EMBEDDING_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX claude-memory-layer process --project "$PWD"
```

## Maintenance (optional)

To process pending embedding/vector outbox work and processing jobs stuck for more than 5 minutes on a schedule, enable it once:

```bash
# macOS: registers a user LaunchAgent in ~/Library/LaunchAgents
# Linux: registers a systemd user timer in ~/.config/systemd/user (no sudo)
claude-memory-layer maintenance install

# every 15 minutes instead of the default 5
claude-memory-layer maintenance install --interval 900

claude-memory-layer maintenance status
claude-memory-layer maintenance run --json
claude-memory-layer maintenance run --no-compaction

# require more free space than the default 5 GiB
claude-memory-layer maintenance run --min-free-gb 10

# removes only the scheduler definition; memory data is kept
claude-memory-layer maintenance uninstall
```

- Each run checks stores from the most recent, one at a time, under a per-project worker lock. By default it processes at most 4 rounds per store (at most one batch per vector schema per round), so it does not hold resources for long.
- Only pending jobs, retryable failed jobs and processing jobs stuck for more than 5 minutes are recovered automatically. Quarantined jobs that exceeded the retry limit stay in the status instead of being retried forever.
- If the file system holding the memory root has less than 5 GiB free, maintenance records its write work as `blocked` and only reports the queue. Change the threshold with `--min-free-gb <GiB>`; `0` explicitly turns this guard off. Scheduled runs use the same default.
- `maintenance install` / `uninstall` change only your user account's launchd/systemd definitions.
- On minimal Linux, containers or some WSL setups without a systemd user session, call `claude-memory-layer maintenance run` from your existing cron or task scheduler instead.

## Troubleshooting: CUDA 11 and `onnxruntime-node`

On a Linux x64 server with CUDA 11, `onnxruntime-node` (a dependency of `@huggingface/transformers`) detects `nvcc --version` and tries to install CUDA 11 GPU binaries. Its install script does not support that yet, so `npm install` can fail with:

```text
Error: CUDA 11 binaries are not supported by this script yet.
```

The postinstall repair installs the backend into its isolated directory with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`, pinning a CPU-only ONNX Runtime and a patched `sharp`. If npm's final exit code is 0 and `claude-memory-layer --version` works, the install is fine. On current versions this normally just works:

```bash
npm install -g claude-memory-layer@latest
claude-memory-layer --version
```

If the same error keeps appearing because of npm version or environment differences, skip the CUDA binary download explicitly and reinstall:

```bash
# remove a partially installed global package first
npm uninstall -g claude-memory-layer || true

# reinstall with a CPU-only ONNX Runtime
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest
claude-memory-layer --version
```

In a local checkout:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
```

If only the backend of an already installed package is damaged or missing, run the repair script from that package directory (or use `claude-memory-layer doctor --fix`):

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip node scripts/postinstall-embedding-backend.cjs
```

`npm warn deprecated ...` messages come from transitive dependencies and do not cause install failures.
