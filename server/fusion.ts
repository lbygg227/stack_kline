import type { OpinionSignal } from './opinion-signals.ts'
import type { StrategyResult } from './strategy.ts'
import type { OpinionPlatform } from './opinions.ts'

export interface FusionConfig {
  platform?: OpinionPlatform
  opinionRequired: boolean
  minOpinionScore: number
  technicalWeight: number
  opinionWeight: number
}

export interface FusionResult {
  code: string
  name: string
  price: number
  changePct: number
  fusionScore: number
  technicalScore: number
  opinionScore?: number
  opinionConfidence?: number
  recommendation: 'recommend' | 'observe' | 'avoid'
  strategies: string[]
  authors: string[]
  reasons: string[]
  risks: string[]
}

const round = (value: number, digits = 2): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function fuseScreeningResults(
  technicalResults: StrategyResult[],
  opinionSignals: OpinionSignal[],
  raw: Partial<FusionConfig> = {},
): FusionResult[] {
  const technicalWeight = Math.max(0, raw.technicalWeight ?? 0.65)
  const opinionWeight = Math.max(0, raw.opinionWeight ?? 0.35)
  const weightTotal = technicalWeight + opinionWeight || 1
  const config: FusionConfig = {
    platform: raw.platform,
    opinionRequired: raw.opinionRequired ?? false,
    minOpinionScore: Math.max(-100, Math.min(100, raw.minOpinionScore ?? 15)),
    technicalWeight: technicalWeight / weightTotal,
    opinionWeight: opinionWeight / weightTotal,
  }
  const signalByCode = new Map(opinionSignals.map((signal) => [signal.code, signal]))
  const maxStrategyHits = Math.max(1, ...technicalResults.map((result) => result.strategies?.length ?? 0))

  return technicalResults.flatMap((result, index) => {
    const signal = signalByCode.get(result.code)
    if (config.opinionRequired && (!signal || signal.score < config.minOpinionScore)) return []
    const strategyHits = result.strategies ?? []
    const rankScore = technicalResults.length <= 1
      ? 70
      : 100 - index / (technicalResults.length - 1) * 40
    const hitScore = strategyHits.length ? strategyHits.length / maxStrategyHits * 100 : 60
    const technicalScore = rankScore * 0.45 + hitScore * 0.55
    const normalizedOpinionScore = signal ? (signal.score + 100) / 2 : 50
    const effectiveOpinionWeight = signal ? config.opinionWeight * signal.confidence : 0
    const effectiveTechnicalWeight = config.technicalWeight + config.opinionWeight - effectiveOpinionWeight
    const fusionScore = technicalScore * effectiveTechnicalWeight + normalizedOpinionScore * effectiveOpinionWeight
    const bearishVeto = Boolean(signal && signal.score <= -30 && signal.confidence >= 0.35)
    const recommendation: FusionResult['recommendation'] = bearishVeto
      ? 'avoid'
      : fusionScore >= 68
        ? 'recommend'
        : fusionScore >= 48
          ? 'observe'
          : 'avoid'
    const reasons = [
      result.reason,
      ...(signal?.theses.slice(0, 3) ?? []),
    ].filter(Boolean)
    return [{
      code: result.code,
      name: result.name,
      price: result.price,
      changePct: result.changePct,
      fusionScore: round(fusionScore),
      technicalScore: round(technicalScore),
      opinionScore: signal?.score,
      opinionConfidence: signal?.confidence,
      recommendation,
      strategies: strategyHits,
      authors: signal?.authors ?? [],
      reasons,
      risks: signal?.risks ?? [],
    }]
  }).sort((a, b) => b.fusionScore - a.fusionScore)
}
