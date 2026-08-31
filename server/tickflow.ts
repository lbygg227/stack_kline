/**
 * TickFlow 行情 API 客户端（服务端，Node）。
 * 文档：https://docs.tickflow.org  ·  Base: https://api.tickflow.org/v1
 * 鉴权：x-api-key 请求头。
 *
 * 该 key 权限范围（实测）：
 *  ✅ klines（日/周/月，支持前复权）、klines/intraday（分钟）、quotes（实时）、
 *     depth（五档盘口）、instruments（标的信息：涨跌停/股本）
 *  ❌ universes（全市场标的池）、financials（PE/PB 财务数据）
 *
 * API Key 仅存于服务端，前端只走 /api/* 代理，不接触 key。
 * 生产环境请用环境变量 TICKFLOW_API_KEY 注入。
 */

import type { KLineBar } from './tencent.ts'

const API_BASE = 'https://api.tickflow.org/v1'
const API_KEY = process.env.TICKFLOW_API_KEY || 'tk_fb01b600c365481e9134388f0f0458f6'

/** sh600519 -> 600519.SH；sz000001 -> 000001.SZ */
export const toTickSymbol = (code: string): string => {
  const m = code.match(/^(sh|sz|bj)(\d{6})$/)
  if (!m) return code
  return `${m[2]}.${m[1].toUpperCase()}`
}

/** 600519.SH -> sh600519 */
export const fromTickSymbol = (symbol: string): string => {
  const m = symbol.match(/^(\d{6})\.(SH|SZ|BJ)$/)
  if (!m) return symbol.toLowerCase()
  return `${m[2].toLowerCase()}${m[1]}`
}

async function tfGet(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v))
  }
  const url = `${API_BASE}${path}?${qs.toString()}`
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'x-api-key': API_KEY } })
      if (res.status === 429) throw new Error('tickflow 429 rate limited')
      const json = (await res.json()) as { code?: string; message?: string; data?: unknown }
      if (!res.ok || json.code) {
        throw new Error(json.message || json.code || `tickflow http ${res.status}`)
      }
      return json.data
    } catch (e) {
      lastErr = e
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt + Math.random() * 200))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 列式 K 线数据 */
interface ColumnKlines {
  timestamp?: number[]
  open?: number[]
  high?: number[]
  low?: number[]
  close?: number[]
  volume?: number[]
}

const columnToBars = (c: ColumnKlines): KLineBar[] => {
  if (!c?.timestamp || !c?.close) return []
  const n = c.timestamp.length
  const bars: KLineBar[] = []
  for (let i = 0; i < n; i++) {
    const ts = c.timestamp[i]
    const open = c.open?.[i]
    const high = c.high?.[i]
    const low = c.low?.[i]
    const close = c.close[i]
    const volume = c.volume?.[i]
    if (!ts || !isFinite(open as number) || !isFinite(close as number)) continue
    bars.push({
      timestamp: ts,
      open: open as number,
      high: high as number,
      low: low as number,
      close,
      volume: volume ?? 0,
    })
  }
  bars.sort((a, b) => a.timestamp - b.timestamp)
  return bars
}

/** 日/周/月 K 线（前复权） */
export async function fetchTickKlines(symbol: string, period: '1d' | '1w' | '1M', count: number): Promise<KLineBar[]> {
  const data = (await tfGet('/klines', { symbol, period, count, adjust: 'forward' })) as ColumnKlines
  return columnToBars(data)
}

/** 批量日/周/月 K 线（前复权），一次拉多只，返回 symbol -> bars */
export async function fetchTickKlinesBatch(
  symbols: string[],
  period: '1d' | '1w' | '1M',
  count: number,
): Promise<Map<string, KLineBar[]>> {
  const data = (await tfGet('/klines/batch', { symbols: symbols.join(','), period, count, adjust: 'forward' })) as
    | Record<string, ColumnKlines>
    | undefined
  const map = new Map<string, KLineBar[]>()
  if (data && typeof data === 'object') {
    for (const [sym, col] of Object.entries(data)) {
      const bars = columnToBars(col)
      if (bars.length > 0) map.set(sym, bars)
    }
  }
  return map
}

/** 当日分钟 K 线（1m/5m/15m/30m/60m） */
export async function fetchTickIntraday(symbol: string, period: '1m' | '5m' | '15m' | '30m' | '60m', count = 240): Promise<KLineBar[]> {
  const data = (await tfGet('/klines/intraday', { symbol, period, count })) as ColumnKlines
  return columnToBars(data)
}

/* ============ 报价相关 ============ */

export interface TickQuote {
  symbol: string
  last_price: number
  prev_close: number
  open: number
  high: number
  low: number
  volume: number
  amount: number
  timestamp: number
  ext?: { name?: string; change_pct?: number; change_amount?: number; amplitude?: number; turnover_rate?: number }
}

export interface TickInstrument {
  symbol: string
  name?: string
  ext?: { limit_up?: number; limit_down?: number; total_shares?: number; float_shares?: number }
}

export interface TickDepth {
  symbol: string
  bid_prices?: number[]
  bid_volumes?: number[]
  ask_prices?: number[]
  ask_volumes?: number[]
}

export async function fetchTickQuotes(symbols: string[]): Promise<TickQuote[]> {
  const data = (await tfGet('/quotes', { symbols: symbols.join(',') })) as TickQuote[]
  return Array.isArray(data) ? data : []
}

/** 按标的池拉取全市场行情（universes，如 CN_Equity_A） */
export async function fetchTickQuotesByUniverse(universe: string): Promise<TickQuote[]> {
  const data = (await tfGet('/quotes', { universes: universe })) as TickQuote[]
  return Array.isArray(data) ? data : []
}

export async function fetchTickInstruments(symbols: string[]): Promise<TickInstrument[]> {
  const data = (await tfGet('/instruments', { symbols: symbols.join(',') })) as TickInstrument[]
  return Array.isArray(data) ? data : []
}

export async function fetchTickDepth(symbols: string[]): Promise<TickDepth[]> {
  const data = (await tfGet('/depth/batch', { symbols: symbols.join(',') })) as
    | TickDepth[]
    | Record<string, TickDepth>
  if (Array.isArray(data)) return data
  return data ? Object.values(data) : []
}

/* ============ 标的池（行业分类） ============ */

export interface UniverseInfo {
  id: string
  name: string
  description?: string
  symbol_count?: number
}

export async function fetchUniverses(): Promise<UniverseInfo[]> {
  const data = (await tfGet('/universes')) as UniverseInfo[]
  return Array.isArray(data) ? data : []
}

export async function fetchUniverseMembers(id: string): Promise<string[]> {
  const data = (await tfGet(`/universes/${id}`)) as { symbols?: string[] }
  return data?.symbols ?? []
}
