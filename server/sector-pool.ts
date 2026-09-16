/**
 * 板块内选股（补涨池）：把「板块效应」落到具体标的上。
 *
 * 逻辑：热点板块启动后，资金通常先打龙头，再外溢到板块内尚未启动的二线（补涨）。
 * 因此补涨池的评分由四部分组成：
 *   1. 板块热度（板块本身是否够强）
 *   2. 落后度（相对板块龙头还差多少涨幅，越落后空间越大，但不能是弱势下跌）
 *   3. 资金在进（当日主力净流入、连续净流入天数）
 *   4. 量价配合（量比、换手、成交额，且当日不能已经涨停）
 *
 * 明确排除：已涨停（那是打板池）、跌停/大跌、无量、主力大幅流出。
 */

import type { SnapshotStock } from './eastmoney.ts'
import type { LimitUpBoard, SectorBoard } from './limit-up.ts'
import { buildFundStockReco } from './fund-stock-reco.ts'

export interface SectorPoolItem {
  code: string
  name: string
  price: number
  changePct: number
  turnover: number
  volumeRatio: number
  amountYi: number
  mainNetInflowYi: number
  consecutiveInflowDays: number
  /** 相对板块龙头的落后幅度（百分点） */
  lagPct: number
  /** 补涨评分 0-100 */
  score: number
  /** 一句话理由 */
  reason: string
  /** 是否已在涨停梯队里 */
  limitUp: boolean
  boardHeight: number
}

export interface SectorPoolResult {
  sector: { name: string; type: 'industry' | 'concept'; heat: number; limitUpCount: number; maxBoard: number; leaderName: string; mainNetInflowYi: number }
  items: SectorPoolItem[]
  stats: { members: number; limitUp: number; poolSize: number; excluded: number }
}

export interface SectorPoolOptions {
  sector: string
  type?: 'industry' | 'concept'
  stocks: SnapshotStock[]
  board?: LimitUpBoard | null
  limit?: number
  /** 补涨池最小成交额（元），默认 5000 万 */
  minAmount?: number
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value))
const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits

export function buildSectorPool(options: SectorPoolOptions): SectorPoolResult {
  const { stocks } = options
  const type = options.type ?? 'concept'
  const limit = Math.max(1, Math.min(100, options.limit ?? 30))
  const minAmount = options.minAmount ?? 5e7

  const sector: SectorBoard | undefined = options.board?.sectors.find(
    (item) => item.name === options.sector && item.type === type,
  )
  const leaderCode = sector?.leaderCode ?? ''
  const leader = leaderCode ? stocks.find((stock) => stock.code.toLowerCase() === leaderCode) : undefined
  const leaderChange = leader?.changePct ?? 0
  const limitUpCodes = new Set((options.board?.limitUp ?? []).map((item) => item.code))
  const boardHeightOf = new Map((options.board?.limitUp ?? []).map((item) => [item.code, item.board]))

  // 资金面：连续净流入天数（复用资金流缓存）
  const inflowDays = new Map<string, number>()
  const inflowSum = new Map<string, number>()
  try {
    for (const item of buildFundStockReco({ days: 5, limit: 300 }).items) {
      inflowDays.set(item.code, item.consecutiveInflowDays)
      inflowSum.set(item.code, item.mainNetSum)
    }
  } catch {
    /* 资金流缓存不可用时只用当日快照的主力净流入 */
  }

  const members: SnapshotStock[] = []
  for (const stock of stocks) {
    const code = stock.code.toLowerCase()
    const inSector = type === 'industry'
      ? stock.industry === options.sector
      : (stock.concepts ?? []).includes(options.sector)
    if (inSector) members.push({ ...stock, code })
  }

  let excluded = 0
  const items: SectorPoolItem[] = []
  for (const stock of members) {
    const code = stock.code
    const isLimitUp = limitUpCodes.has(code)
    const boardHeight = boardHeightOf.get(code) ?? 0
    if (!isLimitUp) {
      // 排除：跌停/大跌、无量、主力大幅流出、成交额过小
      if (stock.changePct <= -3) { excluded++; continue }
      if (stock.amount < minAmount) { excluded++; continue }
      if (stock.volumeRatio > 0 && stock.volumeRatio < 0.8) { excluded++; continue }
      // 主力明显流出（占比 <= -3% 或净流出超过 5000 万）
      if ((stock.mainNetInflowPct ?? 0) <= -3 || (stock.mainNetInflow ?? 0) <= -5e7) { excluded++; continue }
    }

    const lagPct = leader ? round(leaderChange - stock.changePct) : 0
    const inflowYi = (stock.mainNetInflow ?? 0) / 1e8
    const consecutive = inflowDays.get(code) ?? 0
    const sumYi = (inflowSum.get(code) ?? 0) / 1e8

    // 评分：板块热度 25 + 落后度 25 + 资金 30 + 量价 20
    const heatPart = (sector?.heat ?? 0) / 100 * 25
    const lagPart = clamp(lagPct, 0, 12) / 12 * 25
    const flowPart = clamp(inflowYi * 4, 0, 14) + clamp(consecutive, 0, 4) * 3 + clamp(sumYi, 0, 8) * 1.2
    const volumePart = clamp((stock.volumeRatio - 0.8) * 10, 0, 10) + clamp(stock.turnover / 5, 0, 6) + clamp(stock.amount / 5e8, 0, 4)
    const score = clamp(heatPart + lagPart + clamp(flowPart, 0, 30) + clamp(volumePart, 0, 20))

    const notes: string[] = []
    if (sector) notes.push(sector.name + ' 板块 ' + sector.limitUpCount + ' 家涨停、热度 ' + sector.heat)
    if (isLimitUp) notes.push(boardHeight > 1 ? '已 ' + boardHeight + ' 连板（打板池）' : '已涨停（打板池）')
    else notes.push('尚未启动，落后龙头 ' + lagPct.toFixed(1) + 'pct')
    if (consecutive > 0) notes.push('主力连续 ' + consecutive + ' 日净流入（近 5 日 ' + sumYi.toFixed(2) + '亿）')
    else if (inflowYi > 0) notes.push('当日主力净流入 ' + inflowYi.toFixed(2) + '亿')
    notes.push('量比 ' + stock.volumeRatio.toFixed(2) + '、换手 ' + stock.turnover.toFixed(1) + '%、成交 ' + (stock.amount / 1e8).toFixed(1) + '亿')

    items.push({
      code,
      name: stock.name,
      price: stock.price,
      changePct: Number(stock.changePct.toFixed(2)),
      turnover: Number(stock.turnover.toFixed(2)),
      volumeRatio: Number(stock.volumeRatio.toFixed(2)),
      amountYi: Number((stock.amount / 1e8).toFixed(2)),
      mainNetInflowYi: Number(inflowYi.toFixed(3)),
      consecutiveInflowDays: consecutive,
      lagPct,
      score: Math.round(score),
      reason: notes.join('，'),
      limitUp: isLimitUp,
      boardHeight,
    })
  }

  items.sort((a, b) => b.score - a.score)

  return {
    sector: {
      name: options.sector,
      type,
      heat: sector?.heat ?? 0,
      limitUpCount: sector?.limitUpCount ?? 0,
      maxBoard: sector?.maxBoard ?? 0,
      leaderName: sector?.leaderName ?? leader?.name ?? '',
      mainNetInflowYi: Number(((sector?.mainNetInflow ?? 0) / 1e8).toFixed(2)),
    },
    items: items.slice(0, limit),
    stats: {
      members: members.length,
      limitUp: members.filter((stock) => limitUpCodes.has(stock.code)).length,
      poolSize: items.filter((item) => !item.limitUp).length,
      excluded,
    },
  }
}
