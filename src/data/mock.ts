import type { KLineBar, Quote } from '../types'
import { stockNameOf } from './stocks'

/** 稳定伪随机：同一股票代码每次生成相同数据，保证页面刷新后 K 线一致 */
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randn(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const r2 = (n: number) => Math.round(n * 100) / 100

function isTradingDay(d: Date): boolean {
  const dow = d.getDay()
  return dow !== 0 && dow !== 6
}

/** 最近的交易日（不含今天，避免盘中数据干扰） */
function lastTradingDay(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - 1)
  while (!isTradingDay(d)) d.setDate(d.getDate() - 1)
  return d
}

function basePriceOf(code: string): number {
  return 6 + (hashStr(code + ':base') % 2400) / 10 // 6 ~ 246 元
}

/** 生成日 K（不含节假日，从最近交易日往前推） */
export function generateDailyBars(code: string, count = 320): KLineBar[] {
  const rng = mulberry32(hashStr(code + ':daily'))
  let price = basePriceOf(code)
  const bars: KLineBar[] = []
  const d = new Date(lastTradingDay())
  while (bars.length < count) {
    if (isTradingDay(d)) {
      const open = price * (1 + (rng() - 0.5) * 0.02)
      const close = open * (1 + randn(rng) * 0.024)
      const high = Math.max(open, close) * (1 + rng() * 0.014)
      const low = Math.min(open, close) * (1 - rng() * 0.014)
      price = close
      bars.unshift({
        timestamp: d.getTime(),
        open: r2(open),
        high: r2(high),
        low: r2(low),
        close: r2(close),
        volume: Math.round(1e5 + rng() * 9.8e6),
      })
    }
    d.setDate(d.getDate() - 1)
  }
  return bars
}

/** 生成当日分钟 K（9:30-11:30 / 13:00-15:00 共 240 根） */
export function generateMinuteBars(code: string, count = 240): KLineBar[] {
  const rng = mulberry32(hashStr(code + ':minute'))
  const prev = generateDailyBars(code, 30)
  const base = prev[prev.length - 1]?.close ?? basePriceOf(code)
  let price = base * (1 - 0.006 + rng() * 0.012)
  const day = lastTradingDay()
  const bars: KLineBar[] = []
  const slots: Array<[number, number]> = []
  for (let i = 0; i < 120; i++) slots.push([9, 30 + i])
  for (let i = 0; i < 120; i++) slots.push([13, i])
  for (const [h, m] of slots) {
    if (bars.length >= count) break
    const open = price
    const close = open * (1 + randn(rng) * 0.0011)
    const high = Math.max(open, close) * (1 + rng() * 0.0009)
    const low = Math.min(open, close) * (1 - rng() * 0.0009)
    price = close
    bars.push({
      timestamp: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime(),
      open: r2(open),
      high: r2(high),
      low: r2(low),
      close: r2(close),
      volume: Math.round(2e3 + rng() * 2e5),
    })
  }
  return bars
}

/** 生成实时报价（基于最近一根日 K） */
export function generateQuote(code: string): Quote {
  const rng = mulberry32(hashStr(code + ':quote:' + Math.floor(Date.now() / 15000)))
  const daily = generateDailyBars(code, 60)
  const last = daily[daily.length - 1]
  const prev = daily[daily.length - 2] ?? last
  const base = last.close
  const price = r2(base * (1 + (rng() - 0.5) * 0.008))
  const open = r2(prev.close * (1 + (rng() - 0.5) * 0.01))
  const high = r2(Math.max(price, open) * (1 + rng() * 0.006))
  const low = r2(Math.min(price, open) * (1 - rng() * 0.006))
  const step = Math.max(0.01, r2(base * 0.001))
  const bids = Array.from({ length: 5 }, (_, i) => ({
    price: r2(price - step * (i + 1)),
    volume: Math.round(50 + rng() * 5000),
  }))
  const asks = Array.from({ length: 5 }, (_, i) => ({
    price: r2(price + step * (i + 1)),
    volume: Math.round(50 + rng() * 5000),
  }))
  const mktCapFloat = r2((base * (1e8 + rng() * 4.9e9)) / 1e8)
  return {
    code,
    name: stockNameOf(code),
    price,
    prevClose: prev.close,
    open,
    high,
    low,
    change: r2(price - prev.close),
    changePct: r2(((price - prev.close) / prev.close) * 100),
    volume: Math.round(2e5 + rng() * 2e6),
    amount: r2((price * (2e5 + rng() * 2e6) * 100) / 1e4),
    turnover: r2(0.5 + rng() * 4.5),
    amplitude: r2(((high - low) / prev.close) * 100),
    volumeRatio: r2(0.5 + rng() * 2.5),
    pe: r2(8 + rng() * 60),
    pb: r2(0.8 + rng() * 10),
    mktCapFloat,
    mktCapTotal: r2(mktCapFloat * (1.1 + rng() * 2)),
    upLimit: r2(base * 1.1),
    downLimit: r2(base * 0.9),
    bids,
    asks,
    time: new Date().toISOString().replace(/[-T:Z]/g, '').slice(0, 14),
  }
}
