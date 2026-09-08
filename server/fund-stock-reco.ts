/**
 * 资金面荐股：候选池资金流日榜缓存 + 主力净流入聚合（零 LLM）。
 */

import type { SnapshotStock } from './eastmoney.ts'
import { fetchFundFlow, type FundFlowDay, type FundFlowResult } from './eastmoney-fund.ts'
import { readJson, writeJson } from './store.ts'
import { listWatchCandidates } from './watch-candidates.ts'

const STORE_FILE = 'fund-flow-rank.json'
const DEFAULT_LOOKBACK = 5
const DEFAULT_TOP_AMOUNT = 300
const FETCH_CONCURRENCY = 6
const FETCH_DAYS = 20

export interface FundFlowCacheEntry {
  code: string
  name: string
  industry?: string
  price?: number
  changePct?: number
  amount?: number
  updatedAt: number
  days: FundFlowDay[]
}

interface FundFlowRankStore {
  version: 1
  updatedAt: number
  lastRefreshAt?: number
  lastError?: string
  entries: FundFlowCacheEntry[]
}

export interface FundStockRecoItem {
  code: string
  name: string
  industry?: string
  score: number
  mainNetSum: number
  mainNetToday: number
  consecutiveInflowDays: number
  positiveDays: number
  lookbackDays: number
  reason: string
  price?: number
  changePct?: number
}

export interface FundStockRecoOptions {
  days?: number
  limit?: number
  minMainNetSum?: number
  minConsecutive?: number
  excludeDownPct?: number
  entries?: FundFlowCacheEntry[]
}

function emptyStore(): FundFlowRankStore {
  return { version: 1, updatedAt: 0, entries: [] }
}

function loadStore(): FundFlowRankStore {
  const raw = readJson<FundFlowRankStore>(STORE_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) return emptyStore()
  return raw
}

function saveStore(store: FundFlowRankStore): void {
  writeJson(STORE_FILE, { ...store, updatedAt: Date.now() })
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase()
}

/** 近 lookback 日主力净流入合计（取序列末尾） */
export function sumMainNet(days: FundFlowDay[], lookback: number): number {
  const slice = days.slice(-Math.max(1, lookback))
  return slice.reduce((sum, d) => sum + d.mainNet, 0)
}

/** 从最近一日往前数连续主力净流入天数 */
export function consecutiveInflowDays(days: FundFlowDay[]): number {
  let n = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].mainNet > 0) n += 1
    else break
  }
  return n
}

export function positiveInflowDays(days: FundFlowDay[], lookback: number): number {
  return days.slice(-Math.max(1, lookback)).filter((d) => d.mainNet > 0).length
}

export function scoreFundFlow(input: {
  mainNetSum: number
  consecutive: number
  positiveDays: number
  lookback: number
}): number {
  const yi = input.mainNetSum / 1e8
  const base = Math.tanh(yi / 3) * 70
  const streak = Math.min(25, input.consecutive * 5)
  const density = input.lookback > 0 ? (input.positiveDays / input.lookback) * 15 : 0
  return Math.round((base + streak + density) * 10) / 10
}

export function aggregateFundStockReco(
  entries: FundFlowCacheEntry[],
  options: FundStockRecoOptions = {},
): FundStockRecoItem[] {
  const lookback = Math.max(1, Math.min(20, options.days ?? DEFAULT_LOOKBACK))
  const limit = Math.max(1, Math.min(100, options.limit ?? 40))
  const minSum = options.minMainNetSum ?? 0
  const minConsecutive = options.minConsecutive ?? 0
  const excludeDown = options.excludeDownPct

  const items: FundStockRecoItem[] = []
  for (const entry of entries) {
    if (!entry.days.length) continue
    if (excludeDown != null && entry.changePct != null && entry.changePct < excludeDown) continue
    const mainNetSum = sumMainNet(entry.days, lookback)
    const consecutive = consecutiveInflowDays(entry.days)
    const positiveDays = positiveInflowDays(entry.days, lookback)
    if (mainNetSum < minSum) continue
    if (consecutive < minConsecutive) continue
    if (mainNetSum <= 0 && consecutive <= 0) continue

    const today = entry.days.at(-1)?.mainNet ?? 0
    const score = scoreFundFlow({ mainNetSum, consecutive, positiveDays, lookback })
    const sumYi = mainNetSum / 1e8
    items.push({
      code: normalizeCode(entry.code),
      name: entry.name,
      industry: entry.industry,
      score,
      mainNetSum,
      mainNetToday: today,
      consecutiveInflowDays: consecutive,
      positiveDays,
      lookbackDays: lookback,
      reason: `近${lookback}日主力净流入 ${sumYi >= 0 ? '+' : ''}${sumYi.toFixed(2)}亿 · 连续流入 ${consecutive} 日`,
      price: entry.price,
      changePct: entry.changePct,
    })
  }

  return items
    .sort((a, b) => b.score - a.score || b.mainNetSum - a.mainNetSum || a.code.localeCompare(b.code))
    .slice(0, limit)
}

export function buildFundStockReco(options: FundStockRecoOptions = {}): {
  items: FundStockRecoItem[]
  days: number
  total: number
  lastRefreshAt?: number
  poolSize: number
} {
  const store = loadStore()
  const days = Math.max(1, Math.min(20, options.days ?? DEFAULT_LOOKBACK))
  const items = aggregateFundStockReco(options.entries ?? store.entries, { ...options, days })
  return {
    items,
    days,
    total: items.length,
    lastRefreshAt: store.lastRefreshAt,
    poolSize: store.entries.length,
  }
}

export function getFundFlowCacheEntry(code: string): FundFlowCacheEntry | null {
  const want = normalizeCode(code)
  return loadStore().entries.find((e) => normalizeCode(e.code) === want) ?? null
}

export function pickFundFlowUniverse(options: {
  stocks?: SnapshotStock[]
  watchlist?: string[]
  topAmount?: number
  maxPool?: number
}): Array<{ code: string; name: string; industry?: string; price?: number; changePct?: number; amount?: number }> {
  const topAmount = options.topAmount ?? DEFAULT_TOP_AMOUNT
  const maxPool = options.maxPool ?? 400
  const stocks = options.stocks ?? []
  const byCode = new Map(stocks.map((s) => [normalizeCode(s.code), s]))

  const prefer = new Set<string>([
    ...(options.watchlist ?? []).map(normalizeCode),
    ...listWatchCandidates({ limit: 200 }).map((c) => normalizeCode(c.code)),
  ])

  const picked = new Map<string, { code: string; name: string; industry?: string; price?: number; changePct?: number; amount?: number }>()

  for (const code of prefer) {
    const snap = byCode.get(code)
    picked.set(code, {
      code,
      name: snap?.name ?? code.toUpperCase(),
      industry: snap?.industry,
      price: snap?.price,
      changePct: snap?.changePct,
      amount: snap?.amount,
    })
  }

  const byAmount = [...stocks].sort((a, b) => b.amount - a.amount).slice(0, topAmount)
  for (const s of byAmount) {
    const code = normalizeCode(s.code)
    if (picked.has(code)) continue
    picked.set(code, {
      code,
      name: s.name,
      industry: s.industry,
      price: s.price,
      changePct: s.changePct,
      amount: s.amount,
    })
    if (picked.size >= maxPool) break
  }

  return [...picked.values()]
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

export async function refreshFundFlowRank(options: {
  stocks?: SnapshotStock[]
  watchlist?: string[]
  topAmount?: number
  fetchDays?: number
} = {}): Promise<{
  refreshed: number
  failed: number
  poolSize: number
  updatedAt: number
}> {
  const universe = pickFundFlowUniverse(options)
  const fetchDays = options.fetchDays ?? FETCH_DAYS
  let failed = 0
  const prev = loadStore()
  const prevByCode = new Map(prev.entries.map((e) => [normalizeCode(e.code), e]))

  const results = await mapPool(universe, FETCH_CONCURRENCY, async (stock) => {
    try {
      const flow: FundFlowResult = await fetchFundFlow(stock.code, fetchDays)
      return {
        code: normalizeCode(stock.code),
        name: flow.name || stock.name,
        industry: stock.industry,
        price: stock.price,
        changePct: stock.changePct,
        amount: stock.amount,
        updatedAt: Date.now(),
        days: flow.days,
      } satisfies FundFlowCacheEntry
    } catch {
      failed += 1
      const old = prevByCode.get(normalizeCode(stock.code))
      if (old?.days?.length) {
        return {
          ...old,
          name: stock.name || old.name,
          industry: stock.industry ?? old.industry,
          price: stock.price ?? old.price,
          changePct: stock.changePct ?? old.changePct,
          amount: stock.amount ?? old.amount,
        }
      }
      return null
    }
  })

  const entries = results.filter((x): x is FundFlowCacheEntry => !!x)
  const updatedAt = Date.now()
  const errorMsg = failed
    ? entries.length
      ? `${failed} 只拉取失败，已保留部分旧缓存`
      : `${failed} 只全部拉取失败（请检查东财资金流接口/代理）`
    : undefined
  saveStore({
    version: 1,
    updatedAt,
    lastRefreshAt: updatedAt,
    lastError: errorMsg,
    entries,
  })
  return { refreshed: entries.length, failed, poolSize: entries.length, updatedAt }
}

export function fundFlowRankStatus(): {
  poolSize: number
  lastRefreshAt?: number
  lastError?: string
  updatedAt: number
} {
  const store = loadStore()
  return {
    poolSize: store.entries.length,
    lastRefreshAt: store.lastRefreshAt,
    lastError: store.lastError,
    updatedAt: store.updatedAt,
  }
}

/** 交易时段后半段 / 收盘后轻量刷新资金榜 */
export class FundFlowRankScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRunDay = ''
  private running = false

  start(getContext: () => { stocks: SnapshotStock[]; watchlist?: string[] }) {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(getContext), 60_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private shouldRun(now = new Date()): boolean {
    const w = now.getDay()
    if (w < 1 || w > 5) return false
    const mins = now.getHours() * 60 + now.getMinutes()
    // 14:40 或 15:40 各尝试一次（同一天用 lastRunDay+slot 简化为每天一次收盘后）
    return mins >= 15 * 60 + 40
  }

  async tick(getContext: () => { stocks: SnapshotStock[]; watchlist?: string[] }) {
    if (this.running || !this.shouldRun()) return
    const day = new Date().toISOString().slice(0, 10)
    if (this.lastRunDay === day) return
    this.running = true
    this.lastRunDay = day
    try {
      const ctx = getContext()
      const result = await refreshFundFlowRank({
        stocks: ctx.stocks,
        watchlist: ctx.watchlist ?? [],
      })
      console.log(
        `[fund-flow] 日榜刷新 ${result.refreshed} 只（失败 ${result.failed}）`,
      )
    } catch (e) {
      console.warn('[fund-flow] 日榜刷新失败: ', e)
      this.lastRunDay = ''
    } finally {
      this.running = false
    }
  }
}
