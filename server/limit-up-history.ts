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
const KLINE_DIR = 'kline-cache'

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
} = {}): Promise<{ pools: DayPool[]; universe: number }> {
  const dir = path.join(process.cwd(), 'data', KLINE_DIR)
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('_day.json'))
  } catch {
    return { pools: [], universe: 0 }
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
    let board = 0
    for (let i = 1; i < bars.length; i++) {
      const date = dayOf(bars[i].timestamp)
      const prices = limitPrices(bars[i - 1].close, code, name)
      if (!prices) continue
      const bar = bars[i]
      const isUp = bar.close >= prices.up - 0.005
      const isDown = bar.close <= prices.down + 0.005
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
  return { pools, universe }
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

export function saveLimitUpBacktest(result: LimitUpBacktest): void {
  writeJson(CACHE_FILE, result)
}

export function loadLimitUpBacktest(): LimitUpBacktest | null {
  return readJson<LimitUpBacktest>(CACHE_FILE)
}
