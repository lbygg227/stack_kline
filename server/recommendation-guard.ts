/**
 * 推荐准入守卫：把「事后归因结论」和「单条推荐内的反向证据」变成硬性准入门槛。
 *
 * 两类拦截：
 *   1. 冷理由（cold）：归因统计里跑赢率过低的理由，出现即降级为观察，不再直接推荐
 *   2. 反向证据（veto）：这条推荐自己就带着明确的负面事实（高估值分位、业绩下滑、主力大幅净流出）
 *
 * 被拦截的标的不会被丢弃，而是写入观察队列（watch-candidates，status=observe），
 * 保留理由与价位，等条件改善再回到推荐列表。
 */

import { readJson, writeJson } from './store.ts'
import type { RecommendationAttribution } from './recommendation-attribution.ts'
import { REASON_DIMENSION_LABEL, type ReasonDimension } from './recommendation-reasons.ts'

const GUARD_FILE = 'recommendation-guard.json'

/** 理由被判冷/判热所需的最少成熟样本 */
export const MIN_REASON_SAMPLES = 8
/** 跑赢率低于该值判为冷理由 */
export const COLD_HIT_RATE = 40
/** 跑赢率高于该值判为可信理由 */
export const TRUSTED_HIT_RATE = 60

export interface GuardedReason {
  dimension: string
  label: string
  samples: number
  excessHitRate: number
  averageExcessPct: number
}

export interface ReasonGuardState {
  version: 1
  updatedAt: number
  minSamples: number
  /** 低胜率理由：命中即降级观察 */
  penalized: GuardedReason[]
  /** 高胜率理由：命中即确认为正面证据 */
  trusted: GuardedReason[]
  penalizedDimensions: string[]
  trustedDimensions: string[]
}

export interface GuardDecision {
  status: 'recommend' | 'observe'
  /** 命中的冷理由（归因结论） */
  coldReasons: string[]
  /** 硬性拦截（任何风格都不该推荐） */
  vetoes: string[]
  /** 风险提示（不拦截，只在详情里标注） */
  warnings: string[]
  note: string
}

function emptyState(): ReasonGuardState {
  return {
    version: 1,
    updatedAt: 0,
    minSamples: MIN_REASON_SAMPLES,
    penalized: [],
    trusted: [],
    penalizedDimensions: [],
    trustedDimensions: [],
  }
}

export function getReasonGuard(): ReasonGuardState {
  const raw = readJson<ReasonGuardState>(GUARD_FILE)
  if (!raw || raw.version !== 1) return emptyState()
  return { ...emptyState(), ...raw }
}

export function saveReasonGuard(state: ReasonGuardState): void {
  writeJson(GUARD_FILE, state)
}

/** 由归因结果生成冷/热理由名单 */
export function buildReasonGuard(attribution: RecommendationAttribution, now = Date.now()): ReasonGuardState {
  const penalized: GuardedReason[] = []
  const trusted: GuardedReason[] = []
  for (const label of attribution.byLabel) {
    if (label.samples < MIN_REASON_SAMPLES) continue
    const entry: GuardedReason = {
      dimension: label.dimension,
      label: label.label,
      samples: label.samples,
      excessHitRate: label.excessHitRate,
      averageExcessPct: label.averageExcessPct,
    }
    if (label.excessHitRate < COLD_HIT_RATE) penalized.push(entry)
    else if (label.excessHitRate >= TRUSTED_HIT_RATE) trusted.push(entry)
  }
  const penalizedDimensions: string[] = []
  const trustedDimensions: string[] = []
  for (const dimension of attribution.byDimension) {
    if (dimension.samples < MIN_REASON_SAMPLES) continue
    // 维度整体跑输，且该维度下没有可信理由时，整个维度判冷
    if (dimension.excessHitRate < COLD_HIT_RATE && !trusted.some((item) => item.dimension === dimension.dimension)) {
      penalizedDimensions.push(dimension.dimension)
    } else if (dimension.excessHitRate >= TRUSTED_HIT_RATE) {
      trustedDimensions.push(dimension.dimension)
    }
  }
  return {
    version: 1,
    updatedAt: now,
    minSamples: MIN_REASON_SAMPLES,
    penalized: penalized.sort((a, b) => a.excessHitRate - b.excessHitRate).slice(0, 30),
    trusted: trusted.sort((a, b) => b.excessHitRate - a.excessHitRate).slice(0, 30),
    penalizedDimensions,
    trustedDimensions,
  }
}

/** 用最新归因刷新并落盘守卫状态 */
export function refreshReasonGuard(attribution: RecommendationAttribution): ReasonGuardState {
  const state = buildReasonGuard(attribution)
  saveReasonGuard(state)
  return state
}

export interface GuardInput {
  name?: string
  style: string
  reasons?: Array<{ dimension: string; label: string; weight: number }>
  fundamentals?: {
    peTtm?: number
    industryPeMedian?: number
    industryPePercentile?: number
    profitYoy?: number
    revenueYoy?: number
    mainNetInflowPct?: number
    mainNetInflowYi?: number
    debtRatio?: number
  }
  changePct?: number
  /** 涨停板上下文：连板高度与情绪相位 */
  board?: { height?: number; phase?: string }
}

/**
 * 硬性拦截：与风格无关的硬伤（任何策略都不该推荐）。
 * 估值高、业绩波动大属于风格特征（打板/事件本就如此），只做风险提示，不拦。
 */
export function detectVetoes(input: GuardInput): string[] {
  const vetoes: string[] = []
  const f = input.fundamentals
  if (input.name && /ST|退/.test(input.name.toUpperCase())) {
    vetoes.push('名称含 ST/退市风险标识，不纳入推荐')
  }
  if (f) {
    if (typeof f.debtRatio === 'number' && f.debtRatio >= 80) {
      vetoes.push('资产负债率 ' + f.debtRatio.toFixed(1) + '%，财务风险偏高')
    }
    if (typeof f.mainNetInflowPct === 'number' && f.mainNetInflowPct <= -3) {
      vetoes.push('当日主力净占比 ' + f.mainNetInflowPct.toFixed(2) + '%，资金正在流出')
    }
  }
  const height = input.board?.height ?? 0
  const phase = input.board?.phase
  if (height >= 4 && (phase === '退潮' || phase === '冰点')) {
    vetoes.push('情绪' + phase + '期且已是 ' + height + ' 连板，高位接力风险过大')
  } else if (height >= 5) {
    // 历史回测（可成交口径）显示 5 板以上剔除一字板后没有超额收益
    vetoes.push('已 ' + height + ' 连板，剔除一字板后的历史可成交样本无超额收益')
  }
  return vetoes
}

/** 风险提示：不拦截，只在详情中标注，供人工判断 */
export function detectWarnings(input: GuardInput): string[] {
  const warnings: string[] = []
  const f = input.fundamentals
  if (f) {
    if (typeof f.industryPePercentile === 'number' && f.industryPePercentile >= 85 && (f.peTtm ?? 0) > 0) {
      warnings.push('估值处行业 ' + f.industryPePercentile + '% 分位（PE ' + f.peTtm?.toFixed(1) + '），估值无安全边际')
    }
    if ((f.peTtm ?? 1) <= 0) warnings.push('PE(TTM) 为负，公司当前亏损')
    if (typeof f.profitYoy === 'number' && f.profitYoy <= -30) {
      warnings.push('净利润同比 ' + f.profitYoy.toFixed(1) + '%，业绩下滑')
    }
  }
  if ((input.changePct ?? 0) >= 9.8 && input.style !== 'limit_up') {
    warnings.push('当日涨幅 ' + (input.changePct ?? 0).toFixed(1) + '%，追高风险')
  }
  // 高位板 + 情绪退潮：接力风险显著大于收益（硬性拦截在 detectVetoes 中）
  const height = input.board?.height ?? 0
  const phase = input.board?.phase
  if (height >= 3 && (phase === '退潮' || phase === '冰点')) {
    warnings.push('情绪' + phase + '期做 ' + height + ' 连板，注意次日分歧')
  }
  return warnings
}

/** 综合判断：冷理由权重占比过半，或命中任一条反向证据 => 只进观察队列 */
export function evaluateRecordGuard(input: GuardInput, guard: ReasonGuardState = getReasonGuard()): GuardDecision {
  const reasons = input.reasons ?? []
  const totalWeight = reasons.reduce((sum, reason) => sum + reason.weight, 0)
  const coldReasons: string[] = []
  let coldWeight = 0
  for (const reason of reasons) {
    const byLabel = guard.penalized.find((item) => item.label === reason.label)
    const byDimension = guard.penalizedDimensions.includes(reason.dimension)
    if (!byLabel && !byDimension) continue
    const label = byLabel
      ? reason.label + '（跑赢率 ' + byLabel.excessHitRate.toFixed(0) + '%，' + byLabel.samples + ' 样本）'
      : (REASON_DIMENSION_LABEL[reason.dimension as ReasonDimension] ?? reason.dimension) +
        '理由整体跑赢率偏低'
    if (!coldReasons.includes(label)) coldReasons.push(label)
    coldWeight += reason.weight
  }
  const vetoes = detectVetoes(input)
  const warnings = detectWarnings(input)
  const coldShare = totalWeight > 0 ? coldWeight / totalWeight : 0
  const blockedByCold = coldShare >= 0.5 && coldReasons.length > 0
  const status: GuardDecision['status'] = vetoes.length > 0 || blockedByCold ? 'observe' : 'recommend'
  const note = [
    ...vetoes.map((v) => '硬性拦截：' + v),
    ...(blockedByCold ? ['冷理由占比 ' + Math.round(coldShare * 100) + '%：' + coldReasons.join('、')] : []),
  ].join('；')
  return { status, coldReasons, vetoes, warnings, note }
}
