# Hook-path grounding replay: hook-grounding-fixture-v1

- Turns replayed: 7 (semantic lane: off)
- Fidelity of `current` vs. the recorded trace: query reproduced 100.0%, selection reproduced 57.1%
- Semantic results hidden as later than the trace: 0

## All turns

| arm | turns (with responses) | turns injected | memories scored | mean overlap | 95% CI | grounded memories | turns with a grounded memory |
|---|---:|---:|---:|---:|---|---:|---:|
| current | 7 | 5 | 5 | 0.640 | 0.298–0.862 | 80.0% | 80.0% |
| fts-absolute (#121) | 7 | 3 | 4 | 0.625 | 0.000–0.940 | 75.0% | 66.7% |
| query-sanitizer (#125) | 7 | 6 | 6 | 0.700 | 0.395–0.905 | 83.3% | 83.3% |
| #121 + #125 | 7 | 3 | 4 | 0.625 | 0.000–0.940 | 75.0% | 66.7% |

## Historically uninjected turns

| arm | turns (with responses) | turns injected | memories scored | mean overlap | 95% CI | grounded memories | turns with a grounded memory |
|---|---:|---:|---:|---:|---|---:|---:|
| current | 2 | 1 | 1 | 0.660 | n/a | 100.0% | 100.0% |
| fts-absolute (#121) | 2 | 0 | 0 | n/a | n/a | n/a | n/a |
| query-sanitizer (#125) | 2 | 1 | 1 | 0.660 | n/a | 100.0% | 100.0% |
| #121 + #125 | 2 | 0 | 0 | n/a | n/a | n/a | n/a |

## Change vs. current

| arm | query changed | selection changed |
|---|---:|---:|
| current | 0 | 0 |
| fts-absolute (#121) | 0 | 3 |
| query-sanitizer (#125) | 3 | 1 |
| #121 + #125 | 3 | 3 |

**Counterfactual bias.** The responses scored here were written after the hook injected its *historical* selection, so the agent could copy from those memories and not from others. Overlap therefore favors whatever the historical selection contained: the `current` arm is advantaged and a changed arm is understated. The "historically uninjected" rows (turns where the hook injected nothing at the time) carry no such bias and are the fairer comparison.

**Other approximations.** FTS bm25 statistics, memory levels, and lesson revisions are those of the store copy, not of each trace time. The semantic lane runs in-process with the daemon options, over-fetched and filtered to earlier events. Prompts are the redacted stored text. Lexical overlap also rewards responses that merely repeat query terms.
