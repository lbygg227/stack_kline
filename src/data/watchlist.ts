import type { StockInfo } from '../types'
import { DEFAULT_WATCHLIST, stockNameOf } from './stocks'

const KEY = 'stock-kline-watchlist'

/** 读取自选股（localStorage 持久化，首次使用默认列表） */
export function loadWatchlist(): StockInfo[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const arr = JSON.parse(raw) as StockInfo[]
      if (Array.isArray(arr) && arr.length > 0) return arr
    }
  } catch {
    /* 忽略解析错误 */
  }
  return [...DEFAULT_WATCHLIST]
}

export function saveWatchlist(list: StockInfo[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 忽略写入失败 */
  }
}

/** 根据 code 添加自选（已存在则忽略） */
export function addToWatchlist(list: StockInfo[], code: string, name?: string): StockInfo[] {
  if (list.some((s) => s.code === code)) return list
  const market = code.startsWith('sh') ? ('sh' as const) : ('sz' as const)
  const next = [...list, { code, market, name: name ?? stockNameOf(code), type: 'gp_a' }]
  saveWatchlist(next)
  return next
}

/** 根据 code 删除自选 */
export function removeFromWatchlist(list: StockInfo[], code: string): StockInfo[] {
  const next = list.filter((s) => s.code !== code)
  saveWatchlist(next)
  return next
}

/** 批量删除自选 */
export function removeFromWatchlistMany(list: StockInfo[], codes: string[]): StockInfo[] {
  const set = new Set(codes)
  const next = list.filter((s) => !set.has(s.code))
  saveWatchlist(next)
  return next
}
