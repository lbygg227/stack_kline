/**
 * 技术指标公共库（服务端）。
 * 供 strategy.ts（选股）与 analysis.ts（个股分析）复用。
 */

export const sma = (values: number[], period: number): (number | null)[] => {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export const ema = (values: number[], period: number): number[] => {
  const out: number[] = new Array(values.length).fill(0)
  if (values.length === 0) return out
  out[0] = values[0]
  const k = 2 / (period + 1)
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k)
  }
  return out
}

export const macd = (
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { dif: number[]; dea: number[]; hist: number[] } => {
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)
  const dif = closes.map((_, i) => emaFast[i] - emaSlow[i])
  const dea = ema(dif, signal)
  const hist = dif.map((v, i) => (v - dea[i]) * 2)
  return { dif, dea, hist }
}

/** Wilder's SMMA 口径 RSI，与常见图表工具一致 */
export const rsi = (closes: number[], period: number): number[] => {
  const out: number[] = new Array(closes.length).fill(50)
  if (closes.length < period + 1) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

/** 布林带（中轨 SMA，默认 20,2） */
export const boll = (
  closes: number[],
  period = 20,
  times = 2,
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } => {
  const mid = sma(closes, period)
  const upper: (number | null)[] = new Array(closes.length).fill(null)
  const lower: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i]
    if (m === null) continue
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - m) ** 2
    const sd = Math.sqrt(variance / period)
    upper[i] = m + times * sd
    lower[i] = m - times * sd
  }
  return { mid, upper, lower }
}
