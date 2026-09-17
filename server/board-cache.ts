/**
 * 涨停板快照的新鲜度管理。
 *
 * 背景（2026-09-17 实测到的「今日推荐数据延迟」）：
 * /api/recommendations 与日报只读「内存缓存 → 落盘快照」，本身不会重算看板；
 * 而旧实现把落盘的**昨日快照**塞进内存并标记成「9 分钟前」，于是新鲜度时钟被不断重置，
 * 当日看板永远算不出来 —— 今日推荐里的涨停池、情绪相位、板块龙头全是上一个交易日的。
 *
 * 这里把「这个快照还算不算当日数据」抽成纯函数，便于单测，也便于推荐接口显式提示落后。
 */

import type { KLineBar } from './tencent.ts'
import type { LimitUpBoard } from './limit-up.ts'
import { sessionDateOf, signalDateOf } from './trading-day.ts'

export const BOARD_TTL_MS = 10 * 60_000

export interface BoardCacheEntry {
  at: number
  board: LimitUpBoard
}

/** 当前应属于哪个交易日的看板：周末回退到最近的工作日 */
export function expectedBoardDate(now = Date.now()): string {
  const date = signalDateOf(now)
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay()
  if (weekday === 6) return signalDateOf(now - 86_400_000)
  if (weekday === 0) return signalDateOf(now - 2 * 86_400_000)
  return date
}

/** 只看北京时间、用于判断是否处在需要高频刷新看板的时段 */
export function beijingMinutes(timestamp = Date.now()): { weekday: number; minutes: number } {
  const beijing = new Date(timestamp + 8 * 3600_000)
  return { weekday: beijing.getUTCDay(), minutes: beijing.getUTCHours() * 60 + beijing.getUTCMinutes() }
}

/** 盘中窗口：09:15–11:35 与 12:55–15:05（北京时间，周一至周五） */
export function inTradingWindow(timestamp = Date.now()): boolean {
  const { weekday, minutes } = beijingMinutes(timestamp)
  if (weekday === 0 || weekday === 6) return false
  return (minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 35) || (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 5)
}

export interface BoardResolution {
  /** 可以直接拿来用的看板（可能是过期的，需配合 current 判断） */
  board: LimitUpBoard | null
  /** 该看板是否属于当前交易日 */
  current: boolean
  /** 内存缓存是否仍新鲜（命中则无需再读磁盘） */
  fresh: boolean
  /** 是否应回填进内存缓存 */
  adopt: boolean
  /** 是否需要后台重算 */
  needsRefresh: boolean
}

/**
 * 决定该用哪份看板：内存缓存 → 落盘快照 → 都没有。
 * 只有「日期等于当前交易日」的快照才会被视为可回填内存的有效数据，
 * 过期快照只作为兜底返回（并标记 needsRefresh），避免把昨日数据伪装成新鲜数据。
 */
export function resolveBoard(input: {
  memory: BoardCacheEntry | null
  snapshot: LimitUpBoard | null
  now?: number
  ttlMs?: number
}): BoardResolution {
  const now = input.now ?? Date.now()
  const ttl = input.ttlMs ?? BOARD_TTL_MS
  const expected = expectedBoardDate(now)
  const memory = input.memory
  if (memory && memory.board.date === expected && now - memory.at < ttl) {
    return { board: memory.board, current: true, fresh: true, adopt: false, needsRefresh: false }
  }
  const snapshot = input.snapshot
  if (snapshot && snapshot.date === expected) {
    return { board: snapshot, current: true, fresh: false, adopt: true, needsRefresh: false }
  }
  const fallback = snapshot ?? memory?.board ?? null
  return { board: fallback, current: false, fresh: false, adopt: false, needsRefresh: true }
}

/** 只保留属于指定交易日的分钟线，避免「昨天的分时」算出今天的封板时间与炸板次数 */
export function filterSessionBars(bars: KLineBar[], sessionDate: string): KLineBar[] {
  if (!sessionDate) return bars
  return bars.filter((bar) => sessionDateOf(bar.timestamp) === sessionDate)
}
