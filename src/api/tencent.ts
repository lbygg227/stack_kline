import type { KLineBar, Quote, StockInfo } from '../types'
import { stockNameOf } from '../data/stocks'

/* ============ K 线解析（腾讯 web.ifzq.gtimg.cn） ============ */

const parseDayTs = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

const parseMinuteTs = (s: string): number => {
  const y = +s.slice(0, 4)
  const m = +s.slice(4, 6)
  const d = +s.slice(6, 8)
  const h = +s.slice(8, 10)
  const min = +s.slice(10, 12)
  return new Date(y, m - 1, d, h, min).getTime()
}

const fmtDate = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 解析 ifzq K 线返回。
 * 注意腾讯字段顺序为 [时间, 开, 收, 高, 低, 量]，与常见顺序不同。
 */
export function parseKlineBars(json: unknown, code: string, periodKey: string): KLineBar[] {
  const data = (json as { data?: Record<string, Record<string, unknown>> })?.data?.[code]
  if (!data) return []
  const keys = ['qfq' + periodKey, periodKey, 'm' + periodKey]
  let arr: unknown[] | undefined
  for (const k of keys) {
    if (Array.isArray(data[k])) {
      arr = data[k] as unknown[]
      break
    }
  }
  if (!arr || arr.length === 0) return []
  const isMinute = typeof (arr[0] as unknown[])[0] === 'string' && /^\d{12}$/.test(String((arr[0] as unknown[])[0]))

  const seen = new Set<number>()
  const bars: KLineBar[] = []
  for (const row of arr as unknown[][]) {
    const dateStr = String(row[0] ?? '')
    const ts = isMinute ? parseMinuteTs(dateStr) : parseDayTs(dateStr)
    const open = Number(row[1])
    const close = Number(row[2])
    const high = Number(row[3])
    const low = Number(row[4])
    const volume = Number(row[5]) || 0
    if (!ts || !isFinite(open) || !isFinite(close) || !isFinite(high) || !isFinite(low) || seen.has(ts)) continue
    seen.add(ts)
    bars.push({ timestamp: ts, open, high, low, close, volume })
  }
  bars.sort((a, b) => a.timestamp - b.timestamp)
  return bars
}

/* ============ 实时报价解析（腾讯 qt.gtimg.cn，GBK 文本） ============ */

const num = (v: unknown): number => {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

export function parseQuoteText(text: string): Quote[] {
  const quotes: Quote[] = []
  const re = /v_[a-z0-9_]+="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const parts = m[1].split('~')
    const code = parts[2] ?? ''
    const name = parts[1] ?? ''
    const price = num(parts[3])
    const prevClose = num(parts[4])
    if (!code || price <= 0) continue
    const bids = Array.from({ length: 5 }, (_, i) => ({
      price: num(parts[9 + i * 2]),
      volume: num(parts[10 + i * 2]),
    }))
    const asks = Array.from({ length: 5 }, (_, i) => ({
      price: num(parts[19 + i * 2]),
      volume: num(parts[20 + i * 2]),
    }))
    quotes.push({
      code,
      name: name || stockNameOf(code),
      price,
      prevClose,
      open: num(parts[5]),
      high: num(parts[33]),
      low: num(parts[34]),
      change: num(parts[31]),
      changePct: num(parts[32]),
      volume: num(parts[36]),
      amount: num(parts[37]),
      turnover: num(parts[38]),
      amplitude: num(parts[43]),
      volumeRatio: num(parts[49]),
      pe: num(parts[39]),
      pb: num(parts[46]),
      mktCapFloat: num(parts[44]), // 亿元
      mktCapTotal: num(parts[45]), // 亿元
      upLimit: num(parts[47]),
      downLimit: num(parts[48]),
      bids,
      asks,
      time: parts[30] ?? '',
    })
  }
  return quotes
}

/* ============ 搜索解析（腾讯 smartbox，GBK 文本） ============ */

export function parseSearchText(text: string): StockInfo[] {
  // smartbox 返回的字段名是 \uXXXX 转义形式，需要反解
  const decode = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  const m = text.match(/"([^"]*)"/)
  if (!m) return []
  const list: StockInfo[] = []
  for (const item of m[1].split('^')) {
    const parts = item.split('~')
    if (parts.length < 3) continue
    const marketCode = parts[0]
    const market = marketCode === 'sh' || marketCode === 'sz' ? marketCode : null
    if (!market) continue
    list.push({ code: `${marketCode}${parts[1]}`, market, name: decode(parts[2]), type: parts[3] ?? '' })
  }
  return list
}

export { fmtDate }
