/**
 * 「我的观点」工作台：把用户的一句话判断，变成「结构化假设 → 数据对账 → 可追踪记录」。
 *
 * 原则（与项目既有原则一致）：
 *  1. 结论与数字一律来自本地数据与已有回测，模型只负责结构化与措辞，不允许编造数字；
 *  2. 每条逻辑都要给「支持」与「反证」两侧证据，找不到数据就明确写「无数据」；
 *  3. 落成记录后按「次日开盘买入、持有 N 日」结算超额，进入与博主观点同一套校准体系。
 */

import { analyzeStock, type StockAnalysisResult } from './analysis.ts'
import { buildFundamentalProfile, type FundamentalProfile } from './fundamentals.ts'
import { consecutiveInflowDays, getFundFlowCacheEntry, sumMainNet } from './fund-stock-reco.ts'
import { getDragonTigerCacheEntry } from './dragon-tiger-stock-reco.ts'
import { buildOpinionSignals } from './opinion-signals.ts'
import { listOpinionDocuments } from './opinions.ts'
import { loadBoardSnapshot, type LimitUpBoard } from './limit-up.ts'
import {
  computeSectorRotation,
  computeSectorTrends,
  loadLimitUpBacktest,
  loadSectorHistory,
  loadSectorTrendBacktest,
} from './limit-up-history.ts'
import { readJson, writeJson } from './store.ts'
import { sessionDateOf } from './trading-day.ts'
import type { SnapshotStock } from './eastmoney.ts'
import type { KLineBar } from './tencent.ts'

export type ThesisDirection = 'bull' | 'bear' | 'watch'
export type ThesisStyle = 'trend' | 'limit_up' | 'pullback' | 'leader' | 'relay' | 'event' | 'fund' | 'opinion'
export type ThesisDimension =
  | 'board'
  | 'fundamental'
  | 'technical'
  | 'fund'
  | 'dragon'
  | 'event'
  | 'opinion'
  | 'industry'
  | 'sentiment'
export type ThesisStance = 'support' | 'against' | 'neutral'

export interface ThesisFact {
  dimension: ThesisDimension
  key: string
  label: string
  /** 带数字的事实描述（可直接核对） */
  detail: string
  stance: ThesisStance
  /** 该维度在结论中的权重 */
  weight: number
  /** 事实自身强度 0~100 */
  strength: number
  /** 数据来源，便于回查 */
  source: string
}

export interface ThesisClaim {
  text: string
  dimension: ThesisDimension
  verdict: 'supported' | 'refuted' | 'unknown'
  evidence: string[]
  counter: string[]
}

export interface ThesisVerdict {
  conclusion: 'support' | 'partial' | 'against'
  /** 支持度 0~100（加权） */
  score: number
  summary: string
  keyPoints: string[]
  counterPoints: string[]
  /** 什么情况算「我看错了」 */
  invalidation: string[]
  /** 关键观察点（价位 / 板块 / 资金 / 事件） */
  watch: string[]
}

export interface ThesisStructure {
  code: string
  name: string
  direction: ThesisDirection
  style: ThesisStyle
  horizonDays: number
  claims: Array<{ text: string; dimension: ThesisDimension }>
  /** 结构化来源：模型 or 规则兜底 */
  parser: 'llm' | 'rule'
}

export interface ThesisEvaluation {
  entryDate: string
  entryPrice: number
  exitDate?: string
  exitPrice?: number
  days: number
  returnPct?: number
  benchmarkReturnPct?: number
  excessPct?: number
  status: 'pending' | 'settled'
}

export interface MyThesisRecord {
  id: string
  createdAt: number
  updatedAt: number
  author: '我'
  code: string
  name: string
  direction: ThesisDirection
  style: ThesisStyle
  horizonDays: number
  rawText: string
  claims: ThesisClaim[]
  facts: ThesisFact[]
  verdict: ThesisVerdict
  /** 板块上下文快照，便于日后复盘当时的板块状态 */
  sector?: {
    name?: string
    trend?: string
    stage?: string
    change5d?: number
    heat?: number
    limitUpCount?: number
  }
  signalDate: string
  evaluation: ThesisEvaluation
  note?: string
}

const FILE = 'my-thesis.json'
const DAY = 86_400_000

interface ThesisFile {
  version: 1
  updatedAt: number
  items: MyThesisRecord[]
}

const round = (value: number, digits = 2): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const DIMENSION_LABEL: Record<ThesisDimension, string> = {
  board: '板块效应',
  fundamental: '基本面',
  technical: '技术面',
  fund: '资金面',
  dragon: '龙虎榜',
  event: '事件催化',
  opinion: '博主观点',
  industry: '行业',
  sentiment: '情绪周期',
}

/** 维度权重：与推荐理由保持同一口径，便于横向比较 */
const DIMENSION_WEIGHT: Record<ThesisDimension, number> = {
  technical: 0.22,
  fund: 0.2,
  board: 0.2,
  fundamental: 0.16,
  sentiment: 0.12,
  dragon: 0.1,
  event: 0.12,
  opinion: 0.08,
  industry: 0.1,
}

// ---------------------------------------------------------------- 结构化

const BULL_WORDS = ['看多', '看涨', '买入', '低吸', '加仓', '建仓', '做多', '看高', '抄底', '上车', '机会', '主线', '看好']
const BEAR_WORDS = ['看空', '看跌', '卖出', '减仓', '清仓', '做空', '回避', '风险', '见顶', '跑路', '止损', '不参与']
const WATCH_WORDS = ['观察', '关注', '观望', '等回调', '跟踪']

const STYLE_RULES: Array<{ style: ThesisStyle; words: string[] }> = [
  { style: 'limit_up', words: ['打板', '涨停', '封板', '连板', '首板', '接力'] },
  { style: 'pullback', words: ['低吸', '回调', '回踩', '洗盘', '企稳', '支撑位'] },
  { style: 'leader', words: ['龙头', '领头', '最强'] },
  { style: 'relay', words: ['补涨', '跟风', '低位补'] },
  { style: 'event', words: ['事件', '政策', '公告', '催化', '新闻', '订单', '中标'] },
  { style: 'fund', words: ['业绩', '估值', '基本面', '毛利', '净利', '现金流', '分红'] },
  { style: 'opinion', words: ['博主', '大v', '大V', '老师', '观点', '有人喊'] },
  { style: 'trend', words: ['趋势', '均线', '多头', '突破', '放量'] },
]

const DIMENSION_RULES: Array<{ dimension: ThesisDimension; words: string[] }> = [
  { dimension: 'board', words: ['板块', '题材', '主线', '赛道', '概念', '板块效应', '梯队'] },
  { dimension: 'fundamental', words: ['业绩', '估值', '净利', '营收', '毛利', 'roe', 'ROE', '负债', '订单', '分红', '基本面'] },
  { dimension: 'technical', words: ['均线', '日线', '周线', '突破', '回踩', '放量', '缩量', '支撑', '压力', '形态', '缩量', 'macd', 'MACD'] },
  { dimension: 'fund', words: ['主力', '资金', '净流入', '净流出', '北向', '流入', '吸筹'] },
  { dimension: 'dragon', words: ['龙虎榜', '游资', '机构席位', '席位'] },
  { dimension: 'event', words: ['政策', '公告', '新闻', '事件', '催化', '中标', '重组', '并购'] },
  { dimension: 'opinion', words: ['博主', '大v', '大V', '老师', '观点', '看多的人'] },
  { dimension: 'sentiment', words: ['情绪', '涨停家数', '冰点', '退潮', '高潮', '连板高度', '晋级率'] },
]

/** 名称/代码识别：先从全市场名单里找出文本中出现的标的 */
export function matchStocks(text: string, stocks: SnapshotStock[], limit = 8): SnapshotStock[] {
  const found: SnapshotStock[] = []
  const lower = text.toLowerCase()
  for (const stock of stocks) {
    if (stock.name && stock.name.length >= 2 && text.includes(stock.name)) found.push(stock)
    else if (lower.includes(stock.code)) found.push(stock)
    if (found.length >= limit) break
  }
  return found
}

function guessDimension(text: string): ThesisDimension {
  const lower = text.toLowerCase()
  for (const rule of DIMENSION_RULES) {
    if (rule.words.some((word) => lower.includes(word.toLowerCase()))) return rule.dimension
  }
  return 'technical'
}

export function guessDirection(text: string): ThesisDirection {
  const bull = BULL_WORDS.filter((word) => text.includes(word)).length
  const bear = BEAR_WORDS.filter((word) => text.includes(word)).length
  if (bear > bull) return 'bear'
  if (bull > bear) return 'bull'
  if (WATCH_WORDS.some((word) => text.includes(word))) return 'watch'
  return 'watch'
}

export function guessStyle(text: string): ThesisStyle {
  for (const rule of STYLE_RULES) {
    if (rule.words.some((word) => text.includes(word))) return rule.style
  }
  return 'trend'
}

/** 规则兜底：按标点切句，最多 4 条逻辑 */
export function splitClaims(text: string): Array<{ text: string; dimension: ThesisDimension }> {
  const parts = text
    .split(/[。；;！!？?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4)
  const source = parts.length ? parts : [text.trim()].filter(Boolean)
  return source.slice(0, 4).map((part) => ({ text: part.slice(0, 120), dimension: guessDimension(part) }))
}

export function ruleStructure(text: string, stocks: SnapshotStock[]): ThesisStructure | null {
  const matched = matchStocks(text, stocks, 1)
  const stock = matched[0]
  if (!stock) return null
  const style = guessStyle(text)
  return {
    code: stock.code,
    name: stock.name,
    direction: guessDirection(text),
    style,
    horizonDays: style === 'limit_up' || style === 'relay' ? 3 : style === 'pullback' ? 10 : 5,
    claims: splitClaims(text),
    parser: 'rule',
  }
}

// ---------------------------------------------------------------- 数据包

export interface ThesisDataPack {
  code: string
  name: string
  price: number
  changePct: number
  industry?: string
  concepts: string[]
  analysis: StockAnalysisResult
  profile?: FundamentalProfile
  fund?: { mainNetSum5Yi: number; mainNetTodayYi?: number; consecutiveInflowDays: number; positiveDays: number }
  dragon?: { tradeDate: string; netValueYi: number; orgNetValueYi?: number; hotMoneyNetValueYi?: number }
  board?: {
    isLimitUp: boolean
    height?: number
    recognition?: number
    isSectorLeader?: boolean
    firstSealAt?: string
    breakCount?: number
    /** 涨停池口径认定的所属板块 */
    topSector?: string
  }
  sector?: {
    name: string
    type: 'industry' | 'concept'
    heat?: number
    limitUpCount?: number
    maxBoard?: number
    leaderName?: string
    mainNetInflowYi?: number
    trend?: string
    stage?: string
    change5d?: number
    todayChangePct?: number
    rankDelta?: number
  }
  sentiment?: { phase: string; score: number; limitUpCount: number; brokenRate: number; maxBoard: number; promotionRate: number; yesterdayPremium: number }
  opinions?: { score: number; stance: string; authors: string[]; claimCount: number; theses: string[] }
}

/** 收集对账所需的全部本地数据（不发起新的外部请求） */
export async function buildThesisDataPack(input: {
  code: string
  stocks: SnapshotStock[]
  /** 用户原话：用于优先选择他真正在说的板块 */
  text?: string
}): Promise<ThesisDataPack | null> {
  const code = input.code.toLowerCase()
  const stock = input.stocks.find((item) => item.code === code)
  if (!stock) return null
  const analysis = await analyzeStock(code, stock.name)
  const profile = buildFundamentalProfile(stock, undefined).profile

  const pack: ThesisDataPack = {
    code,
    name: stock.name,
    price: stock.price,
    changePct: stock.changePct,
    industry: stock.industry,
    concepts: (stock.concepts ?? []).slice(0, 6),
    analysis,
    profile,
  }

  // 资金：近 5 日主力净额与连续流入天数
  const fundEntry = getFundFlowCacheEntry(code)
  if (fundEntry?.days?.length) {
    pack.fund = {
      mainNetSum5Yi: round(sumMainNet(fundEntry.days, 5) / 1e8, 2),
      mainNetTodayYi: fundEntry.days.length ? round((fundEntry.days.at(-1)?.mainNet ?? 0) / 1e8, 2) : undefined,
      consecutiveInflowDays: consecutiveInflowDays(fundEntry.days),
      positiveDays: fundEntry.days.filter((day) => (day.mainNet ?? 0) > 0).length,
    }
  }

  // 龙虎榜
  const dragon = getDragonTigerCacheEntry(code)
  if (dragon) {
    pack.dragon = {
      tradeDate: dragon.tradeDate,
      netValueYi: round(dragon.netValue / 1e8, 2),
      orgNetValueYi: dragon.orgNetValue == null ? undefined : round(dragon.orgNetValue / 1e8, 2),
      hotMoneyNetValueYi: dragon.hotMoneyNetValue == null ? undefined : round(dragon.hotMoneyNetValue / 1e8, 2),
    }
  }

  // 涨停板 / 板块上下文
  const board = loadBoardSnapshot()
  if (board) {
    const item = board.limitUp.find((row) => row.code === code)
    if (item) {
      pack.board = {
        isLimitUp: true,
        height: item.board,
        recognition: item.recognition,
        isSectorLeader: item.isSectorLeader,
        firstSealAt: item.firstSealAt,
        breakCount: item.breakCount,
        topSector: item.topSector,
      }
    }
    pack.sentiment = {
      phase: board.sentiment.phase,
      score: board.sentiment.score,
      limitUpCount: board.sentiment.limitUpCount,
      brokenRate: board.sentiment.brokenRate,
      maxBoard: board.sentiment.maxBoard,
      promotionRate: board.sentiment.promotionRate,
      yesterdayPremium: board.sentiment.yesterdayPremium,
    }
    const history0 = loadSectorHistory()
    // 用完整板块目录（而不是截断后的趋势榜）匹配用户原话里提到的板块
    const catalog = history0 ? history0.sectors.map((item) => ({ name: item.name, type: item.type })) : []
    const typeOf = new Map(catalog.map((item) => [item.name, item.type]))
    // 板块优先级：用户原话里提到的板块 > 涨停池给的 topSector > 行业 > 概念
    const mentioned = input.text
      ? catalog
          .filter((item) => item.name.length >= 2 && (input.text as string).includes(item.name))
          .sort((a, b) => b.name.length - a.name.length)
          .map((item) => item.name)
      : []
    const limitUpRow = board.limitUp.find((row) => row.code === code)
    const names = [...mentioned, limitUpRow?.topSector, stock.industry, ...(stock.concepts ?? [])].filter(
      (name): name is string => Boolean(name),
    )
    pack.sector = pickSectorContext(board, names, typeOf, new Set(mentioned))
  }

  // 板块趋势 / 阶段 / 轮动
  const history = loadSectorHistory()
  if (history && pack.sector?.name) {
    const trends = computeSectorTrends(history, { limit: 5000 })
    const trend = trends.find((item) => item.name === pack.sector?.name)
    if (trend) {
      pack.sector.trend = trend.trend
      pack.sector.stage = trend.stage
      pack.sector.change5d = trend.change5d
    }
    const rotation = computeSectorRotation(history, { limit: 400 })
    const rotationItem = rotation.find((item) => item.name === pack.sector?.name)
    if (rotationItem) {
      pack.sector.todayChangePct = rotationItem.todayChangePct
      pack.sector.rankDelta = rotationItem.rankDelta
    }
  }

  // 博主观点（只做参考，且标明来源数量）
  try {
    const signals = buildOpinionSignals(listOpinionDocuments({ limit: 5000 }), { maxAgeDays: 30, verifiedOnly: true })
    const signal = signals.find((item) => item.code === code)
    if (signal) {
      pack.opinions = {
        score: round(signal.score, 1),
        stance: signal.stance,
        authors: signal.authors.slice(0, 4),
        claimCount: signal.claimCount,
        theses: signal.theses.slice(0, 2),
      }
    }
  } catch {
    /* 观点数据缺失不影响对账 */
  }

  return pack
}

/**
 * 选板块上下文。**用户明确提到的板块优先**——他在说这个板块，就该按这个板块对账，
 * 即使它今天没有涨停梯队（没有梯队时仍然能取到趋势/阶段/5 日动量）。
 */
function pickSectorContext(
  board: LimitUpBoard,
  names: string[],
  typeOf: Map<string, 'industry' | 'concept'>,
  mentioned: Set<string>,
): ThesisDataPack['sector'] | undefined {
  const usable = names.filter((name) => name && name !== '其他')
  const withLadder = (name: string) => board.sectors.find((row) => row.name === name)
  const toContext = (name: string): ThesisDataPack['sector'] => {
    const sector = withLadder(name)
    if (!sector) return { name, type: typeOf.get(name) ?? 'concept' }
    return {
      name: sector.name,
      type: sector.type,
      heat: sector.heat,
      limitUpCount: sector.limitUpCount,
      maxBoard: sector.maxBoard,
      leaderName: sector.leaderName,
      mainNetInflowYi: round(sector.mainNetInflow / 1e8, 2),
    }
  }
  const mentionedNames = usable.filter((name) => mentioned.has(name))
  const others = usable.filter((name) => !mentioned.has(name))
  const primary = mentionedNames.find((name) => withLadder(name)) ?? mentionedNames[0]
  if (primary) return toContext(primary)
  const secondary = others.find((name) => withLadder(name)) ?? others[0]
  return secondary ? toContext(secondary) : undefined
}

// ---------------------------------------------------------------- 对账（规则优先）

export interface ThesisFactOptions {
  direction: ThesisDirection
  style: ThesisStyle
  pack: ThesisDataPack
}

/** 把数据包翻译成「支持 / 反证」两类事实，全部带数字 */
export function buildThesisFacts(options: ThesisFactOptions): ThesisFact[] {
  const { pack, direction, style } = options
  const facts: ThesisFact[] = []
  const bullish = direction !== 'bear'

  const push = (
    fact: Omit<ThesisFact, 'weight' | 'stance'> & { stance?: ThesisStance },
  ) => {
    const rawStance = fact.stance ?? 'neutral'
    // 方向为看多时，支持性事实计支持；看空时反向解读
    const stance: ThesisStance = rawStance === 'neutral' || direction === 'watch'
      ? 'neutral'
      : bullish
        ? rawStance
        : rawStance === 'support' ? 'against' : 'support'
    facts.push({
      ...fact,
      stance,
      weight: DIMENSION_WEIGHT[fact.dimension] ?? 0.1,
    })
  }

  // ---- 技术面 ----
  const a = pack.analysis
  push({
    dimension: 'technical',
    key: 'technical_score',
    label: '技术面综合',
    detail: '技术评分 ' + a.score + '（' + a.signalLabel + '）；' + (a.reasons[0] ?? '无更多说明'),
    stance: a.score >= 60 ? 'support' : a.score <= 40 ? 'against' : 'neutral',
    strength: Math.abs(a.score - 50) * 2,
    source: 'analyzeStock',
  })
  push({
    dimension: 'technical',
    key: 'trend',
    label: '趋势状态',
    detail: '趋势「' + a.trend.status + '」（强度 ' + a.trend.trendStrength + '，' + a.trend.alignment + '），量能「' + a.volume.status + '」，RSI6 ' + round(a.rsi.rsi6, 1) + '，MACD ' + a.macd.status,
    stance: a.trend.status.includes('多头') || a.trend.status.includes('强势') ? 'support' : a.trend.status.includes('空头') ? 'against' : 'neutral',
    strength: a.trend.trendStrength,
    source: 'analyzeStock',
  })
  if (a.levels?.support?.length || a.levels?.resistance?.length) {
    const support = a.levels.support[0]
    const distance = support && a.price ? round((a.price / support - 1) * 100, 2) : undefined
    push({
      dimension: 'technical',
      key: 'levels',
      label: '关键价位',
      detail:
        '现价 ' + a.price + '，最近支撑 ' + support + (distance == null ? '' : '（上方 ' + distance + '%）') +
        '，压力 ' + (a.levels.resistance[0] ?? '--') + '，策略止损 ' + a.levels.stopLoss + '，目标 ' + a.levels.target,
      stance: 'neutral',
      strength: 50,
      source: 'analyzeStock',
    })
  }
  if (style === 'pullback') {
    const ma20 = a.trend.ma20 || a.levels?.support?.[0]
    const near = ma20 && a.price ? Math.abs(a.price / ma20 - 1) <= 0.03 : false
    push({
      dimension: 'technical',
      key: 'pullback_position',
      label: '低吸位置',
      detail: near
        ? '现价距离最近支撑（约 ' + ma20 + '）不足 3%，属于回踩位置'
        : '现价 ' + a.price + ' 距离最近支撑 ' + (ma20 ?? '--') + ' 超过 3%，尚未回踩到位',
      stance: near ? 'support' : 'against',
      strength: near ? 62 : 40,
      source: 'analyzeStock',
    })
  }
  if (style === 'limit_up' || style === 'leader' || style === 'relay') {
    const board = pack.board
    push({
      dimension: 'board',
      key: 'limit_up_state',
      label: '涨停状态',
      detail: board?.isLimitUp
        ? (board.height ?? 1) + ' 板，辨识度 ' + (board.recognition ?? 0) + (board.isSectorLeader ? '，板块内辨识度第一' : '') +
          (board.firstSealAt ? '，' + board.firstSealAt + ' 封板' : '') + (board.breakCount ? '，炸板 ' + board.breakCount + ' 次' : '')
        : '今日未涨停，不属于打板标的',
      stance: board?.isLimitUp ? 'support' : 'against',
      strength: board?.isLimitUp ? Math.min(90, 50 + (board.height ?? 1) * 8) : 30,
      source: '涨停板快照' + (loadBoardSnapshot()?.date ? '（' + loadBoardSnapshot()!.date + '）' : ''),
    })
  }

  // ---- 板块效应 ----
  const sector = pack.sector
  if (sector) {
    const inPool = pack.board?.isLimitUp === true
    const isLeader = pack.board?.isSectorLeader === true
    push({
      dimension: 'board',
      key: 'sector_leader',
      label: '板块地位',
      detail: inPool
        ? '涨停池口径板块「' + (pack.board?.topSector ?? '--') + '」：' +
          (isLeader ? '辨识度第一（' + (pack.board?.height ?? 1) + ' 板）' : '辨识度不是板块第一') +
          '；判断依据是涨停家数、封板时间与板块资金，与上面对账用的板块可能不是同一个概念'
        : '本股今日未涨停，无法判定板块地位',
      stance: isLeader ? 'support' : inPool ? 'against' : 'neutral',
      strength: isLeader ? 74 : inPool ? 45 : 40,
      source: '涨停板板块梯队',
    })
  }
  if (sector) {
    push({
      dimension: 'board',
      key: 'sector_effect',
      label: '板块效应',
      detail:
        sector.limitUpCount == null
          ? sector.name + '：今日没有涨停梯队数据（该板块今天无涨停股），趋势与阶段见下一条'
          : sector.name + '：热度 ' + (sector.heat ?? '--') + '，涨停 ' + sector.limitUpCount + ' 家，最高 ' + (sector.maxBoard ?? 0) +
            ' 板，龙头 ' + (sector.leaderName ?? '--') + (sector.mainNetInflowYi == null ? '' : '，板块主力净流入 ' + sector.mainNetInflowYi + ' 亿'),
      stance: (sector.limitUpCount ?? 0) >= 3 ? 'support' : 'neutral',
      strength: Math.min(90, 40 + (sector.limitUpCount ?? 0) * 6),
      source: '涨停板板块梯队',
    })
  }
  {
    const trend = sector?.trend
    const stage = sector?.stage
    push({
      dimension: 'board',
      key: 'sector_trend',
      label: '板块趋势与阶段',
      detail: sector
        ? (sector.name ?? '所属板块') + '：趋势' + (trend ?? '未知') + '，阶段' + (stage ?? '未知') +
          (sector.change5d == null ? '' : '，5 日 ' + (sector.change5d > 0 ? '+' : '') + sector.change5d + '%')
        : '暂无板块趋势数据（需先重算板块历史序列）',
      stance: trend === '升温' || stage === '刚启动' || stage === '持续升温' ? 'support' : trend === '退潮' || stage === '退潮' ? 'against' : 'neutral',
      strength: trend === '升温' ? 68 : trend === '退潮' ? 45 : 55,
      source: '板块历史序列',
    })
  }

  // ---- 资金面 ----
  if (pack.fund) {
    const f = pack.fund
    push({
      dimension: 'fund',
      key: 'main_net',
      label: '主力资金',
      detail: '近 5 日主力净额 ' + f.mainNetSum5Yi + ' 亿（今日 ' + (f.mainNetTodayYi ?? '--') + ' 亿），连续净流入 ' + f.consecutiveInflowDays + ' 日，净流入天数 ' + f.positiveDays,
      stance: f.mainNetSum5Yi > 0 ? 'support' : 'against',
      strength: Math.min(92, 45 + Math.abs(f.mainNetSum5Yi) * 3 + f.consecutiveInflowDays * 6),
      source: '资金流榜单',
    })
  } else {
    push({
      dimension: 'fund',
      key: 'main_net',
      label: '主力资金',
      detail: '该股不在资金流榜单缓存中，暂无主力净额数据',
      stance: 'neutral',
      strength: 20,
      source: '资金流榜单',
    })
  }

  // ---- 龙虎榜 ----
  if (pack.dragon) {
    const d = pack.dragon
    push({
      dimension: 'dragon',
      key: 'dragon',
      label: '龙虎榜',
      detail: d.tradeDate + ' 净买入 ' + d.netValueYi + ' 亿（机构 ' + (d.orgNetValueYi ?? '--') + ' 亿，游资 ' + (d.hotMoneyNetValueYi ?? '--') + ' 亿）',
      stance: d.netValueYi > 0 ? 'support' : 'against',
      strength: Math.min(90, 45 + Math.abs(d.netValueYi) * 8),
      source: '龙虎榜榜单',
    })
  }

  // ---- 基本面 ----
  const p = pack.profile
  if (p) {
    push({
      dimension: 'fundamental',
      key: 'valuation',
      label: '估值与业绩',
      detail:
        'PE(TTM) ' + (p.peTtm ?? '--') + (p.industryPePercentile == null ? '' : '（行业内 ' + p.industryPePercentile + ' 分位）') +
        '，PB ' + (p.pb ?? '--') + '，净利同比 ' + (p.profitYoy == null ? '--' : (p.profitYoy > 0 ? '+' : '') + p.profitYoy + '%') +
        '，负债率 ' + (p.debtRatio == null ? '--' : p.debtRatio + '%') + '，评级 ' + p.rating,
      stance: p.rating === 'strong' ? 'support' : p.rating === 'weak' ? 'against' : 'neutral',
      strength: p.rating === 'strong' ? 70 : p.rating === 'weak' ? 45 : 55,
      source: '快照财务字段',
    })
    if ((p.debtRatio ?? 0) >= 80) {
      push({
        dimension: 'fundamental',
        key: 'debt_risk',
        label: '财务硬伤',
        detail: '资产负债率 ' + p.debtRatio + '%，超过 80% 阈值',
        stance: 'against',
        strength: 70,
        source: '快照财务字段',
      })
    }
    if ((p.industryPePercentile ?? 0) >= 85) {
      push({
        dimension: 'fundamental',
        key: 'valuation_risk',
        label: '估值偏高',
        detail: 'PE 处于行业 ' + p.industryPePercentile + ' 分位（≥85 视为偏高）',
        stance: 'against',
        strength: 60,
        source: '快照财务字段',
      })
    }
  }

  // ---- 情绪周期 ----
  const s = pack.sentiment
  if (s) {
    push({
      dimension: 'sentiment',
      key: 'phase',
      label: '情绪相位',
      detail:
        '相位「' + s.phase + '」（' + s.score + '），涨停 ' + s.limitUpCount + ' 家，炸板率 ' + s.brokenRate + '%，最高 ' + s.maxBoard +
        ' 板，晋级率 ' + s.promotionRate + '%，昨日涨停今日 ' + s.yesterdayPremium + '%',
      stance: s.phase === '冰点' || s.phase === '启动' ? 'support' : s.phase === '退潮' ? 'against' : 'neutral',
      strength: s.phase === '高潮' ? 60 : s.phase === '退潮' ? 45 : 65,
      source: '涨停板快照',
    })
  }

  // ---- 博主观点 ----
  if (pack.opinions) {
    const o = pack.opinions
    push({
      dimension: 'opinion',
      key: 'opinion',
      label: '博主观点',
      detail: o.authors.join('、') + ' 等 ' + o.claimCount + ' 条观点（' + (o.stance === 'bullish' ? '看多' : o.stance === 'bearish' ? '看空' : '中性') + '，信号分 ' + o.score + '）' +
        (o.theses[0] ? '；代表逻辑：' + o.theses[0].slice(0, 60) : ''),
      stance: o.stance === 'bullish' ? 'support' : o.stance === 'bearish' ? 'against' : 'neutral',
      strength: Math.min(85, 40 + o.claimCount * 5),
      source: '观点库（逐字校验通过）',
    })
  }

  return facts
}

/** 逻辑里出现这些词时，优先用对应的事实来判定（避免整条维度一荣俱荣） */
const CLAIM_KEY_RULES: Array<{ keys: string[]; words: string[] }> = [
  { keys: ['pullback_position', 'levels'], words: ['回调', '回踩', '低吸', '支撑', '均线', '20日线', '20 日线', '企稳', '洗盘'] },
  { keys: ['sector_leader'], words: ['龙头', '领涨', '辨识度', '最强', '第一'] },
  { keys: ['limit_up_state'], words: ['涨停', '连板', '封板', '打板', '板位', '首板', '接力'] },
  { keys: ['main_net'], words: ['主力', '资金', '净流入', '净流出', '北向', '吸筹'] },
  { keys: ['sector_trend'], words: ['板块', '题材', '主线', '赛道', '概念', '梯队', '发酵'] },
  { keys: ['dragon'], words: ['龙虎榜', '游资', '机构席位', '席位'] },
  { keys: ['valuation', 'debt_risk', 'valuation_risk'], words: ['估值', '业绩', '净利', '营收', '负债', '订单', '基本面', '分红', '毛利'] },
  { keys: ['phase'], words: ['情绪', '涨停家数', '冰点', '退潮', '高潮', '连板高度', '晋级率'] },
  { keys: ['opinion'], words: ['博主', '大v', '大V', '老师', '观点'] },
  { keys: ['sector_effect'], words: ['板块效应', '板块热度', '涨停家数'] },
]

export function preferredFactKeys(text: string): string[] {
  for (const rule of CLAIM_KEY_RULES) {
    if (rule.words.some((word) => text.includes(word))) return rule.keys
  }
  return []
}

/**
 * 逐条逻辑给判定：优先用逻辑里关键词对应的事实，
 * 其次用同维度事实；两侧都没有就老实标 unknown（不硬凑结论）。
 */
export function judgeClaims(
  claims: Array<{ text: string; dimension: ThesisDimension }>,
  facts: ThesisFact[],
): ThesisClaim[] {
  return claims.map((claim) => {
    const preferred = preferredFactKeys(claim.text)
    const targeted = preferred.length ? facts.filter((fact) => preferred.includes(fact.key)) : []
    const related = targeted.length ? targeted : facts.filter((fact) => fact.dimension === claim.dimension)
    const evidence = related.filter((fact) => fact.stance === 'support').map((fact) => fact.label + '：' + fact.detail)
    const counter = related.filter((fact) => fact.stance === 'against').map((fact) => fact.label + '：' + fact.detail)
    let verdict: ThesisClaim['verdict'] = 'unknown'
    if (evidence.length || counter.length) {
      if (evidence.length && !counter.length) verdict = 'supported'
      else if (counter.length && !evidence.length) verdict = 'refuted'
      else verdict = evidence.length >= counter.length ? 'supported' : 'refuted'
    }
    return { text: claim.text, dimension: claim.dimension, verdict, evidence, counter }
  })
}

/** 加权支持度 → 结论 */
export function resolveVerdict(facts: ThesisFact[], direction: ThesisDirection): ThesisVerdict {
  const scored = facts.filter((fact) => fact.stance !== 'neutral' && fact.weight > 0)
  let supportWeight = 0
  let againstWeight = 0
  for (const fact of scored) {
    const weight = fact.weight * (0.5 + Math.min(1, fact.strength / 100) * 0.5)
    if (fact.stance === 'support') supportWeight += weight
    else againstWeight += weight
  }
  const total = supportWeight + againstWeight
  const score = total > 0 ? Math.round((supportWeight / total) * 100) : 50
  const conclusion: ThesisVerdict['conclusion'] = score >= 62 ? 'support' : score >= 45 ? 'partial' : 'against'

  const keyPoints = scored.filter((fact) => fact.stance === 'support').sort((a, b) => b.weight * b.strength - a.weight * a.strength).slice(0, 4)
    .map((fact) => fact.label + '：' + fact.detail)
  const counterPoints = scored.filter((fact) => fact.stance === 'against').sort((a, b) => b.weight * b.strength - a.weight * a.strength).slice(0, 4)
    .map((fact) => fact.label + '：' + fact.detail)

  const directionText = direction === 'bear' ? '看空' : direction === 'bull' ? '看多' : '观察'
  const summary = '你的判断偏「' + directionText + '」，数据对账后支持度 ' + score + '/100 → ' +
    (conclusion === 'support' ? '主要证据支持这个判断' : conclusion === 'partial' ? '证据一半支持一半反对，属于分歧判断' : '证据更偏向反面，建议先观察')

  return {
    conclusion,
    score,
    summary,
    keyPoints,
    counterPoints,
    invalidation: buildInvalidation(facts),
    watch: buildWatchPoints(facts),
  }
}

/** 失效条件：直接来自数据里的可观测阈值 */
export function buildInvalidation(facts: ThesisFact[]): string[] {
  const out: string[] = []
  const levels = facts.find((fact) => fact.key === 'levels')
  if (levels) out.push('技术走坏：' + levels.detail.split('，')[0] + '，跌破最近支撑即视为判断失效')
  const sectorTrend = facts.find((fact) => fact.key === 'sector_trend')
  if (sectorTrend) out.push('板块退潮：所属板块涨停家数连续萎缩或阶段转为「退潮」')
  const fund = facts.find((fact) => fact.key === 'main_net')
  if (fund) out.push('资金转向：主力资金由净流入转为连续 2 日以上净流出')
  const event = facts.find((fact) => fact.dimension === 'event')
  if (event) out.push('催化落空：相关事件被证伪或迟迟不落地')
  if (!out.length) out.push('缺少可量化失效条件，建议补充价位或事件条件后再追踪')
  return out
}

export function buildWatchPoints(facts: ThesisFact[]): string[] {
  const out: string[] = []
  const levels = facts.find((fact) => fact.key === 'levels')
  if (levels) out.push('价位：' + levels.detail)
  const sector = facts.find((fact) => fact.key === 'sector_effect')
  if (sector) out.push('板块：' + sector.detail)
  const sentiment = facts.find((fact) => fact.key === 'phase')
  if (sentiment) out.push('情绪：' + sentiment.detail)
  return out
}

// ---------------------------------------------------------------- 相似情形（引用已有回测）

/** 引用本地已验证的回测分桶，给出「同类情形的历史样本数与胜率」，样本不足时明确说明 */
export function similarCases(pack: ThesisDataPack, style: ThesisStyle): string[] {
  const out: string[] = []
  const sectorBacktest = loadSectorTrendBacktest()
  if (sectorBacktest) {
    const stage = pack.sector?.stage
    const byStage = sectorBacktest.byStage?.find((row) => row.bucket === '板块' + stage)
    if (byStage) {
      out.push(
        '历史同类：板块阶段「' + stage + '」的涨停样本 ' + byStage.samples + ' 个，打板胜率 ' + byStage.winRate +
        '%，次日均收益 ' + byStage.averageNextChange + '%（' + sectorBacktest.startDate + ' ~ ' + sectorBacktest.endDate + '）',
      )
    }
    const trend = pack.sector?.trend
    const byTrend = sectorBacktest.bySectorTrend?.find((row) => row.bucket.includes(trend ?? '###'))
    if (byTrend) {
      out.push('历史同类：板块趋势「' + trend + '」样本 ' + byTrend.samples + ' 个，胜率 ' + byTrend.winRate + '%，均收益 ' + byTrend.averageNextChange + '%')
    }
  }
  const limitBacktest = loadLimitUpBacktest()
  if (limitBacktest && (style === 'limit_up' || style === 'leader' || style === 'relay')) {
    const overall = limitBacktest.executable?.overall
    if (overall) {
      out.push(
        '全市场打板基线：可成交口径 ' + overall.samples + ' 个样本，胜率 ' + overall.nextChangeWinRate + '%，次日均收益 ' +
        overall.averageNextChange + '%（' + limitBacktest.startDate + ' ~ ' + limitBacktest.endDate + '）',
      )
    }
  }
  if (!out.length) out.push('暂无同类历史样本（板块回测与涨停回测都还没生成，或该情形没有对应分桶）')
  return out
}

// ---------------------------------------------------------------- 落盘与结算

export function loadTheses(): ThesisFile {
  const raw = readJson<ThesisFile>(FILE)
  if (!raw || !Array.isArray(raw.items)) return { version: 1, updatedAt: Date.now(), items: [] }
  return raw
}

export function listTheses(): MyThesisRecord[] {
  return loadTheses().items.sort((a, b) => b.createdAt - a.createdAt)
}

export function saveThesis(record: MyThesisRecord): MyThesisRecord {
  const file = loadTheses()
  const items = [record, ...file.items.filter((item) => item.id !== record.id)]
  writeJson(FILE, { version: 1, updatedAt: Date.now(), items } satisfies ThesisFile)
  return record
}

export function deleteThesis(id: string): boolean {
  const file = loadTheses()
  const items = file.items.filter((item) => item.id !== id)
  if (items.length === file.items.length) return false
  writeJson(FILE, { version: 1, updatedAt: Date.now(), items } satisfies ThesisFile)
  return true
}

/** 组装一条完整记录（不落盘，供预览使用） */
export function composeThesis(input: {
  structure: ThesisStructure
  rawText: string
  pack: ThesisDataPack
  facts: ThesisFact[]
  verdict: ThesisVerdict
  claims: ThesisClaim[]
  note?: string
}): MyThesisRecord {
  const now = Date.now()
  const evaluation: ThesisEvaluation = {
    entryDate: '',
    entryPrice: 0,
    days: input.structure.horizonDays,
    status: 'pending',
  }
  return {
    id: 'thesis:' + input.structure.code + ':' + now,
    createdAt: now,
    updatedAt: now,
    author: '我',
    code: input.structure.code,
    name: input.structure.name,
    direction: input.structure.direction,
    style: input.structure.style,
    horizonDays: input.structure.horizonDays,
    rawText: input.rawText,
    claims: input.claims,
    facts: input.facts,
    verdict: input.verdict,
    sector: input.pack.sector
      ? {
          name: input.pack.sector.name,
          trend: input.pack.sector.trend,
          stage: input.pack.sector.stage,
          change5d: input.pack.sector.change5d,
          heat: input.pack.sector.heat,
          limitUpCount: input.pack.sector.limitUpCount,
        }
      : undefined,
    signalDate: sessionDateOf(Date.now()),
    evaluation,
    note: input.note,
  }
}

/**
 * 结算：次日开盘买入 → 持有 horizonDays 个交易日收盘卖出，基准用沪深 300。
 * 数据不足（未到持有期）时保持 pending。
 */
export async function settleTheses(
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<MyThesisRecord[]> {
  const file = loadTheses()
  const indexBars = await loadBars('sh000300').catch(() => [] as KLineBar[])
  let changed = false
  const items: MyThesisRecord[] = []
  for (const record of file.items) {
    if (record.evaluation.status === 'settled' && record.evaluation.exitDate) {
      items.push(record)
      continue
    }
    try {
      const bars = (await loadBars(record.code)).filter((bar) => bar.close > 0)
      if (bars.length < record.horizonDays + 2) {
        items.push(record)
        continue
      }
      const created = sessionDateOf(record.createdAt)
      const entryIndex = bars.findIndex((bar) => sessionDateOf(bar.timestamp) > created)
      if (entryIndex < 0 || entryIndex + record.horizonDays >= bars.length) {
        items.push(record)
        continue
      }
      const entry = bars[entryIndex]
      const exit = bars[entryIndex + record.horizonDays]
      const entryDate = sessionDateOf(entry.timestamp)
      const exitDate = sessionDateOf(exit.timestamp)
      const returnPct = round((exit.close / entry.open - 1) * 100, 2)
      const benchmark = benchmarkReturn(indexBars, entryDate, exitDate)
      const evaluation: ThesisEvaluation = {
        entryDate,
        entryPrice: entry.open,
        exitDate,
        exitPrice: exit.close,
        days: record.horizonDays,
        returnPct,
        benchmarkReturnPct: benchmark == null ? undefined : round(benchmark, 2),
        excessPct: benchmark == null ? undefined : round(returnPct - benchmark, 2),
        status: 'settled',
      }
      items.push({ ...record, evaluation, updatedAt: Date.now() })
      changed = true
    } catch {
      items.push(record)
    }
  }
  if (changed) writeJson(FILE, { version: 1, updatedAt: Date.now(), items } satisfies ThesisFile)
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

function benchmarkReturn(bars: KLineBar[], entryDate: string, exitDate: string): number | null {
  if (!bars.length) return null
  const entry = bars.find((bar) => sessionDateOf(bar.timestamp) === entryDate)
  const exit = bars.find((bar) => sessionDateOf(bar.timestamp) === exitDate)
  if (!entry || !exit || !entry.open) return null
  return (exit.close / entry.open - 1) * 100
}

/** 统计：我的判断整体命中情况（按方向、风格拆分，样本不足时明确标注） */
export function thesisStats(records: MyThesisRecord[]): {
  total: number
  settled: number
  pending: number
  winRate: number
  averageReturnPct: number
  averageExcessPct: number
  byStyle: Array<{ style: ThesisStyle; samples: number; winRate: number; averageExcessPct: number }>
} {
  const settled = records.filter((record) => record.evaluation.status === 'settled' && record.evaluation.excessPct != null)
  const excess = settled.map((record) => record.evaluation.excessPct as number)
  const returns = settled.map((record) => record.evaluation.returnPct ?? 0)
  const byStyle = new Map<ThesisStyle, number[]>()
  for (const record of settled) {
    const list = byStyle.get(record.style) ?? []
    list.push(record.evaluation.excessPct as number)
    byStyle.set(record.style, list)
  }
  return {
    total: records.length,
    settled: settled.length,
    pending: records.length - settled.length,
    winRate: excess.length ? round(excess.filter((value) => value > 0).length / excess.length * 100, 1) : 0,
    averageReturnPct: returns.length ? round(returns.reduce((sum, value) => sum + value, 0) / returns.length, 2) : 0,
    averageExcessPct: excess.length ? round(excess.reduce((sum, value) => sum + value, 0) / excess.length, 2) : 0,
    byStyle: [...byStyle.entries()].map(([style, values]) => ({
      style,
      samples: values.length,
      winRate: round(values.filter((value) => value > 0).length / values.length * 100, 1),
      averageExcessPct: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
    })),
  }
}

export const THESIS_DIMENSION_LABELS = DIMENSION_LABEL
export { DAY as THESIS_DAY_MS }
