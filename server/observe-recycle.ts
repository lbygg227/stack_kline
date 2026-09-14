/**
 * 观察名单回流：被准入守卫拦下的标的，条件改善后自动回到推荐列表。
 *
 * 每次生成推荐时做一次对账：
 *   - 仍在观察名单（今天依然被拦）：刷新拦截原因与连续拦截天数
 *   - 已不在观察名单（今天通过守卫）：标记「条件已改善，已回到推荐」，并可被推荐流程正常使用
 *
 * 判断依据始终是当天真实数据重新算出的守卫结论，不做主观放宽。
 */

import { listWatchCandidates, upsertWatchCandidate, type WatchCandidate } from './watch-candidates.ts'

export interface RecycledItem {
  code: string
  name: string
  /** 之前被拦的原因 */
  previousNote: string
  /** 现在为什么可以推荐 */
  currentNote: string
}

export interface ObserveReconcileResult {
  /** 本次回到推荐列表的标的 */
  recycled: RecycledItem[]
  /** 仍在观察名单的数量 */
  stillBlocked: number
  /** 连续被拦天数达到提醒阈值的标的 */
  stale: Array<{ code: string; name: string; days: number; note: string }>
}

const GUARD_MARK = '推荐守卫拦截'
/** 连续被拦多少天后提示「理由可能长期不成立」 */
export const STALE_BLOCK_DAYS = 5

function guardNote(candidate: WatchCandidate): string {
  const note = candidate.context?.note ?? ''
  if (note.includes(GUARD_MARK)) return note.replace(GUARD_MARK + '：', '').trim()
  return candidate.context?.conditionsSummary ?? ''
}

const dayKey = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10)

/** 记录当天被守卫拦下的标的，用于下次对账（按自然日累计，同一天多次生成不重复计数） */
export function trackBlocked(records: Array<{ code: string; name: string; guard?: { note: string } }>, now = Date.now()): void {
  const candidates = listWatchCandidates({ limit: 500 })
  for (const record of records) {
    if (!record.guard?.note) continue
    const existing = candidates.find((c) => c.code === record.code)
    const previousDays = existing?.context?.blockedDays ?? 0
    const lastBlockedAt = existing?.context?.lastBlockedAt
    const alreadyCountedToday = lastBlockedAt != null && dayKey(lastBlockedAt) === dayKey(now)
    const blockedDays = alreadyCountedToday ? Math.max(1, previousDays) : previousDays + 1
    upsertWatchCandidate({
      code: record.code,
      name: record.name,
      status: 'observe',
      source: 'guard',
      context: {
        recommendation: 'observe',
        conditionsSummary: record.guard.note,
        note: GUARD_MARK + '：' + record.guard.note,
        blockedDays,
        lastBlockedAt: alreadyCountedToday ? lastBlockedAt : now,
      },
    })
  }
}

/** 与当天的推荐/观察结果对账，标记回流 */
export function reconcileObserving(
  input: {
    recommend: Array<{ code: string; name: string; reasonSummary?: { topLabels: string[] } }>
    observing: Array<{ code: string; name: string }>
    now?: number
  },
): ObserveReconcileResult {
  const now = input.now ?? Date.now()
  const recommendMap = new Map(input.recommend.map((item) => [item.code.toLowerCase(), item]))
  const observingSet = new Set(input.observing.map((item) => item.code.toLowerCase()))
  const recycled: RecycledItem[] = []
  const stale: ObserveReconcileResult['stale'] = []
  let stillBlocked = 0

  for (const candidate of listWatchCandidates({ limit: 500 })) {
    const note = candidate.context?.note ?? ''
    if (!note.includes(GUARD_MARK)) continue
    const code = candidate.code.toLowerCase()
    const previousNote = guardNote(candidate)

    if (observingSet.has(code)) {
      stillBlocked += 1
      const days = candidate.context?.blockedDays ?? 1
      if (days >= STALE_BLOCK_DAYS) stale.push({ code, name: candidate.name, days, note: previousNote })
      continue
    }

    const current = recommendMap.get(code)
    if (!current) continue
    recycled.push({
      code,
      name: current.name,
      previousNote,
      currentNote: current.reasonSummary?.topLabels.slice(0, 3).join('、') || '理由已重新满足准入条件',
    })
    upsertWatchCandidate({
      code,
      name: current.name,
      status: 'hold',
      context: {
        recommendation: 'recommend',
        recycledAt: now,
        recycleNote: '此前' + (previousNote ? '因「' + previousNote + '」' : '') + '被拦，今日条件已改善，已回到推荐列表',
        blockedDays: 0,
      },
    })
  }

  return { recycled, stillBlocked, stale }
}
