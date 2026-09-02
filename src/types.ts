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

export interface DataCoverageResponse {
  klines: Array<{
    code: string
    period: string
    bars: number
    firstDate?: string
    lastDate?: string
    fetchedAt?: number
    adjust: 'forward'
  }>
  pointInTimeSnapshots: Array<{
    capturedAt: number
    asOfDate: string
    file: string
    count: number
    fields: string[]
    source: 'tickflow+eastmoney'
  }>
  constraints: {
    klineAdjust: 'forward'
    fundamentalBacktestRequiresSnapshot: boolean
    unavailableHistorically: string[]
  }
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

export interface StrategyDefinition {
  key: string
  name: string
  description: string
  needsKline: boolean
  category: 'technical' | 'quant'
  version: number
  minBars: number
  backtestable?: boolean
  params: Array<{
    key: string
    label: string
    default: number
    min: number
    max: number
    step: number
    unit?: string
  }>
}

export interface BacktestConfig {
  strategyKeys: string[]
  strategyParams?: Record<string, Record<string, number>>
  codes: string[]
  holdingDays: number
  combineMode: 'all' | 'any'
  startDate?: string
  endDate?: string
  commissionRate: number
  stampDutyRate: number
  slippageBps: number
  benchmarkCode: string
}

export interface BacktestTrade {
  code: string
  signalDate: string
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  returnPct: number
  benchmarkReturnPct?: number
  excessReturnPct?: number
  maxFavorablePct: number
  maxAdversePct: number
  hitStrategies: string[]
}

export interface BacktestResult {
  mode: 'event_study'
  config: BacktestConfig
  strategyVersions: Record<string, number>
  metrics: {
    trades: number
    winRate: number
    averageReturnPct: number
    medianReturnPct: number
    cumulativeReturnPct: number
    maxDrawdownPct: number
    averageBenchmarkReturnPct?: number
    averageExcessReturnPct?: number
    approximateSharpe?: number
    averageMaxFavorablePct: number
    averageMaxAdversePct: number
  }
  trades: BacktestTrade[]
  equityCurve: Array<{ date: string; value: number }>
  skippedCodes: Array<{ code: string; reason: string }>
  warnings: string[]
}

export interface PortfolioBacktestConfig {
  strategyKeys: string[]
  strategyParams: Record<string, Record<string, number>>
  codes: string[]
  holdingDays: number
  combineMode: 'all' | 'any'
  startDate?: string
  endDate?: string
  initialCapital: number
  maxPositions: number
  positionSizePct: number
  commissionRate: number
  minCommission: number
  stampDutyRate: number
  slippageBps: number
  lotSize: number
  benchmarkCode: string
}

export interface PortfolioBacktestResult {
  mode: 'portfolio'
  config: PortfolioBacktestConfig
  metrics: {
    totalReturnPct: number
    annualizedReturnPct: number
    benchmarkReturnPct?: number
    excessReturnPct?: number
    maxDrawdownPct: number
    sharpe?: number
    trades: number
    winRate: number
    endingEquity: number
    cash: number
    openPositions: number
  }
  equityCurve: Array<{ date: string; equity: number; cash: number; positions: number; benchmark?: number }>
  trades: Array<{
    code: string
    signalDate: string
    entryDate: string
    plannedExitDate: string
    exitDate: string
    shares: number
    entryPrice: number
    exitPrice: number
    entryCost: number
    exitProceeds: number
    pnl: number
    returnPct: number
    holdingDays: number
    hitStrategies: string[]
  }>
  rejectedSignals: Record<'alreadyHeld' | 'positionLimit' | 'insufficientCash' | 'limitUp', number>
  warnings: string[]
}

export interface StrategyOptimizationConfig {
  strategyKey: string
  codes: string[]
  parameterRanges: Record<string, { min: number; max: number; step: number }>
  holdingDays: number
  splitRatio: number
  objective: 'averageExcess' | 'averageReturn' | 'winRate' | 'sharpe'
  minTrades: number
  benchmarkCode: string
  maxCombinations: number
}

export interface StrategyOptimizationTrial {
  parameters: Record<string, number>
  score: number
  trades: number
  winRate: number
  averageReturnPct: number
  averageExcessReturnPct?: number
  approximateSharpe?: number
}

export interface StrategyOptimizationResult {
  config: StrategyOptimizationConfig
  splitDate: string
  testStartDate: string
  combinations: number
  trials: StrategyOptimizationTrial[]
  bestParameters: Record<string, number>
  training: BacktestResult
  testing: BacktestResult
  degradationPct?: number
  warnings: string[]
}

export type OpinionPlatform = 'zhihu' | 'xueqiu'

export interface OpinionSubscription {
  id: string
  platform: OpinionPlatform
  platformUserId: string
  nickname: string
  profileUrl: string
  enabled: boolean
  intervalMinutes: number
  lastCheckedAt: number
  lastPostId?: string
  authStatus: 'ready' | 'missing' | 'expired' | 'error'
  lastError?: string
  collectionPolicyVersion?: number
  createdAt: number
  updatedAt: number
}

export interface OpinionSyncLog {
  id: string
  subscriptionId: string
  platform: OpinionPlatform
  authorName: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'failed'
  attempt: number
  fetched: number
  created: number
  changed: number
  analyzed: number
  failed: number
  error?: string
}

export interface OpinionClaim {
  id: string
  code?: string
  name?: string
  industry?: string
  stance: 'bullish' | 'bearish' | 'neutral'
  horizonDays: number
  thesis: string
  catalysts: string[]
  risks: string[]
  invalidation: string
  confidence: number
  evidenceQuote: string
}

export interface OpinionDocumentVersion {
  version: number
  capturedAt: number
  contentHash: string
  title: string
  content: string
}

export interface OpinionDocument {
  id: string
  subscriptionId?: string
  platform: OpinionPlatform
  platformPostId?: string
  authorId: string
  authorName: string
  profileUrl?: string
  url: string
  title: string
  content: string
  publishedAt: number
  capturedAt: number
  updatedAt: number
  contentHash: string
  versions: OpinionDocumentVersion[]
  status: 'pending' | 'analyzed' | 'failed'
  summary?: string
  claims: OpinionClaim[]
  analysisModel?: string
  analysisError?: string
  contentKind?: 'original' | 'commentary_repost' | 'manual'
  originalAuthor?: string
}

export interface OpinionSignalEvidence {
  documentId: string
  claimId: string
  authorName: string
  publishedAt: number
  stance: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  thesis: string
  evidenceQuote: string
}

export interface OpinionSignal {
  code: string
  name: string
  industry?: string
  score: number
  stance: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  agreement: number
  authors: string[]
  claimCount: number
  latestAt: number
  horizonDays: number
  theses: string[]
  risks: string[]
  evidence: OpinionSignalEvidence[]
}

export interface OpinionBacktestConfig {
  platform?: OpinionPlatform
  subscriptionId?: string
  startDate?: string
  endDate?: string
  holdingDays?: number
  benchmarkCode: string
}

export interface OpinionBacktestEvent {
  documentId: string
  claimId: string
  platform: OpinionPlatform
  authorName: string
  code: string
  name: string
  stance: 'bullish' | 'bearish'
  publishedAt: number
  signalDate: string
  entryDate: string
  exitDate: string
  holdingDays: number
  confidence: number
  forwardReturnPct: number
  benchmarkReturnPct?: number
  directionalReturnPct: number
  directionalExcessPct?: number
  correct: boolean
  thesis: string
}

export interface OpinionAuthorPerformance {
  authorName: string
  evaluated: number
  correct: number
  hitRate: number
  averageDirectionalReturnPct: number
  averageDirectionalExcessPct?: number
  reliability: number
}

export interface OpinionBacktestResult {
  mode: 'opinion_event_study'
  config: OpinionBacktestConfig
  metrics: {
    totalClaims: number
    evaluated: number
    skipped: number
    hitRate: number
    averageForwardReturnPct: number
    averageDirectionalReturnPct: number
    medianDirectionalReturnPct: number
    averageDirectionalExcessPct?: number
  }
  events: OpinionBacktestEvent[]
  authors: OpinionAuthorPerformance[]
  skipped: Array<{ documentId: string; claimId: string; reason: string }>
  warnings: string[]
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

export interface FusionResult {
  code: string
  name: string
  price: number
  changePct: number
  fusionScore: number
  technicalScore: number
  opinionScore?: number
  opinionConfidence?: number
  recommendation: 'recommend' | 'observe' | 'avoid'
  strategies: string[]
  authors: string[]
  reasons: string[]
  risks: string[]
}

export type ResearchStance = 'bullish' | 'bearish' | 'neutral'

export interface ResearchRevision {
  version: number
  createdAt: number
  contentHash: string
  title: string
  thesis: string
  stance: ResearchStance
  horizonDays: number
  targetPrice?: number
  stopLoss?: number
  catalysts: string[]
  risks: string[]
  tags: string[]
  snapshot?: Record<string, unknown>
}

export interface ResearchRecord {
  id: string
  code: string
  name: string
  source: 'manual' | 'analysis' | 'opinion' | 'fusion'
  createdAt: number
  updatedAt: number
  currentVersion: number
  revisions: ResearchRevision[]
}

export interface ResearchDossier {
  code: string
  records: ResearchRecord[]
  timeline: Array<{
    id: string
    type: 'research' | 'opinion'
    timestamp: number
    title: string
    summary: string
    stance: ResearchStance
    recordId?: string
    version?: number
    author?: string
    sourceUrl?: string
  }>
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

export interface NewsItem {
  title: string
  url: string
  snippet: string
  date?: string
  source?: string
}

export interface StockBriefAi {
  oneSentence: string
  commentary: string
  confidence: string
  risk: string
  model?: string
}

export interface BatchStrategyHit {
  key: string
  name: string
}

export interface BatchAnalysisItem {
  code: string
  name: string
  price?: number
  changePct?: number
  score?: number
  signalKey?: string
  signalLabel?: string
  summary?: string
  strategies?: BatchStrategyHit[]
  news?: NewsItem[]
  ai?: StockBriefAi
  error?: string
}

export interface BatchAnalysisResponse {
  items: BatchAnalysisItem[]
  newsProvider: string
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
