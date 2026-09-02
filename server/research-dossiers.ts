import { createHash, randomUUID } from 'node:crypto'
import { readJson, writeJson } from './store.ts'

export type ResearchStance = 'bullish' | 'bearish' | 'neutral'
export type ResearchSource = 'manual' | 'analysis' | 'opinion' | 'fusion'

export interface ResearchRevision {
  version: number
  createdAt: number
  contentHash: string
  title: string
  thesis: string
  stance: ResearchStance
  horizonDays: number
  targetPrice?: number
  stopLoss?: number
  catalysts: string[]
  risks: string[]
  tags: string[]
  snapshot?: Record<string, unknown>
}

export interface ResearchRecord {
  id: string
  code: string
  name: string
  source: ResearchSource
  createdAt: number
  updatedAt: number
  currentVersion: number
  revisions: ResearchRevision[]
}

interface ResearchStore {
  records: ResearchRecord[]
}

const STORE_FILE = 'research/dossiers.json'
const state: ResearchStore = readJson<ResearchStore>(STORE_FILE) ?? { records: [] }
const persist = () => writeJson(STORE_FILE, state)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function saveResearchRecord(input: {
  id?: string
  code: string
  name?: string
  source?: ResearchSource
  title?: string
  thesis: string
  stance?: ResearchStance
  horizonDays?: number
  targetPrice?: number
  stopLoss?: number
  catalysts?: string[]
  risks?: string[]
  tags?: string[]
  snapshot?: Record<string, unknown>
}): ResearchRecord {
  const code = input.code.trim().toLowerCase()
  if (!/^(sh|sz|bj)\d{6}$/.test(code)) throw new Error('股票代码格式无效')
  if (!input.thesis?.trim()) throw new Error('研究结论不能为空')
  const existing = input.id ? state.records.find((record) => record.id === input.id) : undefined
  if (input.id && !existing) throw new Error('研究记录不存在')
  if (existing && existing.code !== code) throw new Error('不能修改研究记录所属股票')
  const now = Date.now()
  const content = {
    title: input.title?.trim() || `${input.name || code} 研究结论`,
    thesis: input.thesis.trim(),
    stance: input.stance ?? 'neutral',
    horizonDays: Math.max(1, Math.min(1825, Math.round(input.horizonDays ?? 90))),
    targetPrice: Number.isFinite(input.targetPrice) ? input.targetPrice : undefined,
    stopLoss: Number.isFinite(input.stopLoss) ? input.stopLoss : undefined,
    catalysts: (input.catalysts ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 20),
    risks: (input.risks ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 20),
    tags: (input.tags ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 20),
    snapshot: input.snapshot,
  }
  const contentHash = hash(content)
  if (existing) {
    if (existing.revisions.at(-1)?.contentHash === contentHash) return existing
    existing.name = input.name?.trim() || existing.name
    existing.updatedAt = now
    existing.currentVersion += 1
    existing.revisions.push({ version: existing.currentVersion, createdAt: now, contentHash, ...content })
    persist()
    return existing
  }
  const record: ResearchRecord = {
    id: randomUUID(),
    code,
    name: input.name?.trim() || code,
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
    currentVersion: 1,
    revisions: [{ version: 1, createdAt: now, contentHash, ...content }],
  }
  state.records.unshift(record)
  persist()
  return record
}

export function listResearchRecords(code?: string): ResearchRecord[] {
  return state.records
    .filter((record) => !code || record.code === code.toLowerCase())
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function removeResearchRecord(id: string): boolean {
  const index = state.records.findIndex((record) => record.id === id)
  if (index < 0) return false
  state.records.splice(index, 1)
  persist()
  return true
}

export function compareResearchRevisions(
  id: string,
  fromVersion: number,
  toVersion: number,
): Array<{ field: string; before: unknown; after: unknown }> {
  const record = state.records.find((item) => item.id === id)
  if (!record) throw new Error('研究记录不存在')
  const from = record.revisions.find((revision) => revision.version === fromVersion)
  const to = record.revisions.find((revision) => revision.version === toVersion)
  if (!from || !to) throw new Error('指定版本不存在')
  const fields: Array<keyof ResearchRevision> = [
    'title', 'thesis', 'stance', 'horizonDays', 'targetPrice', 'stopLoss', 'catalysts', 'risks', 'tags',
  ]
  return fields.flatMap((field) =>
    JSON.stringify(from[field]) === JSON.stringify(to[field])
      ? []
      : [{ field, before: from[field], after: to[field] }])
}
