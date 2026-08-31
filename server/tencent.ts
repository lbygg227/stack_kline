/**
 * 服务端 K 线读取（数据源：TickFlow）+ 本地磁盘缓存。
 * - 日/周/月/分钟全支持；数据落盘 data/kline-cache/{code}_{period}.json
 * - 一次拉取完整历史（日/周/月各 500 根、分钟当日 240 根），无需分页
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
}

/** 带磁盘缓存的 K 线读取（start/end 分页参数已废弃，TickFlow 一次拉全历史） */
export async function getKlineWithCache(
  code: string,
  period: string,
  _count = 500,
  _start = '',
  _end = '',
): Promise<KLineBar[]> {
  const cfg = PERIOD_CFG[period] ?? PERIOD_CFG.day
  const cacheKey = `${code}_${period}`
  const cached = readJson<KlineCacheFile>(`kline-cache/${cacheKey}.json`)
  if (cached && cached.bars.length > 0 && Date.now() - cached.fetchedAt < 30 * 60 * 1000) {
    return cached.bars
  }
  const symbol = toTickSymbol(code)
  const bars =
    cfg.kind === 'klines'
      ? await fetchTickKlines(symbol, cfg.p, cfg.count)
      : await fetchTickIntraday(symbol, cfg.p, cfg.count)
  if (bars.length > 0) {
    writeJson(`kline-cache/${cacheKey}.json`, { fetchedAt: Date.now(), bars })
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
          writeJson(`kline-cache/${code}_${period}.json`, { fetchedAt: Date.now(), bars })
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
