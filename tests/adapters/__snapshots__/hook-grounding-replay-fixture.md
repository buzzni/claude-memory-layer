# Hook-path grounding replay: hook-grounding-fixture-v1

- Turns replayed: 8 (semantic lane: off)
- Fidelity of `current` vs. the recorded trace: query reproduced 100.0%, selection reproduced 37.5%
- Turns whose adherence was inferred (prompt not stored): 1
- Semantic results later than the trace (time-bound check, expected 0): 0

## All turns

| arm | turns (with responses) | turns injected | memories scored | mean overlap | 95% CI | grounded memories | turns with a grounded memory |
|---|---:|---:|---:|---:|---|---:|---:|
| current | 8 | 6 | 6 | 0.643 | 0.383–0.843 | 83.3% | 83.3% |
| fts-absolute (#121) | 8 | 4 | 4 | 0.593 | 0.203–0.875 | 75.0% | 75.0% |
| query-sanitizer (#125) | 8 | 7 | 7 | 0.694 | 0.460–0.877 | 85.7% | 85.7% |
| #121 + #125 | 8 | 4 | 4 | 0.593 | 0.203–0.875 | 75.0% | 75.0% |

## Historically uninjected turns

| arm | turns (with responses) | turns injected | memories scored | mean overlap | 95% CI | grounded memories | turns with a grounded memory |
|---|---:|---:|---:|---:|---|---:|---:|
| current | 3 | 2 | 2 | 0.640 | 0.620–0.660 | 100.0% | 100.0% |
| fts-absolute (#121) | 3 | 1 | 1 | 0.620 | n/a | 100.0% | 100.0% |
| query-sanitizer (#125) | 3 | 2 | 2 | 0.640 | 0.620–0.660 | 100.0% | 100.0% |
| #121 + #125 | 3 | 1 | 1 | 0.620 | n/a | 100.0% | 100.0% |

## Change vs. current

| arm | query changed | selection changed |
|---|---:|---:|
| current | 0 | 0 |
| fts-absolute (#121) | 0 | 2 |
| query-sanitizer (#125) | 3 | 1 |
| #121 + #125 | 3 | 2 |

**Counterfactual bias.** The responses scored here were written after the hook injected its *historical* selection, so the agent could copy from those memories and not from others. Overlap therefore favors whatever the historical selection contained: the `current` arm is advantaged and a changed arm is understated. The "historically uninjected" rows (turns where the hook injected nothing at the time) carry no such bias and are the fairer comparison.

**Other approximations.** FTS bm25 statistics, memory levels, lesson revisions, and the adaptive rerank weights are those of the store copy, not of each trace time. The semantic lane runs in-process with the daemon options instead of through the daemon. Prompts are the redacted stored text. Lexical overlap also rewards responses that merely repeat query terms.
