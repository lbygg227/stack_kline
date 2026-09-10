/**
 * 推荐表现追踪：读取已持久化的推荐记录，回看 N 日后的收益、目标/止损命中情况。
 */

import type { KLineBar } from './tencent.ts'
import { readJson } from './store.ts'

const RECORD_FILE = 'recommendation-records.json'

export interface RecommendationOutcome {
  recommendationId: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  entryPrice?: number
  exitPrice?: number
  returnPct?: number
  maxGainPct?: number
  maxLossPct?: number
  hitTarget: boolean
  hitStop: boolean
  invalidated: boolean
  horizonDays: number
}

export interface RecommendationPerformanceStats {
  generatedAt: number
  totalRecords: number
  matured: number
  skipped: number
  winRate: number
  averageReturnPct: number
  byStyle: Record<string, { count: number; winRate: number; averageReturnPct: number }>
  byChannel: Record<string, { count: number; winRate: number; averageReturnPct: number }>
  outcomes: RecommendationOutcome[]
}

type RecommendationRecord = {
  id: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  horizonDays: number
  levels?: { entry?: number; target?: number; stopLoss?: number }
  createdAt: number
}

type RecordStore = { version: number; records: RecommendationRecord[] }

function loadRecords(): RecommendationRecord[] {
  const raw = readJson<RecordStore>(RECORD_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) return []
  return raw.records
}

const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => new Date(msOf(timestamp)).toISOString().slice(0, 10)

export async function buildRecommendationPerformance(
  loadBars: (code: string) => Promise<KLineBar[]>,
  options: { minAgeDays?: number; limit?: number } = {},
): Promise<RecommendationPerformanceStats> {
  const minAgeDays = Math.max(1, options.minAgeDays ?? 3)
  const limit = Math.max(1, Math.min(300, options.limit ?? 300))
  const records = loadRecords().sort((a, b) => b.signalDate.localeCompare(a.signalDate)).slice(0, limit)
  const outcomes: RecommendationOutcome[] = []
  let matured = 0
  let skipped = 0

  for (const record of records) {
    const horizonDays = Math.max(1, record.horizonDays || 5)
    const signalTime = Date.parse(record.signalDate)
    if (!Number.isFinite(signalTime)) continue
    const ageDays = Math.floor((Date.now() - signalTime) / 86_400_000)
    if (ageDays < minAgeDays + horizonDays) {
      skipped += 1
      continue
    }
    matured += 1
    const bars = (await loadBars(record.code).catch(() => []))
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
    const index = bars.findIndex((bar) => dayOf(bar.timestamp) >= record.signalDate)
    if (index < 0 || index + horizonDays >= bars.length) {
      skipped += 1
      continue
    }
    const entryIndex = index + 1
    const exitIndex = index + horizonDays
    const entry = bars[entryIndex]?.open
    const exit = bars[exitIndex]?.close
    if (!entry || !exit) {
      skipped += 1
      continue
    }
    const holding = bars.slice(entryIndex, exitIndex + 1)
    const maxHigh = Math.max(...holding.map((bar) => bar.high))
    const minLow = Math.min(...holding.map((bar) => bar.low))
    const target = record.levels?.target
    const stop = record.levels?.stopLoss
    const hitTarget = target != null && target > 0 && maxHigh >= target
    const hitStop = stop != null && stop > 0 && minLow <= stop
    outcomes.push({
      recommendationId: record.id,
      code: record.code,
      name: record.name,
      style: record.style,
      channels: record.channels,
      signalDate: record.signalDate,
      entryPrice: entry,
      exitPrice: exit,
      returnPct: (exit / entry - 1) * 100,
      maxGainPct: (maxHigh / entry - 1) * 100,
      maxLossPct: (minLow / entry - 1) * 100,
      hitTarget,
      hitStop,
      invalidated: hitStop,
      horizonDays,
    })
  }

  const returns = outcomes.map((o) => o.returnPct ?? 0)
  const avg = returns.length ? returns.reduce((sum, v) => sum + v, 0) / returns.length : 0
  const winRate = outcomes.length ? outcomes.filter((o) => (o.returnPct ?? 0) > 0).length / outcomes.length * 100 : 0
  const byStyle: Record<string, { count: number; winRate: number; averageReturnPct: number }> = {}
  for (const outcome of outcomes) {
    const bucket = byStyle[outcome.style] ?? { count: 0, winRate: 0, averageReturnPct: 0 }
    bucket.count += 1
    bucket.averageReturnPct += outcome.returnPct ?? 0
    if ((outcome.returnPct ?? 0) > 0) bucket.winRate += 1
    byStyle[outcome.style] = bucket
  }
  for (const key of Object.keys(byStyle)) {
    const bucket = byStyle[key]
    bucket.averageReturnPct = bucket.count ? bucket.averageReturnPct / bucket.count : 0
    bucket.winRate = bucket.count ? bucket.winRate / bucket.count * 100 : 0
  }

  const byChannel: Record<string, { count: number; winRate: number; averageReturnPct: number }> = {}
  for (const outcome of outcomes) {
    const channels = outcome.channels.length ? outcome.channels : ['unknown']
    for (const channel of channels) {
      const bucket = byChannel[channel] ?? { count: 0, winRate: 0, averageReturnPct: 0 }
      bucket.count += 1
      bucket.averageReturnPct += outcome.returnPct ?? 0
      if ((outcome.returnPct ?? 0) > 0) bucket.winRate += 1
      byChannel[channel] = bucket
    }
  }
  for (const key of Object.keys(byChannel)) {
    const bucket = byChannel[key]
    bucket.averageReturnPct = bucket.count ? bucket.averageReturnPct / bucket.count : 0
    bucket.winRate = bucket.count ? bucket.winRate / bucket.count * 100 : 0
  }

  return {
    generatedAt: Date.now(),
    totalRecords: records.length,
    matured,
    skipped,
    winRate,
    averageReturnPct: avg,
    byStyle,
    byChannel,
    outcomes: outcomes.slice(0, 200),
  }
}
