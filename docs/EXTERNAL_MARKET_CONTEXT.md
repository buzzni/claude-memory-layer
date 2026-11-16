# External Market Context (DART/FRED/Finnhub)

[← README](../README.md)

`claude-memory-layer market-context` fetches read-only external company and market data from environment-configured providers and returns a structured `MarketContextSnapshot` plus a Markdown analysis report. It does not read or write project memory.

## Example

```bash
export DART_API_KEY=...      # env-only; never commit real keys
export FRED_API_KEY=...
export FINNHUB_API_KEY=...
claude-memory-layer market-context \
  --company 삼성전자 \
  --dart-corp-code 00126380 \
  --symbol 005930.KS \
  --providers dart,fred,finnhub \
  --fred-series FEDFUNDS,CPIAUCSL \
  --json
```

| Option | Meaning |
|---|---|
| `--company <name>` | Company name for the DART fallback search and the report subject |
| `--dart-corp-code <code>` | Exact DART `corp_code` for issuer-specific filings |
| `--symbol <ticker>` | Listed ticker for the Finnhub company profile |
| `--providers <list>` | Comma-separated providers: `dart,fred,finnhub` |
| `--fred-series <list>` | Comma-separated FRED series IDs |
| `--json` | Print structured JSON including `analysis.marketSnapshot` |
| `--no-snapshot` | Disable the `MarketContextSnapshot` and the DART company snapshot analysis |

## Security and behavior

- API keys are read only from `DART_API_KEY`, `FRED_API_KEY`, and `FINNHUB_API_KEY`.
- `.env*` files are ignored; `.env.example` is placeholder-only.
- Missing provider keys produce skipped-provider statuses rather than hard failures.
- Provider requests use bounded timeouts; large FRED series lists are capped to the first 10 unique series.
- Empty Finnhub profile responses are treated as skipped-provider/no-data results, not profile evidence.
- Provider errors and rendered reports redact credential-bearing query params such as `crtfc_key`, `api_key`, and `token`.
- The MCP `external-market-context` tool is read-only and does not initialize or mutate memory storage. It is part of the `experimental` and `all` MCP profiles (see [MCP_TOOL_PROFILES.md](MCP_TOOL_PROFILES.md)).
- `--no-snapshot` / MCP `includeSnapshot: false` disables both `analysis.marketSnapshot` and the DART company snapshot.

What each provider receives is listed in [SECURITY.md → data that leaves the machine](../SECURITY.md#기기-밖으로-나가는-데이터) (Korean).

## `MarketContextSnapshot`

- `schemaVersion: market-context-snapshot.v1`
- `subject`: company, DART corpCode, ticker symbol
- `coverage`: DART/FRED/Finnhub provider status and counts
- `bullCases`, `bearCases`, `risks`, `catalysts`: deterministic evidence-backed insights
- `watchlist` and `followUpQuestions`

The Markdown report includes a `### MarketContextSnapshot` section with **Bull case**, **Bear case**, **Risks**, and **Catalysts**. DART analysis uses all fetched filings; only the rendered filing list is truncated. If `dartCorpCode` is omitted, company-name fallback is marked low-confidence, so exact DART corp codes are recommended for customer-facing analysis.
