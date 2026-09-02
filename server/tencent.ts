/**
 * 服务端 K 线读取（数据源：TickFlow）+ 本地磁盘缓存。
 * - 日/周/月/分钟全支持；数据落盘 data/kline-cache/{code}_{period}.json
 * - 日/周/月最多按需拉取 10000 根，支持 start/end 时间区间
 * - 保留 batchKlines 供全量预取 / 策略引擎共用
 */

import { readJson, writeJson } from './store.ts'
import {
  fetchTickIntraday,
  fetchTickKlines,
  fetchTickKlinesBatch,
  toTickSymbol,
} from './tickflow.ts'

export interface KLineBar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type PeriodCfg =
  | { kind: 'klines'; p: '1d' | '1w' | '1M'; count: number }
  | { kind: 'intraday'; p: '1m' | '5m' | '15m' | '30m' | '60m'; count: number }

const PERIOD_CFG: Record<string, PeriodCfg> = {
  day: { kind: 'klines', p: '1d', count: 500 },
  week: { kind: 'klines', p: '1w', count: 500 },
  month: { kind: 'klines', p: '1M', count: 500 },
  m1: { kind: 'intraday', p: '1m', count: 240 },
  m5: { kind: 'intraday', p: '5m', count: 240 },
  m15: { kind: 'intraday', p: '15m', count: 240 },
  m30: { kind: 'intraday', p: '30m', count: 240 },
  m60: { kind: 'intraday', p: '60m', count: 240 },
}

interface KlineCacheFile {
  fetchedAt: number
  bars: KLineBar[]
  period?: string
  adjust?: 'forward'
  requestedCount?: number
  firstTimestamp?: number
  lastTimestamp?: number
}

const parseTime = (value: string, endOfDay = false): number | undefined => {
  if (!value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
  const parsed = Date.parse(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999` : value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const cachePayload = (period: string, requestedCount: number, bars: KLineBar[]): KlineCacheFile => ({
  fetchedAt: Date.now(),
  period,
  adjust: 'forward',
  requestedCount,
  firstTimestamp: bars[0]?.timestamp,
  lastTimestamp: bars.at(-1)?.timestamp,
  bars,
})

/** 带磁盘缓存的 K 线读取，日/周/月可按数量或时间区间获取。 */
export async function getKlineWithCache(
  code: string,
  period: string,
  count = 500,
  start = '',
  end = '',
): Promise<KLineBar[]> {
  const cfg = PERIOD_CFG[period] ?? PERIOD_CFG.day
  const cacheKey = `${code}_${period}`
  const cached = readJson<KlineCacheFile>(`kline-cache/${cacheKey}.json`)
  const requestedCount = cfg.kind === 'klines'
    ? Math.max(1, Math.min(10_000, Math.round(count || cfg.count)))
    : Math.max(1, Math.min(cfg.count, Math.round(count || cfg.count)))
  const startTime = parseTime(start)
  const endTime = parseTime(end, true)
  const isFresh = cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000
  if (isFresh && cached.bars.length > 0 && !startTime && !endTime && cached.bars.length >= requestedCount) {
    return cached.bars.slice(-requestedCount)
  }
  const symbol = toTickSymbol(code)
  const bars =
    cfg.kind === 'klines'
      ? await fetchTickKlines(symbol, cfg.p, requestedCount, startTime, endTime)
      : await fetchTickIntraday(symbol, cfg.p, requestedCount)
  if (bars.length > 0) {
    const merged = startTime || endTime
      ? [...new Map([...(cached?.bars ?? []), ...bars].map((bar) => [bar.timestamp, bar])).values()]
          .sort((a, b) => a.timestamp - b.timestamp)
      : bars
    writeJson(`kline-cache/${cacheKey}.json`, cachePayload(period, requestedCount, merged))
  }
  return bars
}

/** 并发受限的批量 K 线拉取（预取任务用）：日/周/月走 TickFlow 批量端点（50 只/次），写磁盘缓存 */
export async function batchKlines(
  codes: string[],
  period: string,
  _count = 500,
  _concurrency = 4,
  onOne?: (done: number, total: number, failed: number) => void,
): Promise<Map<string, KLineBar[]>> {
  const cfg = PERIOD_CFG[period] ?? PERIOD_CFG.day
  const result = new Map<string, KLineBar[]>()
  let done = 0
  let failed = 0
  const CHUNK = 50

  // 已缓存的直接复用
  const toFetch: string[] = []
  for (const code of codes) {
    const cached = readJson<KlineCacheFile>(`kline-cache/${code}_${period}.json`)
    if (cached && cached.bars.length > 0 && Date.now() - cached.fetchedAt < 30 * 60 * 1000) {
      result.set(code, cached.bars)
      done++
      onOne?.(done, codes.length, failed)
    } else {
      toFetch.push(code)
    }
  }

  for (let i = 0; i < toFetch.length; i += CHUNK) {
    const chunk = toFetch.slice(i, i + CHUNK)
    try {
      let barsMap: Map<string, KLineBar[]>
      if (cfg.kind === 'klines') {
        barsMap = await fetchTickKlinesBatch(chunk.map(toTickSymbol), cfg.p, cfg.count)
      } else {
        barsMap = new Map()
        for (const code of chunk) {
          const bars = await fetchTickIntraday(toTickSymbol(code), cfg.p, cfg.count)
          barsMap.set(toTickSymbol(code), bars)
        }
      }
      for (const code of chunk) {
        const bars = barsMap.get(toTickSymbol(code))
        if (bars && bars.length > 0) {
          result.set(code, bars)
          writeJson(`kline-cache/${code}_${period}.json`, cachePayload(period, cfg.count, bars))
        } else {
          failed++
        }
        done++
        onOne?.(done, codes.length, failed)
      }
    } catch {
      chunk.forEach(() => {
        failed++
        done++
        onOne?.(done, codes.length, failed)
      })
    }
    await new Promise((r) => setTimeout(r, 120))
  }

  return result
}

export interface KlineCoverage {
  code: string
  period: string
  bars: number
  firstDate?: string
  lastDate?: string
  fetchedAt?: number
  adjust: 'forward'
  status?: 'current' | 'stale' | 'missing'
}

const timestampMs = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp

const marketDate = (timestamp: number | undefined): string | undefined => timestamp
  ? new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestampMs(timestamp)))
  : undefined

const shanghaiClock = (timestamp = Date.now()): { date: string; minutes: number } => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  }
}

/** 以大盘实际日线为交易日锚点；15:05 前不把当日未完成日线视为完整数据。 */
export async function getExpectedLatestTradingDate(now = Date.now()): Promise<string | undefined> {
  const bars = await fetchTickKlines(toTickSymbol('sh000001'), '1d', 5)
  const dates = [...new Set(bars.map((bar) => marketDate(bar.timestamp)).filter(Boolean))] as string[]
  const clock = shanghaiClock(now)
  if (clock.minutes < 15 * 60 + 5 && dates.at(-1) === clock.date) return dates.at(-2)
  return dates.at(-1)
}

export function getKlineCoverage(
  codes: string[],
  period = 'day',
  expectedDate?: string,
): KlineCoverage[] {
  return codes.map((code) => {
    const cached = readJson<KlineCacheFile>(`kline-cache/${code}_${period}.json`)
    const first = cached?.bars[0]?.timestamp
    const last = cached?.bars.at(-1)?.timestamp
    const lastDate = marketDate(last)
    return {
      code,
      period,
      bars: cached?.bars.length ?? 0,
      firstDate: marketDate(first),
      lastDate,
      fetchedAt: cached?.fetchedAt,
      adjust: 'forward',
      status: !lastDate ? 'missing' : expectedDate && lastDate < expectedDate ? 'stale' : 'current',
    }
  })
}

export interface LatestKlineSyncItem {
  code: string
  status: 'current' | 'synced' | 'unavailable' | 'failed'
  lastDateBefore?: string
  lastDateAfter?: string
  barsAdded: number
  error?: string
}

export interface LatestKlineSyncResult {
  expectedDate?: string
  checkedAt: number
  summary: { total: number; current: number; synced: number; unavailable: number; failed: number }
  items: LatestKlineSyncItem[]
}

/** 强制拉取最近日线并与本地历史合并，用于检测和补齐缓存尾部及近期缺口。 */
export async function syncLatestDailyKlines(codes: string[]): Promise<LatestKlineSyncResult> {
  const uniqueCodes = [...new Set(codes.map((code) => code.toLowerCase()))]
    .filter((code) => /^(sh|sz|bj)\d{6}$/.test(code))
    .slice(0, 6000)
  const expectedDate = await getExpectedLatestTradingDate()
  const items: LatestKlineSyncItem[] = []
  const CHUNK = 50

  for (let i = 0; i < uniqueCodes.length; i += CHUNK) {
    const chunk = uniqueCodes.slice(i, i + CHUNK)
    try {
      // 主动检测只需覆盖近期交易日；完整历史由“全量预取”负责。
      const fetched = await fetchTickKlinesBatch(chunk.map(toTickSymbol), '1d', 20)
      for (const code of chunk) {
        const cached = readJson<KlineCacheFile>(`kline-cache/${code}_day.json`)
        const oldBars = cached?.bars ?? []
        const oldTimestamps = new Set(oldBars.map((bar) => bar.timestamp))
        const incoming = fetched.get(toTickSymbol(code)) ?? []
        const lastDateBefore = marketDate(oldBars.at(-1)?.timestamp)
        if (!incoming.length) {
          items.push({
            code,
            status: 'unavailable',
            lastDateBefore,
            lastDateAfter: lastDateBefore,
            barsAdded: 0,
          })
          continue
        }
        const merged = [...new Map([...oldBars, ...incoming].map((bar) => [bar.timestamp, bar])).values()]
          .sort((a, b) => a.timestamp - b.timestamp)
        const barsAdded = incoming.filter((bar) => !oldTimestamps.has(bar.timestamp)).length
        writeJson(`kline-cache/${code}_day.json`, cachePayload('day', Math.max(500, merged.length), merged))
        const lastDateAfter = marketDate(merged.at(-1)?.timestamp)
        const caughtUp = !expectedDate || Boolean(lastDateAfter && lastDateAfter >= expectedDate)
        items.push({
          code,
          status: !caughtUp ? 'unavailable' : barsAdded > 0 ? 'synced' : 'current',
          lastDateBefore,
          lastDateAfter,
          barsAdded,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      chunk.forEach((code) => items.push({ code, status: 'failed', barsAdded: 0, error: message }))
    }
    if (i + CHUNK < uniqueCodes.length) await new Promise((resolve) => setTimeout(resolve, 120))
  }

  return {
    expectedDate,
    checkedAt: Date.now(),
    summary: {
      total: items.length,
      current: items.filter((item) => item.status === 'current').length,
      synced: items.filter((item) => item.status === 'synced').length,
      unavailable: items.filter((item) => item.status === 'unavailable').length,
      failed: items.filter((item) => item.status === 'failed').length,
    },
    items,
  }
}
