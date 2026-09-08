/**
 * 龙虎榜荐股：扶摇日榜缓存 + 净买额/机构/游资聚合（零 LLM）。
 */

import type { SnapshotStock } from './eastmoney.ts'
import {
  fetchDragonTigerList,
  fromFuyaoThscode,
  hasFuyao,
  type DragonTigerBoardType,
  type DragonTigerRawItem,
} from './fuyao.ts'
import { readJson, writeJson } from './store.ts'

const STORE_FILE = 'dragon-tiger-rank.json'

export interface DragonTigerCacheEntry {
  code: string
  name: string
  industry?: string
  tradeDate: string
  boardType: DragonTigerBoardType
  netValue: number
  buyValue: number
  sellValue: number
  orgNetValue: number | null
  hotMoneyNetValue: number | null
  change: number | null
  hotRank: number | null
  limitReason?: string
  concepts: string[]
  updatedAt: number
}

interface DragonTigerStore {
  version: 1
  updatedAt: number
  lastRefreshAt?: number
  lastError?: string
  tradeDate?: string
  boardType?: DragonTigerBoardType
  entries: DragonTigerCacheEntry[]
}

export interface DragonTigerRecoItem {
  code: string
  name: string
  industry?: string
  score: number
  tradeDate: string
  boardType: DragonTigerBoardType
  netValue: number
  orgNetValue: number | null
  hotMoneyNetValue: number | null
  changePct: number | null
  limitReason?: string
  concepts: string[]
  reason: string
}

export interface DragonTigerRecoOptions {
  boardType?: DragonTigerBoardType
  limit?: number
  /** 主指标净买额下限（元），默认 0 只保留净买入 */
  minNetValue?: number
  /** 排除涨跌幅低于该百分比的标的，如 -5 */
  excludeDownPct?: number
  /** 偏好：net | org | hot */
  prefer?: 'net' | 'org' | 'hot'
  entries?: DragonTigerCacheEntry[]
}

function emptyStore(): DragonTigerStore {
  return { version: 1, updatedAt: 0, entries: [] }
}

function loadStore(): DragonTigerStore {
  const raw = readJson<DragonTigerStore>(STORE_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) return emptyStore()
  return raw
}

function saveStore(store: DragonTigerStore): void {
  writeJson(STORE_FILE, { ...store, updatedAt: Date.now() })
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase()
}

/** 本地日历日 YYYY-MM-DD */
export function formatLocalDate(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 扶摇缺省取「早于当前自然日」的最近交易日，收盘后当天榜需显式传 date。
 * 交易日 15:00 后优先尝试当日；未出榜再回退缺省。
 */
export function preferTodayDragonTigerDate(now = new Date()): string | undefined {
  const w = now.getDay()
  if (w < 1 || w > 5) return undefined
  const mins = now.getHours() * 60 + now.getMinutes()
  if (mins < 15 * 60) return undefined
  return formatLocalDate(now)
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function primaryMetric(
  entry: Pick<DragonTigerCacheEntry, 'netValue' | 'orgNetValue' | 'hotMoneyNetValue'>,
  prefer: 'net' | 'org' | 'hot',
): number {
  if (prefer === 'org' && entry.orgNetValue != null) return entry.orgNetValue
  if (prefer === 'hot' && entry.hotMoneyNetValue != null) return entry.hotMoneyNetValue
  return entry.netValue
}

export function scoreDragonTiger(input: {
  primary: number
  orgNet: number | null
  hotNet: number | null
}): number {
  const yi = input.primary / 1e8
  const base = Math.tanh(yi / 2) * 70
  let bonus = 0
  if (input.orgNet != null && input.orgNet > 0) bonus += Math.min(12, (input.orgNet / 1e8) * 2)
  if (input.hotNet != null && input.hotNet > 0) bonus += Math.min(12, (input.hotNet / 1e8) * 2)
  if ((input.orgNet ?? 0) > 0 && (input.hotNet ?? 0) > 0) bonus += 6
  return Math.round((base + bonus) * 10) / 10
}

function formatYi(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(2)}亿`
}

function mapRawItem(
  raw: DragonTigerRawItem,
  meta: { tradeDate: string; boardType: DragonTigerBoardType; industry?: string },
): DragonTigerCacheEntry | null {
  const thscode = raw.thscode?.trim()
  if (!thscode) return null
  const code = normalizeCode(fromFuyaoThscode(thscode))
  if (!/^(sh|sz|bj)\d{6}$/.test(code)) return null
  return {
    code,
    name: raw.name || code.toUpperCase(),
    industry: meta.industry,
    tradeDate: meta.tradeDate,
    boardType: meta.boardType,
    netValue: num(raw.net_value),
    buyValue: num(raw.buy_value),
    sellValue: num(raw.sell_value),
    orgNetValue: raw.org_net_value == null ? null : num(raw.org_net_value),
    hotMoneyNetValue: raw.hot_money_net_value == null ? null : num(raw.hot_money_net_value),
    change: raw.change == null ? null : num(raw.change),
    hotRank: raw.hot_rank == null ? null : num(raw.hot_rank),
    limitReason: raw.limit_reason?.trim() || undefined,
    concepts: (raw.concept_list ?? []).map((c) => c.name).filter(Boolean).slice(0, 6),
    updatedAt: Date.now(),
  }
}

export function aggregateDragonTigerReco(
  entries: DragonTigerCacheEntry[],
  options: DragonTigerRecoOptions = {},
): DragonTigerRecoItem[] {
  const limit = Math.max(1, Math.min(100, options.limit ?? 40))
  const minNet = options.minNetValue ?? 0
  const excludeDown = options.excludeDownPct
  const prefer =
    options.prefer ??
    (options.boardType === 'org' ? 'org' : options.boardType === 'hot_money' ? 'hot' : 'net')

  const items: DragonTigerRecoItem[] = []
  for (const entry of entries) {
    if (options.boardType && entry.boardType !== options.boardType && entry.boardType !== 'all') {
      /* 缓存按单次 board 刷新；过滤由 prefer 处理 */
    }
    const primary = primaryMetric(entry, prefer)
    if (primary < minNet) continue
    const changePct = entry.change == null ? null : entry.change * 100
    if (excludeDown != null && changePct != null && changePct < excludeDown) continue

    const score = scoreDragonTiger({
      primary,
      orgNet: entry.orgNetValue,
      hotNet: entry.hotMoneyNetValue,
    })
    const tag =
      prefer === 'org' ? '机构净买' : prefer === 'hot' ? '游资净买' : '龙虎净买'
    const reasonParts = [
      `${entry.tradeDate} ${tag} ${formatYi(primary)}`,
      entry.limitReason,
      entry.concepts[0],
    ].filter(Boolean)

    items.push({
      code: normalizeCode(entry.code),
      name: entry.name,
      industry: entry.industry,
      score,
      tradeDate: entry.tradeDate,
      boardType: entry.boardType,
      netValue: entry.netValue,
      orgNetValue: entry.orgNetValue,
      hotMoneyNetValue: entry.hotMoneyNetValue,
      changePct,
      limitReason: entry.limitReason,
      concepts: entry.concepts,
      reason: reasonParts.join(' · '),
    })
  }

  return items
    .sort((a, b) => b.score - a.score || b.netValue - a.netValue || a.code.localeCompare(b.code))
    .slice(0, limit)
}

export function buildDragonTigerReco(options: DragonTigerRecoOptions = {}): {
  items: DragonTigerRecoItem[]
  total: number
  tradeDate?: string
  boardType?: DragonTigerBoardType
  lastRefreshAt?: number
  poolSize: number
  configured: boolean
} {
  const store = loadStore()
  const boardType = options.boardType ?? store.boardType ?? 'all'
  const items = aggregateDragonTigerReco(options.entries ?? store.entries, {
    ...options,
    boardType,
  })
  return {
    items,
    total: items.length,
    tradeDate: store.tradeDate,
    boardType: store.boardType,
    lastRefreshAt: store.lastRefreshAt,
    poolSize: store.entries.length,
    configured: hasFuyao(),
  }
}

export function getDragonTigerCacheEntry(code: string): DragonTigerCacheEntry | null {
  const want = normalizeCode(code)
  return loadStore().entries.find((e) => normalizeCode(e.code) === want) ?? null
}

export async function refreshDragonTigerRank(options: {
  date?: string
  boardType?: DragonTigerBoardType
  stocks?: SnapshotStock[]
} = {}): Promise<{
  refreshed: number
  tradeDate: string
  boardType: DragonTigerBoardType
  poolSize: number
  updatedAt: number
}> {
  if (!hasFuyao()) throw new Error('未配置 FUYAO_API_KEY')
  const boardType = options.boardType ?? 'all'
  const explicitDate = options.date?.trim() || undefined
  const todayHint = explicitDate ? undefined : preferTodayDragonTigerDate()
  let result = await fetchDragonTigerList({
    date: explicitDate ?? todayHint,
    boardType,
  })
  // 当日尚未出榜时回退扶摇缺省（通常为上一交易日）
  if (!explicitDate && todayHint && result.items.length === 0) {
    result = await fetchDragonTigerList({ boardType })
  }
  const byCode = new Map(
    (options.stocks ?? []).map((s) => [normalizeCode(s.code), s]),
  )

  const entries: DragonTigerCacheEntry[] = []
  for (const raw of result.items) {
    const mapped = mapRawItem(raw, {
      tradeDate: result.tradeDate,
      boardType: result.boardType,
    })
    if (!mapped) continue
    const snap = byCode.get(mapped.code)
    if (snap) {
      mapped.industry = snap.industry
      if (!mapped.name || mapped.name === mapped.code.toUpperCase()) mapped.name = snap.name
    }
    entries.push(mapped)
  }

  const updatedAt = Date.now()
  saveStore({
    version: 1,
    updatedAt,
    lastRefreshAt: updatedAt,
    lastError: undefined,
    tradeDate: result.tradeDate,
    boardType: result.boardType,
    entries,
  })
  return {
    refreshed: entries.length,
    tradeDate: result.tradeDate,
    boardType: result.boardType,
    poolSize: entries.length,
    updatedAt,
  }
}

export function dragonTigerRankStatus(): {
  configured: boolean
  poolSize: number
  tradeDate?: string
  boardType?: DragonTigerBoardType
  lastRefreshAt?: number
  lastError?: string
  updatedAt: number
} {
  const store = loadStore()
  return {
    configured: hasFuyao(),
    poolSize: store.entries.length,
    tradeDate: store.tradeDate,
    boardType: store.boardType,
    lastRefreshAt: store.lastRefreshAt,
    lastError: store.lastError,
    updatedAt: store.updatedAt,
  }
}

/** 交易日收盘后拉取龙虎榜（约 16:20 起，每天一次） */
export class DragonTigerRankScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRunDay = ''
  private running = false

  start(getContext: () => { stocks: SnapshotStock[] }) {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(getContext), 60_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private shouldRun(now = new Date()): boolean {
    if (!hasFuyao()) return false
    const w = now.getDay()
    if (w < 1 || w > 5) return false
    const mins = now.getHours() * 60 + now.getMinutes()
    return mins >= 16 * 60 + 20
  }

  async tick(getContext: () => { stocks: SnapshotStock[] }) {
    if (this.running || !this.shouldRun()) return
    const day = new Date().toISOString().slice(0, 10)
    if (this.lastRunDay === day) return
    this.running = true
    this.lastRunDay = day
    try {
      const ctx = getContext()
      const result = await refreshDragonTigerRank({
        stocks: ctx.stocks,
        boardType: 'all',
        date: preferTodayDragonTigerDate(),
      })
      console.log(`[dragon-tiger] 日榜刷新 ${result.refreshed} 只 · ${result.tradeDate}`)
    } catch (e) {
      console.warn('[dragon-tiger] 日榜刷新失败: ', e)
      const store = loadStore()
      saveStore({
        ...store,
        lastError: e instanceof Error ? e.message : String(e),
      })
      this.lastRunDay = ''
    } finally {
      this.running = false
    }
  }
}
