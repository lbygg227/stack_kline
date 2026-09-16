/**
 * 结构化推荐理由：把每个通道的入选依据拆成「维度 + 具体数值 + 事后验证口径」。
 *
 * 目的：让每条推荐都能回答三个问题——
 *   1. 为什么推荐（基本面 / 技术 / 资金 / 事件 / 观点 / 龙虎 / 行业，各自给出具体数值）
 *   2. 怎么算对（每条理由都带 expect，回测时按同一口径判定成立或证伪）
 *   3. 错了改什么（归因按维度统计胜率，反过来调整维度权重与目标价系数）
 */

import type { SnapshotStock } from './eastmoney.ts'
import type { FundamentalSignal } from './fundamentals.ts'
import type { IndustryStats } from './screening-strategies.ts'

export type ReasonDimension = 'board' | 'fundamental' | 'technical' | 'fund' | 'dragon' | 'event' | 'opinion' | 'industry'

export const REASON_DIMENSION_LABEL: Record<ReasonDimension, string> = {
  board: '涨停板',
  fundamental: '基本面',
  technical: '技术面',
  fund: '资金面',
  dragon: '龙虎榜',
  event: '事件催化',
  opinion: '博主观点',
  industry: '行业板块',
}

export const REASON_DIMENSIONS: ReasonDimension[] = ['board', 'fundamental', 'technical', 'fund', 'dragon', 'event', 'opinion', 'industry']

export interface ReasonSourceLink {
  authorName: string
  platform: string
  title: string
  url: string
  publishedAt: number
}

export interface RecommendationReason {
  dimension: ReasonDimension
  key: string
  label: string
  detail: string
  /** 该理由在综合结论里的权重 0~1 */
  weight: number
  /** 理由自身强度 0~100 */
  strength: number
  metrics: Record<string, number | string>
  /** 事后验证口径：满足什么条件算这条理由成立 */
  expect: string
  sources?: ReasonSourceLink[]
}

export interface ReasonSummary {
  total: number
  byDimension: Record<string, number>
  topLabels: string[]
  /** 理由加权强度 0~100，作为「理由分」参与置信度计算 */
  reasonScore: number
}

const f2 = (value: number): number => Number(value.toFixed(2))

/** 技术面理由：全部来自当日量价快照，数值可直接核对 */
export function technicalReasons(stock: SnapshotStock, stats?: IndustryStats): RecommendationReason[] {
  const reasons: RecommendationReason[] = []
  const range = stock.high > stock.low ? (stock.price - stock.low) / (stock.high - stock.low) : 0.5
  reasons.push({
    dimension: 'technical',
    key: 'price_action',
    label: stock.changePct >= 9.8 ? '涨停' : stock.changePct >= 3 ? '放量上攻' : stock.changePct > 0 ? '小幅走强' : '回调',
    detail:
      '涨跌幅 ' + f2(stock.changePct) + '%，收于当日振幅 ' + (range * 100).toFixed(0) + '% 位置' +
      '（价 ' + f2(stock.price) + ' / 高 ' + f2(stock.high) + ' / 低 ' + f2(stock.low) + '）',
    weight: 0.3,
    strength: Math.max(20, Math.min(92, 50 + stock.changePct * 4)),
    metrics: { changePct: f2(stock.changePct), closePosition: Math.round(range * 100) },
    expect: '形态成立 → 次日不跌破当日均价，3 日内不跌破推荐日最低价',
  })
  if (stock.volumeRatio > 0) {
    const active = stock.volumeRatio >= 1.5 ? '明显放量' : stock.volumeRatio >= 1 ? '温和放量' : '缩量'
    reasons.push({
      dimension: 'technical',
      key: 'volume',
      label: active,
      detail: '量比 ' + f2(stock.volumeRatio) + '，换手率 ' + f2(stock.turnover) + '%，成交额 ' + (stock.amount / 1e8).toFixed(2) + '亿',
      weight: 0.24,
      strength: Math.max(25, Math.min(90, 40 + (stock.volumeRatio - 1) * 35 + stock.turnover * 2)),
      metrics: { volumeRatio: f2(stock.volumeRatio), turnover: f2(stock.turnover), amountYi: f2(stock.amount / 1e8) },
      expect: '放量有效 → 后续 3 日成交额不低于推荐日的 60%，且价格不创推荐日新低',
    })
  }
  if (stats) {
    const edge = stock.changePct - stats.avgChangePct
    reasons.push({
      dimension: 'industry',
      key: 'industry_relative',
      label: edge >= 3 ? '显著强于板块' : edge >= 0 ? '略强于板块' : '弱于板块',
      detail: '个股 ' + f2(stock.changePct) + '% vs 行业均值 ' + f2(stats.avgChangePct) + '%（超额 ' + f2(edge) + 'pct）',
      weight: 0.18,
      strength: Math.max(20, Math.min(90, 50 + edge * 6)),
      metrics: { stockChangePct: f2(stock.changePct), industryAvgChangePct: f2(stats.avgChangePct), edgePct: f2(edge) },
      expect: '板块共振 → 持有期内个股涨幅不低于所属行业中位数',
    })
  }
  return reasons
}

export function fundamentalReasons(signals: FundamentalSignal[]): RecommendationReason[] {
  return signals.map((signal) => ({
    dimension: 'fundamental' as ReasonDimension,
    key: signal.key,
    label: signal.label,
    detail: signal.detail,
    weight: signal.weight,
    strength: signal.strength,
    metrics: signal.metrics,
    expect: signal.expect,
  }))
}

export function fundReasons(item: {
  mainNetSum: number
  mainNetToday: number
  consecutiveInflowDays: number
  positiveDays: number
  lookbackDays: number
}): RecommendationReason[] {
  const reasons: RecommendationReason[] = [{
    dimension: 'fund',
    key: 'main_net_inflow',
    label: '主力连续净流入',
    detail: '近 ' + item.lookbackDays + ' 日主力净流入 ' + (item.mainNetSum / 1e8).toFixed(2) + '亿，连续流入 ' + item.consecutiveInflowDays + ' 日，净流入天数 ' + item.positiveDays + '/' + item.lookbackDays,
    weight: 0.4,
    strength: Math.max(30, Math.min(92, 45 + item.consecutiveInflowDays * 8 + (item.mainNetSum / 1e8))),
    metrics: { mainNetSumYi: f2(item.mainNetSum / 1e8), mainNetTodayYi: f2(item.mainNetToday / 1e8), consecutiveDays: item.consecutiveInflowDays },
    expect: '资金逻辑成立 → 持有期内主力净流入未转为持续流出，且股价跑赢大盘',
  }]
  return reasons
}

export function dragonReasons(item: {
  netValue: number
  orgNetValue: number | null
  hotMoneyNetValue: number | null
  boardType: string
  concepts: string[]
  occurrences?: number
  tradeDates?: string[]
}): RecommendationReason[] {
  const reasons: RecommendationReason[] = [{
    dimension: 'dragon',
    key: 'dragon_board',
    label: '龙虎榜净买入',
    detail:
      (item.tradeDates?.length ? item.tradeDates.join('、') + ' ' : '') + '上榜 ' + (item.occurrences ?? 1) + ' 次（' + item.boardType + '），净买额 ' +
      (item.netValue / 1e8).toFixed(2) + '亿' +
      (item.orgNetValue != null ? '，机构净买 ' + (item.orgNetValue / 1e8).toFixed(2) + '亿' : '') +
      (item.hotMoneyNetValue != null ? '，游资净买 ' + (item.hotMoneyNetValue / 1e8).toFixed(2) + '亿' : ''),
    weight: 0.34,
    strength: Math.max(30, Math.min(92, 50 + (item.netValue / 1e8) * 1.5 + ((item.occurrences ?? 1) - 1) * 10)),
    metrics: {
      netValueYi: f2(item.netValue / 1e8),
      orgNetValueYi: item.orgNetValue != null ? f2(item.orgNetValue / 1e8) : 0,
      hotMoneyNetValueYi: item.hotMoneyNetValue != null ? f2(item.hotMoneyNetValue / 1e8) : 0,
      occurrences: item.occurrences ?? 1,
    },
    expect: '龙虎榜逻辑成立 → 次日不炸板，且 3 日内收盘价不低于上榜日收盘价',
  }]
  if (item.concepts.length) {
    reasons.push({
      dimension: 'dragon',
      key: 'dragon_concepts',
      label: '题材加持',
      detail: '关联题材：' + item.concepts.slice(0, 4).join('、'),
      weight: 0.16,
      strength: 58,
      metrics: { conceptCount: item.concepts.length },
      expect: '题材发酵 → 持有期内相关题材指数走强',
    })
  }
  return reasons
}

export function eventReasons(item: { headlines: string[]; eventCount: number; source?: string }): RecommendationReason[] {
  if (!item.headlines.length) return []
  return [{
    dimension: 'event',
    key: 'event_catalyst',
    label: '事件催化',
    detail: '命中 ' + item.eventCount + ' 条事件：' + item.headlines.slice(0, 2).map((h) => (h.length > 52 ? h.slice(0, 52) + '…' : h)).join('；'),
    weight: 0.36,
    strength: Math.max(35, Math.min(90, 45 + item.eventCount * 12)),
    metrics: { eventCount: item.eventCount },
    expect: '事件逻辑成立 → 事件后 7 日内股价跑赢大盘，且题材热度未快速退潮',
  }]
}

export function opinionReasons(item: {
  authors: string[]
  claimCount: number
  agreement: number
  confidence: number
  theses: string[]
  risks?: string[]
  sources?: ReasonSourceLink[]
  /** 支撑该观点的内容类型：只有想法的信号要大幅降权 */
  kinds?: Array<'pin' | 'longform' | 'manual'>
}): RecommendationReason[] {
  if (!item.authors.length && !item.claimCount) return []
  const onlyPin = item.kinds?.length === 1 && item.kinds[0] === 'pin'
  const kindLabel = item.kinds?.length
    ? item.kinds.map((kind) => (kind === 'pin' ? '想法' : kind === 'longform' ? '长文' : '手工导入')).join('/')
    : ''
  const reasons: RecommendationReason[] = [{
    dimension: 'opinion',
    key: 'blogger_bullish',
    label: onlyPin ? '博主看多（仅想法）' : '博主看多',
    detail:
      item.authors.length + ' 位博主 · ' + item.claimCount + ' 条观点' + (kindLabel ? '（' + kindLabel + '）' : '') +
      ' · 一致度 ' + Math.round(item.agreement * 100) + '%' +
      (item.theses[0] ? '：' + (item.theses[0].length > 70 ? item.theses[0].slice(0, 70) + '…' : item.theses[0]) : ''),
    // 分层回测：想法在 3/5/10/20 日全部负超额，长文稳定正超额 → 仅想法支撑的信号降权
    weight: onlyPin ? 0.16 : 0.38,
    strength: Math.max(18, Math.min(88, 35 + item.confidence * 40 + item.agreement * 20 - (onlyPin ? 18 : 0))),
    metrics: {
      authors: item.authors.length,
      claims: item.claimCount,
      agreement: Math.round(item.agreement * 100),
      kinds: kindLabel || '未知',
    },
    expect: '观点成立 → 观点发布后 7 日内股价跟随上涨；若观点看多但价格走弱即为证伪',
    sources: item.sources?.slice(0, 5),
  }]
  if (item.risks?.length) {
    reasons.push({
      dimension: 'opinion',
      key: 'blogger_risk',
      label: '观点提示风险',
      detail: item.risks.slice(0, 2).join('；'),
      weight: 0.12,
      strength: 35,
      metrics: { riskCount: item.risks.length },
      expect: '风险兑现 → 若提示的风险事件发生，推荐应判定为失效',
    })
  }
  return reasons
}

/** 涨停板理由：连板高度、板块效应、封板质量、情绪相位 */
export function boardReasons(item: {
  board: number
  /** relay = 板块补涨（未涨停的跟随标的） */
  kind?: 'board' | 'relay'
  isSectorLeader: boolean
  topSector?: string
  topSectorCount?: number
  firstSealAt?: string
  breakCount?: number
  recognition: number
  sectorNames?: string[]
  /** 板块连板分布：{ '1': 3, '2': 1 } */
  sectorLadder?: Record<string, number>
  sectorFirstSealAt?: string
  sectorMainNetInflowYi?: number
  sectorHeat?: number
  sentimentPhase?: string
  sentimentScore?: number
}): RecommendationReason[] {
  const reasons: RecommendationReason[] = []
  const isRelay = item.kind === 'relay'
  reasons.push({
    dimension: 'board',
    key: 'board_height',
    label: isRelay
      ? '板块补涨'
      : (item.board >= 2 ? item.board + ' 连板' : '首板') + (item.isSectorLeader ? '·板块龙头' : ''),
    detail: isRelay
      ? '所属板块已有 ' + (item.topSectorCount ?? 0) + ' 家涨停，本股尚未启动，属于板块内补涨位置'
      :
      (item.board >= 2 ? '已连续 ' + item.board + ' 个交易日涨停' : '今日首次涨停') +
      (item.firstSealAt ? '，' + item.firstSealAt + ' 封板' : '') +
      (item.breakCount ? '，盘中炸板 ' + item.breakCount + ' 次' : '，未炸板') +
      '，辨识度 ' + item.recognition,
    weight: 0.34,
    strength: isRelay
      ? Math.max(35, Math.min(80, 40 + (item.topSectorCount ?? 0) * 5))
      : Math.max(30, Math.min(95, 40 + item.board * 12 - (item.breakCount ?? 0) * 2 + (item.breakCount ? 0 : 6))),
    metrics: {
      board: item.board,
      recognition: item.recognition,
      breakCount: item.breakCount ?? 0,
      firstSealAt: item.firstSealAt ?? '未知',
    },
    expect: isRelay
      ? '补涨逻辑成立 → 3 日内板块延续且本股跑赢板块中位数，否则证伪'
      : '连板逻辑成立 → 次日高开或继续封板；若炸板或收盘跌破前一日涨停价则证伪',
  })
  if (item.topSector && (item.topSectorCount ?? 0) >= 2) {
    const ladderText = item.sectorLadder
      ? Object.entries(item.sectorLadder)
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(([board, count]) => board + '板 ' + count + ' 家')
          .join('、')
      : ''
    reasons.push({
      dimension: 'board',
      key: 'sector_effect',
      label: '板块效应（' + item.topSector + '）',
      detail:
        item.topSector + ' 今日 ' + item.topSectorCount + ' 家涨停' +
        (ladderText ? '（' + ladderText + '）' : '') +
        (item.sectorFirstSealAt ? '，最早 ' + item.sectorFirstSealAt + ' 封板' : '') +
        (typeof item.sectorMainNetInflowYi === 'number' ? '，板块主力净流入 ' + item.sectorMainNetInflowYi.toFixed(2) + '亿' : '') +
        (item.isSectorLeader ? '；本股为板块内辨识度第一' : '；本股为跟随标的'),
      weight: 0.3,
      strength: Math.max(30, Math.min(92, 35 + (item.topSectorCount ?? 0) * 6 + (item.isSectorLeader ? 12 : 0) + Math.min(10, (item.sectorHeat ?? 0) / 10))),
      metrics: {
        sector: item.topSector,
        sectorLimitUpCount: item.topSectorCount ?? 0,
        sectorHeat: item.sectorHeat ?? 0,
        isLeader: item.isSectorLeader ? 'yes' : 'no',
      },
      expect: '板块效应成立 → 板块 3 日内仍有涨停家数，本股不弱于板块中位',
    })
  }
  if (item.sentimentPhase) {
    reasons.push({
      dimension: 'board',
      key: 'sentiment',
      label: '情绪相位：' + item.sentimentPhase,
      detail: '当日市场情绪评分 ' + (item.sentimentScore ?? 0) + '，相位「' + item.sentimentPhase + '」',
      weight: 0.14,
      strength: item.sentimentPhase === '退潮' || item.sentimentPhase === '冰点' ? 32 : item.sentimentPhase === '高潮' ? 58 : 68,
      metrics: { phase: item.sentimentPhase, score: item.sentimentScore ?? 0 },
      expect: '情绪相位判断正确 → 相位与次日打板溢价方向一致（发酵/高潮为正，退潮为负）',
    })
  }
  if (item.sectorNames?.length) {
    reasons.push({
      dimension: 'board',
      key: 'sector_tags',
      label: '题材归属',
      detail: '关联题材：' + item.sectorNames.slice(0, 4).join('、'),
      weight: 0.1,
      strength: 55,
      metrics: { sectorCount: item.sectorNames.length },
      expect: '题材持续 → 持有期内题材指数未明显走弱',
    })
  }
  return reasons
}

export function summarizeReasons(reasons: RecommendationReason[]): ReasonSummary {
  const byDimension: Record<string, number> = {}
  for (const reason of reasons) byDimension[reason.dimension] = (byDimension[reason.dimension] ?? 0) + 1
  const totalWeight = reasons.reduce((sum, r) => sum + r.weight, 0)
  const reasonScore = totalWeight
    ? Math.max(0, Math.min(100, Math.round(reasons.reduce((sum, r) => sum + r.weight * r.strength, 0) / totalWeight)))
    : 0
  return {
    total: reasons.length,
    byDimension,
    topLabels: [...reasons].sort((a, b) => b.weight * b.strength - a.weight * a.strength).slice(0, 4).map((r) => r.label),
    reasonScore,
  }
}

/** 抑制同维度重复理由（合并通道后同一维度可能有多条） */
export function dedupeReasons(reasons: RecommendationReason[]): RecommendationReason[] {
  const seen = new Set<string>()
  const out: RecommendationReason[] = []
  for (const reason of reasons) {
    const key = reason.dimension + ':' + reason.key
    if (seen.has(key)) continue
    seen.add(key)
    out.push(reason)
  }
  return out.sort((a, b) => b.weight * b.strength - a.weight * a.strength).slice(0, 10)
}
