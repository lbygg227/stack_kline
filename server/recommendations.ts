/**
 * 统一推荐聚合器：把技术/事件/观点/资金/龙虎通道映射为统一 RecommendationRecord。
 * 当前为 P0 规则版：不调用 LLM，不实时拉取外部数据，基于既有缓存和快照聚合。
 */

import type { SnapshotStock } from './eastmoney.ts'
import { buildEventStockReco } from './event-stock-reco.ts'
import { buildOpinionStockReco } from './opinion-stock-reco.ts'
import { buildFundStockReco } from './fund-stock-reco.ts'
import { buildDragonTigerReco } from './dragon-tiger-stock-reco.ts'
import { buildIndustryStats } from './screening-strategies.ts'
import { PHASE_STYLE_MULTIPLIER, type LimitUpBoard, type SectorBoard } from './limit-up.ts'
import type { CapitalConsensus } from './capital-consensus.ts'
import { readJson, writeJson } from './store.ts'
import {
  getConfidenceScale,
  getDimensionWeights,
  getRecommendationWeights,
  getTargetFactor,
} from './recommendation-weights.ts'
import { buildFundamentalProfile, buildIndustryValuation, type FundamentalProfile } from './fundamentals.ts'
import { evaluateRecordGuard, getReasonGuard, type GuardDecision } from './recommendation-guard.ts'
import { reconcileObserving, trackBlocked, type RecycledItem } from './observe-recycle.ts'

export type { RecycledItem }
import {
  boardReasons,
  dedupeReasons,
  dragonReasons,
  eventReasons,
  fundReasons,
  fundamentalReasons,
  opinionReasons,
  summarizeReasons,
  technicalReasons,
  type ReasonSummary,
  type RecommendationReason,
} from './recommendation-reasons.ts'

export type RecommendationStyle =
  | 'trend'
  | 'limit_up'
  | 'pullback'
  | 'leader'
  | 'relay'
  | 'event'
  | 'fund'
  | 'opinion'
export type RecommendationChannel = 'technical' | 'event' | 'opinion' | 'fund' | 'dragon' | 'board'

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
  board?: string[]
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
  /** 结构化推荐理由：每条都带具体数值与事后验证口径 */
  reasons?: RecommendationReason[]
  reasonSummary?: ReasonSummary
  /** 推荐当时的基本面画像（估值/盈利/成长/质量/资金） */
  fundamentals?: FundamentalProfile
  /** 生成这条推荐时实际使用的权重，便于事后对账 */
  appliedWeights?: {
    style: number
    dimension: number
    targetFactor: number
    confidenceScale: number
  }
  /** 持有期起点基准，用于回测归因（跑赢大盘） */
  benchmark?: string
  /** 准入守卫结论：observe 表示有反向证据或冷理由占比过高，只进观察队列 */
  guard?: GuardDecision
  /** 涨停板上下文（连板高度/板块/封板质量/情绪相位） */
  board?: {
    height: number
    recognition: number
    isSectorLeader: boolean
    topSector?: string
    topSectorCount?: number
    firstSealAt?: string
    breakCount?: number
    phase?: string
    /** 资金共识分（三线合成分） */
    consensusScore?: number
    /** 命中的资金线数量 */
    consensusLines?: number
  }
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

export interface RecommendationListResponse {
  generatedAt: number
  total: number
  items: RecommendationRecord[]
  grouped: Record<RecommendationStyle, RecommendationRecord[]>
  market?: MarketTemperature
  /** 被守卫拦下、只做观察的标的（含拦截原因） */
  observing: RecommendationRecord[]
  /** 涨停板情绪相位（有数据时） */
  sentiment?: { phase: string; score: number; limitUpCount: number; limitDownCount: number; brokenRate: number; maxBoard: number; yesterdayPremium: number; promotionRate: number }
  /** 从观察名单回到推荐的标的（条件已改善） */
  recycled: RecycledItem[]
  /** 连续多日被拦、理由可能长期不成立的标的 */
  staleObserving: Array<{ code: string; name: string; days: number; note: string }>
}

export function computeMarketTemperature(stocks: SnapshotStock[]): MarketTemperature {
  let up = 0
  let down = 0
  let limitUp = 0
  let limitDown = 0
  let changeSum = 0
  let amountSum = 0
  for (const stock of stocks) {
    if (stock.changePct > 0) up += 1
    else if (stock.changePct < 0) down += 1
    if (stock.changePct >= 9.8) limitUp += 1
    if (stock.changePct <= -9.8) limitDown += 1
    changeSum += stock.changePct
    amountSum += stock.amount
  }
  const avgChangePct = stocks.length ? changeSum / stocks.length : 0
  const riskOff = avgChangePct < -1.2 || down > up * 1.4 || limitUp < 20
  const riskOn = avgChangePct > 1.2 && up > down * 1.2
  return {
    avgChangePct,
    upCount: up,
    downCount: down,
    limitUpCount: limitUp,
    limitDownCount: limitDown,
    totalAmountYi: amountSum / 1e12,
    riskOff,
    riskOn,
  }
}

const STYLE_KEYS: RecommendationStyle[] = ['trend', 'limit_up', 'pullback', 'leader', 'relay', 'event', 'fund', 'opinion']
const HISTORY_FILE = 'recommendation-history.json'
const RECORD_FILE = 'recommendation-records.json'

type RecommendationHistory = {
  version: 1
  lastRecommended: Record<string, string>
}

function loadHistory(): RecommendationHistory {
  const raw = readJson<RecommendationHistory>(HISTORY_FILE)
  if (!raw || raw.version !== 1 || !raw.lastRecommended) return { version: 1, lastRecommended: {} }
  return raw
}

function saveHistory(history: RecommendationHistory): void {
  writeJson(HISTORY_FILE, history)
}

type RecommendationRecordStore = {
  version: 1
  records: RecommendationRecord[]
}

function loadRecords(): RecommendationRecordStore {
  const raw = readJson<RecommendationRecordStore>(RECORD_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) return { version: 1, records: [] }
  return raw
}

function saveRecommendationRecords(records: RecommendationRecord[]): void {
  const prev = loadRecords().records
  const map = new Map<string, RecommendationRecord>()
  for (const record of prev) map.set(record.code + ':' + record.signalDate, record)
  for (const record of records) {
    const key = record.code + ':' + record.signalDate
    const old = map.get(key)
    // 同一天同一只股票：优先保留分数更高的；若旧记录缺少结构化理由（早期版本），则用新记录覆盖
    if (!old || record.score > old.score || (!old.reasons?.length && record.reasons?.length)) map.set(key, record)
  }
  const merged = [...map.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 2000)
  writeJson(RECORD_FILE, { version: 1, records: merged } satisfies RecommendationRecordStore)
}
const STYLE_LABEL: Record<RecommendationStyle, string> = {
  trend: '趋势',
  limit_up: '打板',
  pullback: '低吸',
  leader: '龙头',
  relay: '补涨',
  event: '事件',
  fund: '资金',
  opinion: '观点',
}

function clampScore(value: number): number {
  if (!isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function levelsFor(price?: number, style: RecommendationStyle = 'trend'): RecommendationLevels {
  if (!price || price <= 0) return {}
  if (style === 'limit_up') {
    return { entry: price, target: price * 1.05, stopLoss: price * 0.95 }
  }
  if (style === 'pullback') {
    return { entry: price, target: price * 1.06, stopLoss: price * 0.93 }
  }
  return { entry: price, target: price * 1.08, stopLoss: price * 0.94 }
}

function invalidFor(style: RecommendationStyle): string[] {
  switch (style) {
    case 'limit_up':
      return ['次日无法高开或快速炸板', '板块退潮、封单快速减少']
    case 'trend':
      return ['跌破5日均线', '放量滞涨或出现长上影']
    case 'pullback':
      return ['继续放量下跌', '跌破近期低点']
    case 'relay':
      return ['板块龙头炸板或跌停', '板块涨停家数快速萎缩']
    case 'leader':
      return ['失去行业领涨地位', '板块内出现更强卡位']
    case 'event':
      return ['事件被证伪', '题材热度快速退潮']
    case 'fund':
      return ['主力转为连续净流出', '净流入无法持续']
    case 'opinion':
      return ['共识转空', '核心逻辑被证伪']
  }
}

function horizonFor(style: RecommendationStyle): number {
  return style === 'limit_up' ? 3 : style === 'pullback' ? 3 : style === 'relay' ? 5 : style === 'event' ? 7 : style === 'opinion' ? 7 : 5
}

function computeVerification(item: RecommendationRecord, stock?: SnapshotStock): RecommendationVerification {
  const confirmations: string[] = []
  const conflicts: string[] = []
  // 打板/龙头/补涨看的不是「涨幅是否过大」，而是封板质量与板块梯队，判定口径需要区分
  const boardStyle = item.style === 'limit_up' || item.style === 'leader' || item.style === 'relay'
  if (item.channels.includes('technical')) confirmations.push('技术形态入选')
  if (item.channels.includes('fund')) confirmations.push('资金面同向')
  if (item.channels.includes('event')) confirmations.push('事件催化')
  if (item.channels.includes('dragon')) confirmations.push('龙虎榜确认')
  if (item.channels.includes('opinion')) confirmations.push('博主观点')
  if (item.channels.includes('board')) confirmations.push('涨停板通道入选')
  if (item.board) {
    const board = item.board
    if ((board.topSectorCount ?? 0) >= 3) {
      confirmations.push('板块梯队成立（' + (board.topSector ?? '') + ' ' + board.topSectorCount + ' 家涨停）')
    }
    if (board.firstSealAt && board.firstSealAt <= '10:00') confirmations.push('早盘封板（' + board.firstSealAt + '）')
    if (board.firstSealAt && board.firstSealAt >= '14:00') conflicts.push('尾盘才封板（' + board.firstSealAt + '），封板质量弱')
    if ((board.breakCount ?? 0) >= 3) conflicts.push('盘中反复炸板 ' + board.breakCount + ' 次')
    if (board.isSectorLeader && board.height >= 2) confirmations.push('板块龙头（' + board.height + ' 连板）')
    if (board.height >= 1 && board.height <= 3) confirmations.push('板位不高（' + board.height + ' 板），接力空间尚可')
    if (board.height >= 5) conflicts.push('已 ' + board.height + ' 连板，高位分歧风险')
    if (board.phase === '退潮') conflicts.push('情绪处于退潮期')
    if (board.phase === '高潮') conflicts.push('情绪高潮期，警惕次日分歧')
  }
  if (stock) {
    if (stock.changePct > 0 && stock.volumeRatio >= 1.2) confirmations.push('量价配合')
    if (stock.changePct < -3) conflicts.push('当日跌幅较大')
    if (stock.volumeRatio > 0 && stock.volumeRatio < 0.8) conflicts.push('量能不足')
    // 打板类标的本来就在涨停板上，不能用「涨幅过大」扣分
    if (stock.changePct >= 9.8 && !boardStyle) conflicts.push('短期涨幅过大')
    if (item.style === 'opinion' && stock.changePct < 0) conflicts.push('观点看多但价格走弱')
  }
  const score = Math.max(0, Math.min(100, 50 + confirmations.length * 12 - conflicts.length * 18))
  return { score, confirmations, conflicts }
}

function makeRecord(input: {
  id: string
  code: string
  name: string
  style: RecommendationStyle
  channel: RecommendationChannel
  thesis: string
  score: number
  evidence: string[]
  price?: number
  changePct?: number
  industry?: string
  createdAt?: number
  sources?: RecommendationSource[]
  verification?: RecommendationVerification
  reasons?: RecommendationReason[]
  board?: RecommendationRecord['board']
}): RecommendationRecord {
  const evidenceKey = input.channel === 'technical' ? 'technical' : input.channel === 'event' ? 'event' : input.channel === 'opinion' ? 'opinion' : input.channel === 'fund' ? 'fund' : 'dragon'
  const reasons = dedupeReasons(input.reasons ?? [])
  return {
    id: input.id,
    code: input.code.toLowerCase(),
    name: input.name,
    style: input.style,
    channels: [input.channel],
    thesis: input.thesis,
    confidence: clampScore(input.score),
    score: clampScore(input.score),
    evidence: { [evidenceKey]: input.evidence.slice(0, 4) } as RecommendationEvidence,
    levels: levelsFor(input.price, input.style),
    invalidIf: invalidFor(input.style),
    horizonDays: horizonFor(input.style),
    signalDate: new Date().toISOString().slice(0, 10),
    createdAt: input.createdAt ?? Date.now(),
    price: input.price,
    changePct: input.changePct,
    industry: input.industry,
    sources: input.sources,
    verification: input.verification,
    reasons: reasons.length ? reasons : undefined,
    reasonSummary: reasons.length ? summarizeReasons(reasons) : undefined,
    benchmark: 'sh000001',
    board: input.board,
  }
}

function buildTechnicalRecords(stocks: SnapshotStock[]): RecommendationRecord[] {
  const stats = buildIndustryStats(stocks)
  const candidates: Array<{ stock: SnapshotStock; style: RecommendationStyle; reason: string; rank: number }> = []
  for (const stock of stocks) {
    if (!stock.price || stock.price <= 0) continue
    const indStats = stats.get(stock.industry ?? '其他')
    if (stock.changePct >= 9.8 && stock.amount >= 1e8) {
      candidates.push({ stock, style: 'limit_up', reason: '涨停或接近涨停，成交活跃', rank: Math.abs(stock.changePct) })
    } else if (stock.changePct >= 5 && indStats?.topCodes.has(stock.code)) {
      candidates.push({ stock, style: 'leader', reason: '行业内涨幅领先，具备龙头特征', rank: stock.changePct })
    } else if (stock.changePct >= 3 && stock.volumeRatio >= 1.2 && stock.turnover >= 3) {
      candidates.push({ stock, style: 'trend', reason: '放量上涨，短线趋势较强', rank: stock.changePct })
    } else if (stock.changePct <= -2 && stock.changePct >= -7 && stock.turnover >= 2 && stock.pe > 0) {
      candidates.push({ stock, style: 'pullback', reason: '缩量回调后具备低吸观察价值', rank: Math.abs(stock.changePct) })
    }
  }

  const records: RecommendationRecord[] = []
  for (const { stock, style, reason } of candidates.sort((a, b) => b.rank - a.rank).slice(0, 60)) {
    records.push(makeRecord({
      id: 'technical:' + style + ':' + stock.code,
      code: stock.code,
      name: stock.name,
      style,
      channel: 'technical',
      thesis: STYLE_LABEL[style] + '：' + reason,
      score: Math.min(100, 55 + Math.abs(stock.changePct) * 3),
      evidence: [
        '涨跌幅 ' + stock.changePct.toFixed(2) + '%',
        '换手率 ' + stock.turnover.toFixed(2) + '%',
        '量比 ' + stock.volumeRatio.toFixed(2),
        '成交额 ' + (stock.amount / 1e8).toFixed(1) + '亿',
      ],
      price: stock.price,
      changePct: stock.changePct,
      industry: stock.industry,
      reasons: technicalReasons(stock, stats.get(stock.industry ?? '其他')),
    }))
  }
  return records
}

function buildEventRecords(stocks: SnapshotStock[]): RecommendationRecord[] {
  return buildEventStockReco({ stocks, days: 7, limit: 30 }).items.map((item) =>
    makeRecord({
      id: 'event:' + item.code,
      code: item.code,
      name: item.name,
      style: 'event',
      channel: 'event',
      thesis: item.reason,
      score: item.score,
      evidence: item.headlines.slice(0, 3),
      price: item.price,
      changePct: item.changePct,
      industry: item.industry,
      reasons: eventReasons({ headlines: item.headlines, eventCount: item.eventCount, source: item.source }),
    }),
  )
}

function buildOpinionRecords(stocks: SnapshotStock[]): RecommendationRecord[] {
  return buildOpinionStockReco({ stocks, days: 60, limit: 30, stance: 'bullish' }).items.map((item) =>
    makeRecord({
      id: 'opinion:' + item.code,
      code: item.code,
      name: item.name,
      style: 'opinion',
      channel: 'opinion',
      thesis: item.reason,
      score: Math.round(Math.abs(item.score) * item.confidence),
      evidence: item.theses.slice(0, 3),
      industry: item.industry,
      reasons: opinionReasons({
        authors: item.authors,
        claimCount: item.claimCount,
        agreement: item.agreement,
        confidence: item.confidence,
        theses: item.theses,
        risks: item.risks,
        sources: (item.sources ?? []).map((s) => ({
          authorName: s.authorName,
          platform: s.platform,
          title: s.title,
          url: s.url,
          publishedAt: s.publishedAt,
        })),
      }),
      sources: (item.sources ?? []).map((s) => ({
        documentId: s.documentId,
        claimId: s.claimId,
        authorName: s.authorName,
        platform: s.platform,
        title: s.title,
        url: s.url,
        publishedAt: s.publishedAt,
        stance: s.stance,
        confidence: s.confidence,
        thesis: s.thesis,
        evidenceQuote: s.evidenceQuote,
      })),
    }),
  )
}

function buildFundRecords(): RecommendationRecord[] {
  return buildFundStockReco({ days: 5, limit: 30 }).items.map((item) =>
    makeRecord({
      id: 'fund:' + item.code,
      code: item.code,
      name: item.name,
      style: 'fund',
      channel: 'fund',
      thesis: item.reason,
      score: item.score,
      evidence: ['近' + item.lookbackDays + '日主力净流入 ' + (item.mainNetSum / 1e8).toFixed(2) + '亿', '连续流入 ' + item.consecutiveInflowDays + ' 日'],
      price: item.price,
      changePct: item.changePct,
      industry: item.industry,
      reasons: fundReasons(item),
    }),
  )
}

/**
 * 涨停板通道：把「谁先涨停、谁连板、哪个板块成梯队」翻译成可推荐的标的。
 *   - leader  龙头：板块内辨识度第一且连板 >= 2
 *   - limit_up 打板：有板块效应（同板块 >= 3 家涨停）的首板 / 低板
 *   - relay   补涨：热点板块内尚未涨停、量价配合的二线
 */
function buildBoardRecords(
  stocks: SnapshotStock[],
  board: LimitUpBoard,
  consensus?: Map<string, CapitalConsensus>,
): RecommendationRecord[] {
  const records: RecommendationRecord[] = []
  const stockMap = new Map(stocks.map((stock) => [stock.code.toLowerCase(), stock]))
  const phase = board.sentiment.phase
  const sentimentBase = {
    sentimentPhase: phase,
    sentimentScore: board.sentiment.score,
  }

  for (const item of board.limitUp) {
    const stock = stockMap.get(item.code)
    if (!stock) continue
    const sectorTier = item.topSectorCount ?? 0
    const isLeader = item.isSectorLeader && item.board >= 2
    const hasSectorEffect = sectorTier >= 3
    if (!isLeader && !hasSectorEffect) continue
    if (item.board >= 6) continue // 6 板以上空间有限，交给观察名单
    const style: RecommendationStyle = isLeader ? 'leader' : 'limit_up'
    const agree = consensus?.get(item.code)
    const reasonText = (isLeader
      ? '板块龙头：' + item.board + ' 连板，' + (item.topSector ?? '') + ' 板块 ' + sectorTier + ' 家涨停'
      : '板块效应打板：' + (item.topSector ?? '') + ' 板块 ' + sectorTier + ' 家涨停，本股今日涨停') +
      (agree && agree.lineCount >= 2 ? '｜资金三线共振 ' + agree.lineCount + ' 条（共识分 ' + agree.score + '）' : '')
    records.push(makeRecord({
      id: 'board:' + style + ':' + item.code,
      code: item.code,
      name: item.name,
      style,
      channel: 'board',
      thesis: reasonText,
      // 共识分本身已含「广度」加成，这里直接取两者较大值，避免重复加成
      score: Math.max(45, Math.min(98, Math.round(Math.max(item.recognition, agree?.score ?? 0)))),
      evidence: [
        item.board > 1 ? item.board + ' 连板' : '首板',
        (item.firstSealAt ? item.firstSealAt + ' 封板' : '封板时间未知') + (item.breakCount ? '，炸板 ' + item.breakCount + ' 次' : ''),
        (item.topSector ?? '无板块') + ' 涨停 ' + sectorTier + ' 家',
        '成交额 ' + (item.amount / 1e8).toFixed(1) + '亿，换手 ' + item.turnover.toFixed(1) + '%',
      ],
      price: item.price,
      changePct: item.changePct,
      industry: item.industry,
      reasons: [
        ...boardReasons({
          board: item.board,
          isSectorLeader: item.isSectorLeader,
          topSector: item.topSector,
          topSectorCount: item.topSectorCount,
          firstSealAt: item.firstSealAt,
          breakCount: item.breakCount,
          recognition: item.recognition,
          sectorNames: item.concepts,
          ...sentimentBase,
        }),
        ...(agree && agree.lineCount >= 2 ? [consensusReason(agree)] : []),
      ],
      board: {
        height: item.board,
        recognition: item.recognition,
        isSectorLeader: item.isSectorLeader,
        topSector: item.topSector,
        topSectorCount: item.topSectorCount,
        firstSealAt: item.firstSealAt,
        breakCount: item.breakCount,
        phase,
        consensusScore: agree?.score,
        consensusLines: agree?.lineCount,
      },
    }))
  }

  // 补涨：热点板块（>= 3 家涨停）内未涨停、量价配合的跟随标的
  const hotSectors = board.sectors.filter((sector) => sector.limitUpCount >= 3)
  const used = new Set(records.map((record) => record.code))
  const limitUpCodes = new Set(board.limitUp.map((item) => item.code))
  const candidates = new Map<string, { stock: SnapshotStock; sector: SectorBoard }>()
  for (const sector of hotSectors) {
    for (const stock of stocks) {
      const code = stock.code.toLowerCase()
      if (limitUpCodes.has(code) || used.has(code)) continue
      if (stock.changePct < 1 || stock.changePct >= 9) continue
      if (stock.volumeRatio < 1.1 || stock.amount < 2e8 || stock.turnover < 2) continue
      const match = sector.type === 'industry'
        ? stock.industry === sector.name
        : (stock.concepts ?? []).includes(sector.name)
      if (!match) continue
      const existing = candidates.get(code)
      if (!existing || existing.sector.limitUpCount < sector.limitUpCount) candidates.set(code, { stock, sector })
    }
  }
  for (const { stock, sector } of [...candidates.values()]
    .sort((a, b) => b.sector.limitUpCount - a.sector.limitUpCount || b.stock.changePct - a.stock.changePct)
    .slice(0, 20)) {
    const relayAgree = consensus?.get(stock.code)
    records.push(makeRecord({
      id: 'board:relay:' + stock.code,
      code: stock.code,
      name: stock.name,
      style: 'relay',
      channel: 'board',
      thesis: '板块补涨：' + sector.name + ' 今日 ' + sector.limitUpCount + ' 家涨停，本股尚未启动',
      score: Math.max(
        42,
        Math.min(88, Math.round(Math.max(45 + sector.limitUpCount * 4 + Math.min(12, stock.changePct * 2), relayAgree?.score ?? 0))),
      ),
      evidence: [
        '板块 ' + sector.name + ' 涨停 ' + sector.limitUpCount + ' 家，最高 ' + sector.maxBoard + ' 板',
        '板块龙头 ' + sector.leaderName,
        '本股涨跌 ' + stock.changePct.toFixed(2) + '%，量比 ' + stock.volumeRatio.toFixed(2),
        (stock.mainNetInflow ?? 0) > 0
          ? '主力净流入 ' + ((stock.mainNetInflow ?? 0) / 1e8).toFixed(2) + '亿'
          : '主力净流出 ' + (Math.abs(stock.mainNetInflow ?? 0) / 1e8).toFixed(2) + '亿',
      ],
      price: stock.price,
      changePct: stock.changePct,
      industry: stock.industry,
      reasons: boardReasons({
        board: 0,
        kind: 'relay',
        isSectorLeader: false,
        topSector: sector.name,
        topSectorCount: sector.limitUpCount,
        recognition: 0,
        sectorNames: [sector.name],
        ...sentimentBase,
      }),
      board: {
        height: 0,
        recognition: 0,
        isSectorLeader: false,
        topSector: sector.name,
        topSectorCount: sector.limitUpCount,
        phase,
      },
    }))
  }
  return records
}

function buildDragonRecords(): RecommendationRecord[] {
  return buildDragonTigerReco({ limit: 30, minNetValue: 0 }).items.map((item) =>
    makeRecord({
      id: 'dragon:' + item.code,
      code: item.code,
      name: item.name,
      style: item.boardType === 'hot_money' ? 'limit_up' : 'fund',
      channel: 'dragon',
      thesis: item.reason,
      score: item.score,
      evidence: [item.tradeDate + ' ' + item.boardType, '净买额 ' + (item.netValue / 1e8).toFixed(2) + '亿', ...item.concepts.slice(0, 2)],
      changePct: item.changePct ?? undefined,
      industry: item.industry,
      reasons: dragonReasons({
        netValue: item.netValue,
        orgNetValue: item.orgNetValue,
        hotMoneyNetValue: item.hotMoneyNetValue,
        boardType: String(item.boardType),
        concepts: item.concepts,
        occurrences: item.occurrences,
        tradeDates: item.tradeDates,
      }),
    }),
  )
}

function mergeRecord(target: RecommendationRecord, incoming: RecommendationRecord): RecommendationRecord {
  const channels = [...new Set([...target.channels, ...incoming.channels])]
  const evidence: RecommendationEvidence = {
    technical: [...(target.evidence.technical ?? []), ...(incoming.evidence.technical ?? [])],
    event: [...(target.evidence.event ?? []), ...(incoming.evidence.event ?? [])],
    opinion: [...(target.evidence.opinion ?? []), ...(incoming.evidence.opinion ?? [])],
    fund: [...(target.evidence.fund ?? []), ...(incoming.evidence.fund ?? [])],
    dragon: [...(target.evidence.dragon ?? []), ...(incoming.evidence.dragon ?? [])],
  }
  const better = incoming.score > target.score
  const sources = [...(target.sources ?? []), ...(incoming.sources ?? [])]
  const verification = target.verification ?? incoming.verification
  const reasons = dedupeReasons([...(target.reasons ?? []), ...(incoming.reasons ?? [])])
  return {
    ...target,
    channels,
    evidence,
    score: Math.max(target.score, incoming.score),
    confidence: Math.max(target.confidence, incoming.confidence),
    style: better ? incoming.style : target.style,
    thesis: better ? incoming.thesis : target.thesis,
    price: target.price ?? incoming.price,
    changePct: target.changePct ?? incoming.changePct,
    industry: target.industry ?? incoming.industry,
    levels: better ? incoming.levels : target.levels,
    invalidIf: better ? incoming.invalidIf : target.invalidIf,
    sources: sources.length ? sources : undefined,
    verification,
    reasons: reasons.length ? reasons : undefined,
    reasonSummary: reasons.length ? summarizeReasons(reasons) : undefined,
    board: target.board ?? incoming.board,
  }
}

/** 资金共识理由：把三条资金线的检查结果写成一条可验证的理由 */
function consensusReason(consensus: CapitalConsensus): RecommendationReason {
  const lines: string[] = []
  if (consensus.parts.board != null) lines.push('涨停板 ' + consensus.parts.board)
  if (consensus.parts.dragon != null) lines.push('龙虎榜 ' + consensus.parts.dragon)
  if (consensus.parts.fund != null) lines.push('主力资金 ' + consensus.parts.fund)
  return {
    dimension: 'fund',
    key: 'capital_consensus',
    label: '资金三线共振（' + consensus.lineCount + ' 条）',
    detail: lines.join(' / ') + '；共识分 ' + consensus.score + '。' + consensus.notes.join('；'),
    weight: 0.26,
    strength: Math.max(35, Math.min(92, consensus.score)),
    metrics: {
      consensusScore: consensus.score,
      lines: consensus.lineCount,
      boardLine: consensus.parts.board ?? 0,
      dragonLine: consensus.parts.dragon ?? 0,
      fundLine: consensus.parts.fund ?? 0,
    },
    expect: '多线共振成立 → 次日溢价比单线标的更高；若三线共振仍跑输大盘则证伪',
  }
}

/** 目标价系数：按历史实际达成幅度缩放目标价，避免系统性高估 */
function applyTargetFactor(levels: RecommendationLevels, factor: number): RecommendationLevels {
  if (!levels.entry || !levels.target || !Number.isFinite(factor) || factor === 1) return levels
  const base = levels.target / levels.entry - 1
  return { ...levels, target: Number((levels.entry * (1 + base * factor)).toFixed(2)) }
}

/** 记录理由维度的平均权重，作为置信度的维度修正 */
function averageDimensionWeight(item: RecommendationRecord, dimensionWeights: Record<string, number>): number {
  const dimensions = [...new Set((item.reasons ?? []).map((reason) => reason.dimension))]
  if (!dimensions.length) return 1
  const sum = dimensions.reduce((acc, dimension) => acc + (dimensionWeights[dimension] ?? 1), 0)
  return Math.max(0.7, Math.min(1.3, sum / dimensions.length))
}

export function buildTodayRecommendations(
  stocks: SnapshotStock[],
  options: { coolingDays?: number; board?: LimitUpBoard; consensus?: Map<string, CapitalConsensus> } = {},
): RecommendationListResponse {
  const all = [
    ...buildTechnicalRecords(stocks),
    ...buildEventRecords(stocks),
    ...buildOpinionRecords(stocks),
    ...buildFundRecords(),
    ...buildDragonRecords(),
    ...(options.board ? buildBoardRecords(stocks, options.board, options.consensus) : []),
  ]
  const byCode = new Map<string, RecommendationRecord>()
  for (const item of all) {
    const prev = byCode.get(item.code)
    if (!prev) byCode.set(item.code, item)
    else byCode.set(item.code, mergeRecord(prev, item))
  }

  const stockMap = new Map(stocks.map((stock) => [stock.code.toLowerCase(), stock]))
  const industryValuation = buildIndustryValuation(stocks)
  const reasonGuard = getReasonGuard()
  const dimensionWeights = getDimensionWeights()
  const targetFactor = getTargetFactor()
  const confidenceScale = getConfidenceScale()
  for (const [code, item] of byCode) {
    const stock = stockMap.get(code)
    if (stock) {
      if (!item.price || item.price <= 0) item.price = stock.price
      if (item.changePct == null) item.changePct = stock.changePct
      if (!item.industry) item.industry = stock.industry
      // 基本面画像 + 基本面理由：所有通道的推荐都补齐「公司本身好不好」这一层
      const { profile, signals } = buildFundamentalProfile(stock, industryValuation)
      item.fundamentals = profile
      const reasons = dedupeReasons([...(item.reasons ?? []), ...fundamentalReasons(signals)])
      item.reasons = reasons.length ? reasons : undefined
      item.reasonSummary = reasons.length ? summarizeReasons(reasons) : undefined
      if (!item.levels.entry || !item.levels.target || !item.levels.stopLoss) {
        item.levels = levelsFor(item.price, item.style)
      }
      item.levels = applyTargetFactor(item.levels, targetFactor)
    }
    const verification = computeVerification(item, stock)
    item.verification = verification
    item.guard = evaluateRecordGuard(
      {
        name: item.name,
        style: item.style,
        changePct: item.changePct,
        reasons: (item.reasons ?? []).map((reason) => ({
          dimension: reason.dimension,
          label: reason.label,
          weight: reason.weight,
        })),
        fundamentals: item.fundamentals,
        board: item.board ? { height: item.board.height, phase: item.board.phase } : undefined,
      },
      reasonGuard,
    )
  }

  const history = loadHistory()
  const signalDate = new Date().toISOString().slice(0, 10)
  const coolingDays = Math.max(0, options.coolingDays ?? 0)
  const eligible = coolingDays > 0
    ? [...byCode.values()].filter((item) => {
        const last = history.lastRecommended[item.code]
        if (!last) return true
        const diff = Math.floor((Date.parse(signalDate) - Date.parse(last)) / 86_400_000)
        return diff >= coolingDays
      })
    : [...byCode.values()]
  const market = computeMarketTemperature(stocks)
  const weights = getRecommendationWeights()
  const styleWeights = { ...weights }
  if (market.riskOff) {
    styleWeights.trend *= 0.75
    styleWeights.limit_up *= 0.7
    styleWeights.leader *= 0.8
  }
  if (market.riskOn) {
    styleWeights.trend *= 1.08
    styleWeights.limit_up *= 1.1
    styleWeights.leader *= 1.08
  }
  // 有涨停板/情绪数据时，用「情绪相位」替代二元温度做更细的取向调整
  const phase = options.board?.sentiment.phase
  if (phase) {
    const multipliers = PHASE_STYLE_MULTIPLIER[phase]
    for (const [style, factor] of Object.entries(multipliers)) {
      if (style in styleWeights) styleWeights[style] *= factor
    }
  }
  const rawItems = eligible.sort((a, b) => b.score - a.score || (b.changePct ?? 0) - (a.changePct ?? 0))
  const items = rawItems.map((item) => {
    const styleWeight = styleWeights[item.style] ?? 1
    const dimensionWeight = averageDimensionWeight(item, dimensionWeights)
    // 证据分 = 通道分 6 : 理由分 4，理由越扎实、越具体，证据分越高
    const reasonScore = item.reasonSummary?.reasonScore ?? item.score
    const evidenceScore = Math.max(0, Math.min(100, Math.round(item.score * 0.6 + reasonScore * 0.4)))
    const verificationScore = item.verification?.score ?? 50
    const confidence = Math.max(
      0,
      Math.min(100, Math.round(evidenceScore * (0.4 + verificationScore / 200) * styleWeight * dimensionWeight * confidenceScale)),
    )
    return {
      ...item,
      score: Math.max(0, Math.min(100, Math.round(evidenceScore * styleWeight))),
      confidence,
      appliedWeights: {
        style: Number(styleWeight.toFixed(3)),
        dimension: Number(dimensionWeight.toFixed(3)),
        targetFactor: Number(targetFactor.toFixed(3)),
        confidenceScale: Number(confidenceScale.toFixed(3)),
      },
    }
  }).sort((a, b) => b.score - a.score || (b.changePct ?? 0) - (a.changePct ?? 0))
  const observing = items.filter((item) => item.guard?.status === 'observe')
  const recommendable = items.filter((item) => item.guard?.status !== 'observe')
  const grouped: Record<RecommendationStyle, RecommendationRecord[]> = {
    trend: [],
    limit_up: [],
    pullback: [],
    leader: [],
    relay: [],
    event: [],
    fund: [],
    opinion: [],
  }
  const styleIndustryCount = new Map<string, Map<string, number>>()
  for (const item of recommendable) {
    const key = item.style
    const industry = item.industry ?? '其他'
    const counter = styleIndustryCount.get(key) ?? new Map<string, number>()
    const used = counter.get(industry) ?? 0
    if (used >= 2) continue
    counter.set(industry, used + 1)
    styleIndustryCount.set(key, counter)
    grouped[key].push(item)
  }
  for (const key of STYLE_KEYS) {
    grouped[key] = grouped[key].slice(0, 12)
  }
  const top = STYLE_KEYS.flatMap((key) => grouped[key]).sort((a, b) => b.score - a.score).slice(0, 80)

  const observingTop = observing.slice(0, 80)
  // 记录被拦标的（含连续拦截天数），供观察名单展示与回流判断
  try {
    trackBlocked(observingTop)
  } catch {
    /* 观察队列写入失败不影响推荐 */
  }

  for (const item of top) {
    history.lastRecommended[item.code] = signalDate
  }
  saveHistory(history)
  saveRecommendationRecords(top)

  // 观察名单回流：今天通过守卫的标的自动回到推荐，并记录原因
  let recycled: RecycledItem[] = []
  let staleObserving: Array<{ code: string; name: string; days: number; note: string }> = []
  try {
    const reconciled = reconcileObserving({ recommend: top, observing: observingTop })
    recycled = reconciled.recycled
    staleObserving = reconciled.stale
  } catch {
    /* 回流对账失败不影响推荐结果 */
  }

  return {
    generatedAt: Date.now(),
    total: top.length,
    items: top,
    grouped,
    market,
    observing: observingTop,
    recycled,
    staleObserving,
    sentiment: options.board
      ? {
          phase: options.board.sentiment.phase,
          score: options.board.sentiment.score,
          limitUpCount: options.board.sentiment.limitUpCount,
          limitDownCount: options.board.sentiment.limitDownCount,
          brokenRate: options.board.sentiment.brokenRate,
          maxBoard: options.board.sentiment.maxBoard,
          yesterdayPremium: options.board.sentiment.yesterdayPremium,
          promotionRate: options.board.sentiment.promotionRate,
        }
      : undefined,
  }
}
