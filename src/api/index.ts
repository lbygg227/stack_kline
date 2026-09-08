import type {
  AiStrategyResponse,
  BacktestConfig,
  BacktestResult,
  BatchAnalysisResponse,
  DataCoverageResponse,
  FusionResult,
  KLineBar,
  LatestKlineSyncResult,
  MarketEventCollectResult,
  MarketEventDetail,
  MarketEventKind,
  MarketEventListResponse,
  EventStockRecoResponse,
  OpinionDocument,
  OpinionStockRecoResponse,
  FundFlowResult,
  FundFlowRankStatus,
  FundFlowRefreshProgress,
  FundStockRecoResponse,
  DragonTigerBoardType,
  DragonTigerCacheEntry,
  DragonTigerRankStatus,
  DragonTigerRecoResponse,
  OpinionBacktestConfig,
  OpinionBacktestResult,
  OpinionPlatform,
  OpinionSignal,
  OpinionSubscription,
  OpinionSyncLog,
  PortfolioBacktestConfig,
  PortfolioBacktestResult,
  PrefetchProgress,
  StrategyProgress,
  Quote,
  RecommendationListResponse,
  RecommendationPerformanceStats,
  StyleBacktestResult,
  ResearchDossier,
  ResearchRecord,
  ResearchStance,
  SnapshotResponse,
  StockAnalysisResult,
  StockInfo,
  StrategyConditions,
  StrategyDefinition,
  StrategyOptimizationConfig,
  StrategyOptimizationResult,
  StrategyResult,
  SustainabilityReport,
  TunnelInfo,
  UpdateStatus,
  WatchCandidate,
  CandidateReviewStats,
  CandidateStatus,
  CandidateSource,
  CandidateContext,
} from '../types'
import { searchLocal, stockNameOf } from '../data/stocks'
import { generateDailyBars, generateMinuteBars, generateQuote } from '../data/mock'
import { parseSearchText } from './tencent'

/** 日志打点：标记当前数据源，便于确认走的是真实接口还是模拟兜底 */
const logSource = (kind: string, code: string, source: 'real' | 'mock') => {
  if (import.meta.env.DEV) console.debug(`[行情] ${kind} ${code} -> ${source === 'real' ? '腾讯真实数据' : '模拟数据'}`)
}

export interface KlineRequest {
  code: string
  periodKey: string
  count?: number
  /** 向前翻页：返回 endDate 之前（更早）的 K 线 */
  endDate?: string
  /** 向后翻页：返回 startDate 之后（更新）的 K 线 */
  startDate?: string
}

export async function fetchKlineBars(req: KlineRequest): Promise<KLineBar[]> {
  const { code, periodKey, count = 320, endDate, startDate } = req
  const params = new URLSearchParams({ code, period: periodKey, count: String(count) })
  if (endDate) params.set('end', endDate)
  if (startDate) params.set('start', startDate)
  try {
    const res = await fetch(`/api/kline?${params.toString()}`)
    if (!res.ok) throw new Error(`kline http ${res.status}`)
    const json = (await res.json()) as { bars?: KLineBar[] }
    const bars = json.bars ?? []
    if (bars.length > 0) {
      logSource('K线', code, 'real')
      return bars
    }
    throw new Error('empty kline')
  } catch {
    logSource('K线', code, 'mock')
    if (periodKey.startsWith('m')) return generateMinuteBars(code, count)
    return generateDailyBars(code, count)
  }
}

export async function fetchDataCoverage(codes: string[], period = 'day'): Promise<DataCoverageResponse> {
  const params = new URLSearchParams({ codes: codes.join(','), period })
  const res = await fetch(`/api/data/coverage?${params}`)
  if (!res.ok) throw new Error(`data coverage http ${res.status}`)
  return await res.json()
}

export async function fetchFundFlow(code: string, days = 20): Promise<FundFlowResult> {
  const res = await fetch(`/api/data/fund-flow?code=${encodeURIComponent(code)}&days=${days}`)
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(error?.error ?? `fund-flow http ${res.status}`)
  }
  return (await res.json()) as FundFlowResult
}

export async function fetchFundStockReco(opts: {
  days?: number
  limit?: number
  minMainNet?: number
  minConsecutive?: number
  excludeDown?: number
} = {}): Promise<FundStockRecoResponse> {
  const params = new URLSearchParams()
  if (opts.days) params.set('days', String(opts.days))
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.minMainNet != null) params.set('minMainNet', String(opts.minMainNet))
  if (opts.minConsecutive != null) params.set('minConsecutive', String(opts.minConsecutive))
  if (opts.excludeDown != null) params.set('excludeDown', String(opts.excludeDown))
  const res = await fetch(`/api/fund/stock-reco?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `fund stock reco http ${res.status}`)
  }
  return (await res.json()) as FundStockRecoResponse
}

export async function fetchFundRankStatus(): Promise<FundFlowRankStatus> {
  const res = await fetch('/api/fund/status')
  if (!res.ok) throw new Error(`fund status http ${res.status}`)
  return (await res.json()) as FundFlowRankStatus
}

export async function refreshFundRank(opts: {
  watchlist?: string[]
  topAmount?: number
} = {}): Promise<{ refreshed: number; failed: number; poolSize: number; updatedAt: number }> {
  const res = await fetch('/api/fund/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...opts, wait: true }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `fund refresh http ${res.status}`)
  }
  return (await res.json()) as { refreshed: number; failed: number; poolSize: number; updatedAt: number }
}

export async function startFundRankRefresh(opts: {
  watchlist?: string[]
  topAmount?: number
} = {}): Promise<FundFlowRefreshProgress> {
  const res = await fetch('/api/fund/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `fund refresh http ${res.status}`)
  }
  return (await res.json()) as FundFlowRefreshProgress
}

export async function fetchDragonTigerStockReco(opts: {
  boardType?: DragonTigerBoardType
  prefer?: 'net' | 'org' | 'hot'
  limit?: number
  minNet?: number
  excludeDown?: number
} = {}): Promise<DragonTigerRecoResponse> {
  const params = new URLSearchParams()
  if (opts.boardType) params.set('boardType', opts.boardType)
  if (opts.prefer) params.set('prefer', opts.prefer)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.minNet != null) params.set('minNet', String(opts.minNet))
  if (opts.excludeDown != null) params.set('excludeDown', String(opts.excludeDown))
  const res = await fetch(`/api/dragon/stock-reco?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `dragon stock reco http ${res.status}`)
  }
  return (await res.json()) as DragonTigerRecoResponse
}

export async function fetchDragonTigerStatus(): Promise<DragonTigerRankStatus> {
  const res = await fetch('/api/dragon/status')
  if (!res.ok) throw new Error(`dragon status http ${res.status}`)
  return (await res.json()) as DragonTigerRankStatus
}

export async function refreshDragonTigerRank(opts: {
  date?: string
  boardType?: DragonTigerBoardType
} = {}): Promise<{
  refreshed: number
  tradeDate: string
  boardType: DragonTigerBoardType
  poolSize: number
  updatedAt: number
}> {
  const res = await fetch('/api/dragon/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `dragon refresh http ${res.status}`)
  }
  return (await res.json()) as {
    refreshed: number
    tradeDate: string
    boardType: DragonTigerBoardType
    poolSize: number
    updatedAt: number
  }
}

export async function fetchDragonTigerItem(code: string): Promise<DragonTigerCacheEntry | null> {
  const res = await fetch(`/api/dragon/item?code=${encodeURIComponent(code)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `dragon item http ${res.status}`)
  }
  return (await res.json()) as DragonTigerCacheEntry
}

export async function syncLatestDailyKlines(codes?: string[]): Promise<LatestKlineSyncResult> {
  const res = await fetch('/api/data/kline/sync-latest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(codes?.length ? { codes } : { scope: 'all' }),
  })
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(error?.error ?? `latest kline sync http ${res.status}`)
  }
  return await res.json()
}

/** 全市场快照（服务端缓存/抓取） */
export async function fetchSnapshot(force = false): Promise<SnapshotResponse> {
  const res = await fetch(`/api/snapshot${force ? '?force=1' : ''}`)
  if (!res.ok) throw new Error(`snapshot http ${res.status}`)
  return (await res.json()) as SnapshotResponse
}

/** 全量预取日 K 到本地缓存 */
export async function startPrefetch(period = 'day'): Promise<void> {
  await fetch(`/api/prefetch?period=${period}`)
}

export async function getPrefetchProgress(): Promise<PrefetchProgress> {
  const res = await fetch('/api/prefetch/progress')
  return (await res.json()) as PrefetchProgress
}

export async function getStrategyProgress(): Promise<StrategyProgress> {
  const res = await fetch('/api/strategy/progress')
  if (!res.ok) {
    return { running: false, phase: 'idle', done: 0, total: 0, hits: 0, message: '' }
  }
  return (await res.json()) as StrategyProgress
}

/** 运行选股策略 */
export async function runStrategy(conds: StrategyConditions): Promise<StrategyResult[]> {
  const res = await fetch('/api/strategy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(conds),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `strategy http ${res.status}`)
  }
  const json = (await res.json()) as { results: StrategyResult[] }
  return json.results ?? []
}

export async function runFusionScreen(
  conditions: StrategyConditions,
  opinion: {
    platform?: OpinionPlatform
    opinionRequired?: boolean
    minOpinionScore?: number
    technicalWeight?: number
    opinionWeight?: number
  },
): Promise<{ results: FusionResult[]; technicalCount: number; opinionSignalCount: number }> {
  const res = await fetch('/api/fusion/screen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conditions, opinion }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `fusion screen http ${res.status}`)
  }
  return await res.json()
}

/** 服务端统一策略目录，前端与 AI 使用同一份元数据 */
export async function fetchStrategyDefinitions(): Promise<StrategyDefinition[]> {
  const res = await fetch('/api/strategy-defs')
  if (!res.ok) throw new Error(`strategy definitions http ${res.status}`)
  const json = (await res.json()) as { strategies?: StrategyDefinition[] }
  return json.strategies ?? []
}

/** 运行固定持有期日线事件回测 */
export async function runBacktest(config: Partial<BacktestConfig>): Promise<BacktestResult> {
  const res = await fetch('/api/backtests/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `backtest http ${res.status}`)
  }
  return (await res.json()) as BacktestResult
}

export async function runPortfolioBacktest(
  config: Partial<PortfolioBacktestConfig>,
): Promise<PortfolioBacktestResult> {
  const res = await fetch('/api/backtests/portfolio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `portfolio backtest http ${res.status}`)
  }
  return await res.json()
}

export async function optimizeStrategy(
  config: Partial<StrategyOptimizationConfig>,
): Promise<StrategyOptimizationResult> {
  const res = await fetch('/api/backtests/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `strategy optimization http ${res.status}`)
  }
  return await res.json()
}

/** AI 选股：自然语言 -> 服务端 DeepSeek 解析 -> 策略引擎 */
export async function aiStrategy(text: string, watchlist: string[]): Promise<AiStrategyResponse> {
  const res = await fetch('/api/ai-strategy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, watchlist }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `ai http ${res.status}`)
  }
  return (await res.json()) as AiStrategyResponse
}

/** 个股分析（规则版，快速） */
export async function fetchAnalysis(code: string): Promise<StockAnalysisResult> {
  const res = await fetch(`/api/analysis?code=${encodeURIComponent(code)}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `analysis http ${res.status}`)
  }
  return (await res.json()) as StockAnalysisResult
}

export async function fetchResearchDossier(code: string): Promise<ResearchDossier> {
  const res = await fetch(`/api/research/dossier?code=${encodeURIComponent(code)}`)
  if (!res.ok) throw new Error(`research dossier http ${res.status}`)
  return await res.json()
}

export async function saveResearchRecord(input: {
  id?: string
  code: string
  name?: string
  source?: 'manual' | 'analysis' | 'opinion' | 'fusion'
  title?: string
  thesis: string
  stance?: ResearchStance
  horizonDays?: number
  targetPrice?: number
  stopLoss?: number
  catalysts?: string[]
  risks?: string[]
  tags?: string[]
  snapshot?: Record<string, unknown>
}): Promise<ResearchRecord> {
  const res = await fetch('/api/research/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `save research http ${res.status}`)
  return json
}

export async function deleteResearchRecord(id: string): Promise<void> {
  const res = await fetch(`/api/research/records?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete research http ${res.status}`)
}

export async function compareResearchRevisions(
  id: string,
  from: number,
  to: number,
): Promise<Array<{ field: string; before: unknown; after: unknown }>> {
  const params = new URLSearchParams({ id, from: String(from), to: String(to) })
  const res = await fetch(`/api/research/compare?${params}`)
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `compare research http ${res.status}`)
  return json.changes ?? []
}

/** 批量个股分析：技术指标 + 策略命中 + 舆情新闻 + 可选 AI 简报 */
export async function fetchBatchAnalysis(codes: string[], withNews = true, withAi = false): Promise<BatchAnalysisResponse> {
  const res = await fetch('/api/analysis/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes, withNews, withAi }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `batch analysis http ${res.status}`)
  }
  return (await res.json()) as BatchAnalysisResponse
}

export async function fetchOpinionSubscriptions(platform?: OpinionPlatform): Promise<OpinionSubscription[]> {
  const query = platform ? `?platform=${platform}` : ''
  const res = await fetch(`/api/opinions/subscriptions${query}`)
  if (!res.ok) throw new Error(`opinion subscriptions http ${res.status}`)
  const json = (await res.json()) as { subscriptions?: OpinionSubscription[] }
  return json.subscriptions ?? []
}

export async function saveOpinionSubscription(
  subscription: Partial<OpinionSubscription> & { platform: OpinionPlatform },
): Promise<OpinionSubscription> {
  const editing = Boolean(subscription.id)
  const url = editing
    ? `/api/opinions/subscriptions/${encodeURIComponent(subscription.id!)}`
    : '/api/opinions/subscriptions'
  const res = await fetch(url, {
    method: editing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `save opinion subscription http ${res.status}`)
  }
  const json = (await res.json()) as { subscription: OpinionSubscription }
  return json.subscription
}

export async function deleteOpinionSubscription(id: string): Promise<void> {
  const res = await fetch(`/api/opinions/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete opinion subscription http ${res.status}`)
}

export async function fetchOpinionDocuments(
  filters: { platform?: OpinionPlatform; subscriptionId?: string; code?: string; limit?: number } = {},
): Promise<OpinionDocument[]> {
  const params = new URLSearchParams()
  if (filters.platform) params.set('platform', filters.platform)
  if (filters.subscriptionId) params.set('subscriptionId', filters.subscriptionId)
  if (filters.code) params.set('code', filters.code)
  if (filters.limit) params.set('limit', String(filters.limit))
  const query = params.size ? `?${params}` : ''
  const res = await fetch(`/api/opinions/feed${query}`)
  if (!res.ok) throw new Error(`opinion feed http ${res.status}`)
  const json = (await res.json()) as { documents?: OpinionDocument[] }
  return json.documents ?? []
}

export async function fetchOpinionSignals(
  platform?: OpinionPlatform,
  maxAgeDays = 180,
): Promise<OpinionSignal[]> {
  const params = new URLSearchParams({ maxAgeDays: String(maxAgeDays) })
  if (platform) params.set('platform', platform)
  const res = await fetch(`/api/opinions/signals?${params}`)
  if (!res.ok) throw new Error(`opinion signals http ${res.status}`)
  const json = (await res.json()) as { signals?: OpinionSignal[] }
  return json.signals ?? []
}

export async function fetchOpinionStockReco(opts: {
  days?: number
  limit?: number
  platform?: OpinionPlatform
  stance?: 'bullish' | 'bearish' | 'all'
} = {}): Promise<OpinionStockRecoResponse> {
  const params = new URLSearchParams()
  if (opts.days) params.set('days', String(opts.days))
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.platform) params.set('platform', opts.platform)
  if (opts.stance) params.set('stance', opts.stance)
  const res = await fetch(`/api/opinions/stock-reco?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `opinion stock reco http ${res.status}`)
  }
  return (await res.json()) as OpinionStockRecoResponse
}

export async function fetchOpinionSyncLogs(
  platform?: OpinionPlatform,
  limit = 20,
): Promise<OpinionSyncLog[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (platform) params.set('platform', platform)
  const res = await fetch(`/api/opinions/sync-logs?${params}`)
  if (!res.ok) throw new Error(`opinion sync logs http ${res.status}`)
  const json = (await res.json()) as { logs?: OpinionSyncLog[] }
  return json.logs ?? []
}

export async function runOpinionBacktest(
  config: Partial<OpinionBacktestConfig>,
): Promise<OpinionBacktestResult> {
  const res = await fetch('/api/opinions/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `opinion backtest http ${res.status}`)
  }
  return await res.json()
}

export async function ingestOpinionDocument(input: {
  platform: OpinionPlatform
  subscriptionId?: string
  authorId?: string
  authorName?: string
  url?: string
  title?: string
  content: string
  publishedAt?: number
  analyze?: boolean
}): Promise<OpinionDocument> {
  const res = await fetch('/api/opinions/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `opinion ingest http ${res.status}`)
  }
  const json = (await res.json()) as { document: OpinionDocument }
  return json.document
}

export async function analyzeOpinionDocument(id: string): Promise<OpinionDocument> {
  const res = await fetch('/api/opinions/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `opinion analyze http ${res.status}`)
  }
  const json = (await res.json()) as { document: OpinionDocument }
  return json.document
}

export async function syncOpinionSubscription(id: string): Promise<{
  fetched: number
  created: number
  changed: number
  analyzed: number
  failed: number
  activeTotal: number
  message?: string
}> {
  const res = await fetch('/api/opinions/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriptionId: id }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `opinion sync http ${res.status}`)
  }
  return await res.json()
}

/** 个股分析（AI 点评增强，较慢） */
export async function fetchAiAnalysis(code: string): Promise<StockAnalysisResult> {
  const res = await fetch('/api/analysis/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `ai analysis http ${res.status}`)
  }
  return (await res.json()) as StockAnalysisResult
}

/** 远程访问隧道状态（Cloudflare quick tunnel） */
export async function fetchTunnelInfo(): Promise<TunnelInfo> {
  try {
    const res = await fetch('/api/tunnel')
    if (!res.ok) throw new Error(`tunnel http ${res.status}`)
    return (await res.json()) as TunnelInfo
  } catch {
    return { phase: 'stopped' }
  }
}

/** 每日自动更新调度状态 */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const res = await fetch('/api/update/status')
  return (await res.json()) as UpdateStatus
}

/** 手动触发一次完整更新（快照 + 行业 + 日K预取） */
export async function runUpdate(): Promise<void> {
  await fetch('/api/update/run')
}

export async function fetchMarketEvents(filters: {
  days?: number
  kind?: MarketEventKind | ''
  industry?: string
  code?: string
  related?: boolean
  q?: string
  limit?: number
} = {}): Promise<MarketEventListResponse> {
  const params = new URLSearchParams()
  if (filters.days) params.set('days', String(filters.days))
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.industry) params.set('industry', filters.industry)
  if (filters.code) params.set('code', filters.code)
  if (filters.related) params.set('related', '1')
  if (filters.q) params.set('q', filters.q)
  if (filters.limit) params.set('limit', String(filters.limit))
  const res = await fetch(`/api/events?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `events http ${res.status}`)
  }
  return (await res.json()) as MarketEventListResponse
}

export async function fetchMarketEvent(id: string): Promise<MarketEventDetail> {
  const res = await fetch(`/api/events/${encodeURIComponent(id)}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `event http ${res.status}`)
  }
  const json = (await res.json()) as { event: MarketEventDetail }
  return json.event
}

export async function collectMarketEvents(watchlist: string[] = []): Promise<MarketEventCollectResult> {
  const res = await fetch('/api/events/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watchlist }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `events collect http ${res.status}`)
  }
  return (await res.json()) as MarketEventCollectResult
}

export async function fetchEventStockReco(opts: {
  days?: number
  limit?: number
  watchlist?: string[]
  kind?: MarketEventKind | ''
  industry?: string
} = {}): Promise<EventStockRecoResponse> {
  const params = new URLSearchParams()
  if (opts.days) params.set('days', String(opts.days))
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.watchlist?.length) params.set('watchlist', opts.watchlist.join(','))
  if (opts.kind) params.set('kind', opts.kind)
  if (opts.industry) params.set('industry', opts.industry)
  const res = await fetch(`/api/events/stock-reco?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `event stock reco http ${res.status}`)
  }
  return (await res.json()) as EventStockRecoResponse
}

export async function fetchJin10Status(): Promise<{ configured: boolean }> {
  const res = await fetch('/api/jin10/status')
  if (!res.ok) throw new Error(`jin10 status http ${res.status}`)
  return (await res.json()) as { configured: boolean }
}

export async function fetchJin10Flash(opts: { q?: string; cursor?: string } = {}): Promise<{
  items: Array<{ title?: string; content: string; time: string; url: string }>
  hasMore?: boolean
  cursor?: string
  provider: string
}> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.cursor) params.set('cursor', opts.cursor)
  const res = await fetch(`/api/jin10/flash?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `jin10 flash http ${res.status}`)
  }
  return (await res.json()) as {
    items: Array<{ title?: string; content: string; time: string; url: string }>
    hasMore?: boolean
    cursor?: string
    provider: string
  }
}

export async function fetchJin10Calendar(): Promise<{
  items: Array<Record<string, unknown>>
  provider: string
}> {
  const res = await fetch('/api/jin10/calendar')
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `jin10 calendar http ${res.status}`)
  }
  return (await res.json()) as { items: Array<Record<string, unknown>>; provider: string }
}

export async function fetchRecommendationPerformance(): Promise<RecommendationPerformanceStats> {
  const res = await fetch('/api/recommendations/performance')
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `recommendation performance http ${res.status}`)
  }
  return (await res.json()) as RecommendationPerformanceStats
}

export async function fetchRecommendations(): Promise<RecommendationListResponse> {
  const res = await fetch('/api/recommendations')
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `recommendations http ${res.status}`)
  }
  return (await res.json()) as RecommendationListResponse
}

export async function runStyleBacktest(payload: Record<string, unknown>): Promise<StyleBacktestResult> {
  const res = await fetch('/api/backtests/styles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `style backtest http ${res.status}`)
  }
  return (await res.json()) as StyleBacktestResult
}

export async function fetchWatchCandidates(status?: CandidateStatus): Promise<WatchCandidate[]> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  const res = await fetch(`/api/candidates?${params}`)
  if (!res.ok) throw new Error(`candidates http ${res.status}`)
  const json = (await res.json()) as { candidates: WatchCandidate[] }
  return json.candidates ?? []
}

export async function upsertWatchCandidate(body: {
  code: string
  name?: string
  industry?: string
  status?: CandidateStatus
  source?: CandidateSource
  sources?: CandidateSource[]
  context?: CandidateContext
}): Promise<WatchCandidate> {
  const res = await fetch('/api/candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `candidates upsert http ${res.status}`)
  }
  return (await res.json()) as WatchCandidate
}

export async function setWatchCandidateStatus(code: string, status: CandidateStatus): Promise<WatchCandidate> {
  const res = await fetch('/api/candidates/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, status }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `candidates status http ${res.status}`)
  }
  return (await res.json()) as WatchCandidate
}

export async function removeWatchCandidate(code: string): Promise<void> {
  const res = await fetch(`/api/candidates?code=${encodeURIComponent(code)}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `candidates delete http ${res.status}`)
  }
}

export async function fetchCandidateReviewStats(): Promise<CandidateReviewStats> {
  const res = await fetch('/api/candidates/review-stats')
  if (!res.ok) throw new Error(`candidates review http ${res.status}`)
  return (await res.json()) as CandidateReviewStats
}

export async function fetchSustainability(code: string, persist = true): Promise<SustainabilityReport> {
  const res = await fetch(`/api/sustainability?code=${encodeURIComponent(code)}&persist=${persist ? '1' : '0'}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `sustainability http ${res.status}`)
  }
  return (await res.json()) as SustainabilityReport
}

/** 拉取多只股票实时报价（服务端已合并 TickFlow/腾讯为统一 JSON） */
export async function fetchQuotes(codes: string[]): Promise<Quote[]> {
  if (codes.length === 0) return []
  try {
    const res = await fetch(`/api/quote?codes=${codes.join(',')}`)
    if (!res.ok) throw new Error(`quote http ${res.status}`)
    const json = (await res.json()) as { quotes?: Quote[] }
    const quotes = json.quotes ?? []
    if (quotes.length > 0) {
      logSource('报价', codes.join(','), 'real')
      return quotes
    }
    throw new Error('empty quote')
  } catch {
    logSource('报价', codes.join(','), 'mock')
    return codes.map((c) => generateQuote(c))
  }
}

/** 关键词搜索（全市场，腾讯智能搜索） */
export async function searchStocks(keyword: string): Promise<StockInfo[]> {
  const kw = keyword.trim()
  if (!kw) return []
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(kw)}`)
    if (!res.ok) throw new Error(`search http ${res.status}`)
    const text = await res.text()
    const list = parseSearchText(text)
    if (list.length > 0) {
      logSource('搜索', kw, 'real')
      return list
    }
    throw new Error('empty search')
  } catch {
    logSource('搜索', kw, 'mock')
    return searchLocal(kw)
  }
}

/** 供 K 线 DataLoader 使用的加载函数（适配 klinecharts v10） */
export async function loadBarsForChart(args: {
  code: string
  periodKey: string
  type: 'init' | 'forward' | 'backward' | 'update'
  timestamp: number | null
}): Promise<{ bars: KLineBar[]; more: { forward: boolean; backward: boolean } }> {
  const { code, periodKey, type } = args
  // TickFlow 一次拉全历史（日/周/月 500 根、分钟当日 240 根），无需分页加载
  if (type === 'init') {
    const bars = await fetchKlineBars({ code, periodKey })
    return { bars, more: { forward: false, backward: false } }
  }
  return { bars: [], more: { forward: false, backward: false } }
}

export const quoteDisplayName = (code: string, fallback: string) => stockNameOf(code) || fallback
