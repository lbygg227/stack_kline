/** K 线单根数据（klinecharts KLineData 兼容） */
export interface KLineBar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
  [key: string]: unknown
}

/** 股票/指数基础信息（code 为带市场前缀，如 sh600519） */
export interface StockInfo {
  code: string
  market: 'sh' | 'sz'
  name: string
  type?: string // gp_a A股 / zs 指数 等（腾讯类型码）
}

/** 买卖一档 */
export interface BidAsk {
  price: number
  volume: number // 手
}

/** 实时报价（腾讯 qt 接口解析结果） */
export interface Quote {
  code: string
  name: string
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  change: number
  changePct: number
  volume: number // 手
  amount: number // 万元
  turnover: number // 换手率 %
  amplitude: number // 振幅 %
  volumeRatio: number // 量比
  pe: number
  pb: number
  mktCapFloat: number // 流通市值 亿
  mktCapTotal: number // 总市值 亿
  upLimit: number
  downLimit: number
  bids: BidAsk[]
  asks: BidAsk[]
  time: string // YYYYMMDDHHMMSS
}

/** 周期定义 */
export interface PeriodSpec {
  key: 'm1' | 'm5' | 'm15' | 'm30' | 'm60' | 'day' | 'week' | 'month'
  label: string
  multiplier: number
  timespan: 'minute' | 'day' | 'week' | 'month'
  count: number // 请求 K 线根数
}

export const PERIODS: PeriodSpec[] = [
  { key: 'm1', label: '分时', multiplier: 1, timespan: 'minute', count: 240 },
  { key: 'm5', label: '5分', multiplier: 5, timespan: 'minute', count: 240 },
  { key: 'm15', label: '15分', multiplier: 15, timespan: 'minute', count: 240 },
  { key: 'm30', label: '30分', multiplier: 30, timespan: 'minute', count: 240 },
  { key: 'm60', label: '60分', multiplier: 60, timespan: 'minute', count: 240 },
  { key: 'day', label: '日K', multiplier: 1, timespan: 'day', count: 420 },
  { key: 'week', label: '周K', multiplier: 1, timespan: 'week', count: 320 },
  { key: 'month', label: '月K', multiplier: 1, timespan: 'month', count: 240 },
]

export const periodByKey = (key: string): PeriodSpec =>
  PERIODS.find((p) => p.key === key) ?? PERIODS[5]

/** 全市场快照单条（东方财富接口，服务端落盘） */
export interface SnapshotStock {
  code: string
  name: string
  price: number
  change: number
  changePct: number
  open: number
  high: number
  low: number
  prevClose: number
  volume: number // 手
  amount: number // 元
  turnover: number // %
  volumeRatio: number // 量比
  pe: number
  pb: number
  mktcap: number // 万元
  nmc: number // 万元
  industry?: string // 申万一级行业（服务端合并）
}

export interface SnapshotResponse {
  status: 'ready' | 'fetching' | 'refreshing'
  fetchedAt?: number
  count?: number
  stocks?: SnapshotStock[]
  progress?: { page: number; count: number }
}

export interface PrefetchProgress {
  running: boolean
  done: number
  total: number
  failed: number
}

export interface StrategyConditions {
  minChangePct?: number
  maxChangePct?: number
  minTurnover?: number
  maxTurnover?: number
  minVolumeRatio?: number
  maxVolumeRatio?: number
  minPe?: number
  maxPe?: number
  minMktcap?: number // 亿
  maxMktcap?: number // 亿
  minAmount?: number // 亿
  maxAmount?: number // 亿
  minPrice?: number
  maxPrice?: number
  industry?: string // 申万一级行业（空=不限）
  pool: 'all' | 'watchlist'
  watchlist: string[]
  /** 常见策略（多选，取交集） */
  strategies?: string[]
  indicator: string
}

export interface StrategyResult {
  code: string
  name: string
  price: number
  changePct: number
  reason: string
  extra: Record<string, number>
  strategies?: string[]
}

export interface AiStrategyResponse {
  conditions: StrategyConditions
  explanation: string
  results: StrategyResult[]
}

export interface AnalysisDimension {
  key: string
  name: string
  score: number
  max: number
  detail: string
  tone: 'bullish' | 'bearish' | 'neutral'
}

export interface AnalysisTrend {
  status: string
  alignment: string
  trendStrength: number
  ma5: number
  ma10: number
  ma20: number
  ma60: number
  biasMa5: number
  biasMa10: number
  biasMa20: number
}

export interface AnalysisMacd {
  dif: number
  dea: number
  bar: number
  status: string
  signal: string
}

export interface AnalysisRsi {
  rsi6: number
  rsi12: number
  rsi24: number
  status: string
  signal: string
}

export interface AnalysisVolume {
  ratio5d: number
  status: string
  meaning: string
}

export interface AnalysisLevels {
  support: number[]
  resistance: number[]
  stopLoss: number
  target: number
}

export interface AiCommentary {
  oneSentence: string
  commentary: string
  confidence: string
  model?: string
}

export interface StockAnalysisResult {
  code: string
  name: string
  price: number
  changePct: number
  score: number
  signalKey: 'strong_buy' | 'buy' | 'watch' | 'reduce' | 'sell' | 'unknown'
  signalLabel: string
  summary: string
  dimensions: AnalysisDimension[]
  trend: AnalysisTrend
  macd: AnalysisMacd
  rsi: AnalysisRsi
  volume: AnalysisVolume
  levels: AnalysisLevels
  reasons: string[]
  risks: string[]
  dataQuality: 'full' | 'partial' | 'insufficient'
  disclaimer: string
  ai?: AiCommentary | null
}

export interface TunnelInfo {
  phase: 'stopped' | 'starting' | 'running' | 'failed'
  url?: string
  error?: string
}

export interface UpdatePlanStatus {
  key: string
  label: string
  time: string
  done: boolean
}

export interface UpdateStatus {
  running: boolean
  lastRun: number
  lastResult: string
  today: string
  isTradingDay: boolean
  plan: UpdatePlanStatus[]
}
