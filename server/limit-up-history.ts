/**
 * 涨停池历史回算与回测。
 *
 * 目的：不依赖「等 20 个交易日积累」，直接用本地日K缓存（约 5400 只 × 2000 根，2018 年起）
 * 重算历史每一天的涨停池、连板梯队、炸板率与情绪相位，再统计：
 *   - 按板位（首板 / 2 板 / 3 板 / 最高板）的次日溢价与 3 日收益
 *   - 按情绪相位（冰点/启动/发酵/高潮/退潮）的次日溢价
 *   - 晋级率、赚钱效应的时间序列
 *
 * 口径：
 *   - 信号日 = 涨停当天；买入 = 次日开盘
 *   - 次日溢价 = 次日开盘买、次日收盘卖
 *   - 3 日收益 = 次日开盘买、T+3 收盘卖
 *   - 昨日涨停今日表现（赚钱效应）= 昨日涨停股今日收盘相对昨日收盘的涨幅
 *   - 历史无分时数据，因此不含首次封板时间；ST 状态按当前名称近似
 */

import fs from 'node:fs'
import path from 'node:path'
import type { KLineBar } from './tencent.ts'
import { readJson, writeJson } from './store.ts'
import { sessionDateOf } from './trading-day.ts'
import { classifyPhase, limitPrices, type SentimentPhase } from './limit-up.ts'

const CACHE_FILE = 'limit-up-backtest.json'
const SECTOR_FILE = 'sector-history.json'
const KLINE_DIR = 'kline-cache'
/** 板块序列保留的交易日数（约 3 个月） */
const SECTOR_SERIES_DAYS = 66

export interface DayPool {
  date: string
  /** code -> 连板高度 */
  limitUp: Record<string, number>
  limitDown: string[]
  broken: string[]
  /** 次日开盘买、次日收盘卖（%） */
  nextPremium: Record<string, number>
  /** 次日收盘相对涨停日收盘（%），即「昨日涨停今日表现」 */
  nextChange: Record<string, number>
  /** 次日开盘买、T+3 收盘卖（%） */
  hold3: Record<string, number>
  /** 打板口径：涨停日收盘买、T+3 收盘卖（%） */
  hold3FromClose: Record<string, number>
  /** 当日是否一字板（开=高=低=收），一字板按涨停价买不到 */
  sealedAllDay: Record<string, boolean>
  maxBoard: number
  ladder: Record<string, number>
}

export interface PhaseSeriesPoint {
  date: string
  phase: SentimentPhase
  score: number
  limitUpCount: number
  limitDownCount: number
  brokenCount: number
  brokenRate: number
  maxBoard: number
  /** 昨日涨停股今日平均涨幅（赚钱效应） */
  yesterdayPremium: number
  /** 昨日首板今日晋级 2 板及以上的比例 */
  promotionRate: number
  /** 当日涨停股次日平均溢价 */
  nextPremium: number
}

export interface BoardStat {
  bucket: string
  samples: number
  /** 次日开盘买、次日收盘卖（接力口径） */
  winRate: number
  averageNextPremium: number
  medianNextPremium: number
  p10: number
  p90: number
  /** 打板口径：涨停日收盘买、次日收盘卖 */
  averageNextChange: number
  nextChangeWinRate: number
  /** 次日开盘买、T+3 收盘卖 */
  averageHold3: number
  /** 打板持有 3 日：涨停日收盘买、T+3 收盘卖 */
  averageHold3FromClose: number
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
  /** 可成交口径：剔除当日一字板（买不到）与次日一字板（卖不掉/买不到） */
  executable: {
    overall: BoardStat
    byBoard: BoardStat[]
    byPhase: BoardStat[]
    excluded: number
  }
  phaseSeries: PhaseSeriesPoint[]
  notes: string[]
}

const dayOf = (timestamp: number): string => sessionDateOf(timestamp)
const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits
const average = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return round(sorted[index])
}

interface Row {
  next?: number
  nextChange?: number
  hold3?: number
  hold3FromClose?: number
  /** 当日一字板或次日一字板：不可成交 */
  blocked?: boolean
}

function stat(bucket: string, rows: Row[]): BoardStat {
  const nexts = rows.map((row) => row.next).filter((v): v is number => typeof v === 'number')
  const nextChanges = rows.map((row) => row.nextChange).filter((v): v is number => typeof v === 'number')
  const holds = rows.map((row) => row.hold3).filter((v): v is number => typeof v === 'number')
  const holdsFromClose = rows.map((row) => row.hold3FromClose).filter((v): v is number => typeof v === 'number')
  return {
    bucket,
    samples: nexts.length,
    winRate: nexts.length ? round(nexts.filter((value) => value > 0).length / nexts.length * 100, 1) : 0,
    averageNextPremium: round(average(nexts)),
    medianNextPremium: percentile(nexts, 0.5),
    p10: percentile(nexts, 0.1),
    p90: percentile(nexts, 0.9),
    averageNextChange: round(average(nextChanges)),
    nextChangeWinRate: nextChanges.length ? round(nextChanges.filter((value) => value > 0).length / nextChanges.length * 100, 1) : 0,
    averageHold3: round(average(holds)),
    averageHold3FromClose: round(average(holdsFromClose)),
  }
}

interface CacheFile {
  bars?: KLineBar[]
}

/** 用日K缓存重算历史涨停池：单遍遍历，内存只保留按日聚合的小记录 */
export async function rebuildDailyPools(options: {
  startDate?: string
  endDate?: string
  onProgress?: (done: number, total: number) => void
  nameOf?: (code: string) => string | undefined
  /** 标的的板块归属，用于产出每日每板块聚合（只统计最近 sectorDays 个交易日） */
  metaOf?: (code: string) => { industry?: string; concepts?: string[] }
  /** 板块聚合保留的交易日数，默认 66 */
  sectorDays?: number
} = {}): Promise<{ pools: DayPool[]; universe: number; sectorDays: SectorDayAggregate[] }> {
  const dir = path.join(process.cwd(), 'data', KLINE_DIR)
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('_day.json'))
  } catch {
    return { pools: [], universe: 0, sectorDays: [] }
  }

  type Bucket = {
    limitUp: Map<string, number>
    limitDown: Set<string>
    broken: Set<string>
    nextPremium: Map<string, number>
    nextChange: Map<string, number>
    hold3: Map<string, number>
    hold3FromClose: Map<string, number>
    sealedAllDay: Map<string, boolean>
  }
  const poolMap = new Map<string, Bucket>()
  const ensure = (date: string): Bucket => {
    let bucket = poolMap.get(date)
    if (!bucket) {
      bucket = {
        limitUp: new Map(),
        limitDown: new Set(),
        broken: new Set(),
        nextPremium: new Map(),
        nextChange: new Map(),
        hold3: new Map(),
        hold3FromClose: new Map(),
        sealedAllDay: new Map(),
      }
      poolMap.set(date, bucket)
    }
    return bucket
  }

  // 每日每板块聚合：day -> key -> 统计
  type DaySectorBucket = { count: number; maxBoard: number; stocks: number; changeSum: number; amount: number; upCount: number; downCount: number }
  const sectorAgg = new Map<string, Map<string, DaySectorBucket>>()
  const bumpSector = (date: string, key: string, board: number, changePct: number, amount: number) => {
    let day = sectorAgg.get(date)
    if (!day) {
      day = new Map()
      sectorAgg.set(date, day)
    }
    const bucket = day.get(key) ?? { count: 0, maxBoard: 0, stocks: 0, changeSum: 0, amount: 0, upCount: 0, downCount: 0 }
    bucket.stocks += 1
    bucket.changeSum += changePct
    bucket.amount += amount
    if (changePct > 0) bucket.upCount += 1
    else if (changePct < 0) bucket.downCount += 1
    if (board > 0) {
      bucket.count += 1
      bucket.maxBoard = Math.max(bucket.maxBoard, board)
    }
    day.set(key, bucket)
  }

  let done = 0
  let universe = 0
  for (const file of files) {
    const code = file.replace('_day.json', '')
    if (!/^(sh|sz|bj)\d{6}$/.test(code)) { done++; continue }
    const cached = readJson<CacheFile>(`${KLINE_DIR}/${file}`)
    const bars = (cached?.bars ?? []).filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
    if (bars.length < 30) { done++; continue }
    universe++
    const name = options.nameOf?.(code) ?? ''
    const meta = options.metaOf?.(code)
    const sectorKeys: string[] = []
    if (meta?.industry) sectorKeys.push('industry:' + meta.industry)
    for (const concept of meta?.concepts ?? []) sectorKeys.push('concept:' + concept)
    let board = 0
    for (let i = 1; i < bars.length; i++) {
      const date = dayOf(bars[i].timestamp)
      const prices = limitPrices(bars[i - 1].close, code, name)
      if (!prices) continue
      const bar = bars[i]
      const isUp = bar.close >= prices.up - 0.005
      const isDown = bar.close <= prices.down + 0.005
      if (sectorKeys.length) {
        const prevClose = bars[i - 1].close
        const changePct = prevClose > 0 ? (bar.close / prevClose - 1) * 100 : 0
        for (const key of sectorKeys) bumpSector(date, key, isUp ? board + 1 : 0, changePct, bar.volume * bar.close)
      }
      if (isUp) {
        board += 1
        const pool = ensure(date)
        pool.limitUp.set(code, board)
        // 一字板：开盘即涨停且全天未打开，打板价买不到
        pool.sealedAllDay.set(code, bar.open >= prices.up - 0.005 && bar.low >= prices.up - 0.005)
        const next = bars[i + 1]
        if (next && next.open > 0) {
          pool.nextPremium.set(code, (next.close / next.open - 1) * 100)
          if (bar.close > 0) pool.nextChange.set(code, (next.close / bar.close - 1) * 100)
          const third = bars[i + 3]
          if (third) {
            pool.hold3.set(code, (third.close / next.open - 1) * 100)
            if (bar.close > 0) pool.hold3FromClose.set(code, (third.close / bar.close - 1) * 100)
          }
        }
      } else {
        board = 0
        if (bar.high >= prices.up - 0.005) ensure(date).broken.add(code)
        if (isDown) ensure(date).limitDown.add(code)
      }
    }
    done++
    if (done % 500 === 0) options.onProgress?.(done, files.length)
  }
  options.onProgress?.(done, files.length)

  const pools: DayPool[] = []
  for (const [date, bucket] of [...poolMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (options.startDate && date < options.startDate) continue
    if (options.endDate && date > options.endDate) continue
    const ladder: Record<string, number> = {}
    let maxBoard = 0
    for (const value of bucket.limitUp.values()) {
      ladder[String(value)] = (ladder[String(value)] ?? 0) + 1
      maxBoard = Math.max(maxBoard, value)
    }
    pools.push({
      date,
      limitUp: Object.fromEntries(bucket.limitUp),
      limitDown: [...bucket.limitDown],
      broken: [...bucket.broken],
      nextPremium: Object.fromEntries(bucket.nextPremium),
      nextChange: Object.fromEntries(bucket.nextChange),
      hold3: Object.fromEntries(bucket.hold3),
      hold3FromClose: Object.fromEntries(bucket.hold3FromClose),
      sealedAllDay: Object.fromEntries(bucket.sealedAllDay),
      maxBoard,
      ladder,
    })
  }
  // 只保留最近 N 个交易日的板块聚合
  const keepDays = Math.max(5, Math.min(240, options.sectorDays ?? SECTOR_SERIES_DAYS))
  const recentDates = [...new Set(pools.map((pool) => pool.date))].slice(-keepDays)
  const keep = new Set(recentDates)
  const sectorDayList: SectorDayAggregate[] = []
  for (const [date, day] of sectorAgg) {
    if (!keep.has(date)) continue
    for (const [key, bucket] of day) {
      const [type, name] = key.split(':') as ['industry' | 'concept', string]
      if (name === '其他') continue
      sectorDayList.push({
        date,
        name,
        type,
        count: bucket.count,
        maxBoard: bucket.maxBoard,
        avgChangePct: Number((bucket.changeSum / Math.max(1, bucket.stocks)).toFixed(2)),
        amountYi: Number((bucket.amount / 1e8).toFixed(1)),
        upCount: bucket.upCount,
        downCount: bucket.downCount,
      })
    }
  }
  return { pools, universe, sectorDays: sectorDayList }
}

export interface BacktestOptions {
  minSamples?: number
  universe?: number
}

/** 基于历史涨停池，输出按板位与情绪相位的溢价统计 */
export function backtestLimitUpPools(pools: DayPool[], options: BacktestOptions = {}): LimitUpBacktest {
  const minSamples = Math.max(1, options.minSamples ?? 20)
  const series: PhaseSeriesPoint[] = []
  const boardRows = new Map<string, Row[]>()
  const phaseRows = new Map<SentimentPhase, Row[]>()
  const overallRows: Row[] = []

  for (let index = 0; index < pools.length; index++) {
    const pool = pools[index]
    const previous = pools[index - 1]
    const limitUpCount = Object.keys(pool.limitUp).length
    const total = limitUpCount + pool.broken.length
    const brokenRate = total ? pool.broken.length / total * 100 : 0

    const yesterdayPremium = previous ? average(Object.values(previous.nextChange)) : 0
    let promotionRate = 0
    if (previous) {
      const prevFirst = Object.values(previous.limitUp).filter((board) => board === 1).length
      const promoted = Object.keys(previous.limitUp).filter((code) => (pool.limitUp[code] ?? 0) >= 2).length
      promotionRate = prevFirst ? promoted / prevFirst * 100 : 0
    }
    const nextPremium = average(Object.values(pool.nextPremium))

    const classified = classifyPhase({
      limitUpCount,
      limitDownCount: pool.limitDown.length,
      brokenCount: pool.broken.length,
      maxBoard: pool.maxBoard,
      yesterdayPremium,
      hasPrevious: Boolean(previous),
    })
    series.push({
      date: pool.date,
      phase: classified.phase,
      score: classified.score,
      limitUpCount,
      limitDownCount: pool.limitDown.length,
      brokenCount: pool.broken.length,
      brokenRate: round(brokenRate, 1),
      maxBoard: pool.maxBoard,
      yesterdayPremium: round(yesterdayPremium),
      promotionRate: round(promotionRate, 1),
      nextPremium: round(nextPremium),
    })

    const nextPool = pools[index + 1]
    for (const [code, board] of Object.entries(pool.limitUp)) {
      const row: Row = {
        next: pool.nextPremium[code],
        nextChange: pool.nextChange[code],
        hold3: pool.hold3[code],
        hold3FromClose: pool.hold3FromClose[code],
        // 当日一字板买不到；次日一字板（次日也是涨停且一字）则卖不掉/买不到
        blocked: Boolean(pool.sealedAllDay[code]) || Boolean(nextPool?.sealedAllDay[code]),
      }
      const bucket = board >= 5 ? '5板及以上' : board + '板'
      const list = boardRows.get(bucket) ?? []
      list.push(row)
      boardRows.set(bucket, list)
      const phaseList = phaseRows.get(classified.phase) ?? []
      phaseList.push(row)
      phaseRows.set(classified.phase, phaseList)
      overallRows.push(row)
    }
  }

  const byBoard = [...boardRows.entries()]
    .map(([bucket, rows]) => stat(bucket, rows))
    .filter((item) => item.samples >= minSamples)
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
  const byPhase = (['冰点', '启动', '发酵', '高潮', '退潮'] as SentimentPhase[])
    .map((phase) => stat(phase, phaseRows.get(phase) ?? []))
    .filter((item) => item.samples >= minSamples)

  const executableRows = overallRows.filter((row) => !row.blocked)
  const executableBoard = new Map<string, Row[]>()
  const executablePhase = new Map<SentimentPhase, Row[]>()
  for (let index = 0; index < pools.length; index++) {
    const pool = pools[index]
    const phase = series[index]?.phase
    if (!phase) continue
    for (const [code, board] of Object.entries(pool.limitUp)) {
      const isBlocked = Boolean(pool.sealedAllDay[code]) || Boolean(pools[index + 1]?.sealedAllDay[code])
      if (isBlocked) continue
      const row: Row = {
        next: pool.nextPremium[code],
        nextChange: pool.nextChange[code],
        hold3: pool.hold3[code],
        hold3FromClose: pool.hold3FromClose[code],
      }
      const bucket = board >= 5 ? '5板及以上' : board + '板'
      const list = executableBoard.get(bucket) ?? []
      list.push(row)
      executableBoard.set(bucket, list)
      const phaseList = executablePhase.get(phase) ?? []
      phaseList.push(row)
      executablePhase.set(phase, phaseList)
    }
  }

  return {
    generatedAt: Date.now(),
    startDate: pools[0]?.date ?? '',
    endDate: pools[pools.length - 1]?.date ?? '',
    tradingDays: pools.length,
    universe: options.universe ?? 0,
    overall: stat('全部涨停股', overallRows),
    byBoard,
    byPhase,
    executable: {
      overall: stat('可成交样本', executableRows),
      byBoard: [...executableBoard.entries()]
        .map(([bucket, rows]) => stat(bucket, rows))
        .filter((item) => item.samples >= minSamples)
        .sort((a, b) => a.bucket.localeCompare(b.bucket)),
      byPhase: (['冰点', '启动', '发酵', '高潮', '退潮'] as SentimentPhase[])
        .map((phase) => stat(phase, executablePhase.get(phase) ?? []))
        .filter((item) => item.samples >= minSamples),
      excluded: overallRows.length - executableRows.length,
    },
    phaseSeries: series,
    notes: [
      '次日溢价 = 次日开盘买、次日收盘卖（接力口径）；打板收益 = 涨停日收盘买、次日收盘卖',
      '可成交口径剔除当日一字板（买不到）与次日一字板（买不到/卖不掉），更接近实际可执行的收益',
      '历史无分时数据，不含首次封板时间与封单质量；ST 状态按当前名称近似',
      '样本仅覆盖仍有本地日K的标的，退市股缺失，存在幸存者偏差（真实打板胜率应低于此）',
      '次日开盘买入假设能成交：一字板次日通常买不到，实际收益会低于统计值',
    ],
  }
}

export interface SectorSeriesPoint {
  date: string
  /** 该板块当日涨停家数 */
  count: number
  maxBoard: number
  /** 板块成员当日平均涨幅（%） */
  avgChangePct: number
  /** 板块成员当日成交额（亿元） */
  amountYi: number
  upCount: number
  downCount: number
}

/** 每日每板块的行情聚合（重建历史池时顺带产出） */
export interface SectorDayAggregate {
  date: string
  name: string
  type: 'industry' | 'concept'
  count: number
  maxBoard: number
  avgChangePct: number
  amountYi: number
  upCount: number
  downCount: number
}

export interface SectorSeries {
  name: string
  type: 'industry' | 'concept'
  points: SectorSeriesPoint[]
}

export interface SectorHistoryFile {
  version: 1
  updatedAt: number
  startDate: string
  endDate: string
  /** 交易日升序 */
  dates: string[]
  sectors: SectorSeries[]
}

export interface SectorTrend {
  name: string
  type: 'industry' | 'concept'
  today: number
  yesterday: number
  avgRecent: number
  avgPrevious: number
  /** 连续出现（有涨停）的交易日数 */
  streak: number
  /** 窗口内首次出现日期 */
  firstDate: string
  /** 窗口内有涨停的交易日占比（活跃度） */
  activeRatio: number
  trend: '升温' | '持平' | '退潮'
  deltaPct: number
  series: number[]
}

/** 由历史涨停池 + 当前标的元信息，产出每日板块涨停家数序列 */
export function buildSectorSeries(
  pools: DayPool[],
  metaOf: (code: string) => { industry?: string; concepts?: string[] },
  options: { days?: number; sectorDays?: SectorDayAggregate[] } = {},
): SectorHistoryFile {
  const days = Math.max(5, Math.min(240, options.days ?? SECTOR_SERIES_DAYS))
  const recent = pools.slice(-days)
  const dates = recent.map((pool) => pool.date)
  const map = new Map<string, SectorSeries>()
  // 每日每板块的行情聚合：涨停家数之外，还要看板块整体涨幅与成交额
  const dailyByKey = new Map<string, Map<string, { stocks: number; changeSum: number; amount: number; upCount: number; downCount: number }>>()
  for (const item of options.sectorDays ?? []) {
    if (!dates.includes(item.date)) continue
    let day = dailyByKey.get(item.date)
    if (!day) {
      day = new Map()
      dailyByKey.set(item.date, day)
    }
    day.set(item.type + ':' + item.name, {
      stocks: item.upCount + item.downCount,
      changeSum: item.avgChangePct * Math.max(1, item.upCount + item.downCount),
      amount: item.amountYi * 1e8,
      upCount: item.upCount,
      downCount: item.downCount,
    })
  }
  for (const pool of recent) {
    const counted = new Map<string, { count: number; maxBoard: number }>()
    for (const [code, board] of Object.entries(pool.limitUp)) {
      const meta = metaOf(code)
      const names: Array<{ name: string; type: 'industry' | 'concept' }> = []
      if (meta.industry) names.push({ name: meta.industry, type: 'industry' })
      for (const concept of meta.concepts ?? []) names.push({ name: concept, type: 'concept' })
      for (const entry of names) {
        const key = entry.type + ':' + entry.name
        const current = counted.get(key) ?? { count: 0, maxBoard: 0 }
        current.count += 1
        current.maxBoard = Math.max(current.maxBoard, board)
        counted.set(key, current)
      }
    }
    const daily = dailyByKey.get(pool.date)
    for (const [key, value] of counted) {
      const [type, name] = key.split(':') as ['industry' | 'concept', string]
      const series = map.get(key) ?? { name, type, points: [] }
      const market = daily?.get(key)
      series.points.push({
        date: pool.date,
        count: value.count,
        maxBoard: value.maxBoard,
        avgChangePct: market ? Number((market.changeSum / Math.max(1, market.stocks)).toFixed(2)) : 0,
        amountYi: market ? Number((market.amount / 1e8).toFixed(1)) : 0,
        upCount: market?.upCount ?? 0,
        downCount: market?.downCount ?? 0,
      })
      map.set(key, series)
    }
  }
  // 补齐「当天没有涨停、但有成员交易」的板块：轮动分析需要看到全部板块的涨跌，
  // 否则资金流出榜永远为空（没涨停的板块根本不在序列里）。
  for (const [date, day] of dailyByKey) {
    for (const [key, value] of day) {
      const [type, name] = key.split(':') as ['industry' | 'concept', string]
      let series = map.get(key)
      if (!series) {
        series = { name, type, points: [] }
        map.set(key, series)
      }
      if (series.points.some((point) => point.date === date)) continue
      series.points.push({
        date,
        count: 0,
        maxBoard: 0,
        avgChangePct: Number((value.changeSum / Math.max(1, value.stocks)).toFixed(2)),
        amountYi: Number((value.amount / 1e8).toFixed(1)),
        upCount: value.upCount,
        downCount: value.downCount,
      })
    }
  }
  for (const series of map.values()) {
    series.points.sort((a, b) => a.date.localeCompare(b.date))
  }
  const sectors = [...map.values()]
    .filter((series) => series.points.length >= 5)
    .sort((a, b) => (b.points.at(-1)?.amountYi ?? 0) - (a.points.at(-1)?.amountYi ?? 0))
    .slice(0, 400)
  return {
    version: 1,
    updatedAt: Date.now(),
    startDate: dates[0] ?? '',
    endDate: dates.at(-1) ?? '',
    dates,
    sectors,
  }
}

export function saveSectorHistory(file: SectorHistoryFile): void {
  writeJson(SECTOR_FILE, file)
}

export function loadSectorHistory(): SectorHistoryFile | null {
  const raw = readJson<SectorHistoryFile>(SECTOR_FILE)
  if (!raw || raw.version !== 1) return null
  return raw
}

/** 计算板块趋势：近 3 日均值 vs 前 3 日均值 */
export function computeSectorTrends(file: SectorHistoryFile, options: { limit?: number } = {}): SectorTrend[] {
  const limit = Math.max(1, Math.min(200, options.limit ?? 60))
  const dates = file.dates
  const trends: SectorTrend[] = []
  for (const sector of file.sectors) {
    const byDate = new Map(sector.points.map((point) => [point.date, point.count]))
    const series = dates.map((date) => byDate.get(date) ?? 0)
    const last = series.at(-1) ?? 0
    if (!last) continue
    const yesterday = series.at(-2) ?? 0
    const recent = series.slice(-3)
    const previous = series.slice(-6, -3)
    const avgRecent = average(recent)
    const avgPrevious = previous.length ? average(previous) : avgRecent
    let streak = 0
    for (let index = series.length - 1; index >= 0; index--) {
      if (series[index] > 0) streak++
      else break
    }
    const firstIndex = series.findIndex((value) => value > 0)
    const deltaPct = avgPrevious > 0 ? (avgRecent - avgPrevious) / avgPrevious * 100 : (avgRecent > 0 ? 100 : 0)
    const trend: SectorTrend['trend'] = deltaPct >= 25 && avgRecent >= 2
      ? '升温'
      : deltaPct <= -25 || (last === 0)
        ? '退潮'
        : '持平'
    trends.push({
      name: sector.name,
      type: sector.type,
      today: last,
      yesterday,
      avgRecent: Number(avgRecent.toFixed(2)),
      avgPrevious: Number(avgPrevious.toFixed(2)),
      streak,
      firstDate: firstIndex >= 0 ? dates[firstIndex] : '',
      activeRatio: Number((series.filter((value) => value > 0).length / Math.max(1, series.length) * 100).toFixed(1)),
      trend,
      deltaPct: Number(deltaPct.toFixed(1)),
      series: series.slice(-20),
    })
  }
  return trends
    .filter((item) => item.name !== '其他')
    .sort((a, b) => b.today - a.today || b.deltaPct - a.deltaPct)
    .slice(0, limit)
}

export interface SectorBucketStat {
  bucket: string
  samples: number
  winRate: number
  averageNextChange: number
  medianNextChange: number
  averageHold3FromClose: number
}

export interface SectorTrendBacktest {
  generatedAt: number
  startDate: string
  endDate: string
  /** 参与统计的涨停样本数 */
  samples: number
  /** 按「信号日所属板块的前一日趋势」分桶 */
  bySectorTrend: SectorBucketStat[]
  /** 按「信号日该板块涨停家数」分桶 */
  bySectorCount: SectorBucketStat[]
  /** 按「板块内是否龙头」分桶（仅统计有涨停的板块） */
  byLeader: SectorBucketStat[]
  conclusion: string[]
}

const bucketStat = (bucket: string, rows: Row[]): SectorBucketStat => {
  const changes = rows.map((row) => row.nextChange).filter((value): value is number => typeof value === 'number')
  const holds = rows.map((row) => row.hold3FromClose).filter((value): value is number => typeof value === 'number')
  return {
    bucket,
    samples: changes.length,
    winRate: changes.length ? Number((changes.filter((value) => value > 0).length / changes.length * 100).toFixed(1)) : 0,
    averageNextChange: Number(average(changes).toFixed(2)),
    medianNextChange: percentile(changes, 0.5),
    averageHold3FromClose: Number(average(holds).toFixed(2)),
  }
}

/**
 * 板块趋势 × 次日溢价的统计验证。
 *
 * 对每个涨停样本，取「信号日所属板块在前一交易日的趋势」（近 3 日涨停家数 vs 前 3 日），
 * 按趋势分桶统计打板收益（涨停日收盘买、次日收盘卖），回答：
 *   板块在升温时打板，收益是否真的更高？板块内涨停家数越多是否越好？
 */
export function backtestSectorTrend(
  pools: DayPool[],
  sectorSeries: SectorHistoryFile,
  options: { minSamples?: number; sectorKeysOf?: Map<string, string[]> } = {},
): SectorTrendBacktest {
  const sectorKeysOf = options.sectorKeysOf ?? new Map<string, string[]>()
  const minSamples = Math.max(1, options.minSamples ?? 30)
  const byTrend = new Map<string, Row[]>()
  const byCount = new Map<string, Row[]>()
  const byLeader = new Map<string, Row[]>()
  let samples = 0

  // (date, sectorKey) -> 该日涨停家数；并据此算「前一交易日趋势」
  const countByDate = new Map<string, Map<string, number>>()
  for (const sector of sectorSeries.sectors) {
    const key = sector.type + ':' + sector.name
    for (const point of sector.points) {
      let day = countByDate.get(point.date)
      if (!day) {
        day = new Map()
        countByDate.set(point.date, day)
      }
      day.set(key, point.count)
    }
  }
  const dates = sectorSeries.dates
  const indexOfDate = new Map(dates.map((date, index) => [date, index]))

  const trendOf = (dateIndex: number, key: string): { delta: number; count: number } | null => {
    if (dateIndex < 3) return null
    const series: number[] = []
    for (let i = Math.max(0, dateIndex - 5); i <= dateIndex; i++) {
      series.push(countByDate.get(dates[i])?.get(key) ?? 0)
    }
    if (series.length < 4) return null
    const recent = series.slice(-3)
    const previous = series.slice(-6, -3)
    const avgRecent = average(recent)
    const avgPrevious = previous.length ? average(previous) : avgRecent
    const delta = avgPrevious > 0 ? (avgRecent - avgPrevious) / avgPrevious * 100 : (avgRecent > 0 ? 100 : 0)
    return { delta, count: series.at(-1) ?? 0 }
  }

  for (const pool of pools) {
    const dateIndex = indexOfDate.get(pool.date)
    if (dateIndex == null) continue
    for (const code of Object.keys(pool.limitUp)) {
      const row: Row = {
        nextChange: pool.nextChange[code],
        hold3FromClose: pool.hold3FromClose[code],
        blocked: Boolean(pool.sealedAllDay[code]),
      }
      if (row.nextChange == null) continue
      samples++
      const keys = sectorKeysOf.get(code) ?? []
      if (!keys.length) continue

      // 取该股所属板块中「当下最强」的那个（涨停家数最多，其次趋势最高）
      let best: { key: string; count: number; delta: number } | null = null
      for (const key of keys) {
        const trend = trendOf(dateIndex, key)
        if (!trend) continue
        if (!best || trend.count > best.count || (trend.count === best.count && trend.delta > best.delta)) {
          best = { key, count: trend.count, delta: trend.delta }
        }
      }
      if (!best) continue

      const trendBucket = best.delta >= 50 ? '板块升温（+50%以上）' : best.delta >= 10 ? '板块温和升温' : best.delta > -25 ? '板块持平' : '板块退潮'
      const countBucket = best.count >= 8 ? '板块 ≥8 家涨停' : best.count >= 4 ? '板块 4-7 家涨停' : best.count >= 2 ? '板块 2-3 家涨停' : '板块仅 1 家涨停'
      push(byTrend, trendBucket, row)
      push(byCount, countBucket, row)
      push(byLeader, best.count >= 4 ? '热门板块内' : '冷门板块内', row)
    }
  }

  const order = ['板块升温（+50%以上）', '板块温和升温', '板块持平', '板块退潮']
  const countOrder = ['板块 ≥8 家涨停', '板块 4-7 家涨停', '板块 2-3 家涨停', '板块仅 1 家涨停']
  const bySectorTrend = order.map((bucket) => bucketStat(bucket, byTrend.get(bucket) ?? [])).filter((item) => item.samples >= minSamples)
  const bySectorCount = countOrder.map((bucket) => bucketStat(bucket, byCount.get(bucket) ?? [])).filter((item) => item.samples >= minSamples)
  const leaderStats = [...byLeader.entries()].map(([bucket, rows]) => bucketStat(bucket, rows)).filter((item) => item.samples >= minSamples)

  const rising = bySectorTrend.find((item) => item.bucket.includes('升温（+50'))
  const falling = bySectorTrend.find((item) => item.bucket === '板块退潮')
  const many = bySectorCount.find((item) => item.bucket.includes('≥8'))
  const few = bySectorCount.find((item) => item.bucket.includes('仅 1 家'))
  const conclusion: string[] = []
  if (rising && falling) {
    const gap = rising.averageNextChange - falling.averageNextChange
    conclusion.push(
      '板块升温样本打板均收益 ' + rising.averageNextChange + '%（胜率 ' + rising.winRate + '%），' +
      '退潮样本 ' + falling.averageNextChange + '%（胜率 ' + falling.winRate + '%），差 ' + gap.toFixed(2) + 'pct',
    )
  }
  if (many && few) {
    conclusion.push(
      '板块 ≥8 家涨停时打板均收益 ' + many.averageNextChange + '%，仅 1 家涨停时 ' + few.averageNextChange + '%',
    )
  }
  conclusion.push('口径：涨停日收盘买、次日收盘卖；板块归属按当前行业/概念映射近似（历史概念可能已变化）')

  return {
    generatedAt: Date.now(),
    startDate: sectorSeries.startDate,
    endDate: sectorSeries.endDate,
    samples,
    bySectorTrend,
    bySectorCount,
    byLeader: leaderStats,
    conclusion,
  }
}

function push(map: Map<string, Row[]>, key: string, row: Row): void {
  const list = map.get(key) ?? []
  list.push(row)
  map.set(key, list)
}

export interface SectorRotationItem {
  name: string
  type: 'industry' | 'concept'
  /** 今日板块平均涨幅 */
  todayChangePct: number
  /** 近 5 日累计平均涨幅 */
  change5d: number
  /** 今日成交额（亿元）与近 5 日均值 */
  amountYi: number
  amountAvg5: number
  /** 成交额相对 5 日均值的倍数（放量程度） */
  amountRatio: number
  /** 今日涨停家数与昨日对比 */
  count: number
  countDelta: number
  /** 今日在全市场板块中的涨幅排名（1 = 最强） */
  rank: number
  rankYesterday: number
  /** 排名变化：正数表示资金在往这个板块切 */
  rankDelta: number
  /** 上涨家数占比 */
  upRatio: number
  /** 轮动评分 0-100：涨幅 + 放量 + 排名上升 */
  score: number
}

/** 板块轮动：看资金今天在往哪个板块切、从哪里撤 */
export function computeSectorRotation(file: SectorHistoryFile, options: { limit?: number } = {}): SectorRotationItem[] {
  const limit = Math.max(1, Math.min(100, options.limit ?? 30))
  const dates = file.dates
  const today = dates.at(-1)
  const yesterday = dates.at(-2)
  const items: SectorRotationItem[] = []

  for (const sector of file.sectors) {
    const byDate = new Map(sector.points.map((point) => [point.date, point]))
    const todayPoint = today ? byDate.get(today) : undefined
    if (!todayPoint) continue
    const yesterdayPoint = yesterday ? byDate.get(yesterday) : undefined
    const last5 = dates.slice(-5).map((date) => byDate.get(date)).filter((point): point is SectorSeriesPoint => Boolean(point))
    const change5d = last5.reduce((sum, point) => sum + point.avgChangePct, 0)
    const amountAvg5 = average(last5.map((point) => point.amountYi))
    const amountRatio = amountAvg5 > 0 ? todayPoint.amountYi / amountAvg5 : 1
    const totalStocks = todayPoint.upCount + todayPoint.downCount
    items.push({
      name: sector.name,
      type: sector.type,
      todayChangePct: todayPoint.avgChangePct,
      change5d: Number(change5d.toFixed(2)),
      amountYi: todayPoint.amountYi,
      amountAvg5: Number(amountAvg5.toFixed(1)),
      amountRatio: Number(amountRatio.toFixed(2)),
      count: todayPoint.count,
      countDelta: todayPoint.count - (yesterdayPoint?.count ?? 0),
      rank: 0,
      rankYesterday: 0,
      rankDelta: 0,
      upRatio: totalStocks ? Number((todayPoint.upCount / totalStocks * 100).toFixed(1)) : 0,
      score: 0,
    })
  }

  // 排名：今日与昨日分别按涨幅排名，差值即「轮动」
  const rankedToday = [...items].sort((a, b) => b.todayChangePct - a.todayChangePct)
  const rankToday = new Map(rankedToday.map((item, index) => [item.type + ':' + item.name, index + 1]))
  const rankedYesterday = [...items].sort((a, b) => {
    const aSeries = file.sectors.find((sector) => sector.type === a.type && sector.name === a.name)
    const bSeries = file.sectors.find((sector) => sector.type === b.type && sector.name === b.name)
    const aPrev = aSeries?.points.find((point) => point.date === yesterday)?.avgChangePct ?? 0
    const bPrev = bSeries?.points.find((point) => point.date === yesterday)?.avgChangePct ?? 0
    return bPrev - aPrev
  })
  const rankYesterdayMap = new Map(rankedYesterday.map((item, index) => [item.type + ':' + item.name, index + 1]))

  for (const item of items) {
    const key = item.type + ':' + item.name
    item.rank = rankToday.get(key) ?? items.length
    item.rankYesterday = rankYesterdayMap.get(key) ?? items.length
    item.rankDelta = item.rankYesterday - item.rank
    item.score = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          40 * Math.min(1, Math.max(0, (item.todayChangePct + 2) / 6)) +
          25 * Math.min(1, Math.max(0, (item.amountRatio - 0.8) / 0.8)) +
          20 * Math.min(1, Math.max(0, (item.rankDelta + 20) / 40)) +
          15 * Math.min(1, Math.max(0, item.upRatio / 100)),
        ),
      ),
    )
  }

  return items.sort((a, b) => b.score - a.score).slice(0, limit)
}

export function saveLimitUpBacktest(result: LimitUpBacktest): void {
  writeJson(CACHE_FILE, result)
}

const SECTOR_BACKTEST_FILE = 'sector-backtest.json'

export function saveSectorTrendBacktest(result: SectorTrendBacktest): void {
  writeJson(SECTOR_BACKTEST_FILE, result)
}

export function loadSectorTrendBacktest(): SectorTrendBacktest | null {
  const raw = readJson<SectorTrendBacktest>(SECTOR_BACKTEST_FILE)
  if (!raw || !Array.isArray(raw.bySectorTrend)) return null
  return raw
}

export function loadLimitUpBacktest(): LimitUpBacktest | null {
  return readJson<LimitUpBacktest>(CACHE_FILE)
}
