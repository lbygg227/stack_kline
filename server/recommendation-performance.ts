/**
 * 推荐表现追踪：读取已持久化的推荐记录，回看持有期后的真实收益、超额收益与目标/止损命中情况。
 * 每条结果都保留推荐当时的理由维度、理由分与置信度，供后续归因使用。
 */

import type { KLineBar } from './tencent.ts'
import { sessionDateOf } from './trading-day.ts'
import { readJson } from './store.ts'

const RECORD_FILE = 'recommendation-records.json'
/** 基准：上证指数，用于计算「是否真的跑赢大盘」 */
export const BENCHMARK_CODE = 'sh000001'

export interface OutcomeReason {
  dimension: string
  key: string
  label: string
  weight: number
  strength: number
}

export interface RecommendationOutcome {
  recommendationId: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  entryDate?: string
  exitDate?: string
  entryPrice?: number
  exitPrice?: number
  returnPct?: number
  maxGainPct?: number
  maxLossPct?: number
  /** 同期基准收益 */
  benchmarkReturnPct?: number
  /** 相对基准的超额收益 */
  excessPct?: number
  /** 从买入到最高点的交易日数 */
  daysToPeak?: number
  /** 目标价隐含涨幅 */
  targetImpliedPct?: number
  hitTarget: boolean
  hitStop: boolean
  invalidated: boolean
  horizonDays: number
  confidence?: number
  score?: number
  reasonScore?: number
  verificationScore?: number
  reasons: OutcomeReason[]
  dimensions: string[]
}

export interface RecommendationPerformanceStats {
  generatedAt: number
  totalRecords: number
  matured: number
  skipped: number
  winRate: number
  averageReturnPct: number
  averageExcessPct: number
  byStyle: Record<string, { count: number; winRate: number; averageReturnPct: number; averageExcessPct: number }>
  byChannel: Record<string, { count: number; winRate: number; averageReturnPct: number; averageExcessPct: number }>
  outcomes: RecommendationOutcome[]
}

type RecommendationReason = {
  dimension: string
  key: string
  label: string
  weight: number
  strength: number
}

export type StoredRecord = {
  id: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  horizonDays: number
  levels?: { entry?: number; target?: number; stopLoss?: number }
  createdAt: number
  thesis?: string
  confidence?: number
  score?: number
  verification?: { score?: number }
  reasonSummary?: { reasonScore?: number }
  reasons?: RecommendationReason[]
}

type RecordStore = { version: number; records: StoredRecord[] }

export function loadStoredRecords(): StoredRecord[] {
  const raw = readJson<RecordStore>(RECORD_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) return []
  return raw.records
}

/** 通道 -> 理由维度（历史记录兜底用） */
const CHANNEL_DIMENSION: Record<string, string> = {
  technical: 'technical',
  event: 'event',
  opinion: 'opinion',
  fund: 'fund',
  dragon: 'dragon',
}

const CHANNEL_LABEL: Record<string, string> = {
  technical: '技术',
  event: '事件',
  opinion: '观点',
  fund: '资金',
  dragon: '龙虎',
}

const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => sessionDateOf(msOf(timestamp))

type Bucket = { count: number; winRate: number; averageReturnPct: number; averageExcessPct: number }

function tally(bucket: Bucket, outcome: RecommendationOutcome): void {
  bucket.count += 1
  bucket.averageReturnPct += outcome.returnPct ?? 0
  bucket.averageExcessPct += outcome.excessPct ?? 0
  if ((outcome.returnPct ?? 0) > 0) bucket.winRate += 1
}

function finalize(map: Record<string, Bucket>): void {
  for (const key of Object.keys(map)) {
    const bucket = map[key]
    bucket.averageReturnPct = bucket.count ? bucket.averageReturnPct / bucket.count : 0
    bucket.averageExcessPct = bucket.count ? bucket.averageExcessPct / bucket.count : 0
    bucket.winRate = bucket.count ? bucket.winRate / bucket.count * 100 : 0
  }
}

/** 并发受限地加载 K 线并做进程内去重 */
async function loadBarsBatch(
  codes: string[],
  loadBars: (code: string) => Promise<KLineBar[]>,
  concurrency = 6,
): Promise<Map<string, KLineBar[]>> {
  const unique = [...new Set(codes)]
  const result = new Map<string, KLineBar[]>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (cursor < unique.length) {
      const index = cursor++
      const code = unique[index]
      const bars = await loadBars(code).catch(() => [] as KLineBar[])
      result.set(code, bars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0).sort((a, b) => a.timestamp - b.timestamp))
    }
  })
  await Promise.all(workers)
  return result
}

export async function buildRecommendationPerformance(
  loadBars: (code: string) => Promise<KLineBar[]>,
  options: { minAgeDays?: number; limit?: number; now?: number; codes?: string[] } = {},
): Promise<RecommendationPerformanceStats> {
  const minAgeDays = Math.max(0, options.minAgeDays ?? 0)
  const limit = Math.max(1, Math.min(500, options.limit ?? 300))
  const now = options.now ?? Date.now()
  const wanted = options.codes?.length ? new Set(options.codes.map((code) => code.toLowerCase())) : null
  const records = loadStoredRecords()
    .filter((record) => !wanted || wanted.has(record.code.toLowerCase()))
    .sort((a, b) => b.signalDate.localeCompare(a.signalDate))
    .slice(0, limit)

  const barMap = await loadBarsBatch([...records.map((r) => r.code), BENCHMARK_CODE], loadBars)
  const benchBars = barMap.get(BENCHMARK_CODE) ?? []
  const benchIndexByDay = new Map<string, number>()
  benchBars.forEach((bar, index) => {
    const day = dayOf(bar.timestamp)
    if (!benchIndexByDay.has(day)) benchIndexByDay.set(day, index)
  })

  const outcomes: RecommendationOutcome[] = []
  let matured = 0
  let skipped = 0

  for (const record of records) {
    const horizonDays = Math.max(1, record.horizonDays || 5)
    const signalTime = Date.parse(record.signalDate)
    if (!Number.isFinite(signalTime)) continue
    const ageDays = Math.floor((now - signalTime) / 86_400_000)
    if (ageDays < minAgeDays) {
      skipped += 1
      continue
    }
    const bars = barMap.get(record.code) ?? []
    const index = bars.findIndex((bar) => dayOf(bar.timestamp) >= record.signalDate)
    if (index < 0 || index + horizonDays >= bars.length) {
      skipped += 1
      continue
    }
    matured += 1
    const entryIndex = index + 1
    const exitIndex = index + horizonDays
    const entryBar = bars[entryIndex]
    const exitBar = bars[exitIndex]
    const entry = entryBar?.open
    const exit = exitBar?.close
    if (!entry || !exit) {
      skipped += 1
      continue
    }
    const holding = bars.slice(entryIndex, exitIndex + 1)
    let maxHigh = entry
    let minLow = entry
    let peakIndex = 0
    holding.forEach((bar, offset) => {
      if (bar.high > maxHigh) {
        maxHigh = bar.high
        peakIndex = offset
      }
      if (bar.low < minLow) minLow = bar.low
    })
    const target = record.levels?.target
    const stop = record.levels?.stopLoss
    const returnPct = (exit / entry - 1) * 100

    // 基准同区间收益：按实际买卖日对齐（停牌也不影响）
    let benchmarkReturnPct: number | undefined
    const entryDay = dayOf(entryBar.timestamp)
    const exitDay = dayOf(exitBar.timestamp)
    const benchEntry = benchIndexByDay.get(entryDay)
    const benchExit = benchIndexByDay.get(exitDay)
    if (benchEntry != null && benchExit != null && benchEntry < benchBars.length && benchExit < benchBars.length) {
      const base = benchBars[benchEntry].open
      const last = benchBars[benchExit].close
      if (base > 0) benchmarkReturnPct = (last / base - 1) * 100
    }

    // 早期推荐记录没有结构化理由：用通道反推维度，保证历史样本也能参与归因
    const reasons: OutcomeReason[] = record.reasons?.length
      ? record.reasons.map((r) => ({
          dimension: r.dimension,
          key: r.key,
          label: r.label,
          weight: r.weight,
          strength: r.strength,
        }))
      : (record.channels ?? []).map((channel) => ({
          dimension: CHANNEL_DIMENSION[channel] ?? channel,
          key: 'legacy_channel',
          label: (CHANNEL_LABEL[channel] ?? channel) + '通道（历史记录，无结构化理由）',
          weight: 0.3,
          strength: 50,
        }))

    outcomes.push({
      recommendationId: record.id,
      code: record.code,
      name: record.name,
      style: record.style,
      channels: record.channels ?? [],
      signalDate: record.signalDate,
      entryDate: dayOf(entryBar.timestamp),
      exitDate: dayOf(exitBar.timestamp),
      entryPrice: entry,
      exitPrice: exit,
      returnPct,
      maxGainPct: (maxHigh / entry - 1) * 100,
      maxLossPct: (minLow / entry - 1) * 100,
      benchmarkReturnPct,
      excessPct: benchmarkReturnPct != null ? returnPct - benchmarkReturnPct : undefined,
      daysToPeak: peakIndex,
      targetImpliedPct: target && target > 0 ? (target / entry - 1) * 100 : undefined,
      hitTarget: target != null && target > 0 && maxHigh >= target,
      hitStop: stop != null && stop > 0 && minLow <= stop,
      invalidated: stop != null && stop > 0 && minLow <= stop,
      horizonDays,
      confidence: record.confidence,
      score: record.score,
      reasonScore: record.reasonSummary?.reasonScore,
      verificationScore: record.verification?.score,
      reasons,
      dimensions: [...new Set(reasons.map((r) => r.dimension))],
    })
  }

  const returns = outcomes.map((o) => o.returnPct ?? 0)
  const avg = returns.length ? returns.reduce((sum, v) => sum + v, 0) / returns.length : 0
  const excesses = outcomes.filter((o) => o.excessPct != null).map((o) => o.excessPct as number)
  const avgExcess = excesses.length ? excesses.reduce((sum, v) => sum + v, 0) / excesses.length : 0
  const winRate = outcomes.length ? outcomes.filter((o) => (o.returnPct ?? 0) > 0).length / outcomes.length * 100 : 0

  const byStyle: Record<string, Bucket> = {}
  for (const outcome of outcomes) {
    const bucket = byStyle[outcome.style] ?? { count: 0, winRate: 0, averageReturnPct: 0, averageExcessPct: 0 }
    tally(bucket, outcome)
    byStyle[outcome.style] = bucket
  }
  finalize(byStyle)

  const byChannel: Record<string, Bucket> = {}
  for (const outcome of outcomes) {
    const channels = outcome.channels.length ? outcome.channels : ['unknown']
    for (const channel of channels) {
      const bucket = byChannel[channel] ?? { count: 0, winRate: 0, averageReturnPct: 0, averageExcessPct: 0 }
      tally(bucket, outcome)
      byChannel[channel] = bucket
    }
  }
  finalize(byChannel)

  return {
    generatedAt: now,
    totalRecords: records.length,
    matured,
    skipped,
    winRate,
    averageReturnPct: avg,
    averageExcessPct: avgExcess,
    byStyle,
    byChannel,
    outcomes: outcomes.slice(0, 400),
  }
}
