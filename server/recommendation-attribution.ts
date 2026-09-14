/**
 * 荐股归因与偏差诊断：把「推荐理由」和「真实结果」对上账。
 *
 * 回答三个问题：
 *   1. 哪些理由真的有效（按维度/按具体理由统计超额胜率）
 *   2. 荐股偏在哪（方向、幅度、时间、置信度是否过度自信）
 *   3. 下一步改什么（维度权重、风格权重、目标价系数、置信度缩放）
 */

import type { KLineBar } from './tencent.ts'
import type { RecommendationOutcome, RecommendationPerformanceStats } from './recommendation-performance.ts'
import { buildRecommendationPerformance } from './recommendation-performance.ts'
import { REASON_DIMENSION_LABEL, REASON_DIMENSIONS, type ReasonDimension } from './recommendation-reasons.ts'

/** 样本少于该数量时不参与权重调整，避免小样本过拟合 */
export const MIN_SAMPLES = 5

export interface DimensionAttribution {
  dimension: string
  label: string
  samples: number
  directionHitRate: number
  excessHitRate: number
  averageReturnPct: number
  averageExcessPct: number
  averageMaxGainPct: number
  averageMaxLossPct: number
  verdict: '有效' | '一般' | '无效' | '样本不足'
}

export interface LabelAttribution {
  dimension: string
  label: string
  samples: number
  excessHitRate: number
  averageReturnPct: number
  averageExcessPct: number
  /** 该理由出现时的平均权重 */
  weight: number
}

export interface CalibrationBucket {
  bucket: string
  samples: number
  predictedWinRate: number
  actualWinRate: number
  gapPct: number
  averageReturnPct: number
}

export interface AttributionBias {
  samples: number
  averageTargetImpliedPct: number
  averageActualReturnPct: number
  /** 目标价高估幅度（百分点） */
  targetGapPct: number
  targetHitRate: number
  stopHitRate: number
  averageMaxGainPct: number
  averageMaxLossPct: number
  averageDaysToPeak: number
  averageHorizonDays: number
  /** 达到目标所需涨幅 vs 持有期内实际最大涨幅的差距 */
  potentialGapPct: number
  calibration: CalibrationBucket[]
  /** 校准误差绝对值（ECE） */
  expectedCalibrationError: number
  /** 有符号校准偏差：实际胜率 - 预测胜率，负值表示过度自信 */
  calibrationGapPct: number
}

export interface ResonanceBucket {
  dimensions: number
  samples: number
  winRate: number
  excessHitRate: number
  averageReturnPct: number
  averageExcessPct: number
}

export interface RecommendationAttribution {
  generatedAt: number
  stats: {
    totalRecords: number
    matured: number
    skipped: number
    winRate: number
    averageReturnPct: number
    averageExcessPct: number
  }
  byStyle: RecommendationPerformanceStats['byStyle']
  byChannel: RecommendationPerformanceStats['byChannel']
  byDimension: DimensionAttribution[]
  byLabel: LabelAttribution[]
  resonance: ResonanceBucket[]
  bias: AttributionBias
  /** 建议的维度权重（未与历史权重平滑） */
  dimensionWeights: Record<string, number>
  /** 建议的目标价系数 */
  targetFactor: number
  /** 建议的置信度整体缩放 */
  confidenceScale: number
  suggestions: string[]
  /** 明细（前端展开查看逐条推荐的对账结果） */
  outcomes: Array<{
    code: string
    name: string
    style: string
    signalDate: string
    dimensions: string[]
    reasonLabels: string[]
    returnPct?: number
    excessPct?: number
    benchmarkReturnPct?: number
    targetImpliedPct?: number
    hitTarget: boolean
    hitStop: boolean
    confidence?: number
    reasonScore?: number
  }>
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const round2 = (value: number): number => Math.round(value * 100) / 100
const avg = (values: number[]): number => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0)

function verdictOf(samples: number, excessHitRate: number): DimensionAttribution['verdict'] {
  if (samples < MIN_SAMPLES) return '样本不足'
  if (excessHitRate >= 55) return '有效'
  if (excessHitRate >= 42) return '一般'
  return '无效'
}

function buildByDimension(outcomes: RecommendationOutcome[]): DimensionAttribution[] {
  const result: DimensionAttribution[] = []
  for (const dimension of REASON_DIMENSIONS) {
    const group = outcomes.filter((o) => o.dimensions.includes(dimension))
    if (!group.length) continue
    const withExcess = group.filter((o) => o.excessPct != null)
    const excessHitRate = withExcess.length ? withExcess.filter((o) => (o.excessPct as number) > 0).length / withExcess.length * 100 : 0
    result.push({
      dimension,
      label: REASON_DIMENSION_LABEL[dimension as ReasonDimension] ?? dimension,
      samples: group.length,
      directionHitRate: group.filter((o) => (o.returnPct ?? 0) > 0).length / group.length * 100,
      excessHitRate,
      averageReturnPct: avg(group.map((o) => o.returnPct ?? 0)),
      averageExcessPct: avg(withExcess.map((o) => o.excessPct as number)),
      averageMaxGainPct: avg(group.map((o) => o.maxGainPct ?? 0)),
      averageMaxLossPct: avg(group.map((o) => o.maxLossPct ?? 0)),
      verdict: verdictOf(group.length, excessHitRate),
    })
  }
  return result.sort((a, b) => b.samples - a.samples)
}

function buildByLabel(outcomes: RecommendationOutcome[]): LabelAttribution[] {
  const map = new Map<string, { dimension: string; label: string; group: RecommendationOutcome[]; weightSum: number }>()
  for (const outcome of outcomes) {
    for (const reason of outcome.reasons) {
      const key = reason.dimension + '|' + reason.label
      const item = map.get(key) ?? { dimension: reason.dimension, label: reason.label, group: [], weightSum: 0 }
      item.group.push(outcome)
      item.weightSum += reason.weight
      map.set(key, item)
    }
  }
  const result: LabelAttribution[] = []
  for (const item of map.values()) {
    const withExcess = item.group.filter((o) => o.excessPct != null)
    result.push({
      dimension: item.dimension,
      label: item.label,
      samples: item.group.length,
      excessHitRate: withExcess.length ? withExcess.filter((o) => (o.excessPct as number) > 0).length / withExcess.length * 100 : 0,
      averageReturnPct: avg(item.group.map((o) => o.returnPct ?? 0)),
      averageExcessPct: avg(withExcess.map((o) => o.excessPct as number)),
      weight: round2(item.weightSum / item.group.length),
    })
  }
  return result.sort((a, b) => b.samples - a.samples).slice(0, 24)
}

function buildResonance(outcomes: RecommendationOutcome[]): ResonanceBucket[] {
  const buckets = new Map<number, RecommendationOutcome[]>()
  for (const outcome of outcomes) {
    const count = Math.min(4, outcome.dimensions.length)
    const list = buckets.get(count) ?? []
    list.push(outcome)
    buckets.set(count, list)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dimensions, group]) => {
      const withExcess = group.filter((o) => o.excessPct != null)
      return {
        dimensions,
        samples: group.length,
        winRate: group.filter((o) => (o.returnPct ?? 0) > 0).length / group.length * 100,
        excessHitRate: withExcess.length ? withExcess.filter((o) => (o.excessPct as number) > 0).length / withExcess.length * 100 : 0,
        averageReturnPct: avg(group.map((o) => o.returnPct ?? 0)),
        averageExcessPct: avg(withExcess.map((o) => o.excessPct as number)),
      }
    })
}

function buildBias(outcomes: RecommendationOutcome[]): AttributionBias {
  const withTarget = outcomes.filter((o) => o.targetImpliedPct != null)
  const withPeak = outcomes.filter((o) => o.daysToPeak != null)
  const implied = avg(withTarget.map((o) => o.targetImpliedPct as number))
  const actual = avg(withTarget.map((o) => o.returnPct ?? 0))
  const maxGain = avg(withTarget.map((o) => o.maxGainPct ?? 0))

  const buckets: Array<{ bucket: string; min: number; max: number }> = [
    { bucket: '0-40', min: 0, max: 40 },
    { bucket: '40-55', min: 40, max: 55 },
    { bucket: '55-70', min: 55, max: 70 },
    { bucket: '70-100', min: 70, max: 100 },
  ]
  const calibration: CalibrationBucket[] = []
  for (const bucket of buckets) {
    const group = outcomes.filter((o) => typeof o.confidence === 'number' && o.confidence >= bucket.min && o.confidence < bucket.max)
    if (!group.length) continue
    const predicted = avg(group.map((o) => o.confidence as number))
    const realized = group.filter((o) => (o.returnPct ?? 0) > 0).length / group.length * 100
    calibration.push({
      bucket: bucket.bucket,
      samples: group.length,
      predictedWinRate: predicted,
      actualWinRate: realized,
      gapPct: realized - predicted,
      averageReturnPct: avg(group.map((o) => o.returnPct ?? 0)),
    })
  }
  const totalSamples = calibration.reduce((sum, b) => sum + b.samples, 0)
  const ece = totalSamples
    ? calibration.reduce((sum, b) => sum + Math.abs(b.gapPct) * b.samples, 0) / totalSamples
    : 0
  const signedGap = totalSamples
    ? calibration.reduce((sum, b) => sum + b.gapPct * b.samples, 0) / totalSamples
    : 0

  return {
    samples: outcomes.length,
    averageTargetImpliedPct: implied,
    averageActualReturnPct: actual,
    targetGapPct: implied - actual,
    targetHitRate: outcomes.length ? outcomes.filter((o) => o.hitTarget).length / outcomes.length * 100 : 0,
    stopHitRate: outcomes.length ? outcomes.filter((o) => o.hitStop).length / outcomes.length * 100 : 0,
    averageMaxGainPct: avg(outcomes.map((o) => o.maxGainPct ?? 0)),
    averageMaxLossPct: avg(outcomes.map((o) => o.maxLossPct ?? 0)),
    averageDaysToPeak: avg(withPeak.map((o) => o.daysToPeak as number)),
    averageHorizonDays: avg(outcomes.map((o) => o.horizonDays)),
    potentialGapPct: implied - maxGain,
    calibration,
    expectedCalibrationError: ece,
    calibrationGapPct: signedGap,
  }
}

function suggestDimensionWeights(byDimension: DimensionAttribution[]): Record<string, number> {
  const weights: Record<string, number> = {}
  for (const dimension of REASON_DIMENSIONS) weights[dimension] = 1
  for (const item of byDimension) {
    if (item.samples < MIN_SAMPLES) continue
    const hitEdge = (item.excessHitRate - 50) / 100
    const excessEdge = item.averageExcessPct / 12
    weights[item.dimension] = round2(clamp(1 + hitEdge * 0.9 + excessEdge * 0.4, 0.55, 1.55))
  }
  return weights
}

export function summarizeAttribution(
  stats: RecommendationPerformanceStats,
  options: { now?: number } = {},
): RecommendationAttribution {
  const outcomes = stats.outcomes
  const byDimension = buildByDimension(outcomes)
  const byLabel = buildByLabel(outcomes)
  const resonance = buildResonance(outcomes)
  const bias = buildBias(outcomes)
  const dimensionWeights = suggestDimensionWeights(byDimension)

  // 目标价系数：只在有足够样本且目标确实被高估时下调
  let targetFactor = 1
  if (outcomes.length >= MIN_SAMPLES && bias.averageTargetImpliedPct > 0.5) {
    const realized = Math.max(0.5, bias.averageMaxGainPct)
    targetFactor = round2(clamp(realized / bias.averageTargetImpliedPct, 0.45, 1.15))
  }

  // 置信度缩放：预测胜率 vs 实际胜率的整体比值
  let confidenceScale = 1
  if (outcomes.length >= MIN_SAMPLES && bias.calibration.length) {
    const samples = bias.calibration.reduce((sum, b) => sum + b.samples, 0)
    const predicted = bias.calibration.reduce((sum, b) => sum + b.predictedWinRate * b.samples, 0) / samples
    const actual = bias.calibration.reduce((sum, b) => sum + b.actualWinRate * b.samples, 0) / samples
    if (predicted > 0) confidenceScale = round2(clamp(actual / predicted, 0.6, 1.15))
  }

  const suggestions: string[] = []
  if (!outcomes.length) {
    suggestions.push('暂无成熟样本：推荐记录需要跨过持有期后才能结算，先积累 5 个以上样本再调整权重。')
  }
  for (const item of byDimension) {
    if (item.samples < MIN_SAMPLES) continue
    if (item.excessHitRate < 42) {
      suggestions.push(
        item.label + '理由 ' + item.samples + ' 个样本，跑赢大盘仅 ' + item.excessHitRate.toFixed(0) + '%，平均超额 ' +
        item.averageExcessPct.toFixed(2) + 'pct → 权重下调至 ' + dimensionWeights[item.dimension].toFixed(2),
      )
    } else if (item.excessHitRate >= 55) {
      suggestions.push(
        item.label + '理由 ' + item.samples + ' 个样本，跑赢大盘 ' + item.excessHitRate.toFixed(0) + '%，平均超额 ' +
        item.averageExcessPct.toFixed(2) + 'pct → 权重上调至 ' + dimensionWeights[item.dimension].toFixed(2),
      )
    }
  }
  if (bias.calibration.length && bias.expectedCalibrationError >= 8) {
    suggestions.push(
      bias.calibrationGapPct < 0
        ? '置信度偏乐观：实际胜率比预测低 ' + Math.abs(bias.calibrationGapPct).toFixed(0) + ' 个百分点（校准误差 ' +
          bias.expectedCalibrationError.toFixed(0) + 'pct）→ 置信度整体 ×' + confidenceScale.toFixed(2)
        : '置信度偏低（实测比预测更强）：实际胜率比预测高 ' + bias.calibrationGapPct.toFixed(0) + ' 个百分点（校准误差 ' +
          bias.expectedCalibrationError.toFixed(0) + 'pct）→ 置信度整体 ×' + confidenceScale.toFixed(2),
    )
  }
  if (bias.samples >= MIN_SAMPLES && Math.abs(bias.targetGapPct) >= 1.5) {
    suggestions.push(
      bias.targetGapPct > 0
        ? '目标价普遍高估：隐含涨幅 +' + bias.averageTargetImpliedPct.toFixed(1) + '% vs 实际 +' + bias.averageActualReturnPct.toFixed(1) + '%（差 ' + bias.targetGapPct.toFixed(1) + 'pct）→ 目标价系数 ' + targetFactor.toFixed(2)
        : '目标价偏保守：实际收益高于目标 ' + Math.abs(bias.targetGapPct).toFixed(1) + 'pct → 目标价系数 ' + targetFactor.toFixed(2),
    )
  }
  if (bias.samples >= MIN_SAMPLES && bias.averageDaysToPeak > 0) {
    const nearEnd = bias.averageDaysToPeak >= bias.averageHorizonDays - 0.5
    suggestions.push(
      nearEnd
        ? '最大收益多出现在持有期末（平均第 ' + bias.averageDaysToPeak.toFixed(1) + ' / ' + bias.averageHorizonDays.toFixed(0) + ' 日）→ 持有期偏短，可考虑延长'
        : '最大收益平均出现在第 ' + bias.averageDaysToPeak.toFixed(1) + ' 日（持有期 ' + bias.averageHorizonDays.toFixed(0) + ' 日）→ 持有期设置合理',
    )
  }
  const multi = resonance.find((r) => r.dimensions >= 3)
  const single = resonance.find((r) => r.dimensions === 1)
  if (multi && single && multi.samples >= MIN_SAMPLES && single.samples >= MIN_SAMPLES && multi.excessHitRate - single.excessHitRate >= 8) {
    suggestions.push(
      '多维共振更可靠：3 个以上理由维度 ' + multi.samples + ' 个样本跑赢率 ' + multi.excessHitRate.toFixed(0) +
      '%，单维度 ' + single.samples + ' 个样本 ' + single.excessHitRate.toFixed(0) + '% → 优先推荐多维度共振标的',
    )
  }

  return {
    generatedAt: options.now ?? Date.now(),
    stats: {
      totalRecords: stats.totalRecords,
      matured: stats.matured,
      skipped: stats.skipped,
      winRate: stats.winRate,
      averageReturnPct: stats.averageReturnPct,
      averageExcessPct: stats.averageExcessPct,
    },
    byStyle: stats.byStyle,
    byChannel: stats.byChannel,
    byDimension,
    byLabel,
    resonance,
    bias,
    dimensionWeights,
    targetFactor,
    confidenceScale,
    suggestions,
    outcomes: outcomes.slice(0, 120).map((o) => ({
      code: o.code,
      name: o.name,
      style: o.style,
      signalDate: o.signalDate,
      dimensions: o.dimensions,
      reasonLabels: o.reasons.map((r) => r.label),
      returnPct: o.returnPct,
      excessPct: o.excessPct,
      benchmarkReturnPct: o.benchmarkReturnPct,
      targetImpliedPct: o.targetImpliedPct,
      hitTarget: o.hitTarget,
      hitStop: o.hitStop,
      confidence: o.confidence,
      reasonScore: o.reasonScore,
    })),
  }
}

export async function buildRecommendationAttribution(
  loadBars: (code: string) => Promise<KLineBar[]>,
  options: { minAgeDays?: number; limit?: number } = {},
): Promise<RecommendationAttribution> {
  const stats = await buildRecommendationPerformance(loadBars, { minAgeDays: options.minAgeDays ?? 0, limit: options.limit ?? 300 })
  return summarizeAttribution(stats)
}
