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
import { readJson, writeJson } from './store.ts'
import { getRecommendationWeights } from './recommendation-weights.ts'

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
}

function computeMarketTemperature(stocks: SnapshotStock[]): MarketTemperature {
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

const STYLE_KEYS: RecommendationStyle[] = ['trend', 'limit_up', 'pullback', 'leader', 'event', 'fund', 'opinion']
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
    if (!old || record.score > old.score) map.set(key, record)
  }
  const merged = [...map.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 2000)
  writeJson(RECORD_FILE, { version: 1, records: merged } satisfies RecommendationRecordStore)
}
const STYLE_LABEL: Record<RecommendationStyle, string> = {
  trend: '趋势',
  limit_up: '打板',
  pullback: '低吸',
  leader: '龙头',
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
  return style === 'limit_up' ? 3 : style === 'pullback' ? 3 : style === 'event' ? 7 : style === 'opinion' ? 7 : 5
}

function computeVerification(item: RecommendationRecord, stock?: SnapshotStock): RecommendationVerification {
  const confirmations: string[] = []
  const conflicts: string[] = []
  if (item.channels.includes('technical')) confirmations.push('技术形态入选')
  if (item.channels.includes('fund')) confirmations.push('资金面同向')
  if (item.channels.includes('event')) confirmations.push('事件催化')
  if (item.channels.includes('dragon')) confirmations.push('龙虎榜确认')
  if (item.channels.includes('opinion')) confirmations.push('博主观点')
  if (stock) {
    if (stock.changePct > 0 && stock.volumeRatio >= 1.2) confirmations.push('量价配合')
    if (stock.changePct < -3) conflicts.push('当日跌幅较大')
    if (stock.volumeRatio > 0 && stock.volumeRatio < 0.8) conflicts.push('量能不足')
    if (stock.changePct >= 9.8) conflicts.push('短期涨幅过大')
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
}): RecommendationRecord {
  const evidenceKey = input.channel === 'technical' ? 'technical' : input.channel === 'event' ? 'event' : input.channel === 'opinion' ? 'opinion' : input.channel === 'fund' ? 'fund' : 'dragon'
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
    }),
  )
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
  }
}

export function buildTodayRecommendations(stocks: SnapshotStock[], options: { coolingDays?: number } = {}): RecommendationListResponse {
  const all = [
    ...buildTechnicalRecords(stocks),
    ...buildEventRecords(stocks),
    ...buildOpinionRecords(stocks),
    ...buildFundRecords(),
    ...buildDragonRecords(),
  ]
  const byCode = new Map<string, RecommendationRecord>()
  for (const item of all) {
    const prev = byCode.get(item.code)
    if (!prev) byCode.set(item.code, item)
    else byCode.set(item.code, mergeRecord(prev, item))
  }

  const stockMap = new Map(stocks.map((stock) => [stock.code.toLowerCase(), stock]))
  for (const [code, item] of byCode) {
    const verification = computeVerification(item, stockMap.get(code))
    item.verification = verification
    item.confidence = Math.max(0, Math.min(100, Math.round(item.confidence * (0.4 + verification.score / 200))))
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
  const rawItems = eligible.sort((a, b) => b.score - a.score || (b.changePct ?? 0) - (a.changePct ?? 0))
  const items = rawItems.map((item) => {
    const weight = styleWeights[item.style] ?? 1
    return {
      ...item,
      score: Math.max(0, Math.min(100, Math.round(item.score * weight))),
      confidence: Math.max(0, Math.min(100, Math.round(item.confidence * weight))),
    }
  }).sort((a, b) => b.score - a.score || (b.changePct ?? 0) - (a.changePct ?? 0))
  const grouped: Record<RecommendationStyle, RecommendationRecord[]> = {
    trend: [],
    limit_up: [],
    pullback: [],
    leader: [],
    event: [],
    fund: [],
    opinion: [],
  }
  const styleIndustryCount = new Map<string, Map<string, number>>()
  for (const item of items) {
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

  for (const item of top) {
    history.lastRecommended[item.code] = signalDate
  }
  saveHistory(history)
  saveRecommendationRecords(top)

  return {
    generatedAt: Date.now(),
    total: top.length,
    items: top,
    grouped,
    market,
  }
}
