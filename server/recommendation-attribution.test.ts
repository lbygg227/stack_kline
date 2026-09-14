import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeAttribution, MIN_SAMPLES } from './recommendation-attribution.ts'
import type { RecommendationOutcome, RecommendationPerformanceStats } from './recommendation-performance.ts'

function outcome(partial: {
  code: string
  returnPct: number
  excessPct?: number
  dimensions: string[]
  confidence?: number
  targetImpliedPct?: number
  maxGainPct?: number
  hitTarget?: boolean
  hitStop?: boolean
  style?: string
  horizonDays?: number
}): RecommendationOutcome {
  return {
    recommendationId: partial.code + ':' + (partial.style ?? 'trend'),
    code: partial.code,
    name: partial.code,
    style: partial.style ?? 'trend',
    channels: partial.dimensions,
    signalDate: '2026-09-08',
    entryPrice: 10,
    exitPrice: 10 * (1 + partial.returnPct / 100),
    returnPct: partial.returnPct,
    excessPct: partial.excessPct ?? partial.returnPct,
    benchmarkReturnPct: (partial.returnPct ?? 0) - (partial.excessPct ?? partial.returnPct ?? 0),
    maxGainPct: partial.maxGainPct ?? Math.max(partial.returnPct, 0),
    maxLossPct: -3,
    targetImpliedPct: partial.targetImpliedPct ?? 8,
    daysToPeak: 1,
    hitTarget: partial.hitTarget ?? false,
    hitStop: partial.hitStop ?? false,
    invalidated: partial.hitStop ?? false,
    horizonDays: partial.horizonDays ?? 5,
    confidence: partial.confidence ?? 70,
    score: partial.confidence ?? 70,
    reasonScore: 60,
    verificationScore: 60,
    reasons: partial.dimensions.map((dimension) => ({ dimension, key: 'k', label: dimension + '理由', weight: 0.3, strength: 60 })),
    dimensions: partial.dimensions,
  }
}

function stats(outcomes: RecommendationOutcome[]): RecommendationPerformanceStats {
  const byStyle: RecommendationPerformanceStats['byStyle'] = {}
  for (const item of outcomes) {
    const bucket = byStyle[item.style] ?? { count: 0, winRate: 0, averageReturnPct: 0, averageExcessPct: 0 }
    bucket.count += 1
    bucket.averageReturnPct += item.returnPct ?? 0
    bucket.averageExcessPct += item.excessPct ?? 0
    if ((item.returnPct ?? 0) > 0) bucket.winRate += 1
    byStyle[item.style] = bucket
  }
  for (const [key, bucket] of Object.entries(byStyle)) {
    bucket.averageReturnPct /= bucket.count
    bucket.averageExcessPct /= bucket.count
    bucket.winRate = bucket.winRate / bucket.count * 100
    byStyle[key] = bucket
  }
  return {
    generatedAt: 0,
    totalRecords: outcomes.length,
    matured: outcomes.length,
    skipped: 0,
    winRate: 0,
    averageReturnPct: 0,
    averageExcessPct: 0,
    byStyle,
    byChannel: {},
    outcomes,
  }
}

test('有效维度权重上调，无效维度权重下调', () => {
  const outcomes: RecommendationOutcome[] = []
  for (let i = 0; i < 6; i++) {
    outcomes.push(outcome({ code: 'fund' + i, returnPct: 5, excessPct: 4, dimensions: ['fund'] }))
  }
  for (let i = 0; i < 6; i++) {
    outcomes.push(outcome({ code: 'op' + i, returnPct: -4, excessPct: -5, dimensions: ['opinion'] }))
  }
  const attr = summarizeAttribution(stats(outcomes))

  assert.ok(attr.dimensionWeights.fund > 1, '资金面应上调')
  assert.ok(attr.dimensionWeights.opinion < 1, '观点应下调')
  assert.equal(attr.dimensionWeights.technical, 1, '无样本维度保持 1')

  const fund = attr.byDimension.find((d) => d.dimension === 'fund')
  const opinion = attr.byDimension.find((d) => d.dimension === 'opinion')
  assert.equal(fund?.samples, 6)
  assert.equal(fund?.verdict, '有效')
  assert.equal(opinion?.verdict, '无效')
  assert.ok(attr.suggestions.some((s) => s.includes('资金面')))
})

test('样本不足时不调整权重', () => {
  const outcomes = [
    outcome({ code: 'a', returnPct: 6, excessPct: 5, dimensions: ['event'] }),
    outcome({ code: 'b', returnPct: 6, excessPct: 5, dimensions: ['event'] }),
  ]
  const attr = summarizeAttribution(stats(outcomes))
  assert.ok(outcomes.length < MIN_SAMPLES)
  assert.equal(attr.dimensionWeights.event, 1)
  assert.equal(attr.targetFactor, 1)
  assert.equal(attr.confidenceScale, 1)
})

test('过度自信时置信度缩放下调并给出结论', () => {
  const outcomes: RecommendationOutcome[] = []
  for (let i = 0; i < 10; i++) {
    outcomes.push(outcome({ code: 'h' + i, returnPct: i < 2 ? 3 : -3, excessPct: -2, confidence: 85, dimensions: ['technical'] }))
  }
  const attr = summarizeAttribution(stats(outcomes))
  assert.ok(attr.bias.calibrationGapPct < 0, '实际胜率低于预测')
  assert.ok(attr.confidenceScale < 1, '应下调置信度')
  assert.ok(attr.suggestions.some((s) => s.includes('偏乐观')))
})

test('目标价系统性高估时下调目标价系数', () => {
  const outcomes: RecommendationOutcome[] = []
  for (let i = 0; i < 8; i++) {
    outcomes.push(outcome({
      code: 't' + i,
      returnPct: 1,
      excessPct: 0.5,
      dimensions: ['fundamental'],
      targetImpliedPct: 10,
      maxGainPct: 3,
    }))
  }
  const attr = summarizeAttribution(stats(outcomes))
  assert.ok(attr.targetFactor < 1, '目标价系数应下调')
  assert.ok(attr.bias.targetGapPct > 0)
  assert.ok(attr.suggestions.some((s) => s.includes('目标价普遍高估')))
})

test('多维共振统计按维度数分桶', () => {
  const outcomes: RecommendationOutcome[] = []
  for (let i = 0; i < 5; i++) outcomes.push(outcome({ code: 's' + i, returnPct: 6, excessPct: 5, dimensions: ['fund'] }))
  for (let i = 0; i < 5; i++) {
    outcomes.push(outcome({ code: 'm' + i, returnPct: -3, excessPct: -4, dimensions: ['fund', 'technical', 'industry'] }))
  }
  const attr = summarizeAttribution(stats(outcomes))
  const single = attr.resonance.find((r) => r.dimensions === 1)
  const multi = attr.resonance.find((r) => r.dimensions === 3)
  assert.equal(single?.samples, 5)
  assert.equal(multi?.samples, 5)
  assert.equal(single?.excessHitRate, 100)
  assert.equal(multi?.excessHitRate, 0)
})
