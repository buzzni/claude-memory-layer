#!/usr/bin/env bash
set -euo pipefail

REPORT=$(node scripts/report-sync-gap.js)
PENDING=$(echo "$REPORT" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(o.outboxPendingCount||0));')
FAILED=$(echo "$REPORT" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(o.outboxFailedCount||0));')
NOLEVEL=$(echo "$REPORT" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(o.inEventsNotLeveledCount||0));')

AUTO=0
if [[ "$FAILED" -gt 0 || "$NOLEVEL" -gt 0 ]]; then
  AUTO=1
  node scripts/fix-sync-gap.js >/dev/null
fi

AFTER=$(node scripts/report-sync-gap.js)

node -e 'const before=JSON.parse(process.argv[1]); const after=JSON.parse(process.argv[2]); const auto=Number(process.argv[3]); console.log(JSON.stringify({status:"ok",autoFixApplied:auto,before,after},null,2));' "$REPORT" "$AFTER" "$AUTO"
