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
  expectedDate?: string
  checkedAt: number
  klines: Array<{
    code: string
    period: string
    bars: number
    firstDate?: string
    lastDate?: string
    fetchedAt?: number
    adjust: 'forward'
    status: 'current' | 'stale' | 'missing'
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

export interface LatestKlineSyncResult {
  expectedDate?: string
  checkedAt: number
  summary: {
    total: number
    current: number
    synced: number
    unavailable: number
    failed: number
  }
  items: Array<{
    code: string
    status: 'current' | 'synced' | 'unavailable' | 'failed'
    lastDateBefore?: string
    lastDateAfter?: string
    barsAdded: number
    error?: string
  }>
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

export interface StrategyProgress {
  running: boolean
  phase: 'idle' | 'preparing' | 'ai' | 'screening' | 'done'
  done: number
  total: number
  hits: number
  message: string
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
  minPb?: number
  maxPb?: number
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
  /** 近 N 日须有一级资讯事件（代码或行业命中） */
  requireRecentEvent?: boolean
  eventLookbackDays?: number
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
  lastNotice?: string
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
    type: 'research' | 'opinion' | 'event'
    timestamp: number
    title: string
    summary: string
    stance: ResearchStance
    recordId?: string
    version?: number
    author?: string
    sourceUrl?: string
    eventKind?: MarketEventKind
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

export interface FundFlowDay {
  date: string
  mainNet: number
  smallNet: number
  midNet: number
  bigNet: number
  superBigNet: number
}

export interface FundFlowResult {
  code: string
  name: string
  days: FundFlowDay[]
  fromCache?: boolean
  updatedAt?: number
}

export type MarketEventKind = 'announcement' | 'regulatory' | 'news'

export interface MarketEvent {
  id: string
  title: string
  url: string
  snippet: string
  source?: string
  provider: string
  query: string
  publishedAt: number
  capturedAt: number
  kind: MarketEventKind
  strength: number
  codes: string[]
  names: string[]
  industries: string[]
  opinionCount?: number
}

export interface EventOpinionLink {
  documentId: string
  authorName: string
  platform: string
  title: string
  publishedAt: number
  url: string
  stance: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  thesis: string
  code?: string
  name?: string
  industry?: string
}

export interface MarketEventDetail extends MarketEvent {
  opinions: EventOpinionLink[]
}

export interface MarketEventListResponse {
  events: MarketEvent[]
  lastCollectAt?: number
  lastProvider?: string
  total: number
}

export interface MarketEventCollectResult {
  created: number
  total: number
  queries: number
  provider: string
  message?: string
}

export type EventRecoSource = 'direct' | 'proxy'

export interface EventStockRecoItem {
  code: string
  name: string
  industry?: string
  score: number
  source: EventRecoSource
  eventCount: number
  relatedEventIds: string[]
  headlines: string[]
  reason: string
  price?: number
  changePct?: number
}

export interface EventStockRecoResponse {
  items: EventStockRecoItem[]
  days: number
  total: number
}

export interface Jin10FlashItem {
  title?: string
  content: string
  time: string
  url: string
}

export interface Jin10CalendarItem {
  name?: string
  country?: string
  time?: string
  actual?: string
  forecast?: string
  previous?: string
  importance?: number | string
  [key: string]: unknown
}

export type CandidateStatus = 'observe' | 'hold' | 'reject'
export type CandidateSource = 'strategy' | 'fusion' | 'event' | 'opinion' | 'industry' | 'fund' | 'dragon' | 'guard' | 'manual'

export interface CandidateContext {
  reason?: string
  strategies?: string[]
  fusionScore?: number
  recommendation?: 'recommend' | 'observe' | 'avoid'
  authors?: string[]
  eventId?: string
  eventTitle?: string
  conditionsSummary?: string
  industry?: string
  note?: string
}

export interface SustainabilitySnapshot {
  score: number
  grade: 'track' | 'cautious' | 'reject'
  technical: number
  event: number
  opinion: number
  industryScore: number
  reasons: string[]
  risks: string[]
  vetoes: string[]
  generatedAt: number
}

export interface WatchCandidate {
  code: string
  name: string
  industry?: string
  status: CandidateStatus
  sources: CandidateSource[]
  context: CandidateContext
  sustainability?: SustainabilitySnapshot
  createdAt: number
  updatedAt: number
}

export interface SustainabilityReport extends SustainabilitySnapshot {
  code: string
  name: string
  industry?: string
  analysis?: {
    score: number
    signalKey: string
    signalLabel: string
    summary: string
    reasons: string[]
    risks: string[]
  }
  opinionSignal?: {
    score: number
    stance: 'bullish' | 'bearish' | 'neutral'
    confidence: number
    agreement: number
    authors: string[]
    claimCount: number
  } | null
  events: Array<{
    id: string
    title: string
    kind: MarketEventKind
    strength: number
    publishedAt: number
  }>
  industryChangePct?: number
}

export interface CandidateReviewStats {
  total: number
  byStatus: Record<CandidateStatus, number>
  bySource: Record<string, number>
  withSustainability: number
  avgScore: number | null
}

export interface ScreenerSeed {
  industry?: string
  requireRecentEvent?: boolean
  eventLookbackDays?: number
  /** 打开选股页时切到观点驱动通道 */
  opinionDriven?: boolean
  opinionLookbackDays?: number
  note?: string
}

export interface OpinionStockRecoItem {
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
  theses: string[]
  risks: string[]
  reason: string
}

export interface OpinionStockRecoResponse {
  items: OpinionStockRecoItem[]
  days: number
  total: number
}

export interface FundStockRecoItem {
  code: string
  name: string
  industry?: string
  score: number
  mainNetSum: number
  mainNetToday: number
  consecutiveInflowDays: number
  positiveDays: number
  lookbackDays: number
  reason: string
  price?: number
  changePct?: number
}

export interface FundStockRecoResponse {
  items: FundStockRecoItem[]
  days: number
  total: number
  lastRefreshAt?: number
  poolSize: number
}

export interface FundFlowRefreshProgress {
  running: boolean
  done: number
  total: number
  failed: number
  message: string
  lastRefreshAt?: number
}

export interface FundFlowRankStatus {
  poolSize: number
  lastRefreshAt?: number
  lastError?: string
  updatedAt: number
  progress: FundFlowRefreshProgress
}

export type DragonTigerBoardType = 'all' | 'org' | 'hot_money'

export interface DragonTigerRecoItem {
  code: string
  name: string
  industry?: string
  score: number
  tradeDate: string
  boardType: DragonTigerBoardType
  netValue: number
  orgNetValue: number | null
  hotMoneyNetValue: number | null
  changePct: number | null
  limitReason?: string
  concepts: string[]
  reason: string
  occurrences?: number
  tradeDates?: string[]
}

export interface DragonTigerRecoResponse {
  items: DragonTigerRecoItem[]
  total: number
  tradeDate?: string
  boardType?: DragonTigerBoardType
  lastRefreshAt?: number
  poolSize: number
  configured: boolean
}

export interface DragonTigerRankStatus {
  configured: boolean
  poolSize: number
  tradeDate?: string
  boardType?: DragonTigerBoardType
  lastRefreshAt?: number
  lastError?: string
  updatedAt: number
}

export interface DragonTigerCacheEntry {
  code: string
  name: string
  industry?: string
  tradeDate: string
  boardType: DragonTigerBoardType
  netValue: number
  buyValue: number
  sellValue: number
  orgNetValue: number | null
  hotMoneyNetValue: number | null
  change: number | null
  hotRank: number | null
  limitReason?: string
  concepts: string[]
  updatedAt: number
}

export type RecommendationStyle = 'trend' | 'limit_up' | 'pullback' | 'leader' | 'event' | 'fund' | 'opinion'
export type RecommendationChannel = 'technical' | 'event' | 'opinion' | 'fund' | 'dragon'

export interface RecommendationLevels {
  entry?: number
  target?: number
  stopLoss?: number
}

export interface RecommendationEvidence {
  technical?: string[]
  event?: string[]
  opinion?: string[]
  fund?: string[]
  dragon?: string[]
}

export interface RecommendationSource {
  documentId: string
  claimId: string
  authorName: string
  platform: string
  title: string
  url: string
  publishedAt: number
  stance: string
  confidence: number
  thesis: string
  evidenceQuote: string
}

export interface RecommendationVerification {
  score: number
  confirmations: string[]
  conflicts: string[]
}

export type ReasonDimension = 'fundamental' | 'technical' | 'fund' | 'dragon' | 'event' | 'opinion' | 'industry'

export interface RecommendationReason {
  dimension: ReasonDimension
  key: string
  label: string
  detail: string
  weight: number
  strength: number
  metrics: Record<string, number | string>
  expect: string
  sources?: Array<{ authorName: string; platform: string; title: string; url: string; publishedAt: number }>
}

export interface ReasonSummary {
  total: number
  byDimension: Record<string, number>
  topLabels: string[]
  reasonScore: number
}

export interface FundamentalProfile {
  industry?: string
  peTtm?: number
  peStatic?: number
  pb?: number
  roe?: number
  revenueYi?: number
  revenueYoy?: number
  netProfitYi?: number
  profitYoy?: number
  grossMargin?: number
  netMargin?: number
  debtRatio?: number
  mainNetInflowYi?: number
  mainNetInflowPct?: number
  mktcapYi?: number
  industryPeMedian?: number
  industryPePercentile?: number
  valuationLabel?: string
  growthLabel?: string
  qualityLabel?: string
  rating: 'strong' | 'neutral' | 'weak'
  bullets: string[]
}

export interface RecommendationRecord {
  id: string
  code: string
  name: string
  style: RecommendationStyle
  channels: RecommendationChannel[]
  thesis: string
  confidence: number
  score: number
  evidence: RecommendationEvidence
  levels: RecommendationLevels
  invalidIf: string[]
  horizonDays: number
  signalDate: string
  createdAt: number
  price?: number
  changePct?: number
  industry?: string
  sources?: RecommendationSource[]
  verification?: RecommendationVerification
  reasons?: RecommendationReason[]
  reasonSummary?: ReasonSummary
  fundamentals?: FundamentalProfile
  appliedWeights?: { style: number; dimension: number; targetFactor: number; confidenceScale: number }
  benchmark?: string
  guard?: GuardDecision
}

export interface MarketTemperature {
  avgChangePct: number
  upCount: number
  downCount: number
  limitUpCount: number
  limitDownCount: number
  totalAmountYi: number
  riskOff: boolean
  riskOn: boolean
}

export interface GuardDecision {
  status: 'recommend' | 'observe'
  coldReasons: string[]
  vetoes: string[]
  warnings: string[]
  note: string
}

export interface GuardedReason {
  dimension: string
  label: string
  samples: number
  excessHitRate: number
  averageExcessPct: number
}

export interface ReasonGuardState {
  version: number
  updatedAt: number
  minSamples: number
  penalized: GuardedReason[]
  trusted: GuardedReason[]
  penalizedDimensions: string[]
  trustedDimensions: string[]
}

export interface RecycledItem {
  code: string
  name: string
  previousNote: string
  currentNote: string
}

export interface RecommendationListResponse {
  generatedAt: number
  total: number
  items: RecommendationRecord[]
  grouped: Record<RecommendationStyle, RecommendationRecord[]>
  market?: MarketTemperature
  observing: RecommendationRecord[]
  recycled: RecycledItem[]
  staleObserving: Array<{ code: string; name: string; days: number; note: string }>
}

export interface PerfBucket {
  count: number
  winRate: number
  averageReturnPct: number
  averageExcessPct: number
}

export interface RecommendationOutcome {
  recommendationId: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  entryDate?: string
  exitDate?: string
  entryPrice?: number
  exitPrice?: number
  returnPct?: number
  maxGainPct?: number
  maxLossPct?: number
  benchmarkReturnPct?: number
  excessPct?: number
  daysToPeak?: number
  targetImpliedPct?: number
  hitTarget: boolean
  hitStop: boolean
  invalidated: boolean
  horizonDays: number
  confidence?: number
  score?: number
  reasonScore?: number
  verificationScore?: number
  reasons: Array<{ dimension: string; key: string; label: string; weight: number; strength: number }>
  dimensions: string[]
}

export interface RecommendationPerformanceStats {
  generatedAt: number
  totalRecords: number
  matured: number
  skipped: number
  winRate: number
  averageReturnPct: number
  averageExcessPct: number
  byStyle: Record<string, PerfBucket>
  byChannel: Record<string, PerfBucket>
  outcomes: RecommendationOutcome[]
}

export interface DimensionAttribution {
  dimension: string
  label: string
  samples: number
  directionHitRate: number
  excessHitRate: number
  averageReturnPct: number
  averageExcessPct: number
  averageMaxGainPct: number
  averageMaxLossPct: number
  verdict: '有效' | '一般' | '无效' | '样本不足'
}

export interface LabelAttribution {
  dimension: string
  label: string
  samples: number
  excessHitRate: number
  averageReturnPct: number
  averageExcessPct: number
  weight: number
}

export interface CalibrationBucket {
  bucket: string
  samples: number
  predictedWinRate: number
  actualWinRate: number
  gapPct: number
  averageReturnPct: number
}

export interface AttributionBias {
  samples: number
  averageTargetImpliedPct: number
  averageActualReturnPct: number
  targetGapPct: number
  targetHitRate: number
  stopHitRate: number
  averageMaxGainPct: number
  averageMaxLossPct: number
  averageDaysToPeak: number
  averageHorizonDays: number
  potentialGapPct: number
  calibration: CalibrationBucket[]
  expectedCalibrationError: number
  calibrationGapPct: number
}

export interface RecommendationAttribution {
  generatedAt: number
  stats: {
    totalRecords: number
    matured: number
    skipped: number
    winRate: number
    averageReturnPct: number
    averageExcessPct: number
  }
  byStyle: Record<string, PerfBucket>
  byChannel: Record<string, PerfBucket>
  byDimension: DimensionAttribution[]
  byLabel: LabelAttribution[]
  resonance: Array<{ dimensions: number; samples: number; winRate: number; excessHitRate: number; averageReturnPct: number; averageExcessPct: number }>
  bias: AttributionBias
  dimensionWeights: Record<string, number>
  targetFactor: number
  confidenceScale: number
  suggestions: string[]
  outcomes: Array<{
    code: string
    name: string
    style: string
    signalDate: string
    entryDate?: string
    exitDate?: string
    dimensions: string[]
    reasonLabels: string[]
    returnPct?: number
    excessPct?: number
    benchmarkReturnPct?: number
    targetImpliedPct?: number
    hitTarget: boolean
    hitStop: boolean
    confidence?: number
    reasonScore?: number
  }>
}

export interface StockHistoryItem {
  signalDate: string
  style: string
  channels: string[]
  confidence: number
  score: number
  thesis: string
  reasonLabels: string[]
  dimensions: string[]
  entryPrice?: number
  target?: number
  stopLoss?: number
  horizonDays: number
  settled: boolean
  returnPct?: number
  benchmarkReturnPct?: number
  excessPct?: number
  maxGainPct?: number
  maxLossPct?: number
  hitTarget: boolean
  hitStop: boolean
  daysToPeak?: number
}

export interface StockHistoryResponse {
  code: string
  name: string
  generatedAt: number
  stats: {
    total: number
    settled: number
    pending: number
    winRate: number
    averageReturnPct: number
    averageExcessPct: number
    hitTargetRate: number
    hitStopRate: number
  }
  verdict: string
  byDimension: Array<{ dimension: string; samples: number; excessHitRate: number; averageExcessPct: number }>
  items: StockHistoryItem[]
}

export interface DigestSection {
  title: string
  lines: string[]
}

export type SentimentPhase = '冰点' | '启动' | '发酵' | '高潮' | '退潮'

export interface LimitUpItem {
  code: string
  name: string
  industry?: string
  concepts: string[]
  price: number
  changePct: number
  amount: number
  turnover: number
  volumeRatio: number
  mainNetInflow: number
  limitRatio: number
  board: number
  firstSealAt?: string
  breakCount?: number
  recognition: number
  topSector?: string
  topSectorCount?: number
  isSectorLeader: boolean
}

export interface LimitUpSector {
  key: string
  type: 'industry' | 'concept'
  name: string
  limitUpCount: number
  maxBoard: number
  avgChangePct: number
  totalAmount: number
  leaderCode: string
  leaderName: string
  members: string[]
}

export interface LimitUpSentiment {
  limitUpCount: number
  limitDownCount: number
  brokenCount: number
  brokenRate: number
  maxBoard: number
  promotionRate: number
  yesterdayPremium: number
  phase: SentimentPhase
  score: number
  reasons: string[]
}

export interface LimitUpBoard {
  date: string
  generatedAt: number
  limitUp: LimitUpItem[]
  limitDown: LimitUpItem[]
  broken: LimitUpItem[]
  ladder: Record<string, number>
  sectors: LimitUpSector[]
  sentiment: LimitUpSentiment
}

export interface BoardStat {
  bucket: string
  samples: number
  winRate: number
  averageNextPremium: number
  medianNextPremium: number
  p10: number
  p90: number
  averageNextChange: number
  nextChangeWinRate: number
  averageHold3: number
  averageHold3FromClose: number
}

export interface AuthorStat {
  authorName: string
  evaluated: number
  hitRate: number
  reliability: number
  averageDirectionalReturnPct: number
  averageDirectionalExcessPct?: number
}

export interface AuthorStatsFile {
  version: number
  updatedAt: number
  holdingDays: number
  benchmarkCode: string
  verifiedOnly: boolean
  authors: AuthorStat[]
}

export interface LimitUpPhasePoint {
  date: string
  phase: SentimentPhase
  score: number
  limitUpCount: number
  limitDownCount: number
  brokenCount: number
  brokenRate: number
  maxBoard: number
  yesterdayPremium: number
  promotionRate: number
  nextPremium: number
}

export interface LimitUpBacktest {
  generatedAt: number
  startDate: string
  endDate: string
  tradingDays: number
  universe: number
  overall: BoardStat
  byBoard: BoardStat[]
  byPhase: BoardStat[]
  executable: { overall: BoardStat; byBoard: BoardStat[]; byPhase: BoardStat[]; excluded: number }
  phaseSeries: LimitUpPhasePoint[]
  notes: string[]
  cached: boolean
}

export interface OpinionBackfillProgress {
  subscriptionId: string
  nickname: string
  platform: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  kind?: string
  page?: number
  fetched: number
  created: number
  analyzed: number
  failed: number
  error?: string
}

export interface OpinionBackfillState {
  version: number
  running: boolean
  active: boolean
  sinceDate: string
  kinds: Array<'answers' | 'articles' | 'pins'>
  startedAt: number
  finishedAt?: number
  totals: { fetched: number; created: number; analyzed: number; failed: number }
  progress: OpinionBackfillProgress[]
  recent: Array<{ at: number; text: string }>
  lastError?: string
  cancelRequested?: boolean
}

export type DigestChannel = 'none' | 'webhook' | 'serverchan' | 'dingtalk' | 'feishu' | 'wecom'

export interface DigestPushConfig {
  version: number
  updatedAt: number
  channel: DigestChannel
  target: string
  hasTarget?: boolean
  autoPush: boolean
  maxAttempts: number
  retryIntervalMinutes: number
  pending?: { date: string; attempts: number; nextAttemptAt: number; lastError?: string } | null
}

export interface DigestPushLogEntry {
  at: number
  date: string
  channel: string
  ok: boolean
  attempt: number
  error?: string
}

export interface DailyDigest {
  date: string
  generatedAt: number
  sections: DigestSection[]
  text: string
  stats: {
    recommendCount: number
    observeCount: number
    settledToday: number
    matured: number
    winRate: number
    averageReturnPct: number
    averageExcessPct: number
  }
  push: { pushed: boolean; channel?: string | null; error?: string; retryScheduled?: boolean }
}

export interface WeightAdjustment {
  at: number
  scope: 'style' | 'dimension' | 'target' | 'confidence'
  key: string
  from: number
  to: number
  samples: number
  reason: string
}

export interface RecommendationWeightState {
  version: number
  updatedAt: number
  weights: Record<string, number>
  dimensionWeights: Record<string, number>
  targetFactor: number
  confidenceScale: number
  adjustments: WeightAdjustment[]
}

export interface SimulationPosition {
  id: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  entryDate: string
  entryPrice: number
  shares: number
  cost: number
  horizonDays: number
  target?: number
  stopLoss?: number
  currentPrice: number
  marketValue: number
  returnPct: number
}

export interface SimulationTrade {
  id: string
  code: string
  name: string
  style: string
  signalDate: string
  entryDate: string
  entryPrice: number
  exitDate: string
  exitPrice: number
  shares: number
  returnPct: number
  pnl: number
  horizonDays: number
}

export interface SimulationSnapshot {
  initialCapital: number
  cash: number
  positionValue: number
  totalEquity: number
  totalReturnPct: number
  winRate: number
  trades: SimulationTrade[]
  positions: SimulationPosition[]
  equityCurve: Array<{ date: string; value: number }>
  updatedAt: number
}

export interface BacktestMetricRecord {
  strategyId: string
  style: string
  startDate: string
  endDate: string
  metrics: {
    trades: number
    winRate: number
    avgReturn: number
    maxDrawdown: number
    profitFactor: number
    excessReturn: number
  }
  passed: boolean
}

export type BacktestableStyle = 'trend' | 'limit_up' | 'pullback'

export interface StyleBacktestConfig {
  style: BacktestableStyle
  codes: string[]
  holdingDays: number
  startDate?: string
  endDate?: string
  benchmarkCode: string
  commissionRate: number
  stampDutyRate: number
  slippageBps: number
}

export interface StyleBacktestTrade {
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
}

export interface StyleBacktestMetrics {
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

export interface StyleBacktestResult {
  mode: 'style_event_study'
  style: BacktestableStyle
  config: StyleBacktestConfig
  metrics: StyleBacktestMetrics
  trades: StyleBacktestTrade[]
  equityCurve: Array<{ date: string; value: number }>
  skippedCodes: Array<{ code: string; reason: string }>
  warnings: string[]
}
