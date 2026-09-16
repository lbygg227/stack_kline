/**
 * 资金共识分：把三条独立的资金线合成一个可比较的分数。
 *
 *   1. 涨停板线：辨识度（连板高度 + 板块涨停家数 + 成交额排名 + 封板时间 - 炸板）
 *   2. 龙虎榜线：上榜净买额、机构净买、游资净买、连续上榜次数
 *   3. 主力资金线：连续净流入天数、区间净流入金额
 *
 * 三条线原本各自出推荐、互不知情（同一只票可能同时被三条线选中，也可能只有一条线支持）。
 * 合成后的分数用于：提高共识标的的评分与置信度、在推荐理由里写清「有几条资金线支持」，
 * 也用于事后归因——验证「三线共振是否比单线更可靠」。
 */

import type { SnapshotStock } from './eastmoney.ts'
import type { LimitUpBoard } from './limit-up.ts'
import { buildDragonTigerReco } from './dragon-tiger-stock-reco.ts'
import { buildFundStockReco } from './fund-stock-reco.ts'

export type ConsensusLine = 'board' | 'dragon' | 'fund'

export interface CapitalConsensus {
  code: string
  /** 0-100，越高表示资金面越一致 */
  score: number
  parts: Record<ConsensusLine, number | null>
  /** 命中的资金线数量 */
  lineCount: number
  notes: string[]
}

export interface ConsensusOptions {
  stocks?: SnapshotStock[]
  board?: LimitUpBoard | null
  dragonLimit?: number
  fundDays?: number
  minScore?: number
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value))
const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits
const yi = (value: number): string => (value / 1e8).toFixed(2) + '亿'

/** 各条线的权重（缺数据时按可用线重新归一化） */
const LINE_WEIGHT: Record<ConsensusLine, number> = { board: 0.45, dragon: 0.3, fund: 0.25 }

export function buildCapitalConsensus(options: ConsensusOptions = {}): Map<string, CapitalConsensus> {
  const result = new Map<string, CapitalConsensus>()
  const parts = new Map<string, { parts: Record<ConsensusLine, number | null>; notes: string[] }>()
  const ensure = (code: string) => {
    let entry = parts.get(code)
    if (!entry) {
      entry = { parts: { board: null, dragon: null, fund: null }, notes: [] }
      parts.set(code, entry)
    }
    return entry
  }

  // 1) 涨停板线
  for (const item of options.board?.limitUp ?? []) {
    const entry = ensure(item.code)
    entry.parts.board = clamp(item.recognition)
    entry.notes.push(
      '涨停板：' + (item.board > 1 ? item.board + ' 连板' : '首板') +
      (item.topSector ? '，' + item.topSector + ' 板块 ' + (item.topSectorCount ?? 0) + ' 家涨停' : '') +
      '，辨识度 ' + item.recognition,
    )
  }

  // 2) 龙虎榜线
  try {
    const dragon = buildDragonTigerReco({ limit: options.dragonLimit ?? 200, minNetValue: 0 }).items
    for (const item of dragon) {
      const entry = ensure(item.code)
      const netYi = item.netValue / 1e8
      // 净买 5 亿左右接近满分；机构/游资净买额外加成；连续上榜加分
      const orgBonus = item.orgNetValue && item.orgNetValue > 0 ? Math.min(12, item.orgNetValue / 1e8 * 2) : 0
      const hotBonus = item.hotMoneyNetValue && item.hotMoneyNetValue > 0 ? Math.min(8, item.hotMoneyNetValue / 1e8 * 1.5) : 0
      const timesBonus = Math.min(10, ((item.occurrences ?? 1) - 1) * 4)
      entry.parts.dragon = clamp(45 + netYi * 7 + orgBonus + hotBonus + timesBonus)
      const details = ['龙虎榜：净买 ' + yi(item.netValue)]
      if (item.orgNetValue) details.push('机构 ' + (item.orgNetValue > 0 ? '净买 ' : '净卖 ') + yi(Math.abs(item.orgNetValue)))
      if (item.hotMoneyNetValue) details.push('游资 ' + (item.hotMoneyNetValue > 0 ? '净买 ' : '净卖 ') + yi(Math.abs(item.hotMoneyNetValue)))
      if ((item.occurrences ?? 1) > 1) details.push('近几日上榜 ' + item.occurrences + ' 次')
      details.push('(' + item.tradeDate + ')')
      entry.notes.push(details.join('，'))
    }
  } catch {
    /* 龙虎榜缓存不可用时跳过该线 */
  }

  // 3) 主力资金线
  try {
    const fund = buildFundStockReco({ days: options.fundDays ?? 5, limit: 300 }).items
    for (const item of fund) {
      const entry = ensure(item.code)
      const sumYi = item.mainNetSum / 1e8
      entry.parts.fund = clamp(40 + item.consecutiveInflowDays * 9 + sumYi * 1.5)
      entry.notes.push(
        '主力资金：连续 ' + item.consecutiveInflowDays + ' 日净流入，近 ' + item.lookbackDays + ' 日合计 ' + yi(item.mainNetSum),
      )
    }
  } catch {
    /* 资金流缓存不可用时跳过该线 */
  }

  for (const [code, entry] of parts) {
    const available = (Object.keys(entry.parts) as ConsensusLine[]).filter((line) => entry.parts[line] != null)
    if (!available.length) continue
    const weightSum = available.reduce((sum, line) => sum + LINE_WEIGHT[line], 0)
    const strength = available.reduce((sum, line) => sum + (entry.parts[line] as number) * LINE_WEIGHT[line], 0) / weightSum
    // 共识分 = 强度 × 广度：三线共振的 80 分要高于单线的 80 分
    const score = strength * consensusMultiplier(available.length)
    if (score < (options.minScore ?? 0)) continue
    result.set(code, {
      code,
      score: round(score),
      parts: entry.parts,
      lineCount: available.length,
      notes: entry.notes,
    })
  }
  return result
}

/** 三线共振加成系数：1 线不加成，2 线 ×1.06，3 线 ×1.12 */
export function consensusMultiplier(lineCount: number): number {
  if (lineCount >= 3) return 1.12
  if (lineCount === 2) return 1.06
  return 1
}
