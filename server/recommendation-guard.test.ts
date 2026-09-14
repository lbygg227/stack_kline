import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReasonGuard, detectVetoes, detectWarnings, evaluateRecordGuard, MIN_REASON_SAMPLES } from './recommendation-guard.ts'
import type { RecommendationAttribution } from './recommendation-attribution.ts'

function attribution(partial: {
  byLabel: Array<{ dimension: string; label: string; samples: number; excessHitRate: number; averageExcessPct: number }>
  byDimension: Array<{ dimension: string; samples: number; excessHitRate: number }>
}): RecommendationAttribution {
  return {
    generatedAt: 0,
    stats: { totalRecords: 0, matured: 0, skipped: 0, winRate: 0, averageReturnPct: 0, averageExcessPct: 0 },
    byStyle: {},
    byChannel: {},
    byDimension: partial.byDimension.map((d) => ({
      dimension: d.dimension,
      label: d.dimension,
      samples: d.samples,
      directionHitRate: d.excessHitRate,
      excessHitRate: d.excessHitRate,
      averageReturnPct: 0,
      averageExcessPct: 0,
      averageMaxGainPct: 0,
      averageMaxLossPct: 0,
      verdict: '一般' as const,
    })),
    byLabel: partial.byLabel.map((l) => ({
      dimension: l.dimension,
      label: l.label,
      samples: l.samples,
      excessHitRate: l.excessHitRate,
      averageReturnPct: 0,
      averageExcessPct: l.averageExcessPct,
      weight: 0.3,
    })),
    resonance: [],
    bias: {
      samples: 0,
      averageTargetImpliedPct: 0,
      averageActualReturnPct: 0,
      targetGapPct: 0,
      targetHitRate: 0,
      stopHitRate: 0,
      averageMaxGainPct: 0,
      averageMaxLossPct: 0,
      averageDaysToPeak: 0,
      averageHorizonDays: 0,
      potentialGapPct: 0,
      calibration: [],
      expectedCalibrationError: 0,
      calibrationGapPct: 0,
    },
    dimensionWeights: {},
    targetFactor: 1,
    confidenceScale: 1,
    suggestions: [],
    outcomes: [],
  }
}

test('冷理由按样本与跑赢率判定，样本不足不判定', () => {
  const guard = buildReasonGuard(attribution({
    byLabel: [
      { dimension: 'opinion', label: '博主看多', samples: 10, excessHitRate: 25, averageExcessPct: -4 },
      { dimension: 'fund', label: '主力连续净流入', samples: 9, excessHitRate: 72, averageExcessPct: 3 },
      { dimension: 'event', label: '事件催化', samples: 3, excessHitRate: 0, averageExcessPct: -6 },
    ],
    byDimension: [
      { dimension: 'opinion', samples: 10, excessHitRate: 25 },
      { dimension: 'fund', samples: 9, excessHitRate: 72 },
      { dimension: 'event', samples: 3, excessHitRate: 0 },
    ],
  }))
  assert.deepEqual(guard.penalized.map((p) => p.label), ['博主看多'])
  assert.deepEqual(guard.trusted.map((p) => p.label), ['主力连续净流入'])
  assert.deepEqual(guard.penalizedDimensions, ['opinion'])
  assert.deepEqual(guard.trustedDimensions, ['fund'])
  assert.equal(guard.minSamples, MIN_REASON_SAMPLES)
})

test('冷理由权重占比过半即降级为观察，否则正常推荐', () => {
  const guard = buildReasonGuard(attribution({
    byLabel: [{ dimension: 'opinion', label: '博主看多', samples: 10, excessHitRate: 20, averageExcessPct: -5 }],
    byDimension: [],
  }))
  const blocked = evaluateRecordGuard({
    style: 'opinion',
    reasons: [
      { dimension: 'opinion', label: '博主看多', weight: 0.4 },
      { dimension: 'fundamental', label: '估值 低估', weight: 0.1 },
    ],
  }, guard)
  assert.equal(blocked.status, 'observe')
  assert.equal(blocked.coldReasons.length, 1)
  assert.ok(blocked.note.includes('冷理由占比'))

  const pass = evaluateRecordGuard({
    style: 'trend',
    reasons: [
      { dimension: 'opinion', label: '博主看多', weight: 0.1 },
      { dimension: 'fundamental', label: '估值 低估', weight: 0.4 },
      { dimension: 'technical', label: '明显放量', weight: 0.3 },
    ],
  }, guard)
  assert.equal(pass.status, 'recommend')
})

test('硬性拦截只看与风格无关的硬伤', () => {
  assert.ok(detectVetoes({ name: '*ST益通', style: 'limit_up' }).some((v) => v.includes('ST')))
  assert.ok(detectVetoes({ style: 'trend', fundamentals: { debtRatio: 88 } }).some((v) => v.includes('负债率')))
  assert.ok(detectVetoes({ style: 'trend', fundamentals: { mainNetInflowPct: -5 } }).some((v) => v.includes('主力净占比')))
  // 高估值属于打板风格特征，只提示不拦截
  assert.equal(detectVetoes({ style: 'limit_up', fundamentals: { industryPePercentile: 97, peTtm: 200 } }).length, 0)
})

test('风险提示覆盖高估值、亏损、业绩下滑与追高', () => {
  const warnings = detectWarnings({
    style: 'trend',
    changePct: 9.9,
    fundamentals: { industryPePercentile: 92, peTtm: 180, profitYoy: -60 },
  })
  assert.equal(warnings.length, 3)
  assert.ok(warnings.some((w) => w.includes('估值处行业')))
  assert.ok(warnings.some((w) => w.includes('业绩下滑')))
  assert.ok(warnings.some((w) => w.includes('追高风险')))
  assert.equal(detectWarnings({ style: 'limit_up', changePct: 9.9 }).length, 0)
})
