/**
 * 交易日期的统一口径。
 *
 * TickFlow 的日线时间戳是「该交易日北京时间 00:00」，转成 UTC 会落到前一天
 * （例如 2026-09-15 交易日 -> 1789401600000 -> UTC 2026-09-14T16:00Z）。
 * 直接用 toISOString().slice(0,10) 取日期会整体早一天，进而让所有回测的
 * 信号日/买入日/卖出日错位一天。
 *
 * 已用快照归档交叉验证：日K重算出的涨停池与「次日」归档快照的 Jaccard 相似度 100%
 * （池 2026-09-14 == 归档 2026-09-15），因此规则确定为「时间戳 +8 小时再取日期」。
 */

const BEIJING_OFFSET_MS = 8 * 3600_000

/** K 线时间戳 -> 所属交易日（YYYY-MM-DD） */
export function sessionDateOf(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 当前「信号日」：用 UTC 日期，保证在收盘后到次日开盘前不会提前滚到第二天
 * （北京时间 00:00~08:00 期间 UTC 日期仍是上一个交易日）。
 */
export function signalDateOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** 把可能是秒的时间戳统一成毫秒 */
export function toMilliseconds(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp
}
