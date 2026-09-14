/**
 * 单只股票的历史推荐对账：回答「上次推荐它，后来对不对」。
 * 数据来自 recommendation-records.json（推荐当时的理由与价位）+ 实际 K 线结算。
 */

import type { KLineBar } from './tencent.ts'
import {
  buildRecommendationPerformance,
  loadStoredRecords,
  type RecommendationOutcome,
  type StoredRecord,
} from './recommendation-performance.ts'

export interface StockHistoryItem {
  signalDate: string
  style: string
  channels: string[]
  confidence: number
  score: number
  thesis: string
  reasonLabels: string[]
  dimensions: string[]
  entryPrice?: number
  target?: number
  stopLoss?: number
  horizonDays: number
  settled: boolean
  returnPct?: number
  benchmarkReturnPct?: number
  excessPct?: number
  maxGainPct?: number
  maxLossPct?: number
  hitTarget: boolean
  hitStop: boolean
  daysToPeak?: number
}

export interface StockHistoryResponse {
  code: string
  name: string
  generatedAt: number
  stats: {
    total: number
    settled: number
    pending: number
    winRate: number
    averageReturnPct: number
    averageExcessPct: number
    hitTargetRate: number
    hitStopRate: number
  }
  verdict: string
  /** 该股按理由维度统计的跑赢情况 */
  byDimension: Array<{ dimension: string; samples: number; excessHitRate: number; averageExcessPct: number }>
  items: StockHistoryItem[]
}

const avg = (values: number[]): number => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0)

function toItem(outcome: RecommendationOutcome, record?: StoredRecord): StockHistoryItem {
  return {
    signalDate: outcome.signalDate,
    style: outcome.style,
    channels: outcome.channels,
    confidence: outcome.confidence ?? 0,
    score: outcome.score ?? 0,
    thesis: record?.thesis ?? '',
    reasonLabels: outcome.reasons.map((r) => r.label),
    dimensions: outcome.dimensions,
    entryPrice: outcome.entryPrice,
    target: record?.levels?.target,
    stopLoss: record?.levels?.stopLoss,
    horizonDays: outcome.horizonDays,
    settled: outcome.returnPct != null,
    returnPct: outcome.returnPct,
    benchmarkReturnPct: outcome.benchmarkReturnPct,
    excessPct: outcome.excessPct,
    maxGainPct: outcome.maxGainPct,
    maxLossPct: outcome.maxLossPct,
    hitTarget: outcome.hitTarget,
    hitStop: outcome.hitStop,
    daysToPeak: outcome.daysToPeak,
  }
}

export async function buildStockRecommendationHistory(
  code: string,
  loadBars: (code: string) => Promise<KLineBar[]>,
  options: { limit?: number } = {},
): Promise<StockHistoryResponse> {
  const key = code.trim().toLowerCase()
  const records = loadStoredRecords().filter((record) => record.code.toLowerCase() === key)
  const stats = await buildRecommendationPerformance(loadBars, { limit: 500, codes: [key] })
  const outcomeMap = new Map(stats.outcomes.map((outcome) => [outcome.recommendationId + ':' + outcome.signalDate, outcome]))
  const recordMap = new Map(records.map((record) => [record.id + ':' + record.signalDate, record]))

  const items: StockHistoryItem[] = []
  for (const outcome of stats.outcomes) {
    items.push(toItem(outcome, recordMap.get(outcome.recommendationId + ':' + outcome.signalDate)))
  }
  // 尚未结算的推荐也要显示（否则用户看不到「今天推了它」）
  for (const record of records) {
    const id = record.id + ':' + record.signalDate
    if (outcomeMap.has(id)) continue
    items.push({
      signalDate: record.signalDate,
      style: record.style,
      channels: record.channels ?? [],
      confidence: record.confidence ?? 0,
      score: record.score ?? 0,
      thesis: record.thesis ?? '',
      reasonLabels: (record.reasons ?? []).map((r) => r.label),
      dimensions: [...new Set((record.reasons ?? []).map((r) => r.dimension))],
      entryPrice: record.levels?.entry,
      target: record.levels?.target,
      stopLoss: record.levels?.stopLoss,
      horizonDays: record.horizonDays,
      settled: false,
      hitTarget: false,
      hitStop: false,
    })
  }
  items.sort((a, b) => b.signalDate.localeCompare(a.signalDate))
  const limited = items.slice(0, Math.max(1, Math.min(100, options.limit ?? 30)))

  const settled = limited.filter((item) => item.settled)
  const returns = settled.map((item) => item.returnPct ?? 0)
  const excesses = settled.filter((item) => item.excessPct != null).map((item) => item.excessPct as number)
  const winRate = settled.length ? settled.filter((item) => (item.returnPct ?? 0) > 0).length / settled.length * 100 : 0
  const averageExcessPct = avg(excesses)

  const dimMap = new Map<string, { returns: number[]; excess: number[]; win: number }>()
  for (const item of settled) {
    for (const dimension of item.dimensions) {
      const bucket = dimMap.get(dimension) ?? { returns: [], excess: [], win: 0 }
      bucket.returns.push(item.returnPct ?? 0)
      if (item.excessPct != null) {
        bucket.excess.push(item.excessPct)
        if (item.excessPct > 0) bucket.win += 1
      }
      dimMap.set(dimension, bucket)
    }
  }
  const byDimension = [...dimMap.entries()].map(([dimension, bucket]) => ({
    dimension,
    samples: bucket.returns.length,
    excessHitRate: bucket.excess.length ? bucket.win / bucket.excess.length * 100 : 0,
    averageExcessPct: avg(bucket.excess),
  }))

  let verdict: string
  if (!settled.length) {
    verdict = records.length ? '有 ' + records.length + ' 条推荐记录，但都还没到结算日，暂无法判断对错。' : '历史上没有推荐过这只股票。'
  } else if (averageExcessPct >= 1 && winRate >= 50) {
    verdict = '历史推荐 ' + settled.length + ' 次，胜率 ' + winRate.toFixed(0) + '%、平均超额 +' + averageExcessPct.toFixed(2) + 'pct，理由在该股上有效。'
  } else if (averageExcessPct <= -1) {
    verdict = '历史推荐 ' + settled.length + ' 次，胜率 ' + winRate.toFixed(0) + '%、平均超额 ' + averageExcessPct.toFixed(2) + 'pct，此前推荐偏早或理由不成立，建议降低权重。'
  } else {
    verdict = '历史推荐 ' + settled.length + ' 次，胜率 ' + winRate.toFixed(0) + '%、平均超额 ' + averageExcessPct.toFixed(2) + 'pct，表现接近大盘。'
  }

  return {
    code: key,
    name: records[0]?.name ?? '',
    generatedAt: Date.now(),
    stats: {
      total: limited.length,
      settled: settled.length,
      pending: limited.length - settled.length,
      winRate,
      averageReturnPct: avg(returns),
      averageExcessPct,
      hitTargetRate: settled.length ? settled.filter((item) => item.hitTarget).length / settled.length * 100 : 0,
      hitStopRate: settled.length ? settled.filter((item) => item.hitStop).length / settled.length * 100 : 0,
    },
    verdict,
    byDimension: byDimension.sort((a, b) => b.samples - a.samples),
    items: limited,
  }
}
