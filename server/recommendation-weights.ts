/**
 * 推荐权重自校准：用「事后归因结果」反过来调整荐股策略。
 *
 * v2 起同时维护四类参数：
 *   - weights           风格权重（趋势/打板/低吸/龙头/事件/资金/观点）
 *   - dimensionWeights  理由维度权重（基本面/技术/资金/龙虎/事件/观点/行业）
 *   - targetFactor      目标价系数（按实际达成幅度校准）
 *   - confidenceScale   置信度缩放（按预测胜率 vs 实际胜率的校准误差）
 * 每次调整都会写入 adjustments 日志，说明改了什么、依据多少样本。
 */

import type { KLineBar } from './tencent.ts'
import { readJson, writeJson } from './store.ts'
import { buildRecommendationAttribution, MIN_SAMPLES, type RecommendationAttribution } from './recommendation-attribution.ts'
import { refreshReasonGuard, type ReasonGuardState } from './recommendation-guard.ts'
import { REASON_DIMENSIONS } from './recommendation-reasons.ts'

const WEIGHT_FILE = 'recommendation-weights.json'
/** 新旧权重平滑系数：新权重占比，避免单次小样本剧烈抖动 */
const SMOOTH = 0.5

export interface WeightAdjustment {
  at: number
  scope: 'style' | 'dimension' | 'target' | 'confidence'
  key: string
  from: number
  to: number
  samples: number
  reason: string
}

export type RecommendationWeights = {
  version: 2
  updatedAt: number
  weights: Record<string, number>
  dimensionWeights: Record<string, number>
  targetFactor: number
  confidenceScale: number
  adjustments: WeightAdjustment[]
}

export const DEFAULT_WEIGHTS: Record<string, number> = {
  trend: 1,
  limit_up: 1,
  pullback: 1,
  leader: 1,
  event: 1,
  fund: 1,
  opinion: 1,
}

export const DEFAULT_DIMENSION_WEIGHTS: Record<string, number> = REASON_DIMENSIONS.reduce(
  (acc, dimension) => {
    acc[dimension] = 1
    return acc
  },
  {} as Record<string, number>,
)

function emptyState(): RecommendationWeights {
  return {
    version: 2,
    updatedAt: 0,
    weights: { ...DEFAULT_WEIGHTS },
    dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS },
    targetFactor: 1,
    confidenceScale: 1,
    adjustments: [],
  }
}

function loadWeights(): RecommendationWeights {
  const raw = readJson<Partial<RecommendationWeights> & { version?: number; weights?: Record<string, number> }>(WEIGHT_FILE)
  if (!raw || !raw.weights) return emptyState()
  const base = emptyState()
  return {
    version: 2,
    updatedAt: raw.updatedAt ?? 0,
    weights: { ...base.weights, ...raw.weights },
    dimensionWeights: { ...base.dimensionWeights, ...(raw.dimensionWeights ?? {}) },
    targetFactor: typeof raw.targetFactor === 'number' ? raw.targetFactor : 1,
    confidenceScale: typeof raw.confidenceScale === 'number' ? raw.confidenceScale : 1,
    adjustments: Array.isArray(raw.adjustments) ? raw.adjustments.slice(0, 60) : [],
  }
}

export function getRecommendationWeightState(): RecommendationWeights {
  return loadWeights()
}

export function getRecommendationWeights(): Record<string, number> {
  return { ...DEFAULT_WEIGHTS, ...loadWeights().weights }
}

export function getDimensionWeights(): Record<string, number> {
  return { ...DEFAULT_DIMENSION_WEIGHTS, ...loadWeights().dimensionWeights }
}

export function getTargetFactor(): number {
  return loadWeights().targetFactor
}

export function getConfidenceScale(): number {
  return loadWeights().confidenceScale
}

export function saveRecommendationWeights(weights: Record<string, number>): void {
  const state = loadWeights()
  writeJson(WEIGHT_FILE, {
    ...state,
    version: 2,
    updatedAt: Date.now(),
    weights: { ...DEFAULT_WEIGHTS, ...weights },
  } satisfies RecommendationWeights)
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const round2 = (value: number): number => Math.round(value * 100) / 100

/** 风格权重：按该风格的胜率与平均收益 */
function suggestStyleWeights(attribution: RecommendationAttribution): Record<string, number> {
  const weights: Record<string, number> = { ...DEFAULT_WEIGHTS }
  for (const [style, bucket] of Object.entries(attribution.byStyle)) {
    if (!bucket.count || bucket.count < MIN_SAMPLES) continue
    const winEdge = (bucket.winRate - 50) / 100
    const returnEdge = bucket.averageReturnPct / 10
    const excessEdge = (bucket.averageExcessPct ?? 0) / 12
    weights[style] = round2(clamp(1 + winEdge * 0.7 + returnEdge * 0.25 + excessEdge * 0.3, 0.5, 1.5))
  }
  return weights
}

function blend(previous: number, next: number): number {
  return round2(previous * (1 - SMOOTH) + next * SMOOTH)
}

export interface RefreshResult {
  weights: Record<string, number>
  dimensionWeights: Record<string, number>
  targetFactor: number
  confidenceScale: number
  adjustments: WeightAdjustment[]
  suggestions: string[]
  stats: { matured: number; winRate: number; averageReturnPct: number; averageExcessPct: number }
  /** 冷/热理由名单（准入守卫） */
  guard: ReasonGuardState
}

/** 用最新归因结果刷新全部权重参数 */
export async function refreshRecommendationWeights(
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<RefreshResult> {
  const attribution = await buildRecommendationAttribution(loadBars, { minAgeDays: 0, limit: 300 })
  const previous = loadWeights()
  const at = Date.now()
  const adjustments: WeightAdjustment[] = []

  const styleTargets = suggestStyleWeights(attribution)
  const nextStyles: Record<string, number> = { ...previous.weights }
  for (const [style, target] of Object.entries(styleTargets)) {
    const current = previous.weights[style] ?? 1
    const next = blend(current, target)
    if (Math.abs(next - current) >= 0.02) {
      const bucket = attribution.byStyle[style]
      adjustments.push({
        at,
        scope: 'style',
        key: style,
        from: current,
        to: next,
        samples: bucket?.count ?? 0,
        reason:
          '风格「' + style + '」' + (bucket?.count ?? 0) + ' 个样本胜率 ' + (bucket?.winRate ?? 0).toFixed(0) +
          '%、平均收益 ' + (bucket?.averageReturnPct ?? 0).toFixed(2) + '%、超额 ' + (bucket?.averageExcessPct ?? 0).toFixed(2) + 'pct',
      })
    }
    nextStyles[style] = next
  }

  const nextDimensions: Record<string, number> = { ...previous.dimensionWeights }
  for (const item of attribution.byDimension) {
    if (item.samples < MIN_SAMPLES) continue
    const current = previous.dimensionWeights[item.dimension] ?? 1
    const next = blend(current, attribution.dimensionWeights[item.dimension] ?? 1)
    if (Math.abs(next - current) >= 0.02) {
      adjustments.push({
        at,
        scope: 'dimension',
        key: item.dimension,
        from: current,
        to: next,
        samples: item.samples,
        reason:
          '理由维度「' + item.label + '」' + item.samples + ' 个样本跑赢大盘 ' + item.excessHitRate.toFixed(0) +
          '%、平均超额 ' + item.averageExcessPct.toFixed(2) + 'pct',
      })
    }
    nextDimensions[item.dimension] = next
  }

  const hasEnough = attribution.stats.matured >= MIN_SAMPLES
  const nextTargetFactor = hasEnough ? blend(previous.targetFactor, attribution.targetFactor) : previous.targetFactor
  if (hasEnough && Math.abs(nextTargetFactor - previous.targetFactor) >= 0.02) {
    adjustments.push({
      at,
      scope: 'target',
      key: 'targetFactor',
      from: previous.targetFactor,
      to: nextTargetFactor,
      samples: attribution.stats.matured,
      reason:
        '目标价隐含涨幅 +' + attribution.bias.averageTargetImpliedPct.toFixed(1) + '%，实际最大涨幅 +' +
        attribution.bias.averageMaxGainPct.toFixed(1) + '%',
    })
  }

  const nextConfidenceScale = hasEnough ? blend(previous.confidenceScale, attribution.confidenceScale) : previous.confidenceScale
  if (hasEnough && Math.abs(nextConfidenceScale - previous.confidenceScale) >= 0.02) {
    adjustments.push({
      at,
      scope: 'confidence',
      key: 'confidenceScale',
      from: previous.confidenceScale,
      to: nextConfidenceScale,
      samples: attribution.stats.matured,
      reason:
        '置信度校准：实际胜率比预测' + (attribution.bias.calibrationGapPct < 0 ? '低 ' : '高 ') +
        Math.abs(attribution.bias.calibrationGapPct).toFixed(0) + ' 个百分点（校准误差 ' +
        attribution.bias.expectedCalibrationError.toFixed(1) + 'pct）',
    })
  }

  const state: RecommendationWeights = {
    version: 2,
    updatedAt: at,
    weights: nextStyles,
    dimensionWeights: nextDimensions,
    targetFactor: nextTargetFactor,
    confidenceScale: nextConfidenceScale,
    adjustments: [...adjustments, ...previous.adjustments].slice(0, 60),
  }
  writeJson(WEIGHT_FILE, state)

  const guard = refreshReasonGuard(attribution)

  return {
    weights: state.weights,
    dimensionWeights: state.dimensionWeights,
    targetFactor: state.targetFactor,
    confidenceScale: state.confidenceScale,
    adjustments,
    suggestions: attribution.suggestions,
    guard,
    stats: {
      matured: attribution.stats.matured,
      winRate: attribution.stats.winRate,
      averageReturnPct: attribution.stats.averageReturnPct,
      averageExcessPct: attribution.stats.averageExcessPct,
    },
  }
}
