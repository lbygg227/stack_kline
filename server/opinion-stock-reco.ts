/**
 * 观点驱动荐股：基于 OpinionSignal + 仅行业 claim 的板块代表，与事件荐股同构。
 */

import type { SnapshotStock } from './eastmoney.ts'
import { listOpinionDocuments, type OpinionDocument, type OpinionPlatform, type OpinionStance } from './opinions.ts'
import { buildOpinionSignals, type OpinionSignal } from './opinion-signals.ts'
import { listWatchCandidates } from './watch-candidates.ts'

const DAY = 86_400_000
const PROXY_PER_INDUSTRY = 3

export interface OpinionSourceLink {
  documentId: string
  claimId: string
  authorName: string
  platform: OpinionPlatform
  title: string
  url: string
  publishedAt: number
  stance: OpinionStance
  confidence: number
  thesis: string
  evidenceQuote: string
}

export interface OpinionStockRecoItem {
  code: string
  name: string
  industry?: string
  score: number
  stance: OpinionStance
  confidence: number
  agreement: number
  authors: string[]
  claimCount: number
  latestAt: number
  theses: string[]
  risks: string[]
  reason: string
  source?: 'direct' | 'proxy'
  sources?: OpinionSourceLink[]
}

export interface OpinionStockRecoOptions {
  days?: number
  limit?: number
  platform?: OpinionPlatform
  /** 仅看多 / 仅看空 / 全部方向性（默认 all，排除中性） */
  stance?: 'bullish' | 'bearish' | 'all'
  now?: number
  documents?: OpinionDocument[]
  watchlist?: string[]
  preferCodes?: string[]
  stocks?: Array<Pick<SnapshotStock, 'code' | 'name' | 'industry' | 'amount' | 'mktcap' | 'price' | 'changePct'>>
}

function stanceLabel(stance: OpinionStance): string {
  return ({ bullish: '看多', bearish: '看空', neutral: '中性' } as const)[stance]
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase()
}

function webUrl(url: string, platform: string): string {
  if (platform !== 'zhihu') return url
  const answer = url.match(/\/api\/v4\/answers\/(\d+)/)
  if (answer) return 'https://www.zhihu.com/answer/' + answer[1]
  const article = url.match(/\/api\/v4\/articles\/(\d+)/)
  if (article) return 'https://zhuanlan.zhihu.com/p/' + article[1]
  return url
}

function pickIndustryProxies(
  industry: string,
  stocks: OpinionStockRecoOptions['stocks'],
  preferCodes: Set<string>,
): Array<{ code: string; name: string; industry?: string }> {
  const pool = (stocks ?? []).filter((s) => s.industry === industry)
  if (!pool.length) return []
  const preferred = pool
    .filter((s) => preferCodes.has(normalizeCode(s.code)))
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
  // 观点行业代理：优先自选/观察，不足再补成交额 Top
  const rest = pool
    .filter((s) => !preferCodes.has(normalizeCode(s.code)))
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
  return [...preferred, ...rest].slice(0, PROXY_PER_INDUSTRY).map((s) => ({
    code: s.code,
    name: s.name,
    industry: s.industry,
  }))
}

export function aggregateOpinionStockReco(
  signals: OpinionSignal[],
  options: OpinionStockRecoOptions = {},
): OpinionStockRecoItem[] {
  const days = Math.max(1, Math.min(365, options.days ?? 60))
  const limit = Math.max(1, Math.min(100, options.limit ?? 40))
  const now = options.now ?? Date.now()
  const since = now - days * DAY
  const stanceFilter = options.stance ?? 'all'

  return signals
    .filter((s) => s.stance !== 'neutral')
    .filter((s) => s.latestAt >= since)
    .filter((s) => stanceFilter === 'all' || s.stance === stanceFilter)
    .map((s) => ({
      code: s.code,
      name: s.name,
      industry: s.industry,
      score: s.score,
      stance: s.stance,
      confidence: s.confidence,
      agreement: s.agreement,
      authors: s.authors,
      claimCount: s.claimCount,
      latestAt: s.latestAt,
      theses: s.theses.slice(0, 2),
      risks: s.risks.slice(0, 3),
      reason: `${stanceLabel(s.stance)} · ${s.authors.length} 位博主 · ${s.claimCount} 条 · 一致度 ${Math.round(s.agreement * 100)}%`,
      source: 'direct' as const,
      sources: s.evidence.slice(0, 6).map((e) => ({
        documentId: e.documentId,
        claimId: e.claimId,
        authorName: e.authorName,
        platform: e.platform,
        title: e.title,
        url: webUrl(e.url, e.platform),
        publishedAt: e.publishedAt,
        stance: e.stance,
        confidence: e.confidence,
        thesis: e.thesis,
        evidenceQuote: e.evidenceQuote,
      })),
    }))
    .sort(
      (a, b) =>
        Math.abs(b.score) * b.confidence - Math.abs(a.score) * a.confidence ||
        b.latestAt - a.latestAt,
    )
    .slice(0, limit)
}

/** 仅有行业、无代码的方向性 claim → 板块代表股（降权） */
export function aggregateIndustryOpinionProxies(
  documents: OpinionDocument[],
  options: OpinionStockRecoOptions = {},
): OpinionStockRecoItem[] {
  const days = Math.max(1, Math.min(365, options.days ?? 60))
  const now = options.now ?? Date.now()
  const since = now - days * DAY
  const stanceFilter = options.stance ?? 'all'
  const preferCodes = new Set([
    ...(options.preferCodes ?? []).map(normalizeCode),
    ...(options.watchlist ?? []).map(normalizeCode),
  ])

  type Bucket = {
    industry: string
    stance: 'bullish' | 'bearish'
    authors: Set<string>
    theses: string[]
    risks: string[]
    weight: number
    latestAt: number
    count: number
  }
  const buckets = new Map<string, Bucket>()

  for (const doc of documents) {
    if (doc.status !== 'analyzed') continue
    if (options.platform && doc.platform !== options.platform) continue
    if (doc.publishedAt < since) continue
    for (const claim of doc.claims) {
      if (claim.code || !claim.industry) continue
      if (claim.stance !== 'bullish' && claim.stance !== 'bearish') continue
      if (stanceFilter !== 'all' && claim.stance !== stanceFilter) continue
      const key = `${claim.industry}::${claim.stance}`
      const bucket = buckets.get(key) ?? {
        industry: claim.industry,
        stance: claim.stance,
        authors: new Set<string>(),
        theses: [],
        risks: [],
        weight: 0,
        latestAt: 0,
        count: 0,
      }
      bucket.authors.add(doc.authorName)
      if (claim.thesis && bucket.theses.length < 2) bucket.theses.push(claim.thesis)
      for (const r of claim.risks.slice(0, 2)) {
        if (bucket.risks.length < 3 && !bucket.risks.includes(r)) bucket.risks.push(r)
      }
      bucket.weight += Math.max(0.05, claim.confidence)
      bucket.latestAt = Math.max(bucket.latestAt, doc.publishedAt)
      bucket.count += 1
      buckets.set(key, bucket)
    }
  }

  const items: OpinionStockRecoItem[] = []
  for (const bucket of buckets.values()) {
    const proxies = pickIndustryProxies(bucket.industry, options.stocks, preferCodes)
    const score = (bucket.stance === 'bullish' ? 1 : -1) * Math.min(60, bucket.weight * 25)
    const confidence = Math.min(0.75, bucket.weight / 3)
    for (const proxy of proxies) {
      items.push({
        code: normalizeCode(proxy.code),
        name: proxy.name,
        industry: proxy.industry,
        score: Math.round(score * 10) / 10,
        stance: bucket.stance,
        confidence,
        agreement: Math.min(1, bucket.authors.size / 2),
        authors: [...bucket.authors],
        claimCount: bucket.count,
        latestAt: bucket.latestAt,
        theses: bucket.theses,
        risks: bucket.risks,
        reason: `板块代表 · ${bucket.industry} ${stanceLabel(bucket.stance)}（${bucket.count} 条行业观点）`,
        source: 'proxy',
      })
    }
  }
  return items
}

export function buildOpinionStockReco(options: OpinionStockRecoOptions = {}): {
  items: OpinionStockRecoItem[]
  days: number
  total: number
} {
  const days = Math.max(1, Math.min(365, options.days ?? 60))
  const limit = Math.max(1, Math.min(100, options.limit ?? 40))
  const documents =
    options.documents ??
    listOpinionDocuments({
      platform: options.platform,
      limit: 500,
    })
  const preferCodes = [
    ...(options.preferCodes ?? []),
    ...(options.watchlist ?? []),
    ...listWatchCandidates({ limit: 200 }).map((c) => c.code),
  ]
  const signals = buildOpinionSignals(documents, {
    platform: options.platform,
    maxAgeDays: days,
    now: options.now,
  })
  const direct = aggregateOpinionStockReco(signals, { ...options, days, limit: 100 })
  const proxies = aggregateIndustryOpinionProxies(documents, {
    ...options,
    days,
    preferCodes,
  })
  const byCode = new Map<string, OpinionStockRecoItem>()
  for (const item of [...direct, ...proxies]) {
    const prev = byCode.get(item.code)
    if (!prev || Math.abs(item.score) * item.confidence > Math.abs(prev.score) * prev.confidence) {
      byCode.set(item.code, item)
    }
  }
  const items = [...byCode.values()]
    .sort(
      (a, b) =>
        Math.abs(b.score) * b.confidence - Math.abs(a.score) * a.confidence ||
        b.latestAt - a.latestAt,
    )
    .slice(0, limit)
  return { items, days, total: items.length }
}
