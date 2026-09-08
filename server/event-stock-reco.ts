/**
 * 事件驱动荐股：按股票聚合一级事件（点名优先 + 板块代表），无 LLM。
 */

import type { SnapshotStock } from './eastmoney.ts'
import { listMarketEvents, type MarketEvent } from './market-events.ts'
import { listWatchCandidates } from './watch-candidates.ts'

const DAY_MS = 86_400_000
const PROXY_PER_INDUSTRY = 3
const MAX_EVENTS_PER_STOCK = 5
const PROXY_WEIGHT = 0.45

export type EventRecoSource = 'direct' | 'proxy'

export interface EventStockRecoItem {
  code: string
  name: string
  industry?: string
  score: number
  source: EventRecoSource
  eventCount: number
  relatedEventIds: string[]
  headlines: string[]
  reason: string
  price?: number
  changePct?: number
}

export interface EventStockRecoOptions {
  days?: number
  limit?: number
  kind?: MarketEvent['kind']
  industry?: string
  watchlist?: string[]
  /** 优先作为板块代表的代码（自选 + 观察队列）；测试可注入 */
  preferCodes?: string[]
  stocks?: Array<Pick<SnapshotStock, 'code' | 'name' | 'industry' | 'amount' | 'mktcap' | 'price' | 'changePct'>>
  now?: number
  /** 测试注入事件；默认读落盘 */
  events?: MarketEvent[]
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase()
}

function recencyWeight(publishedAt: number, now: number, days: number): number {
  const ageDays = Math.max(0, (now - publishedAt) / DAY_MS)
  return Math.max(0.25, 1 - ageDays / Math.max(1, days))
}

type Acc = {
  code: string
  name: string
  industry?: string
  score: number
  directHits: number
  proxyHits: number
  events: Array<{ id: string; title: string; publishedAt: number; strength: number }>
  price?: number
  changePct?: number
}

function ensureAcc(
  map: Map<string, Acc>,
  stock: { code: string; name: string; industry?: string; price?: number; changePct?: number },
): Acc {
  const code = normalizeCode(stock.code)
  let acc = map.get(code)
  if (!acc) {
    acc = {
      code,
      name: stock.name,
      industry: stock.industry,
      score: 0,
      directHits: 0,
      proxyHits: 0,
      events: [],
      price: stock.price,
      changePct: stock.changePct,
    }
    map.set(code, acc)
  } else {
    if (!acc.industry && stock.industry) acc.industry = stock.industry
    if (acc.price == null && stock.price != null) acc.price = stock.price
    if (acc.changePct == null && stock.changePct != null) acc.changePct = stock.changePct
  }
  return acc
}

function addEventHit(
  acc: Acc,
  event: MarketEvent,
  weight: number,
  now: number,
  days: number,
  asDirect: boolean,
): void {
  if (acc.events.some((e) => e.id === event.id)) return
  if (acc.events.length >= MAX_EVENTS_PER_STOCK) return
  const delta = event.strength * recencyWeight(event.publishedAt, now, days) * weight
  acc.score += delta
  acc.events.push({
    id: event.id,
    title: event.title,
    publishedAt: event.publishedAt,
    strength: event.strength,
  })
  if (asDirect) acc.directHits += 1
  else acc.proxyHits += 1
}

function pickIndustryProxies(
  industry: string,
  stocks: EventStockRecoOptions['stocks'],
  preferCodes: Set<string>,
  excludeCodes: Set<string>,
  preferOnly = false,
): Array<{ code: string; name: string; industry?: string; price?: number; changePct?: number }> {
  const pool = (stocks ?? []).filter(
    (s) => s.industry === industry && !excludeCodes.has(normalizeCode(s.code)),
  )
  if (!pool.length) return []

  const preferred = pool
    .filter((s) => preferCodes.has(normalizeCode(s.code)))
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))

  if (preferOnly) {
    return preferred.slice(0, PROXY_PER_INDUSTRY).map((s) => ({
      code: s.code,
      name: s.name,
      industry: s.industry,
      price: s.price,
      changePct: s.changePct,
    }))
  }

  const rest = pool
    .filter((s) => !preferCodes.has(normalizeCode(s.code)))
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0) || (b.mktcap ?? 0) - (a.mktcap ?? 0))

  const picked = [...preferred, ...rest].slice(0, PROXY_PER_INDUSTRY)
  return picked.map((s) => ({
    code: s.code,
    name: s.name,
    industry: s.industry,
    price: s.price,
    changePct: s.changePct,
  }))
}

/** 纯函数：事件 → 股票荐股列表（可单测） */
export function aggregateEventStockReco(
  events: MarketEvent[],
  options: EventStockRecoOptions = {},
): EventStockRecoItem[] {
  const days = Math.max(1, Math.min(60, options.days ?? 7))
  const limit = Math.max(1, Math.min(100, options.limit ?? 40))
  const now = options.now ?? Date.now()
  const since = now - days * DAY_MS
  const stocks = options.stocks ?? []
  const stockByCode = new Map(stocks.map((s) => [normalizeCode(s.code), s]))

  const preferCodes = new Set<string>([
    ...(options.preferCodes ?? []).map(normalizeCode),
    ...(options.watchlist ?? []).map(normalizeCode),
  ])

  const byCode = new Map<string, Acc>()
  const usable = events
    .filter((e) => e.publishedAt >= since && (e.codes.length > 0 || e.industries.length > 0))
    .filter((e) => !options.kind || e.kind === options.kind)
    .filter((e) => !options.industry || e.industries.includes(options.industry))

  for (const event of usable) {
    const namedCodes = event.codes.map(normalizeCode)
    const namedSet = new Set(namedCodes)

    for (let i = 0; i < event.codes.length; i++) {
      const code = normalizeCode(event.codes[i])
      const snap = stockByCode.get(code)
      const acc = ensureAcc(byCode, {
        code,
        name: event.names[i] || snap?.name || code.toUpperCase(),
        industry: snap?.industry ?? event.industries[0],
        price: snap?.price,
        changePct: snap?.changePct,
      })
      addEventHit(acc, event, 1, now, days, true)
    }

    const needProxy = event.industries.length > 0 && namedCodes.length < 2
    if (!needProxy) continue

    // 纯行业/主题事件：只推自选/观察池代表，避免全市场 TopK 被宏观噪音淹没
    const preferOnly = namedCodes.length === 0
    for (const industry of event.industries.slice(0, 4)) {
      const proxies = pickIndustryProxies(industry, stocks, preferCodes, namedSet, preferOnly)
      for (const proxy of proxies) {
        const acc = ensureAcc(byCode, proxy)
        addEventHit(acc, event, PROXY_WEIGHT, now, days, false)
      }
    }
  }

  const items: EventStockRecoItem[] = [...byCode.values()]
    .filter((acc) => acc.events.length > 0)
    .map((acc) => {
      const eventsSorted = [...acc.events].sort((a, b) => b.publishedAt - a.publishedAt)
      const source: EventRecoSource = acc.directHits > 0 ? 'direct' : 'proxy'
      const reason =
        source === 'direct'
          ? `点名命中 ${acc.directHits} 条一级事件`
          : `板块代表 · ${acc.industry ?? '相关行业'}（关联 ${acc.proxyHits} 条）`
      return {
        code: acc.code,
        name: acc.name,
        industry: acc.industry,
        score: Math.round(acc.score * 100) / 100,
        source,
        eventCount: acc.events.length,
        relatedEventIds: eventsSorted.map((e) => e.id),
        headlines: eventsSorted.slice(0, 2).map((e) => e.title),
        reason,
        price: acc.price,
        changePct: acc.changePct,
      }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount
      const ap = preferCodes.has(a.code) ? 1 : 0
      const bp = preferCodes.has(b.code) ? 1 : 0
      if (bp !== ap) return bp - ap
      return a.code.localeCompare(b.code)
    })
    .slice(0, limit)

  return items
}

export function buildEventStockReco(options: EventStockRecoOptions = {}): {
  items: EventStockRecoItem[]
  days: number
  total: number
} {
  const days = Math.max(1, Math.min(60, options.days ?? 7))
  const events =
    options.events ??
    listMarketEvents({
      days,
      limit: 200,
      kind: options.kind,
      industry: options.industry,
    }).events.map(({ opinionCount: _oc, ...rest }) => rest)
  const preferCodes = [
    ...(options.preferCodes ?? []),
    ...(options.watchlist ?? []),
    ...listWatchCandidates({ limit: 200 }).map((c) => c.code),
  ]
  const items = aggregateEventStockReco(events, { ...options, days, preferCodes })
  return { items, days, total: items.length }
}
