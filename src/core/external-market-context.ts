const MAX_RENDERED_ITEMS = 8;
const MAX_FRED_SERIES = 10;
const PROVIDER_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_FRED_SERIES = ['FEDFUNDS', 'CPIAUCSL', 'UNRATE'];
const ALLOWED_PROVIDERS = new Set<ExternalMarketProvider>(['dart', 'fred', 'finnhub']);

export type ExternalMarketProvider = 'dart' | 'fred' | 'finnhub';
export type ProviderStatus = 'ok' | 'skipped' | 'error';
export type MarketContextInsightConfidence = 'low' | 'medium' | 'high';
export type MarketContextInsightHorizon = 'near-term' | 'medium-term' | 'monitor';
export type MarketContextDartConfidence = 'exact-corp-code' | 'company-name-fallback' | 'provider-skipped' | 'provider-error' | 'unavailable';

export interface ExternalMarketContextOptions {
  company?: string;
  dartCorpCode?: string;
  symbol?: string;
  providers?: ExternalMarketProvider[];
  fredSeries?: string[];
  includeSnapshot?: boolean;
  now?: Date;
}

export interface DartFiling {
  corpName: string;
  receiptNo: string;
  reportName: string;
  filerName?: string;
  receiptDate?: string;
  remark?: string;
  url: string;
}

export interface DartProviderResult {
  provider: 'dart';
  status: ProviderStatus;
  filings: DartFiling[];
  displayedFilings: DartFiling[];
  warnings?: string[];
  error?: string;
}

export interface FredSeriesSnapshot {
  seriesId: string;
  latestValue?: string;
  latestDate?: string;
}

export interface FredProviderResult {
  provider: 'fred';
  status: ProviderStatus;
  series: FredSeriesSnapshot[];
  warnings?: string[];
  error?: string;
}

export interface FinnhubProviderResult {
  provider: 'finnhub';
  status: ProviderStatus;
  profile?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
}

export interface MarketContextEvidence {
  provider: ExternalMarketProvider;
  title: string;
  reason: string;
  receiptNo?: string;
  receiptDate?: string;
  url?: string;
  category?: string;
  seriesId?: string;
  latestValue?: string;
  latestDate?: string;
  symbol?: string;
}

export interface MarketContextInsight {
  signal: string;
  thesis: string;
  confidence: MarketContextInsightConfidence;
  horizon: MarketContextInsightHorizon;
  evidence: MarketContextEvidence[];
}

export interface CompanySnapshot {
  company: string;
  filingsAnalyzed: number;
  categoryCounts: Record<string, number>;
  riskSignals: MarketContextEvidence[];
  catalysts: MarketContextEvidence[];
  watchlist: string[];
  followUpQuestions: string[];
}

export interface MarketContextSnapshot {
  schemaVersion: 'market-context-snapshot.v1';
  subject: {
    company?: string;
    dartCorpCode?: string;
    symbol?: string;
  };
  coverage: {
    dart?: {
      status: ProviderStatus;
      filingsAnalyzed: number;
      renderedFilings: number;
      confidence: MarketContextDartConfidence;
      warnings?: string[];
    };
    fred?: {
      status: ProviderStatus;
      seriesAnalyzed: number;
      warnings?: string[];
    };
    finnhub?: {
      status: ProviderStatus;
      hasProfile: boolean;
      warnings?: string[];
    };
  };
  bullCases: MarketContextInsight[];
  bearCases: MarketContextInsight[];
  risks: MarketContextInsight[];
  catalysts: MarketContextInsight[];
  watchlist: string[];
  followUpQuestions: string[];
}

export interface ExternalMarketContextAnalysis {
  companySnapshot?: CompanySnapshot;
  marketSnapshot?: MarketContextSnapshot;
}

export interface ExternalMarketContextReport {
  generatedAt: string;
  query: {
    company?: string;
    dartCorpCode?: string;
    symbol?: string;
    providers: ExternalMarketProvider[];
    fredSeries?: string[];
  };
  dart?: DartProviderResult;
  fred?: FredProviderResult;
  finnhub?: FinnhubProviderResult;
  analysis?: ExternalMarketContextAnalysis;
}

export async function fetchExternalMarketContext(options: ExternalMarketContextOptions): Promise<ExternalMarketContextReport> {
  const providers = normalizeProviders(options.providers);
  const fredSelection = selectFredSeries(options.fredSeries);
  const report: ExternalMarketContextReport = {
    generatedAt: (options.now ?? new Date()).toISOString(),
    query: {
      company: optionalTrimmed(options.company),
      dartCorpCode: optionalTrimmed(options.dartCorpCode),
      symbol: optionalTrimmed(options.symbol),
      providers,
      fredSeries: providers.includes('fred') ? fredSelection.series : normalizeStringList(options.fredSeries)
    }
  };

  for (const provider of providers) {
    if (provider === 'dart') report.dart = await fetchDartProvider(report.query.company, report.query.dartCorpCode);
    if (provider === 'fred') report.fred = await fetchFredProvider(fredSelection.series, fredSelection.warnings);
    if (provider === 'finnhub') report.finnhub = await fetchFinnhubProvider(report.query.symbol);
  }

  if (options.includeSnapshot !== false) {
    const companySnapshot = report.dart?.status === 'ok'
      ? buildCompanySnapshot(report.query.company ?? report.dart.filings[0]?.corpName ?? 'unknown', report.dart.filings)
      : undefined;
    report.analysis = {
      ...(companySnapshot ? { companySnapshot } : {}),
      marketSnapshot: buildMarketContextSnapshot(report)
    };
  }

  return report;
}

async function fetchDartProvider(company?: string, corpCode?: string): Promise<DartProviderResult> {
  const apiKey = optionalTrimmed(process.env.DART_API_KEY);
  if (!apiKey) return { provider: 'dart', status: 'skipped', filings: [], displayedFilings: [], warnings: ['DART_API_KEY is not set'] };
  if (!company && !corpCode) return { provider: 'dart', status: 'skipped', filings: [], displayedFilings: [], warnings: ['company or dartCorpCode is required for DART'] };

  const warnings: string[] = [];
  if (company && !corpCode) warnings.push('DART company-name fallback is low-confidence; prefer dartCorpCode for exact issuer coverage.');

  try {
    const url = new URL('https://opendart.fss.or.kr/api/list.json');
    url.searchParams.set('crtfc_key', apiKey);
    if (corpCode) url.searchParams.set('corp_code', corpCode);
    url.searchParams.set('page_count', '100');
    const { response, json } = await fetchJsonWithTimeout(url);
    const status = stringValue(json.status);
    if (status === '013') return { provider: 'dart', status: 'ok', filings: [], displayedFilings: [], warnings };
    if (!response.ok || (status && status !== '000')) {
      return { provider: 'dart', status: 'error', filings: [], displayedFilings: [], warnings, error: redactSecrets(String(json.message ?? `DART status ${status ?? response.status}`)) };
    }
    const rows = Array.isArray(json.list) ? json.list : [];
    const filings = rows
      .map(normalizeDartFiling)
      .filter((filing): filing is DartFiling => filing !== undefined)
      .filter((filing) => corpCode || !company || filing.corpName.includes(company) || company.includes(filing.corpName));
    return { provider: 'dart', status: 'ok', filings, displayedFilings: filings.slice(0, MAX_RENDERED_ITEMS), warnings };
  } catch (error) {
    return { provider: 'dart', status: 'error', filings: [], displayedFilings: [], warnings, error: safeProviderError(error) };
  }
}

async function fetchFredProvider(seriesIds: string[], preflightWarnings: string[] = []): Promise<FredProviderResult> {
  const apiKey = optionalTrimmed(process.env.FRED_API_KEY);
  const series = seriesIds;
  if (!apiKey) return { provider: 'fred', status: 'skipped', series: [], warnings: ['FRED_API_KEY is not set', ...preflightWarnings] };

  const snapshots: FredSeriesSnapshot[] = [];
  const warnings: string[] = [...preflightWarnings];
  for (const seriesId of series) {
    try {
      const url = new URL('https://api.stlouisfed.org/fred/series/observations');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('file_type', 'json');
      url.searchParams.set('series_id', seriesId);
      url.searchParams.set('sort_order', 'desc');
      url.searchParams.set('limit', '1');
      const { response, json } = await fetchJsonWithTimeout(url);
      if (!response.ok || Array.isArray(json.observations) === false) {
        warnings.push(`${seriesId}: ${redactSecrets(String(json.error_message ?? response.statusText ?? 'failed'))}`);
        continue;
      }
      const latest = (json.observations as unknown[]).find((item) => typeof item === 'object' && item !== null) as Record<string, unknown> | undefined;
      snapshots.push({ seriesId, latestValue: stringValue(latest?.value), latestDate: stringValue(latest?.date) });
    } catch (error) {
      warnings.push(`${seriesId}: ${safeProviderError(error)}`);
    }
  }
  return { provider: 'fred', status: snapshots.length > 0 ? 'ok' : 'error', series: snapshots, warnings };
}

async function fetchFinnhubProvider(symbol?: string): Promise<FinnhubProviderResult> {
  const apiKey = optionalTrimmed(process.env.FINNHUB_API_KEY);
  if (!apiKey) return { provider: 'finnhub', status: 'skipped', warnings: ['FINNHUB_API_KEY is not set'] };
  if (!symbol) return { provider: 'finnhub', status: 'skipped', warnings: ['symbol is required for Finnhub'] };

  try {
    const url = new URL('https://finnhub.io/api/v1/stock/profile2');
    url.searchParams.set('token', apiKey);
    url.searchParams.set('symbol', symbol);
    const { response, json } = await fetchJsonWithTimeout(url);
    if (!response.ok) return { provider: 'finnhub', status: 'error', error: redactSecrets(String(json.error ?? response.statusText ?? 'failed')) };
    if (!hasObjectData(json)) return { provider: 'finnhub', status: 'skipped', warnings: ['Finnhub returned no profile data'] };
    return { provider: 'finnhub', status: 'ok', profile: json };
  } catch (error) {
    return { provider: 'finnhub', status: 'error', error: safeProviderError(error) };
  }
}

function buildCompanySnapshot(company: string, filings: DartFiling[]): CompanySnapshot {
  const categoryCounts: Record<string, number> = {};
  const riskSignals: MarketContextEvidence[] = [];
  const catalysts: MarketContextEvidence[] = [];
  for (const filing of filings) {
    const category = categorizeFiling(filing.reportName);
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    const evidence = dartEvidence(filing, category, `DART filing categorized as ${category}`);
    if (category === 'risk' || category === 'correction') riskSignals.push(evidence);
    if (category === 'contract' || category === 'capital' || category === 'financial' || category === 'performance') catalysts.push(evidence);
  }
  return {
    company,
    filingsAnalyzed: filings.length,
    categoryCounts,
    riskSignals,
    catalysts,
    watchlist: [
      'Compare repeat/correction filings with prior filings before relying on trend signals.',
      'Prefer dartCorpCode-based lookups for exact issuer coverage.',
      'Review risk-sensitive filings manually before making investment or sales decisions.'
    ],
    followUpQuestions: [
      'Which recent filings change revenue, margin, capital structure, or governance assumptions?',
      'Are any risk-sensitive filings one-off events or recurring patterns?',
      'What customer/sales implication follows from the latest disclosed business changes?'
    ]
  };
}

function buildMarketContextSnapshot(report: ExternalMarketContextReport): MarketContextSnapshot {
  const bullCases: MarketContextInsight[] = [];
  const bearCases: MarketContextInsight[] = [];
  const risks: MarketContextInsight[] = [];
  const catalysts: MarketContextInsight[] = [];

  if (report.dart?.status === 'ok') appendDartInsights(report.dart.filings, bullCases, bearCases, risks, catalysts);
  if (report.fred?.status === 'ok') appendFredInsights(report.fred.series, bullCases, bearCases, risks, catalysts);
  if (report.finnhub?.status === 'ok' && report.finnhub.profile) appendFinnhubInsights(report.query.symbol, report.finnhub.profile, bullCases, catalysts);

  return {
    schemaVersion: 'market-context-snapshot.v1',
    subject: { company: report.query.company ?? report.dart?.filings[0]?.corpName, dartCorpCode: report.query.dartCorpCode, symbol: report.query.symbol },
    coverage: {
      ...(report.dart ? { dart: { status: report.dart.status, filingsAnalyzed: report.dart.filings.length, renderedFilings: report.dart.displayedFilings.length, confidence: dartConfidence(report), ...(report.dart.warnings?.length ? { warnings: report.dart.warnings } : {}) } } : {}),
      ...(report.fred ? { fred: { status: report.fred.status, seriesAnalyzed: report.fred.series.length, ...(report.fred.warnings?.length ? { warnings: report.fred.warnings } : {}) } } : {}),
      ...(report.finnhub ? { finnhub: { status: report.finnhub.status, hasProfile: report.finnhub.profile !== undefined, ...(report.finnhub.warnings?.length ? { warnings: report.finnhub.warnings } : {}) } } : {})
    },
    bullCases: bullCases.slice(0, 8),
    bearCases: bearCases.slice(0, 8),
    risks: risks.slice(0, 8),
    catalysts: catalysts.slice(0, 8),
    watchlist: [
      'Verify every insight against original provider data before making investment, sales, or strategy decisions.',
      'Separate one-off event disclosures from recurring trend signals.',
      'Use exact identifiers such as DART corpCode and listed ticker for customer-facing reports.'
    ],
    followUpQuestions: [
      'What changed in the latest filings that affects bull-case revenue or margin assumptions?',
      'Which bear-case risks require management, customer, or investor follow-up?',
      'Which catalyst has a concrete date, counterparty, amount, or regulatory dependency?'
    ]
  };
}

function appendDartInsights(filings: DartFiling[], bullCases: MarketContextInsight[], bearCases: MarketContextInsight[], risks: MarketContextInsight[], catalysts: MarketContextInsight[]): void {
  for (const filing of filings) {
    const category = categorizeFiling(filing.reportName);
    const evidence = [dartEvidence(filing, category, `DART filing categorized as ${category}`)];
    if (category === 'performance') bullCases.push(insight('Operating performance disclosure', 'Recent operating performance disclosure can support the bull case if the detailed filing confirms improving revenue, margin, or demand signals.', 'medium', 'near-term', evidence));
    if (category === 'contract') {
      catalysts.push(insight('Commercial contract disclosure', 'New contract or supply disclosure is a catalyst candidate because it can change near-term revenue visibility or customer momentum.', 'medium', 'near-term', evidence));
      bullCases.push(insight('Revenue visibility catalyst', 'Contract disclosure can strengthen the bull case if contract size, duration, and counterparty quality are material.', 'medium', 'near-term', evidence));
    }
    if (category === 'capital') {
      bearCases.push(insight('Capital structure dilution watch', 'Capital issuance can pressure the bear case through dilution, financing cost, or balance-sheet stress unless proceeds create clear strategic value.', 'medium', 'medium-term', evidence));
      catalysts.push(insight('Capital allocation event', 'Capital market activity is a catalyst that requires follow-up on use of proceeds, dilution, and investor demand.', 'low', 'monitor', evidence));
    }
    if (category === 'risk') {
      risks.push(insight('Risk-sensitive disclosure', 'Litigation, enforcement, trading-halt, or governance-risk disclosure needs manual review before relying on the company outlook.', 'high', 'near-term', evidence));
      bearCases.push(insight('Event-risk overhang', 'Risk-sensitive filings can create a bear-case overhang until scope, liability, and operational impact are clarified.', 'high', 'near-term', evidence));
    }
    if (category === 'financial') catalysts.push(insight('Scheduled financial disclosure', 'Financial statements are an analysis catalyst because they can update margin, cash-flow, and growth assumptions.', 'low', 'monitor', evidence));
    if (category === 'correction') risks.push(insight('Correction filing', 'Correction filings should be compared with the original disclosure to confirm whether the change alters material assumptions.', 'medium', 'monitor', evidence));
  }
}

function appendFredInsights(series: FredSeriesSnapshot[], bullCases: MarketContextInsight[], bearCases: MarketContextInsight[], risks: MarketContextInsight[], catalysts: MarketContextInsight[]): void {
  for (const item of series) {
    const evidence = [fredEvidence(item, 'Latest FRED observation included in macro context')];
    catalysts.push(insight('Macro data update', `${item.seriesId} latest observation can update demand, funding, or consumer backdrop assumptions.`, 'low', 'monitor', evidence));
    const value = numericValue(item.latestValue);
    if (/FEDFUNDS|DFF|SOFR/i.test(item.seriesId) && value !== undefined) {
      if (value >= 4) {
        risks.push(insight('High-rate macro pressure', 'Elevated policy/funding rates can pressure valuation multiples, financing cost, and discretionary demand.', 'medium', 'medium-term', evidence));
        bearCases.push(insight('Funding-cost bear case', 'High interest-rate context supports a bear-case watch on financing-sensitive growth assumptions.', 'medium', 'medium-term', evidence));
      } else if (value <= 2) {
        bullCases.push(insight('Low-rate macro support', 'Lower policy-rate context can support risk appetite, financing conditions, and demand assumptions.', 'low', 'medium-term', evidence));
      }
    }
    if (/CPI|PCE|INFLATION/i.test(item.seriesId)) risks.push(insight('Inflation monitor', 'Inflation-sensitive macro data can affect pricing power, cost assumptions, and consumer demand.', 'low', 'monitor', evidence));
    if (/UNRATE|PAYEMS/i.test(item.seriesId)) catalysts.push(insight('Labor-market signal', 'Labor-market data can update consumer demand and wage-cost assumptions.', 'low', 'monitor', evidence));
  }
}

function appendFinnhubInsights(symbol: string | undefined, profile: Record<string, unknown>, bullCases: MarketContextInsight[], catalysts: MarketContextInsight[]): void {
  const ticker = stringValue(profile.ticker) ?? symbol;
  const evidence = [finnhubEvidence(ticker, profile, 'Finnhub company profile included in market context')];
  catalysts.push(insight('Public market profile context', 'Ticker, exchange, industry, and market-cap profile help frame peer set and investor-facing positioning.', 'low', 'monitor', evidence));
  const marketCap = numericValue(profile.marketCapitalization);
  if (marketCap !== undefined && marketCap > 0) {
    bullCases.push(insight('Scale and market presence', 'Available public-market profile and market-cap data can support a scale/visibility bull-case framing when compared with peers.', marketCap >= 10000 ? 'medium' : 'low', 'monitor', evidence));
  }
}

function insight(signal: string, thesis: string, confidence: MarketContextInsightConfidence, horizon: MarketContextInsightHorizon, evidence: MarketContextEvidence[]): MarketContextInsight {
  return { signal, thesis, confidence, horizon, evidence };
}

function dartEvidence(filing: DartFiling, category: string, reason: string): MarketContextEvidence {
  return { provider: 'dart', title: filing.reportName, receiptNo: filing.receiptNo, receiptDate: filing.receiptDate, url: filing.url, category, reason };
}

function fredEvidence(item: FredSeriesSnapshot, reason: string): MarketContextEvidence {
  return { provider: 'fred', title: item.seriesId, seriesId: item.seriesId, latestValue: item.latestValue, latestDate: item.latestDate, reason };
}

function finnhubEvidence(symbol: string | undefined, profile: Record<string, unknown>, reason: string): MarketContextEvidence {
  return { provider: 'finnhub', title: symbol ?? stringValue(profile.name) ?? 'Finnhub profile', symbol, reason };
}

function categorizeFiling(reportName: string): string {
  if (/소송|횡령|배임|거래정지|상장폐지|불성실/i.test(reportName)) return 'risk';
  if (/단일판매|공급계약|계약체결|수주/i.test(reportName)) return 'contract';
  if (/영업\(잠정\)실적|잠정실적|공정공시|매출액|손익구조/i.test(reportName)) return 'performance';
  if (/유상증자|전환사채|신주인수권|증권신고서|사채권/i.test(reportName)) return 'capital';
  if (/사업보고서|분기보고서|반기보고서|감사보고서|재무제표/i.test(reportName)) return 'financial';
  if (/정정/i.test(reportName)) return 'correction';
  if (/주주총회|최대주주|임원|대표이사|합병|분할/i.test(reportName)) return 'governance';
  return 'other';
}

export function renderExternalMarketContextReport(report: ExternalMarketContextReport): string {
  const lines: string[] = [
    '# External Market Context',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Company: ${report.query.company ?? 'n/a'}`,
    `- DART corpCode: ${report.query.dartCorpCode ?? 'n/a'}`,
    `- Symbol: ${report.query.symbol ?? 'n/a'}`,
    `- Providers: ${report.query.providers.join(', ')}`,
    ''
  ];
  if (report.dart) appendDartSection(lines, report.dart, report.analysis?.companySnapshot);
  if (report.fred) appendFredSection(lines, report.fred);
  if (report.finnhub) appendFinnhubSection(lines, report.finnhub);
  if (report.analysis?.marketSnapshot) appendMarketContextSnapshotSection(lines, report.analysis.marketSnapshot);
  return redactSecrets(lines.join('\n'));
}

function appendDartSection(lines: string[], result: DartProviderResult, snapshot?: CompanySnapshot): void {
  lines.push('## DART filings', '', `- Status: ${result.status}`);
  if (result.error) lines.push(`- Error: ${result.error}`);
  if (result.warnings?.length) for (const warning of result.warnings) lines.push(`- Warning: ${warning}`);
  if (result.status === 'ok') lines.push(`- Filings analyzed: ${result.filings.length}`, `- Filings displayed: ${result.displayedFilings.length}`);
  lines.push('');
  for (const filing of result.displayedFilings) lines.push(`- ${filing.reportName} (${filing.receiptDate ?? 'n/a'}) — ${filing.receiptNo} (${filing.url})`);
  lines.push('');
  if (snapshot) {
    lines.push('### DART company analysis snapshot', '', `- ${snapshot.filingsAnalyzed} filings analyzed`, `- Categories: ${Object.entries(snapshot.categoryCounts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`, '');
    lines.push('**Risk signals**');
    if (snapshot.riskSignals.length === 0) lines.push('- none detected in fetched filings');
    for (const item of snapshot.riskSignals) lines.push(`- ${item.title} (${item.receiptNo ?? 'n/a'}): ${item.reason}`);
    lines.push('', '**Catalysts**');
    if (snapshot.catalysts.length === 0) lines.push('- none detected in fetched filings');
    for (const item of snapshot.catalysts) lines.push(`- ${item.title} (${item.receiptNo ?? 'n/a'}): ${item.reason}`);
    lines.push('');
  }
}

function appendFredSection(lines: string[], result: FredProviderResult): void {
  lines.push('## FRED macro series', '', `- Status: ${result.status}`);
  if (result.error) lines.push(`- Error: ${result.error}`);
  if (result.warnings?.length) for (const warning of result.warnings) lines.push(`- Warning: ${warning}`);
  for (const series of result.series) lines.push(`- ${series.seriesId}: ${series.latestValue ?? 'n/a'} (${series.latestDate ?? 'n/a'})`);
  lines.push('');
}

function appendFinnhubSection(lines: string[], result: FinnhubProviderResult): void {
  lines.push('## Finnhub company profile', '', `- Status: ${result.status}`);
  if (result.error) lines.push(`- Error: ${result.error}`);
  if (result.warnings?.length) for (const warning of result.warnings) lines.push(`- Warning: ${warning}`);
  if (result.profile) for (const key of ['name', 'ticker', 'exchange', 'marketCapitalization', 'finnhubIndustry']) if (result.profile[key] !== undefined) lines.push(`- ${key}: ${String(result.profile[key])}`);
  lines.push('');
}

function appendMarketContextSnapshotSection(lines: string[], snapshot: MarketContextSnapshot): void {
  lines.push('### MarketContextSnapshot', '', `- Schema: ${snapshot.schemaVersion}`, `- Subject: ${snapshot.subject.company ?? 'n/a'}${snapshot.subject.dartCorpCode ? ` / DART ${snapshot.subject.dartCorpCode}` : ''}${snapshot.subject.symbol ? ` / ${snapshot.subject.symbol}` : ''}`);
  if (snapshot.coverage.dart) lines.push(`- DART coverage: status=${snapshot.coverage.dart.status}, filings=${snapshot.coverage.dart.filingsAnalyzed}, displayed=${snapshot.coverage.dart.renderedFilings}, confidence=${snapshot.coverage.dart.confidence}`);
  if (snapshot.coverage.fred) lines.push(`- FRED coverage: status=${snapshot.coverage.fred.status}, series=${snapshot.coverage.fred.seriesAnalyzed}`);
  if (snapshot.coverage.finnhub) lines.push(`- Finnhub coverage: status=${snapshot.coverage.finnhub.status}, hasProfile=${snapshot.coverage.finnhub.hasProfile}`);
  lines.push('');
  appendInsightList(lines, '**Bull case**', snapshot.bullCases);
  appendInsightList(lines, '**Bear case**', snapshot.bearCases);
  appendInsightList(lines, '**Risks**', snapshot.risks);
  appendInsightList(lines, '**Catalysts**', snapshot.catalysts);
  lines.push('**Snapshot watchlist**');
  for (const item of snapshot.watchlist) lines.push(`- ${item}`);
  lines.push('', '**Snapshot follow-up questions**');
  for (const item of snapshot.followUpQuestions) lines.push(`- ${item}`);
  lines.push('');
}

function appendInsightList(lines: string[], title: string, insights: MarketContextInsight[]): void {
  lines.push(title);
  if (insights.length === 0) {
    lines.push('- none detected in fetched provider data', '');
    return;
  }
  for (const item of insights) {
    lines.push(`- ${item.signal} [${item.confidence}, ${item.horizon}]: ${item.thesis}`);
    lines.push(`  - Evidence: ${item.evidence.map(formatEvidence).join('; ')}`);
  }
  lines.push('');
}

function formatEvidence(evidence: MarketContextEvidence): string {
  if (evidence.provider === 'dart') return `DART: ${evidence.title}${evidence.receiptNo ? ` (${evidence.receiptNo})` : ''}`;
  if (evidence.provider === 'fred') return `FRED: ${evidence.seriesId ?? evidence.title}${evidence.latestValue ? `=${evidence.latestValue}` : ''}`;
  return `Finnhub: ${evidence.symbol ?? evidence.title}`;
}

function normalizeDartFiling(value: unknown): DartFiling | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const receiptNo = stringValue(row.rcept_no);
  const reportName = stringValue(row.report_nm);
  const corpName = stringValue(row.corp_name) ?? '';
  if (!receiptNo || !reportName) return undefined;
  return {
    corpName,
    receiptNo,
    reportName,
    filerName: stringValue(row.flr_nm),
    receiptDate: stringValue(row.rcept_dt),
    remark: stringValue(row.rm),
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(receiptNo)}`
  };
}

async function fetchJsonWithTimeout(url: URL): Promise<{ response: Response; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const json = await response.json() as Record<string, unknown>;
    return { response, json };
  } finally {
    clearTimeout(timeout);
  }
}

function selectFredSeries(value: string[] | undefined): { series: string[]; warnings: string[] } {
  const normalized = normalizeStringList(value);
  const requested = normalized.length > 0 ? normalized : DEFAULT_FRED_SERIES;
  const series = requested.slice(0, MAX_FRED_SERIES);
  const warnings = requested.length > MAX_FRED_SERIES
    ? [`FRED series list truncated to ${MAX_FRED_SERIES} entries`]
    : [];
  return { series, warnings };
}

function hasObjectData(value: Record<string, unknown>): boolean {
  return Object.values(value).some((item) => item !== undefined && item !== null && String(item).trim().length > 0);
}

function normalizeProviders(value: ExternalMarketProvider[] | undefined): ExternalMarketProvider[] {
  if (!value || value.length === 0) return ['dart', 'fred', 'finnhub'];
  const providers: ExternalMarketProvider[] = [];
  for (const provider of value) {
    if (!ALLOWED_PROVIDERS.has(provider)) throw new Error('Invalid providers: expected dart, fred, or finnhub');
    if (!providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

function normalizeStringList(value: string[] | undefined): string[] {
  return Array.from(new Set((value ?? []).map((item) => item.trim()).filter(Boolean)));
}

function dartConfidence(report: ExternalMarketContextReport): MarketContextDartConfidence {
  if (!report.dart) return 'unavailable';
  if (report.dart.status === 'error') return 'provider-error';
  if (report.dart.status === 'skipped') return 'provider-skipped';
  if (report.query.dartCorpCode) return 'exact-corp-code';
  if (report.query.company) return 'company-name-fallback';
  return 'unavailable';
}

function optionalTrimmed(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeProviderError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function redactSecrets(input: string): string {
  let output = input;
  for (const value of [process.env.DART_API_KEY, process.env.FRED_API_KEY, process.env.FINNHUB_API_KEY]) {
    if (value && value.length > 0) output = output.split(value).join('[REDACTED]');
  }
  return output.replace(/([?&](?:crtfc_key|api_key|token)=)[^&\s)]+/gi, '$1[REDACTED]');
}
