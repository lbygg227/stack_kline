/**
 * 推荐风格权重：根据推荐表现统计自动调整各风格的推荐分数。
 */

import type { KLineBar } from './tencent.ts'
import { readJson, writeJson } from './store.ts'
import { buildRecommendationPerformance } from './recommendation-performance.ts'

const WEIGHT_FILE = 'recommendation-weights.json'

export type RecommendationWeights = {
  version: 1
  updatedAt: number
  weights: Record<string, number>
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

function loadWeights(): RecommendationWeights {
  const raw = readJson<RecommendationWeights>(WEIGHT_FILE)
  if (!raw || raw.version !== 1 || !raw.weights) return { version: 1, updatedAt: 0, weights: { ...DEFAULT_WEIGHTS } }
  return raw
}

export function getRecommendationWeights(): Record<string, number> {
  return { ...DEFAULT_WEIGHTS, ...loadWeights().weights }
}

export function saveRecommendationWeights(weights: Record<string, number>): void {
  writeJson(WEIGHT_FILE, {
    version: 1,
    updatedAt: Date.now(),
    weights: { ...DEFAULT_WEIGHTS, ...weights },
  } satisfies RecommendationWeights)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export async function refreshRecommendationWeights(
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<{ weights: Record<string, number>; updatedAt: number; stats: { matured: number; winRate: number; averageReturnPct: number } }> {
  const stats = await buildRecommendationPerformance(loadBars, { minAgeDays: 3, limit: 300 })
  const weights = { ...DEFAULT_WEIGHTS }
  for (const [style, bucket] of Object.entries(stats.byStyle)) {
    if (!bucket.count || bucket.count < 5) continue
    const winEdge = (bucket.winRate - 50) / 100
    const returnEdge = bucket.averageReturnPct / 10
    weights[style] = clamp(1 + winEdge * 0.8 + returnEdge * 0.3, 0.5, 1.5)
  }
  saveRecommendationWeights(weights)
  return {
    weights,
    updatedAt: Date.now(),
    stats: { matured: stats.matured, winRate: stats.winRate, averageReturnPct: stats.averageReturnPct },
  }
}
