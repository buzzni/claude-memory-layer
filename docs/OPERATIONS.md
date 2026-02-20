# Operations Runbook

## Health scripts

- `npm run ops:sync-gap:report`
- `npm run ops:sync-gap:fix`
- `npm run ops:sync-gap:heal`
- `npm run ops:review:resolve`
- `npm run ops:heartbeat`

## Status policy

- `ok`: no failed outbox items and no un-leveled events after heal
- `needs-attention`: failed outbox remains or level sync still broken

## Notes

These scripts are best-effort operational automation for Claude memory DB (`~/.claude-code/memory/events.sqlite`).
