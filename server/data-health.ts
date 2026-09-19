/**
 * 数据健康自检：把"数据有没有落后"变成可查询、可自愈的状态。
 *
 * 背景（2026-09-19 实测）：调度器只在周一~周五到点运行，一旦某个时间点因为进程重启/停机被错过，
 * 当天就永久跳过，周末又因为 isTradingDay=false 永不补跑 —— 结果全市场快照、日线、板块序列
 * 全都停在 09-17，而"今日推荐"照常显示，用户看到的是一份两天前的推荐。
 *
 * 这里做两件事：
 *  1. 用**数据源**（TickFlow 指数日线）确定"最近一个已收盘交易日"，而不是用机器时钟；
 *  2. 逐项比对本地落盘数据与该日期的差距，输出问题清单 + 建议动作。
 */

import { readJson } from './store.ts'
import { sessionDateOf } from './trading-day.ts'
import { getExpectedLatestTradingDate, type KLineBar } from './tencent.ts'

const DAY = 86_400_000

/** 交易日锚点：15 分钟记忆，失败回落 undefined */
let cache: { at: number; date?: string } | null = null
export async function expectedTradingDate(): Promise<string | undefined> {
  if (cache && Date.now() - cache.at < 15 * 60_000) return cache.date
  try {
    const date = await getExpectedLatestTradingDate()
    cache = { at: Date.now(), date }
    return date
  } catch {
    cache = { at: Date.now(), date: undefined }
    return undefined
  }
}

export type HealthLevel = 'ok' | 'warn' | 'error'

export interface HealthItem {
  key: string
  label: string
  level: HealthLevel
  /** 该数据的日期/时间 */
  value: string
  expected?: string
  /** 落后天数（交易日无法精确计算时用自然日） */
  lagDays?: number
  action?: string
}

export interface DataHealthReport {
  checkedAt: number
  expectedTradingDate?: string
  level: HealthLevel
  items: HealthItem[]
  /** 需要补跑数据（任一 error 级即视为需要） */
  needsCatchUp: boolean
}

const levelOf = (items: HealthItem[]): HealthLevel =>
  items.some((item) => item.level === 'error') ? 'error' : items.some((item) => item.level === 'warn') ? 'warn' : 'ok'

/** 从本地日线缓存尾部推断"市场数据日"（取若干流动性标的的最大日期） */
export function marketDataDateFromCache(codes: string[]): string | undefined {
  let latest = ''
  for (const code of codes) {
    const bars = readJson<{ bars?: KLineBar[] }>(`kline-cache/${code}_day.json`)?.bars ?? []
    const last = bars.at(-1)
    if (!last) continue
    const date = sessionDateOf(last.timestamp)
    if (date > latest) latest = date
  }
  return latest || undefined
}

export const REFERENCE_CODES = ['sh600000', 'sz000001', 'sh601318', 'sz300750', 'sh600519', 'sz000858', 'sh601899', 'sz002594']

export function inspectDataHealth(input: {
  expected?: string
  snapshotFetchedAt?: number
  snapshotCount?: number
  boardDate?: string
  sectorEndDate?: string
  fundRankUpdatedAt?: number
  dragonRankUpdatedAt?: number
  fundHistoryCodes?: number
  fundHistoryMedianDays?: number
  now?: number
}): DataHealthReport {
  const now = input.now ?? Date.now()
  const items: HealthItem[] = []
  const lagDays = (date?: string): number | undefined => {
    if (!date || !input.expected) return undefined
    const diff = Date.parse(input.expected) - Date.parse(date)
    return Number.isFinite(diff) ? Math.round(diff / DAY) : undefined
  }

  const marketDate = marketDataDateFromCache(REFERENCE_CODES)
  items.push({
    key: 'kline',
    label: '全市场日线',
    level: !marketDate ? 'error' : marketDate === input.expected ? 'ok' : 'error',
    value: marketDate ?? '无',
    expected: input.expected,
    lagDays: lagDays(marketDate),
    action: 'POST /api/update/run（收盘后完整更新：快照+慢变量+行业+日K预取）',
  })

  const snapshotAge = input.snapshotFetchedAt ? (now - input.snapshotFetchedAt) / 3_600_000 : undefined
  items.push({
    key: 'snapshot',
    label: '全市场快照',
    level: snapshotAge == null ? 'error' : snapshotAge > 28 ? 'error' : snapshotAge > 6 ? 'warn' : 'ok',
    value: input.snapshotFetchedAt
      ? new Date(input.snapshotFetchedAt).toLocaleString('zh-CN', { hour12: false }) + '（' + Math.round(snapshotAge ?? 0) + ' 小时前，' + (input.snapshotCount ?? 0) + ' 只）'
      : '无',
    action: 'POST /api/update/run',
  })

  items.push({
    key: 'board',
    label: '涨停看板',
    level: !input.boardDate ? 'warn' : input.boardDate === input.expected ? 'ok' : 'warn',
    value: input.boardDate ?? '无',
    expected: input.expected,
    lagDays: lagDays(input.boardDate),
    action: 'GET /api/limit-up?force=1（看板会按数据日期重算）',
  })

  items.push({
    key: 'sector',
    label: '板块序列/回测',
    level: !input.sectorEndDate ? 'warn' : input.sectorEndDate === input.expected ? 'ok' : 'warn',
    value: input.sectorEndDate ?? '无',
    expected: input.expected,
    lagDays: lagDays(input.sectorEndDate),
    action: 'POST /api/limit-up/backtest（约 1 分钟，重算板块序列与回测）',
  })

  for (const [key, label, at] of [
    ['fundRank', '当日资金流榜单', input.fundRankUpdatedAt],
    ['dragonRank', '当日龙虎榜榜单', input.dragonRankUpdatedAt],
  ] as const) {
    const age = at ? (now - at) / 3_600_000 : undefined
    items.push({
      key,
      label,
      level: age == null ? 'warn' : age > 30 ? 'warn' : 'ok',
      value: at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) + '（' + Math.round(age ?? 0) + ' 小时前）' : '无',
      action: '对应 scheduler 任务（收盘后刷新）',
    })
  }

  const median = input.fundHistoryMedianDays ?? 0
  items.push({
    key: 'fundHistory',
    label: '资金流历史（用于资金线回测）',
    level: median >= 20 ? 'ok' : 'warn',
    value: (input.fundHistoryCodes ?? 0) + ' 只，天数中位 ' + median,
    action: 'POST /api/history/backfill {kind:"fund", limit:50}（东财历史口限流，需分批续传）',
  })

  const level = levelOf(items)
  return {
    checkedAt: now,
    expectedTradingDate: input.expected,
    level,
    items,
    needsCatchUp: items.some((item) => item.level === 'error'),
  }
}
