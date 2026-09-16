/**
 * 博主观点核心：订阅、原文版本、结构化观点与本地持久化。
 * 平台采集器只负责提供 OpinionDocumentInput，本模块不依赖具体来源。
 */

import { createHash, randomUUID } from 'node:crypto'
import { readJson, writeJson } from './store.ts'
import type { SnapshotStock } from './eastmoney.ts'

export type OpinionPlatform = 'zhihu' | 'xueqiu'
export type OpinionStance = 'bullish' | 'bearish' | 'neutral'

export interface OpinionSubscription {
  id: string
  platform: OpinionPlatform
  platformUserId: string
  nickname: string
  profileUrl: string
  enabled: boolean
  intervalMinutes: number
  lastCheckedAt: number
  lastPostId?: string
  authStatus: 'ready' | 'missing' | 'expired' | 'error'
  lastError?: string
  lastNotice?: string
  collectionPolicyVersion?: number
  createdAt: number
  updatedAt: number
}

export interface OpinionClaim {
  id: string
  code?: string
  name?: string
  industry?: string
  stance: OpinionStance
  horizonDays: number
  thesis: string
  catalysts: string[]
  risks: string[]
  invalidation: string
  confidence: number
  evidenceQuote: string
  /** 引用是否能在原文中逐字命中（防止抽取幻觉） */
  quoteVerified?: boolean
}

/** 逐字引用校验：忽略空白后判断引用是否出现在原文里 */
export function verifyEvidenceQuote(content: string, quote: string): boolean {
  const target = content.replace(/\s+/g, '')
  const needle = quote.replace(/\s+/g, '')
  if (!needle || needle.length < 4) return false
  return target.includes(needle)
}

export interface OpinionDocumentVersion {
  version: number
  capturedAt: number
  contentHash: string
  title: string
  content: string
}

export interface OpinionDocument {
  id: string
  subscriptionId?: string
  platform: OpinionPlatform
  platformPostId?: string
  authorId: string
  authorName: string
  profileUrl?: string
  url: string
  title: string
  content: string
  publishedAt: number
  capturedAt: number
  updatedAt: number
  contentHash: string
  versions: OpinionDocumentVersion[]
  status: 'pending' | 'analyzed' | 'failed'
  summary?: string
  claims: OpinionClaim[]
  analysisModel?: string
  analysisError?: string
  contentKind?: 'original' | 'commentary_repost' | 'manual'
  originalAuthor?: string
  collectionPolicyVersion?: number
  excludedAt?: number
  exclusionReason?: string
}

export interface OpinionDocumentInput {
  subscriptionId?: string
  platform: OpinionPlatform
  platformPostId?: string
  authorId?: string
  authorName?: string
  profileUrl?: string
  url?: string
  title?: string
  content: string
  publishedAt?: number
  contentKind?: 'original' | 'commentary_repost' | 'manual'
  originalAuthor?: string
  collectionPolicyVersion?: number
}

export interface OpinionSyncLog {
  id: string
  subscriptionId: string
  platform: OpinionPlatform
  authorName: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'failed'
  attempt: number
  fetched: number
  created: number
  changed: number
  analyzed: number
  failed: number
  error?: string
}

interface OpinionStore {
  subscriptions: OpinionSubscription[]
  documents: OpinionDocument[]
  syncLogs: OpinionSyncLog[]
}

const STORE_FILE = 'opinions/store.json'
const loaded = readJson<Partial<OpinionStore>>(STORE_FILE)
let state: OpinionStore = {
  subscriptions: loaded?.subscriptions ?? [],
  documents: loaded?.documents ?? [],
  syncLogs: loaded?.syncLogs ?? [],
}

const persist = () => writeJson(STORE_FILE, state)
const hashContent = (title: string, content: string) =>
  createHash('sha256').update(`${title}\n${content}`).digest('hex')

const normalizePlatformUserId = (platform: OpinionPlatform, input: string, profileUrl: string): string => {
  const value = input.trim()
  if (value) return value
  if (platform === 'xueqiu') return profileUrl.match(/\/u\/(\d+)/)?.[1] ?? ''
  return profileUrl.match(/\/people\/([^/?#]+)/)?.[1] ?? ''
}

export function listOpinionSubscriptions(platform?: OpinionPlatform): OpinionSubscription[] {
  return state.subscriptions
    .filter((item) => !platform || item.platform === platform)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function startOpinionSyncLog(subscription: OpinionSubscription): OpinionSyncLog {
  const log: OpinionSyncLog = {
    id: randomUUID(),
    subscriptionId: subscription.id,
    platform: subscription.platform,
    authorName: subscription.nickname || subscription.platformUserId,
    startedAt: Date.now(),
    status: 'running',
    attempt: 0,
    fetched: 0,
    created: 0,
    changed: 0,
    analyzed: 0,
    failed: 0,
  }
  state.syncLogs.unshift(log)
  state.syncLogs = state.syncLogs.slice(0, 500)
  persist()
  return log
}

export function finishOpinionSyncLog(
  id: string,
  patch: Partial<Omit<OpinionSyncLog, 'id' | 'subscriptionId' | 'platform' | 'authorName' | 'startedAt'>>,
): OpinionSyncLog | null {
  const log = state.syncLogs.find((item) => item.id === id)
  if (!log) return null
  Object.assign(log, patch, { finishedAt: Date.now() })
  persist()
  return log
}

export function listOpinionSyncLogs(filters: {
  platform?: OpinionPlatform
  subscriptionId?: string
  limit?: number
} = {}): OpinionSyncLog[] {
  return state.syncLogs
    .filter((log) => !filters.platform || log.platform === filters.platform)
    .filter((log) => !filters.subscriptionId || log.subscriptionId === filters.subscriptionId)
    .slice(0, Math.max(1, Math.min(200, filters.limit ?? 50)))
}

export function saveOpinionSubscription(input: Partial<OpinionSubscription> & {
  platform: OpinionPlatform
}): OpinionSubscription {
  const now = Date.now()
  const profileUrl = input.profileUrl?.trim() ?? ''
  const platformUserId = normalizePlatformUserId(input.platform, input.platformUserId ?? '', profileUrl)
  const existing = input.id
    ? state.subscriptions.find((item) => item.id === input.id)
    : state.subscriptions.find((item) =>
        item.platform === input.platform &&
        platformUserId &&
        item.platformUserId === platformUserId,
      )
  if (existing) {
    existing.platformUserId = platformUserId || existing.platformUserId
    existing.nickname = input.nickname?.trim() || existing.nickname
    existing.profileUrl = profileUrl || existing.profileUrl
    existing.enabled = input.enabled ?? existing.enabled
    existing.intervalMinutes = Math.max(5, Math.round(input.intervalMinutes ?? existing.intervalMinutes))
    existing.updatedAt = now
    persist()
    return existing
  }
  if (!platformUserId && !input.nickname?.trim()) throw new Error('请提供博主 ID、昵称或主页链接')
  const item: OpinionSubscription = {
    id: randomUUID(),
    platform: input.platform,
    platformUserId,
    nickname: input.nickname?.trim() ?? '',
    profileUrl,
    enabled: input.enabled ?? true,
    intervalMinutes: Math.max(5, Math.round(input.intervalMinutes ?? 15)),
    lastCheckedAt: 0,
    authStatus: 'missing',
    createdAt: now,
    updatedAt: now,
  }
  state.subscriptions.push(item)
  persist()
  return item
}

export function removeOpinionSubscription(id: string): boolean {
  const before = state.subscriptions.length
  state.subscriptions = state.subscriptions.filter((item) => item.id !== id)
  if (state.subscriptions.length === before) return false
  persist()
  return true
}

export function updateSubscriptionRuntime(
  id: string,
  patch: Partial<Pick<OpinionSubscription, 'platformUserId' | 'nickname' | 'profileUrl' | 'lastCheckedAt' | 'lastPostId' | 'authStatus' | 'lastError' | 'lastNotice' | 'collectionPolicyVersion'>>,
): OpinionSubscription | null {
  const item = state.subscriptions.find((subscription) => subscription.id === id)
  if (!item) return null
  Object.assign(item, patch, { updatedAt: Date.now() })
  persist()
  return item
}

export function prepareOpinionCollectionPolicy(id: string, version: number): OpinionSubscription | null {
  const subscription = state.subscriptions.find((item) => item.id === id)
  if (!subscription || (subscription.collectionPolicyVersion ?? 1) >= version) return subscription ?? null
  const now = Date.now()
  for (const document of state.documents) {
    if (document.subscriptionId !== id || document.collectionPolicyVersion === version) continue
    document.excludedAt = now
    document.exclusionReason = '旧采集口径无法确认是博主本人原创发言'
  }
  subscription.collectionPolicyVersion = version
  subscription.lastPostId = undefined
  subscription.lastCheckedAt = 0
  subscription.updatedAt = now
  persist()
  return subscription
}

export function ingestOpinionDocument(input: OpinionDocumentInput): {
  document: OpinionDocument
  created: boolean
  changed: boolean
} {
  const content = input.content.trim()
  if (!content) throw new Error('观点原文不能为空')
  const title = input.title?.trim() || content.slice(0, 50)
  const contentHash = hashContent(title, content)
  const now = Date.now()
  const existing = state.documents.find((document) =>
    (input.platformPostId && document.platform === input.platform && document.platformPostId === input.platformPostId) ||
    (input.url && document.url === input.url),
  )
  if (existing) {
    const metadataChanged = Boolean(
      existing.excludedAt ||
      existing.contentKind !== (input.contentKind ?? existing.contentKind) ||
      existing.originalAuthor !== input.originalAuthor ||
      existing.collectionPolicyVersion !== input.collectionPolicyVersion,
    )
    existing.contentKind = input.contentKind ?? existing.contentKind
    existing.originalAuthor = input.originalAuthor
    existing.collectionPolicyVersion = input.collectionPolicyVersion
    existing.excludedAt = undefined
    existing.exclusionReason = undefined
    if (existing.contentHash === contentHash) {
      if (metadataChanged) persist()
      return { document: existing, created: false, changed: false }
    }
    existing.versions.push({
      version: existing.versions.length + 1,
      capturedAt: now,
      contentHash,
      title,
      content,
    })
    existing.title = title
    existing.content = content
    existing.contentHash = contentHash
    existing.updatedAt = now
    existing.status = 'pending'
    existing.claims = []
    existing.summary = undefined
    existing.analysisError = undefined
    persist()
    return { document: existing, created: false, changed: true }
  }

  const subscription = input.subscriptionId
    ? state.subscriptions.find((item) => item.id === input.subscriptionId)
    : undefined
  const document: OpinionDocument = {
    id: randomUUID(),
    subscriptionId: subscription?.id,
    platform: input.platform,
    platformPostId: input.platformPostId,
    authorId: input.authorId?.trim() || subscription?.platformUserId || '',
    authorName: input.authorName?.trim() || subscription?.nickname || '未知作者',
    profileUrl: input.profileUrl?.trim() || subscription?.profileUrl,
    url: input.url?.trim() || '',
    title,
    content,
    publishedAt: input.publishedAt && input.publishedAt > 0 ? input.publishedAt : now,
    capturedAt: now,
    updatedAt: now,
    contentHash,
    versions: [{ version: 1, capturedAt: now, contentHash, title, content }],
    status: 'pending',
    claims: [],
    contentKind: input.contentKind ?? (input.subscriptionId ? 'original' : 'manual'),
    originalAuthor: input.originalAuthor,
    collectionPolicyVersion: input.collectionPolicyVersion,
  }
  state.documents.push(document)
  persist()
  return { document, created: true, changed: true }
}

export function listOpinionDocuments(filters: {
  platform?: OpinionPlatform
  subscriptionId?: string
  code?: string
  limit?: number
  includeExcluded?: boolean
} = {}): OpinionDocument[] {
  return state.documents
    .filter((document) => filters.includeExcluded || !document.excludedAt)
    .filter((document) => !filters.platform || document.platform === filters.platform)
    .filter((document) => !filters.subscriptionId || document.subscriptionId === filters.subscriptionId)
    .filter((document) => !filters.code || document.claims.some((claim) => claim.code === filters.code))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    // 上限放宽到 5000：观点回测需要覆盖全量历史（回补后单平台可达数千篇）
    .slice(0, Math.max(1, Math.min(5000, filters.limit ?? 100)))
}

export function getOpinionDocument(id: string): OpinionDocument | null {
  return state.documents.find((document) => document.id === id) ?? null
}

export function applyOpinionAnalysis(
  id: string,
  result: { summary: string; claims: OpinionClaim[]; model?: string },
): OpinionDocument {
  const document = getOpinionDocument(id)
  if (!document) throw new Error('观点文章不存在')
  document.summary = result.summary
  document.claims = result.claims
  // 落库即做一次逐字引用校验，后续权重与回测都可据此过滤抽取幻觉
  verifyDocumentQuotes(document)
  document.analysisModel = result.model
  document.analysisError = undefined
  document.status = 'analyzed'
  document.updatedAt = Date.now()
  persist()
  return document
}

/** 内容类型：想法（pin）/ 长文（回答·文章）/ 手工导入 */
export type OpinionDocumentKind = 'pin' | 'longform' | 'manual'

export function opinionDocumentKind(document: Pick<OpinionDocument, 'platformPostId'>): OpinionDocumentKind {
  const id = String(document.platformPostId ?? '')
  if (id.startsWith('pin:')) return 'pin'
  if (id.startsWith('answer:') || id.startsWith('article:')) return 'longform'
  return 'manual'
}

/**
 * 各类型内容的权重系数。
 * 依据 2026-09 回补后的分层回测：想法在 3/5/10/20 日全部负超额（-3.4% @20日），
 * 长文稳定正超额（+3.8% @20日），手工导入 +5.4%。想法只作情绪参考，因此大幅降权。
 */
export const OPINION_KIND_WEIGHT: Record<OpinionDocumentKind, number> = {
  pin: 0.4,
  longform: 1,
  manual: 0.8,
}

export function markOpinionAnalysisFailed(id: string, error: unknown): OpinionDocument {
  const document = getOpinionDocument(id)
  if (!document) throw new Error('观点文章不存在')
  document.status = 'failed'
  document.analysisError = error instanceof Error ? error.message : String(error)
  document.updatedAt = Date.now()
  persist()
  return document
}

export function resolveOpinionClaims(
  rawClaims: Array<Partial<Omit<OpinionClaim, 'id' | 'code'>> & { code?: string }>,
  stocks: SnapshotStock[],
): OpinionClaim[] {
  const byCode = new Map(stocks.map((stock) => [stock.code, stock]))
  const byName = new Map(stocks.map((stock) => [stock.name, stock]))
  const normalizeCode = (value: string | undefined): string | undefined => {
    if (!value) return undefined
    const lowered = value.trim().toLowerCase()
    if (/^(sh|sz|bj)\d{6}$/.test(lowered)) return lowered
    if (/^\d{6}$/.test(lowered)) {
      if (lowered.startsWith('6')) return `sh${lowered}`
      if (lowered.startsWith('0') || lowered.startsWith('3')) return `sz${lowered}`
      if (lowered.startsWith('4') || lowered.startsWith('8')) return `bj${lowered}`
    }
    return undefined
  }
  return rawClaims.map((raw) => {
    const normalizedCode = normalizeCode(raw.code)
    const stock = (normalizedCode ? byCode.get(normalizedCode) : undefined)
      ?? (raw.name ? byName.get(raw.name) : undefined)
    const stance: OpinionStance = raw.stance === 'bullish' || raw.stance === 'bearish' ? raw.stance : 'neutral'
    return {
      id: randomUUID(),
      code: stock?.code,
      name: stock?.name ?? raw.name?.trim(),
      industry: stock?.industry ?? raw.industry?.trim(),
      stance,
      horizonDays: Math.max(1, Math.min(250, Math.round(Number(raw.horizonDays) || 20))),
      thesis: raw.thesis?.trim() ?? '',
      catalysts: Array.isArray(raw.catalysts) ? raw.catalysts.filter((item): item is string => typeof item === 'string') : [],
      risks: Array.isArray(raw.risks) ? raw.risks.filter((item): item is string => typeof item === 'string') : [],
      invalidation: raw.invalidation?.trim() ?? '',
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
      evidenceQuote: raw.evidenceQuote?.trim() ?? '',
      quoteVerified: undefined,
    }
  }).filter((claim) => claim.thesis || claim.evidenceQuote)
}

/** 对文档的所有 claim 做逐字引用校验，返回可核验比例 */
/** 手动触发落盘（批量维护后使用） */
export function persistOpinionStore(): void {
  persist()
}

export function verifyDocumentQuotes(document: Pick<OpinionDocument, 'content' | 'claims'>): {
  verified: number
  total: number
} {
  let verified = 0
  for (const claim of document.claims) {
    claim.quoteVerified = verifyEvidenceQuote(document.content, claim.evidenceQuote)
    if (claim.quoteVerified) verified++
  }
  return { verified, total: document.claims.length }
}
