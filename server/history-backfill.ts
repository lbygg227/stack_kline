/**
 * 历史回补：资金流 + 龙虎榜。
 *
 * 数据源能力（已核实）：
 *  - 资金流：东方财富 `fflow/kline/get?lmt=N` 单只一次可取 N 天日频主力净额（本模块按股票回补，
 *    默认 500 天）。原实现只取最近 20 天、且只覆盖成交额前 400 名，所以没有历史。
 *  - 龙虎榜：扶摇 `dragon-tiger-list?date=YYYY-MM-DD` 支持指定历史交易日，按交易日逐日回补。
 *
 * 落盘：
 *  - `data/fund-flow-history.json`：{ code: FundFlowDay[] }（按日期去重、升序）
 *  - `data/dragon-tiger-history.json`：{ date: item[] }
 * 两者都是增量合并，重复回补不会产生重复行。
 */

import { fetchFundFlow, type FundFlowDay } from './eastmoney-fund.ts'
import { fetchDragonTigerList, hasFuyao } from './fuyao.ts'
import { readJson, writeJson } from './store.ts'
import { sessionDateOf } from './trading-day.ts'
import type { KLineBar } from './tencent.ts'

const FUND_FILE = 'fund-flow-history.json'
const DRAGON_FILE = 'dragon-tiger-history.json'

export interface FundFlowHistoryFile {
  version: 1
  updatedAt: number
  codes: Record<string, FundFlowDay[]>
}

export interface DragonTigerHistoryItem {
  code: string
  name: string
  netValue: number
  orgNetValue: number | null
  hotMoneyNetValue: number | null
  changePct: number | null
  boardType: string
}

export interface DragonTigerHistoryFile {
  version: 1
  updatedAt: number
  days: Record<string, DragonTigerHistoryItem[]>
}

export function loadFundFlowHistory(): FundFlowHistoryFile {
  const raw = readJson<FundFlowHistoryFile>(FUND_FILE)
  if (!raw || typeof raw.codes !== 'object' || !raw.codes) return { version: 1, updatedAt: Date.now(), codes: {} }
  return raw
}

export function loadDragonTigerHistory(): DragonTigerHistoryFile {
  const raw = readJson<DragonTigerHistoryFile>(DRAGON_FILE)
  if (!raw || typeof raw.days !== 'object' || !raw.days) return { version: 1, updatedAt: Date.now(), days: {} }
  return raw
}

/** 合并资金流序列：按日期去重并升序 */
export function mergeFundFlowDays(existing: FundFlowDay[], incoming: FundFlowDay[]): FundFlowDay[] {
  const map = new Map<string, FundFlowDay>()
  for (const day of [...existing, ...incoming]) {
    if (!day?.date) continue
    map.set(day.date, day)
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 合并龙虎榜：同一天整体替换（同日多次拉取以最后一次为准） */
export function mergeDragonTigerDays(
  existing: Record<string, DragonTigerHistoryItem[]>,
  incoming: Record<string, DragonTigerHistoryItem[]>,
): Record<string, DragonTigerHistoryItem[]> {
  return { ...existing, ...incoming }
}

/** 从本地指数日线取出最近 N 个交易日（倒序传入则自动排序） */
export function tradingDatesOf(bars: KLineBar[], limit: number): string[] {
  const dates = [...new Set(
    bars
      .filter((bar) => Number.isFinite(bar.timestamp))
      .map((bar) => sessionDateOf(bar.timestamp))
      .filter(Boolean),
  )].sort()
  return limit > 0 ? dates.slice(-limit) : dates
}

export interface BackfillProgress {
  kind: 'fund' | 'dragon'
  total: number
  done: number
  failed: number
  running: boolean
  startedAt: number
  finishedAt?: number
  error?: string
}

let fundProgress: BackfillProgress | null = null
let dragonProgress: BackfillProgress | null = null

export function backfillProgress(): { fund: BackfillProgress | null; dragon: BackfillProgress | null } {
  return { fund: fundProgress, dragon: dragonProgress }
}

/** 并发受限执行 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 按股票回补资金流历史（增量合并、限速、断点续传）。
 *
 * ⚠️ 必须限速：实测 4 并发连打 55 只 × 2 轮后，东财对来源 IP 直接断连（http=000），
 * 需要等一段时间才恢复。因此默认并发 1、间隔 800ms；连续失败超过阈值就**主动停下**，
 * 避免把 IP 彻底打进黑名单。已回补过的股票默认跳过（续传），force=true 才重拉。
 */
export async function backfillFundFlow(
  codes: string[],
  options: { days?: number; concurrency?: number; intervalMs?: number; force?: boolean; maxConsecutiveFailures?: number } = {},
): Promise<{ codes: number; skipped: number; failed: number; days: number; aborted?: string }> {
  const days = Math.max(20, Math.min(120, Math.round(options.days ?? 120)))
  const concurrency = Math.max(1, Math.min(3, options.concurrency ?? 1))
  const intervalMs = Math.max(0, Math.min(5000, options.intervalMs ?? 800))
  const maxFailures = Math.max(1, options.maxConsecutiveFailures ?? 5)
  const unique = [...new Set(codes.map((code) => code.toLowerCase()).filter((code) => /^(sh|sz|bj)\d{6}$/.test(code)))]
  const file = loadFundFlowHistory()
  const target = options.force
    ? unique
    : unique.filter((code) => (file.codes[code]?.length ?? 0) < Math.min(days, 60))
  const progress: BackfillProgress = {
    kind: 'fund',
    total: target.length,
    done: 0,
    failed: 0,
    running: true,
    startedAt: Date.now(),
  }
  fundProgress = progress
  let failed = 0
  let consecutiveFailures = 0
  let aborted: string | undefined
  await mapLimit(target, concurrency, async (code) => {
    if (aborted) return
    if (consecutiveFailures >= maxFailures) {
      aborted = '连续 ' + consecutiveFailures + ' 次请求失败，已主动停止（疑似被数据源限流），稍后可再次调用续传'
      return
    }
    try {
      const result = await fetchFundFlow(code, days)
      file.codes[code] = mergeFundFlowDays(file.codes[code] ?? [], result.days)
      progress.done++
      consecutiveFailures = 0
    } catch {
      failed++
      progress.failed++
      consecutiveFailures++
    }
    if (intervalMs) await sleep(intervalMs)
  })
  if (aborted) progress.error = aborted
  file.updatedAt = Date.now()
  writeJson(FUND_FILE, { version: 1, updatedAt: file.updatedAt, codes: file.codes } satisfies FundFlowHistoryFile)
  progress.running = false
  progress.finishedAt = Date.now()
  return { codes: target.length, skipped: unique.length - target.length, failed, days, aborted }
}

/** 按交易日回补龙虎榜历史（增量合并） */
export async function backfillDragonTiger(
  dates: string[],
  options: { concurrency?: number; intervalMs?: number } = {},
): Promise<{ days: number; failed: number }> {
  if (!hasFuyao()) {
    dragonProgress = { kind: 'dragon', total: 0, done: 0, failed: 0, running: false, startedAt: Date.now(), finishedAt: Date.now(), error: '未配置 FUYAO_API_KEY' }
    throw new Error('未配置 FUYAO_API_KEY，无法回补龙虎榜')
  }
  const unique = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
  const file = loadDragonTigerHistory()
  const progress: BackfillProgress = { kind: 'dragon', total: unique.length, done: 0, failed: 0, running: true, startedAt: Date.now() }
  dragonProgress = progress
  const incoming: Record<string, DragonTigerHistoryItem[]> = {}
  const intervalMs = Math.max(0, Math.min(5000, options.intervalMs ?? 400))
  await mapLimit(unique, Math.max(1, Math.min(3, options.concurrency ?? 1)), async (date) => {
    try {
      const list = await fetchDragonTigerList({ date })
      if (!list.tradeDate) {
        progress.done++
        return
      }
      incoming[list.tradeDate] = list.items.map((item) => ({
        code: String(item.thscode ?? '').includes('.')
          ? (() => {
              const m = String(item.thscode).trim().match(/^(\d{6})\.(SH|SZ|BJ)$/i)
              return m ? m[2].toLowerCase() + m[1] : String(item.thscode).toLowerCase()
            })()
          : String(item.thscode ?? '').toLowerCase(),
        name: item.name ?? '',
        netValue: item.net_value ?? 0,
        orgNetValue: item.org_net_value ?? null,
        hotMoneyNetValue: item.hot_money_net_value ?? null,
        changePct: typeof item.change === 'number' ? item.change : null,
        boardType: list.boardType,
      }))
      progress.done++
    } catch {
      progress.failed++
    }
    if (intervalMs) await sleep(intervalMs)
  })
  const days = mergeDragonTigerDays(file.days, incoming)
  writeJson(DRAGON_FILE, { version: 1, updatedAt: Date.now(), days } satisfies DragonTigerHistoryFile)
  progress.running = false
  progress.finishedAt = Date.now()
  return { days: Object.keys(incoming).length, failed: progress.failed }
}

/** 取某只股票在某日的龙虎榜记录 */
export function dragonTigerAt(
  file: DragonTigerHistoryFile,
  code: string,
  date: string,
): DragonTigerHistoryItem | undefined {
  return (file.days[date] ?? []).find((item) => item.code === code)
}
