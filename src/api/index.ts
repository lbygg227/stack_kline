import type {
  AiStrategyResponse,
  BacktestConfig,
  BacktestResult,
  BatchAnalysisResponse,
  KLineBar,
  OpinionDocument,
  OpinionPlatform,
  OpinionSubscription,
  PrefetchProgress,
  Quote,
  SnapshotResponse,
  StockAnalysisResult,
  StockInfo,
  StrategyConditions,
  StrategyDefinition,
  StrategyResult,
  TunnelInfo,
  UpdateStatus,
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
