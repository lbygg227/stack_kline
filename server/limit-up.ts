/**
 * 涨停板与情绪周期引擎（P4 核心模块）。
 *
 * A 股板块启动的现实路径：某只个股涨停打出辨识度 → 同板块跟风 → 连板梯队形成 → 分歧退潮。
 * 本模块把这条链路的可量化部分做成结构化数据，供推荐系统直接使用：
 *   1. 精确涨跌停判定（主板 10% / 科创板·创业板 20% / 北交所 30% / ST 5%）
 *   2. 连板高度、炸板、首次封板时间
 *   3. 板块梯队（申万行业 + 东财概念）与辨识度评分
 *   4. 情绪相位（冰点/启动/发酵/高潮/退潮）与晋级率、昨日溢价
 */

import type { SnapshotStock } from './eastmoney.ts'
import type { KLineBar } from './tencent.ts'
import { readJson, writeJson } from './store.ts'

const HISTORY_FILE = 'limit-up-history.json'
const SNAPSHOT_FILE = 'limit-up-latest.json'
const MAX_HISTORY_DAYS = 60

/** 涨跌幅限制 */
export function limitRatio(code: string, name = ''): number {
  const lower = code.toLowerCase()
  const upperName = name.toUpperCase()
  if (lower.startsWith('bj')) return 0.3
  if (lower.startsWith('sh688')) return 0.2
  if (lower.startsWith('sz300') || lower.startsWith('sz301')) return 0.2
  // ST 主板 5%；ST 创业板/科创板仍是 20%（上面已返回）
  if (/ST/.test(upperName)) return 0.05
  return 0.1
}

const round2 = (value: number): number => Math.round(value * 100) / 100

export interface LimitPrices {
  up: number
  down: number
}

export function limitPrices(prevClose: number, code: string, name = ''): LimitPrices | null {
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null
  const ratio = limitRatio(code, name)
  return { up: round2(prevClose * (1 + ratio)), down: round2(prevClose * (1 - ratio)) }
}

export type BoardState = 'limit_up' | 'limit_down' | 'broken' | 'normal'

export interface BoardItem {
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
  /** 连板高度：1=首板 */
  board: number
  /** 首次封板时间 HH:mm（仅有分时数据时） */
  firstSealAt?: string
  /** 炸板次数 */
  breakCount?: number
  /** 辨识度评分 0-100 */
  recognition: number
  /** 该股所属板块中涨停家数最多的板块名 */
  topSector?: string
  topSectorCount?: number
  /** 板块龙头（辨识度第一）时为 true */
  isSectorLeader: boolean
}

export interface SectorBoard {
  key: string
  type: 'industry' | 'concept'
  name: string
  limitUpCount: number
  maxBoard: number
  avgChangePct: number
  totalAmount: number
  leaderCode: string
  leaderName: string
  /** 板块内涨停股代码（按板数、辨识度排序） */
  members: string[]
}

export type SentimentPhase = '冰点' | '启动' | '发酵' | '高潮' | '退潮'

export interface Sentiment {
  limitUpCount: number
  limitDownCount: number
  brokenCount: number
  /** 炸板率 = 炸板 /（涨停 + 炸板） */
  brokenRate: number
  maxBoard: number
  /** 昨日涨停今日仍涨停的比例 */
  promotionRate: number
  /** 昨日涨停股今日平均涨幅（打板赚钱效应） */
  yesterdayPremium: number
  phase: SentimentPhase
  score: number
  reasons: string[]
}

export interface LimitUpBoard {
  date: string
  generatedAt: number
  limitUp: BoardItem[]
  limitDown: BoardItem[]
  broken: BoardItem[]
  ladder: Record<string, number>
  sectors: SectorBoard[]
  sentiment: Sentiment
}

interface HistoryDay {
  date: string
  limitUp: Array<{ code: string; name: string; board: number; industry?: string; concepts: string[] }>
  sentiment: Sentiment
}

interface HistoryFile {
  version: 1
  days: HistoryDay[]
}

const dayOf = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10)

/** 连板高度：从最后一根 K 线往前数连续涨停天数 */
export function countBoards(bars: KLineBar[], code: string, name = '', limit = bars.length): number {
  let count = 0
  for (let index = bars.length - 1; index >= 1 && count < limit; index--) {
    const current = bars[index]
    const prev = bars[index - 1]
    const prices = limitPrices(prev.close, code, name)
    if (!prices) break
    const isLimitUp = current.close >= prices.up - 0.005
    const isLimitDown = current.close <= prices.down + 0.005
    if (isLimitUp) count++
    else if (isLimitDown) break
    else break
  }
  return count
}

/** 当日状态判定 */
export function classifyBoardState(stock: SnapshotStock): BoardState {
  const prices = limitPrices(stock.prevClose, stock.code, stock.name)
  if (!prices) return 'normal'
  if (stock.price >= prices.up - 0.005) return 'limit_up'
  if (stock.price <= prices.down + 0.005) return 'limit_down'
  if (stock.high >= prices.up - 0.005) return 'broken'
  return 'normal'
}

/**
 * 首次封板时间与炸板次数（基于 1 分钟 K 线）。
 *
 * 判定用 low 而不是 close：封板期间成交极少，数据源的分钟收盘价常出现 40.29 这类
 * 「差一分钱」的抖动，用 close 判会把整段封板期误判成反复炸板。
 * low 低于涨停价才说明这一分钟里真的成交在涨停价之下（即开板）。
 */
export function sealStats(intraday: KLineBar[], upPrice: number): { firstSealAt?: string; breakCount: number } {
  let firstIndex = -1
  let breakCount = 0
  let sealed = false
  for (let index = 0; index < intraday.length; index++) {
    const bar = intraday[index]
    const isSealed = bar.low >= upPrice - 0.005
    if (isSealed && !sealed) {
      sealed = true
      if (firstIndex < 0) firstIndex = index
      continue
    }
    if (!isSealed && sealed) {
      breakCount++
      sealed = false
    }
  }
  if (firstIndex < 0) return { breakCount }
  const timestamp = intraday[firstIndex].timestamp
  const date = new Date(timestamp + 8 * 3600_000)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return { firstSealAt: hh + ':' + mm, breakCount }
}

function sealScore(firstSealAt?: string): number {
  if (!firstSealAt) return 6
  const [hh, mm] = firstSealAt.split(':').map(Number)
  const minutes = hh * 60 + mm
  // 09:30-10:00 最强，尾盘最弱
  if (minutes <= 10 * 60) return 15
  if (minutes <= 10 * 60 + 30) return 13
  if (minutes <= 11 * 60 + 30) return 10
  if (minutes <= 13 * 60 + 30) return 7
  if (minutes <= 14 * 60 + 30) return 4
  return 2
}

export interface BuildBoardOptions {
  /** 预先算好的连板高度（code -> 板数） */
  boardCounts?: Map<string, number>
  /** 预先算好的封板信息（code -> 首次封板时间/炸板次数） */
  sealInfo?: Map<string, { firstSealAt?: string; breakCount?: number }>
  now?: number
}

/** 从全市场快照构建当日涨停板与情绪 */
export function buildLimitUpBoard(stocks: SnapshotStock[], options: BuildBoardOptions = {}): LimitUpBoard {
  const now = options.now ?? Date.now()
  const limitUpStocks: SnapshotStock[] = []
  const limitDownStocks: SnapshotStock[] = []
  const brokenStocks: SnapshotStock[] = []
  for (const stock of stocks) {
    if (!stock.price || stock.price <= 0) continue
    const state = classifyBoardState(stock)
    if (state === 'limit_up') limitUpStocks.push(stock)
    else if (state === 'limit_down') limitDownStocks.push(stock)
    else if (state === 'broken') brokenStocks.push(stock)
  }

  const index = new Map(stocks.map((stock) => [stock.code, stock]))
  const toItem = (stock: SnapshotStock, board: number): BoardItem => ({
    code: stock.code,
    name: stock.name,
    industry: stock.industry,
    concepts: (stock.concepts ?? []).slice(0, 8),
    price: stock.price,
    changePct: Number(stock.changePct.toFixed(2)),
    amount: stock.amount,
    turnover: Number(stock.turnover.toFixed(2)),
    volumeRatio: Number(stock.volumeRatio.toFixed(2)),
    mainNetInflow: stock.mainNetInflow ?? 0,
    limitRatio: limitRatio(stock.code, stock.name),
    board,
    recognition: 0,
    isSectorLeader: false,
  })

  const limitUp = limitUpStocks.map((stock) => {
    const item = toItem(stock, options.boardCounts?.get(stock.code) ?? 1)
    const seal = options.sealInfo?.get(stock.code)
    if (seal) {
      item.firstSealAt = seal.firstSealAt
      item.breakCount = seal.breakCount
    }
    return item
  })
  const limitDown = limitDownStocks.map((stock) => toItem(stock, 1))
  const broken = brokenStocks.map((stock) => {
    const item = toItem(stock, 1)
    const seal = options.sealInfo?.get(stock.code)
    if (seal) {
      item.firstSealAt = seal.firstSealAt
      item.breakCount = seal.breakCount
    }
    return item
  })

  // 板块聚合（行业 + 概念），用于辨识度与梯队
  const sectorMap = new Map<string, SectorBoard>()
  const bump = (type: SectorBoard['type'], name: string, item: BoardItem, stock: SnapshotStock) => {
    if (!name) return
    const key = type + ':' + name
    const sector = sectorMap.get(key) ?? {
      key,
      type,
      name,
      limitUpCount: 0,
      maxBoard: 0,
      avgChangePct: 0,
      totalAmount: 0,
      leaderCode: '',
      leaderName: '',
      members: [],
    }
    sector.limitUpCount += 1
    sector.maxBoard = Math.max(sector.maxBoard, item.board)
    sector.avgChangePct += item.changePct
    sector.totalAmount += stock.amount
    sector.members.push(item.code)
    sectorMap.set(key, sector)
  }
  for (const item of limitUp) {
    const stock = index.get(item.code)
    if (!stock) continue
    if (item.industry) bump('industry', item.industry, item, stock)
    for (const concept of item.concepts) bump('concept', concept, item, stock)
  }

  // 辨识度：连板 40 + 板块涨停家数 20 + 成交额排名 20 + 封板时间 15（无分时给 6）+ 炸板扣分 5
  const sortedByAmount = [...limitUp].sort((a, b) => b.amount - a.amount)
  const amountRank = new Map(sortedByAmount.map((item, i) => [item.code, i]))
  for (const item of limitUp) {
    const bestSector = [...sectorMap.values()]
      .filter((sector) => sector.members.includes(item.code))
      .sort((a, b) => b.limitUpCount - a.limitUpCount || b.maxBoard - a.maxBoard)[0]
    item.topSector = bestSector?.name
    item.topSectorCount = bestSector?.limitUpCount
    const boardScore = Math.min(40, item.board * 14)
    const sectorScore = bestSector ? Math.min(20, bestSector.limitUpCount * 4) : 0
    const rank = amountRank.get(item.code) ?? sortedByAmount.length
    const amountScore = Math.max(0, 20 - (rank / Math.max(1, sortedByAmount.length)) * 20)
    // 封板时间 15 分（无分时数据给 6 分），炸板每次扣 2 分
    const seal = sealScore(item.firstSealAt ?? (item.board >= 2 ? '10:00' : undefined))
    const breakPenalty = (item.breakCount ?? 0) * 2
    item.recognition = Math.max(0, Math.round(boardScore + sectorScore + amountScore + seal - breakPenalty))
  }

  // 板块龙头 = 板块内辨识度最高
  for (const sector of sectorMap.values()) {
    const members = sector.members
      .map((code) => limitUp.find((item) => item.code === code))
      .filter((item): item is BoardItem => Boolean(item))
      .sort((a, b) => b.recognition - a.recognition || b.board - a.board)
    if (!members.length) continue
    members[0].isSectorLeader = true
    sector.leaderCode = members[0].code
    sector.leaderName = members[0].name
    sector.members = members.map((item) => item.code)
    sector.avgChangePct = Number((sector.avgChangePct / sector.limitUpCount).toFixed(2))
  }

  const ladder: Record<string, number> = {}
  for (const item of limitUp) ladder[String(item.board)] = (ladder[String(item.board)] ?? 0) + 1

  return {
    date: dayOf(now),
    generatedAt: now,
    limitUp: limitUp.sort((a, b) => b.recognition - a.recognition || b.amount - a.amount),
    limitDown,
    broken,
    ladder,
    sectors: [...sectorMap.values()].sort((a, b) => b.limitUpCount - a.limitUpCount || b.maxBoard - a.maxBoard).slice(0, 40),
    sentiment: {
      limitUpCount: limitUp.length,
      limitDownCount: limitDown.length,
      brokenCount: broken.length,
      brokenRate: 0,
      maxBoard: limitUp.reduce((max, item) => Math.max(max, item.board), 0),
      promotionRate: 0,
      yesterdayPremium: 0,
      phase: '启动',
      score: 50,
      reasons: [],
    },
  }
}

export function loadBoardHistory(): HistoryFile {
  const raw = readJson<HistoryFile>(HISTORY_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.days)) return { version: 1, days: [] }
  return raw
}

export function saveBoardHistory(file: HistoryFile): void {
  writeJson(HISTORY_FILE, { version: 1, days: file.days.slice(0, MAX_HISTORY_DAYS) })
}

export interface SentimentInput {
  board: LimitUpBoard
  /** 昨日涨停名单（来自历史归档） */
  previousLimitUp?: Array<{ code: string; board: number }>
  /** 昨日全部涨停数（用于晋级率分母） */
  previousLimitUpCount?: number
  stocks: SnapshotStock[]
}

/** 计算情绪相位、晋级率与昨日溢价 */
export function computeSentiment(input: SentimentInput): Sentiment {
  const { board, stocks } = input
  const stockMap = new Map(stocks.map((stock) => [stock.code, stock]))
  const total = board.limitUp.length + board.broken.length
  const brokenRate = total ? board.broken.length / total * 100 : 0
  const maxBoard = board.limitUp.reduce((max, item) => Math.max(max, item.board), 0)

  const previous = input.previousLimitUp ?? []
  let promotionRate = 0
  let yesterdayPremium = 0
  if (previous.length) {
    const boardMap = new Map(board.limitUp.map((item) => [item.code, item]))
    const promoted = previous.filter((item) => boardMap.has(item.code)).length
    promotionRate = promoted / previous.length * 100
    const changes = previous
      .map((item) => stockMap.get(item.code)?.changePct)
      .filter((value): value is number => typeof value === 'number')
    yesterdayPremium = changes.length ? changes.reduce((sum, v) => sum + v, 0) / changes.length : 0
  }

  const reasons: string[] = []
  let score = 50
  // 赚钱效应：昨日涨停今日溢价
  if (previous.length) {
    if (yesterdayPremium >= 3) {
      score += 18
      reasons.push('昨日涨停股今日平均 +' + yesterdayPremium.toFixed(1) + '%，打板赚钱效应强')
    } else if (yesterdayPremium >= 0) {
      score += 8
      reasons.push('昨日涨停股今日平均 ' + yesterdayPremium.toFixed(1) + '%，赚钱效应一般')
    } else {
      score -= 18
      reasons.push('昨日涨停股今日平均 ' + yesterdayPremium.toFixed(1) + '%，亏钱效应')
    }
  }
  if (board.limitUp.length >= 100) {
    score += 16
    reasons.push('涨停 ' + board.limitUp.length + ' 家，市场情绪高涨')
  } else if (board.limitUp.length >= 60) {
    score += 10
    reasons.push('涨停 ' + board.limitUp.length + ' 家，情绪偏强')
  } else if (board.limitUp.length < 30) {
    score -= 14
    reasons.push('涨停仅 ' + board.limitUp.length + ' 家，情绪低迷')
  }
  if (brokenRate >= 45) {
    score -= 15
    reasons.push('炸板率 ' + brokenRate.toFixed(0) + '%，分歧加剧')
  } else if (brokenRate > 0 && brokenRate <= 20) {
    score += 8
    reasons.push('炸板率仅 ' + brokenRate.toFixed(0) + '%，封板质量高')
  }
  if (maxBoard >= 5) {
    score += 10
    reasons.push('最高 ' + maxBoard + ' 连板，空间打开')
  } else if (maxBoard <= 2) {
    score -= 8
    reasons.push('最高仅 ' + maxBoard + ' 板，缺乏空间')
  }
  if (board.limitDown.length >= 30) {
    score -= 20
    reasons.push('跌停 ' + board.limitDown.length + ' 家，下杀明显')
  }
  score = Math.max(0, Math.min(100, Math.round(score)))

  let phase: SentimentPhase
  if (previous.length && (yesterdayPremium <= -2 || board.limitDown.length >= 40)) phase = '退潮'
  else if (brokenRate >= 45 && board.limitUp.length >= 40) phase = '退潮'
  else if (score < 35) phase = '冰点'
  else if (score >= 78 && (board.limitUp.length >= 90 || maxBoard >= 5)) phase = '高潮'
  else if (score >= 62) phase = '发酵'
  else phase = '启动'

  return {
    limitUpCount: board.limitUp.length,
    limitDownCount: board.limitDown.length,
    brokenCount: board.broken.length,
    brokenRate: Number(brokenRate.toFixed(1)),
    maxBoard,
    promotionRate: Number(promotionRate.toFixed(1)),
    yesterdayPremium: Number(yesterdayPremium.toFixed(2)),
    phase,
    score,
    reasons,
  }
}

/** 情绪相位 -> 各风格推荐权重系数 */
export const PHASE_STYLE_MULTIPLIER: Record<SentimentPhase, Record<string, number>> = {
  冰点: { limit_up: 0.85, leader: 0.7, relay: 0.9, pullback: 1.15, trend: 1.0, event: 1.0, fund: 1.05, opinion: 1.0 },
  启动: { limit_up: 1.15, leader: 1.0, relay: 1.2, pullback: 1.05, trend: 1.05, event: 1.0, fund: 1.05, opinion: 1.0 },
  发酵: { limit_up: 1.1, leader: 1.2, relay: 1.1, pullback: 1.0, trend: 1.05, event: 1.0, fund: 1.0, opinion: 1.0 },
  高潮: { limit_up: 1.0, leader: 1.15, relay: 0.85, pullback: 0.9, trend: 1.0, event: 1.0, fund: 1.0, opinion: 1.0 },
  退潮: { limit_up: 0.7, leader: 0.6, relay: 0.75, pullback: 1.2, trend: 1.05, event: 1.05, fund: 1.05, opinion: 1.05 },
}

/** 保存完整看板快照：服务重启后推荐接口可直接复用，无需重算 15s */
export function saveBoardSnapshot(board: LimitUpBoard): void {
  writeJson(SNAPSHOT_FILE, board)
}

export function loadBoardSnapshot(): LimitUpBoard | null {
  const raw = readJson<LimitUpBoard>(SNAPSHOT_FILE)
  if (!raw || !Array.isArray(raw.limitUp)) return null
  return raw
}

/** 记录当天涨停梯队，供次日计算晋级率与溢价 */
export function archiveBoard(board: LimitUpBoard): void {
  saveBoardSnapshot(board)
  const file = loadBoardHistory()
  const day: HistoryDay = {
    date: board.date,
    limitUp: board.limitUp.map((item) => ({
      code: item.code,
      name: item.name,
      board: item.board,
      industry: item.industry,
      concepts: item.concepts.slice(0, 3),
    })),
    sentiment: board.sentiment,
  }
  const days = [day, ...file.days.filter((item) => item.date !== board.date)]
  saveBoardHistory({ version: 1, days })
}

/** 并发受限执行 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export interface BoardLoaders {
  loadBars: (code: string) => Promise<KLineBar[]>
  loadIntraday?: (code: string) => Promise<KLineBar[]>
  /** 分析分时数据的股票数上限（按成交额排序，默认 40） */
  intradayLimit?: number
}

/**
 * 完整构建当日涨停板：连板高度 + 封板时间 + 情绪相位 + 归档。
 * 连板高度需要对每只涨停股回溯日 K（涨停股通常 30~120 只，可接受）。
 */
export async function buildLimitUpBoardFull(
  stocks: SnapshotStock[],
  loaders: BoardLoaders,
  now = Date.now(),
): Promise<LimitUpBoard> {
  const prelim = buildLimitUpBoard(stocks, { now })
  const boardCounts = new Map<string, number>()
  await mapLimit(prelim.limitUp, 6, async (item) => {
    try {
      const bars = await loaders.loadBars(item.code)
      const sorted = bars.filter((bar) => bar.close > 0).sort((a, b) => a.timestamp - b.timestamp)
      boardCounts.set(item.code, Math.max(1, countBoards(sorted, item.code, item.name)))
    } catch {
      boardCounts.set(item.code, 1)
    }
  })

  const sealInfo = new Map<string, { firstSealAt?: string; breakCount?: number }>()
  if (loaders.loadIntraday) {
    const limit = Math.max(0, Math.min(80, loaders.intradayLimit ?? 40))
    const targets = [...prelim.limitUp].sort((a, b) => b.amount - a.amount).slice(0, limit)
    await mapLimit(targets, 4, async (item) => {
      try {
        const bars = await loaders.loadIntraday!(item.code)
        const prices = limitPrices(stocks.find((stock) => stock.code === item.code)?.prevClose ?? 0, item.code, item.name)
        if (!prices || !bars.length) return
        sealInfo.set(item.code, sealStats(bars, prices.up))
      } catch {
        /* 分时不可用则忽略 */
      }
    })
  }

  const board = buildLimitUpBoard(stocks, { boardCounts, sealInfo, now })
  board.sentiment = computeSentiment({
    board,
    stocks,
    previousLimitUp: previousLimitUpList(board),
    previousLimitUpCount: undefined,
  })
  archiveBoard(board)
  return board
}

export function previousLimitUpList(board: LimitUpBoard): Array<{ code: string; board: number }> {
  const file = loadBoardHistory()
  const previous = file.days.find((item) => item.date < board.date)
  return previous ? previous.limitUp.map((item) => ({ code: item.code, board: item.board })) : []
}
