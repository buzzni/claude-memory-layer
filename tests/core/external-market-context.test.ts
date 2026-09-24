import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchExternalMarketContext,
  renderExternalMarketContextReport
} from '../../src/core/external-market-context.js';

const originalEnv = process.env;

function dartList(filings: Array<Record<string, string>>) {
  return { status: '000', message: '정상', list: filings, page_count: filings.length, total_count: filings.length };
}

function fredObservations(value: string) {
  return { observations: [{ date: '2026-05-01', value }] };
}

describe('external market context', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = {
      ...originalEnv,
      DART_API_KEY: 'dk',
      FRED_API_KEY: 'fk',
      FINNHUB_API_KEY: 'hk'
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('fails closed for invalid explicit core providers before network fetch', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called for invalid providers');
    }) as never;

    await expect(fetchExternalMarketContext({ providers: ['bogus'] as never })).rejects.toThrow('Invalid providers');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('skips missing provider keys without external fetches', async () => {
    process.env = {
      ...originalEnv,
      DART_API_KEY: '',
      FRED_API_KEY: '',
      FINNHUB_API_KEY: ''
    };
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called when all provider keys are missing');
    }) as never;

    const report = await fetchExternalMarketContext({
      company: '삼성전자',
      dartCorpCode: '00126380',
      symbol: '005930.KS',
      providers: ['dart', 'fred', 'finnhub']
    });

    expect(report.dart).toMatchObject({ status: 'skipped', warnings: ['DART_API_KEY is not set'] });
    expect(report.fred).toMatchObject({ status: 'skipped', warnings: ['FRED_API_KEY is not set'] });
    expect(report.finnhub).toMatchObject({ status: 'skipped', warnings: ['FINNHUB_API_KEY is not set'] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('treats DART status 013 as an empty successful filing result', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: '013', message: '조회된 데이타가 없습니다.' }), { status: 200 })) as never;

    const report = await fetchExternalMarketContext({
      company: '삼성전자',
      dartCorpCode: '00126380',
      providers: ['dart'],
      now: new Date('2026-05-06T00:00:00Z')
    });

    expect(report.dart).toMatchObject({ status: 'ok', filings: [], displayedFilings: [] });
    expect(report.analysis?.marketSnapshot?.coverage.dart).toMatchObject({
      status: 'ok',
      filingsAnalyzed: 0,
      renderedFilings: 0,
      confidence: 'exact-corp-code'
    });
  });

  it('adds abort signals to provider requests and caps large FRED series lists', async () => {
    const fetchSignals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignals.push(init?.signal);
      const url = String(input);
      if (url.includes('opendart.fss.or.kr')) return new Response(JSON.stringify(dartList([])), { status: 200 });
      if (url.includes('stlouisfed.org')) return new Response(JSON.stringify(fredObservations('5.25')), { status: 200 });
      if (url.includes('finnhub.io')) return new Response(JSON.stringify({ name: 'Samsung Electronics', ticker: '005930.KS' }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    }) as never;
    const fredSeries = Array.from({ length: 15 }, (_, index) => `SERIES${index}`);

    const report = await fetchExternalMarketContext({
      company: '삼성전자',
      dartCorpCode: '00126380',
      symbol: '005930.KS',
      providers: ['dart', 'fred', 'finnhub'],
      fredSeries
    });

    expect(report.query.fredSeries).toHaveLength(10);
    expect(report.fred?.series).toHaveLength(10);
    expect(report.fred?.warnings?.some((warning) => warning.includes('truncated to 10'))).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(12);
    expect(fetchSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('treats an empty Finnhub profile as skipped instead of emitting profile evidence', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as never;

    const report = await fetchExternalMarketContext({ symbol: 'NOPE', providers: ['finnhub'] });
    const snapshot = report.analysis?.marketSnapshot;

    expect(report.finnhub).toMatchObject({ status: 'skipped', warnings: ['Finnhub returned no profile data'] });
    expect(report.finnhub?.profile).toBeUndefined();
    expect(snapshot?.coverage.finnhub).toMatchObject({ status: 'skipped', hasProfile: false });
    expect(snapshot?.catalysts.some((item) => item.evidence.some((evidence) => evidence.provider === 'finnhub'))).toBe(false);
  });

  it('builds a structured multi-provider MarketContextSnapshot with bull, bear, risk, and catalyst evidence', async () => {
    const filings = [
      { corp_name: '삼성전자', rcept_no: '20260501000001', report_nm: '단일판매ㆍ공급계약체결', flr_nm: '삼성전자', rcept_dt: '20260501', rm: '' },
      { corp_name: '삼성전자', rcept_no: '20260502000002', report_nm: '영업(잠정)실적(공정공시)', flr_nm: '삼성전자', rcept_dt: '20260502', rm: '' },
      { corp_name: '삼성전자', rcept_no: '20260503000003', report_nm: '소송등의제기ㆍ신청(경영권분쟁소송)', flr_nm: '삼성전자', rcept_dt: '20260503', rm: '' },
      { corp_name: '삼성전자', rcept_no: '20260504000004', report_nm: '유상증자결정', flr_nm: '삼성전자', rcept_dt: '20260504', rm: '' }
    ];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('opendart.fss.or.kr')) return new Response(JSON.stringify(dartList(filings)), { status: 200 });
      if (url.includes('stlouisfed.org')) return new Response(JSON.stringify(fredObservations('5.25')), { status: 200 });
      if (url.includes('finnhub.io')) return new Response(JSON.stringify({ name: 'Samsung Electronics', ticker: '005930.KS', exchange: 'KRX', marketCapitalization: 450000, finnhubIndustry: 'Technology' }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    }) as never;

    const report = await fetchExternalMarketContext({
      company: '삼성전자',
      dartCorpCode: '00126380',
      symbol: '005930.KS',
      providers: ['dart', 'fred', 'finnhub'],
      fredSeries: ['FEDFUNDS'],
      now: new Date('2026-05-06T00:00:00Z')
    });

    const snapshot = report.analysis?.marketSnapshot;
    expect(snapshot).toMatchObject({
      schemaVersion: 'market-context-snapshot.v1',
      subject: { company: '삼성전자', dartCorpCode: '00126380', symbol: '005930.KS' },
      coverage: {
        dart: { status: 'ok', filingsAnalyzed: 4, renderedFilings: 4, confidence: 'exact-corp-code' },
        fred: { status: 'ok', seriesAnalyzed: 1 },
        finnhub: { status: 'ok', hasProfile: true }
      }
    });
    expect(snapshot?.bullCases.some((item) => item.evidence.some((evidence) => evidence.provider === 'dart' && evidence.receiptNo === '20260502000002'))).toBe(true);
    expect(snapshot?.bearCases.some((item) => item.evidence.some((evidence) => evidence.provider === 'dart' && evidence.receiptNo === '20260504000004'))).toBe(true);
    expect(snapshot?.risks.some((item) => item.evidence.some((evidence) => evidence.provider === 'dart' && evidence.receiptNo === '20260503000003'))).toBe(true);
    expect(snapshot?.catalysts.some((item) => item.evidence.some((evidence) => evidence.provider === 'dart' && evidence.receiptNo === '20260501000001'))).toBe(true);
    expect(snapshot?.risks.some((item) => item.evidence.some((evidence) => evidence.provider === 'fred' && evidence.seriesId === 'FEDFUNDS'))).toBe(true);
    expect(snapshot?.bullCases.some((item) => item.evidence.some((evidence) => evidence.provider === 'finnhub' && evidence.symbol === '005930.KS'))).toBe(true);
  });

  it('renders the structured MarketContextSnapshot analysis report with provider evidence', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('opendart.fss.or.kr')) return new Response(JSON.stringify(dartList([{ corp_name: '삼성전자', rcept_no: '20260501000001', report_nm: '단일판매ㆍ공급계약체결', flr_nm: '삼성전자', rcept_dt: '20260501', rm: '' }])), { status: 200 });
      if (url.includes('stlouisfed.org')) return new Response(JSON.stringify(fredObservations('5.25')), { status: 200 });
      return new Response(JSON.stringify({ name: 'Samsung Electronics', ticker: '005930.KS', marketCapitalization: 450000 }), { status: 200 });
    }) as never;

    const report = await fetchExternalMarketContext({ company: '삼성전자', dartCorpCode: '00126380', symbol: '005930.KS', providers: ['dart', 'fred', 'finnhub'], fredSeries: ['FEDFUNDS'] });
    const rendered = renderExternalMarketContextReport(report);

    expect(rendered).toContain('### MarketContextSnapshot');
    expect(rendered).toContain('**Bull case**');
    expect(rendered).toContain('**Bear case**');
    expect(rendered).toContain('**Risks**');
    expect(rendered).toContain('**Catalysts**');
    expect(rendered).toContain('DART: 단일판매ㆍ공급계약체결');
    expect(rendered).toContain('FRED: FEDFUNDS');
    expect(rendered).toContain('Finnhub: 005930.KS');
  });

  it('does not include analysis when includeSnapshot is false', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(dartList([])), { status: 200 })) as never;

    const report = await fetchExternalMarketContext({ company: '삼성전자', dartCorpCode: '00126380', providers: ['dart'], includeSnapshot: false });

    expect(report.analysis).toBeUndefined();
    expect(renderExternalMarketContextReport(report)).not.toContain('MarketContextSnapshot');
  });

  it('redacts credential-bearing provider errors in JSON and Markdown', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('failed URL https://opendart.fss.or.kr/api/list.json?crtfc_key=dk&corp_code=00126380');
    }) as never;

    const report = await fetchExternalMarketContext({ company: '삼성전자', dartCorpCode: '00126380', providers: ['dart'] });
    const rendered = renderExternalMarketContextReport(report);

    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain('dk');
    expect(JSON.stringify(report)).not.toContain('dk');
  });
});
