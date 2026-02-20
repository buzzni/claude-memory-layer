#!/usr/bin/env bash
set -euo pipefail

TMP_REPORT=$(mktemp)
TMP_HEAL=$(mktemp)
TMP_REVIEW=$(mktemp)
trap 'rm -f "$TMP_REPORT" "$TMP_HEAL" "$TMP_REVIEW"' EXIT

node scripts/report-sync-gap.js >"$TMP_REPORT" || echo '{"status":"error","reason":"report_failed"}' >"$TMP_REPORT"
bash scripts/sync-gap-auto-heal.sh >"$TMP_HEAL" || echo '{"status":"error","reason":"heal_failed"}' >"$TMP_HEAL"
node scripts/review-queue-auto-resolve.js >"$TMP_REVIEW" || echo '{"status":"error","reason":"review_failed"}' >"$TMP_REVIEW"

node - <<'EOF' "$TMP_REPORT" "$TMP_HEAL" "$TMP_REVIEW"
const fs = require('fs');
const safe = (p) => { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return { status:'error', reason:'parse_failed' }; } };
const [r,h,v] = process.argv.slice(2);
const report = safe(r);
const heal = safe(h);
const review = safe(v);
const after = heal.after || {};
const needsAttention = (report.outboxFailedCount||0) > 0 || (after.inEventsNotLeveledCount||0) > 0 || report.status === 'error' || heal.status === 'error';
console.log(JSON.stringify({
  status: needsAttention ? 'needs-attention' : 'ok',
  report,
  heal,
  review
}, null, 2));
EOF
