/**
 * 观察队列：选股/融合/资讯/观点等通道产出的可跟踪候选。
 */

import { readJson, writeJson } from './store.ts'

export type CandidateStatus = 'observe' | 'hold' | 'reject'
export type CandidateSource = 'strategy' | 'fusion' | 'event' | 'opinion' | 'industry' | 'fund' | 'dragon' | 'manual'

export interface CandidateContext {
  reason?: string
  strategies?: string[]
  fusionScore?: number
  recommendation?: 'recommend' | 'observe' | 'avoid'
  authors?: string[]
  eventId?: string
  eventTitle?: string
  conditionsSummary?: string
  industry?: string
  note?: string
}

export interface SustainabilitySnapshot {
  score: number
  grade: 'track' | 'cautious' | 'reject'
  technical: number
  event: number
  opinion: number
  industryScore: number
  reasons: string[]
  risks: string[]
  vetoes: string[]
  generatedAt: number
}

export interface WatchCandidate {
  code: string
  name: string
  industry?: string
  status: CandidateStatus
  sources: CandidateSource[]
  context: CandidateContext
  sustainability?: SustainabilitySnapshot
  createdAt: number
  updatedAt: number
}

interface CandidateStore {
  version: 1
  updatedAt: number
  candidates: WatchCandidate[]
}

const STORE_FILE = 'watch-candidates.json'
const MAX_CANDIDATES = 200

function emptyStore(): CandidateStore {
  return { version: 1, updatedAt: 0, candidates: [] }
}

function loadStore(): CandidateStore {
  const raw = readJson<CandidateStore>(STORE_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.candidates)) return emptyStore()
  return raw
}

function saveStore(store: CandidateStore): void {
  writeJson(STORE_FILE, { ...store, updatedAt: Date.now() })
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase()
}

export function listWatchCandidates(filters: {
  status?: CandidateStatus
  limit?: number
} = {}): WatchCandidate[] {
  const store = loadStore()
  return store.candidates
    .filter((c) => !filters.status || c.status === filters.status)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(500, filters.limit ?? 200)))
}

export function getWatchCandidate(code: string): WatchCandidate | null {
  const key = normalizeCode(code)
  return loadStore().candidates.find((c) => c.code === key) ?? null
}

export function upsertWatchCandidate(input: {
  code: string
  name?: string
  industry?: string
  status?: CandidateStatus
  source?: CandidateSource
  sources?: CandidateSource[]
  context?: CandidateContext
  sustainability?: SustainabilitySnapshot
}): WatchCandidate {
  const code = normalizeCode(input.code)
  if (!/^(sh|sz|bj)\d{6}$/.test(code)) throw new Error('股票代码格式无效')
  const store = loadStore()
  const now = Date.now()
  const existing = store.candidates.find((c) => c.code === code)
  const incomingSources = [
    ...(input.sources ?? []),
    ...(input.source ? [input.source] : []),
  ].filter(Boolean) as CandidateSource[]

  if (existing) {
    const sourceSet = new Set([...existing.sources, ...incomingSources])
    existing.name = input.name?.trim() || existing.name
    if (input.industry) existing.industry = input.industry
    if (input.status) existing.status = input.status
    existing.sources = [...sourceSet]
    existing.context = { ...existing.context, ...(input.context ?? {}) }
    if (input.sustainability) existing.sustainability = input.sustainability
    existing.updatedAt = now
    store.candidates = [
      existing,
      ...store.candidates.filter((c) => c.code !== code),
    ].slice(0, MAX_CANDIDATES)
    saveStore(store)
    return existing
  }

  const candidate: WatchCandidate = {
    code,
    name: input.name?.trim() || code,
    industry: input.industry,
    status: input.status ?? 'observe',
    sources: incomingSources.length ? [...new Set(incomingSources)] : ['manual'],
    context: input.context ?? {},
    sustainability: input.sustainability,
    createdAt: now,
    updatedAt: now,
  }
  store.candidates = [candidate, ...store.candidates].slice(0, MAX_CANDIDATES)
  saveStore(store)
  return candidate
}

export function setWatchCandidateStatus(code: string, status: CandidateStatus): WatchCandidate {
  const existing = getWatchCandidate(code)
  if (!existing) throw new Error('观察候选不存在')
  return upsertWatchCandidate({ code, status, name: existing.name })
}

export function attachSustainability(code: string, sustainability: SustainabilitySnapshot): WatchCandidate {
  const existing = getWatchCandidate(code)
  if (!existing) throw new Error('观察候选不存在')
  return upsertWatchCandidate({ code, name: existing.name, sustainability })
}

export function removeWatchCandidate(code: string): boolean {
  const store = loadStore()
  const key = normalizeCode(code)
  const before = store.candidates.length
  store.candidates = store.candidates.filter((c) => c.code !== key)
  if (store.candidates.length === before) return false
  saveStore(store)
  return true
}

export function candidateReviewStats(): {
  total: number
  byStatus: Record<CandidateStatus, number>
  bySource: Record<string, number>
  withSustainability: number
  avgScore: number | null
} {
  const candidates = listWatchCandidates({ limit: 500 })
  const byStatus: Record<CandidateStatus, number> = { observe: 0, hold: 0, reject: 0 }
  const bySource: Record<string, number> = {}
  let scoreSum = 0
  let scoreCount = 0
  for (const c of candidates) {
    byStatus[c.status]++
    for (const s of c.sources) bySource[s] = (bySource[s] ?? 0) + 1
    if (c.sustainability) {
      scoreSum += c.sustainability.score
      scoreCount++
    }
  }
  return {
    total: candidates.length,
    byStatus,
    bySource,
    withSustainability: scoreCount,
    avgScore: scoreCount ? Math.round((scoreSum / scoreCount) * 10) / 10 : null,
  }
}
