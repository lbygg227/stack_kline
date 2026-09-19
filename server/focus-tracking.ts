/**
 * 重点推荐跟踪：把每天选出的「重点推荐」落盘，并在后续交易日结算它的真实表现。
 *
 * 为什么需要：重点推荐是我们唯一对外承诺"有回测证据"的名单，它自己也必须被回测——
 * 否则准入规则（样本≥6、历史超额>0、止损率≤45%）就是自说自话。
 *
 * 口径与 §18 一致：信号日收盘记录，次日开盘买入，持有 horizonDays 个交易日收盘卖出，
 * 超额 = 个股收益 − 同期沪深 300（用注入的 loadBars 取指数）。
 */

import { readJson, writeJson } from './store.ts'
import { sessionDateOf } from './trading-day.ts'
import type { KLineBar } from './tencent.ts'
import type { SignalBacktest } from './signal-backtest.ts'
import type { BoardKey } from './recommendation-boards.ts'

const FILE = 'focus-picks.json'

export interface FocusPick {
  id: string
  /** 记录日（信号日） */
  signalDate: string
  board: BoardKey
  code: string
  name: string
  style: string
  confidence: number
  focusScore: number
  /** 准入时的回测证据快照 */
  backtest: SignalBacktest | null
  horizonDays: number
  entryPlanMode?: string
  settled?: FocusSettlement
}

export interface FocusSettlement {
  entryDate: string
  entryPrice: number
  exitDate: string
  exitPrice: number
  returnPct: number
  benchmarkReturnPct?: number
  excessPct?: number
  maxAdversePct: number
  status: 'settled'
}

interface FocusFile {
  version: 1
  updatedAt: number
  picks: FocusPick[]
}

export function loadFocusPicks(): FocusFile {
  const raw = readJson<FocusFile>(FILE)
  if (!raw || !Array.isArray(raw.picks)) return { version: 1, updatedAt: Date.now(), picks: [] }
  return raw
}

/** 记录当日重点推荐（同一天同一只票只记一次，重复调用不会产生重复行） */
export function recordFocusPicks(input: {
  signalDate: string
  picks: Array<Omit<FocusPick, 'id' | 'signalDate' | 'settled'>>
}): FocusPick[] {
  const file = loadFocusPicks()
  const existing = new Set(file.picks.map((pick) => pick.signalDate + ':' + pick.code))
  const added: FocusPick[] = []
  for (const pick of input.picks) {
    const key = input.signalDate + ':' + pick.code
    if (existing.has(key)) continue
    added.push({ ...pick, id: 'focus:' + key, signalDate: input.signalDate })
    existing.add(key)
  }
  if (added.length) {
    writeJson(FILE, {
      version: 1,
      updatedAt: Date.now(),
      picks: [...added, ...file.picks].slice(0, 4000),
    } satisfies FocusFile)
  }
  return added
}

/** 结算未到期的重点推荐：次日开盘买入 → 持有 horizonDays 个交易日收盘卖出 */
export async function settleFocusPicks(
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<FocusPick[]> {
  const file = loadFocusPicks()
  const indexBars = (await loadBars('sh000300').catch(() => [] as KLineBar[]))
    .filter((item) => Number.isFinite(item.close) && item.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
  const indexByDate = new Map(indexBars.map((item) => [sessionDateOf(item.timestamp), item]))
  let changed = false
  const picks = [...file.picks]
  for (let index = 0; index < picks.length; index++) {
    const pick = picks[index]
    if (pick.settled) continue
    try {
      const bars = (await loadBars(pick.code))
        .filter((item) => Number.isFinite(item.close) && item.close > 0)
        .sort((a, b) => a.timestamp - b.timestamp)
      const entryIndex = bars.findIndex((item) => sessionDateOf(item.timestamp) > pick.signalDate)
      const exitIndex = entryIndex + pick.horizonDays - 1
      if (entryIndex < 0 || exitIndex >= bars.length) continue
      const entry = bars[entryIndex]
      const exit = bars[exitIndex]
      const entryPrice = entry.open > 0 ? entry.open : entry.close
      let maxAdverse = 0
      for (let k = entryIndex; k <= exitIndex; k++) maxAdverse = Math.min(maxAdverse, bars[k].close / entryPrice - 1)
      const returnPct = exit.close / entryPrice - 1
      const entryDate = sessionDateOf(entry.timestamp)
      const exitDate = sessionDateOf(exit.timestamp)
      const indexEntry = indexByDate.get(entryDate)
      const indexExit = indexByDate.get(exitDate)
      const benchmarkReturnPct = indexEntry?.open && indexExit?.close
        ? indexExit.close / indexEntry.open - 1
        : undefined
      picks[index] = {
        ...pick,
        settled: {
          entryDate,
          entryPrice: Number(entryPrice.toFixed(3)),
          exitDate,
          exitPrice: exit.close,
          returnPct: Number((returnPct * 100).toFixed(2)),
          benchmarkReturnPct: benchmarkReturnPct == null ? undefined : Number((benchmarkReturnPct * 100).toFixed(2)),
          excessPct: benchmarkReturnPct == null ? undefined : Number(((returnPct - benchmarkReturnPct) * 100).toFixed(2)),
          maxAdversePct: Number((maxAdverse * 100).toFixed(2)),
          status: 'settled',
        },
      }
      changed = true
    } catch {
      /* 单只失败跳过 */
    }
  }
  if (changed) writeJson(FILE, { version: 1, updatedAt: Date.now(), picks } satisfies FocusFile)
  return picks
}

export interface FocusStats {
  total: number
  settled: number
  pending: number
  winRate: number
  averageReturnPct: number
  averageExcessPct: number
  averageMaxAdversePct: number
  byBoard: Array<{ board: BoardKey; samples: number; winRate: number; averageExcessPct: number }>
  byStyle: Array<{ style: string; samples: number; winRate: number; averageExcessPct: number }>
  /** 重点 vs 同板块全量推荐的对照（如果有全量记录） */
  note: string
}

const round = (value: number, digits = 2): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const average = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

export function focusStats(picks: FocusPick[]): FocusStats {
  const settled = picks.filter((pick) => pick.settled && pick.settled.excessPct != null)
  const excess = settled.map((pick) => pick.settled?.excessPct as number)
  const returns = settled.map((pick) => pick.settled?.returnPct ?? 0)
  const adverse = settled.map((pick) => pick.settled?.maxAdversePct ?? 0)
  const group = <K extends string>(keyOf: (pick: FocusPick) => K) => {
    const map = new Map<K, number[]>()
    for (const pick of settled) {
      const key = keyOf(pick)
      map.set(key, [...(map.get(key) ?? []), pick.settled?.excessPct as number])
    }
    return [...map.entries()].map(([key, values]) => ({
      key,
      samples: values.length,
      winRate: round(values.filter((value) => value > 0).length / values.length * 100, 1),
      averageExcessPct: round(average(values)),
    }))
  }
  return {
    total: picks.length,
    settled: settled.length,
    pending: picks.length - settled.length,
    winRate: excess.length ? round(excess.filter((value) => value > 0).length / excess.length * 100, 1) : 0,
    averageReturnPct: round(average(returns)),
    averageExcessPct: round(average(excess)),
    averageMaxAdversePct: round(average(adverse)),
    byBoard: group((pick) => pick.board).map((item) => ({ board: item.key, samples: item.samples, winRate: item.winRate, averageExcessPct: item.averageExcessPct })),
    byStyle: group((pick) => pick.style).map((item) => ({ style: item.key, samples: item.samples, winRate: item.winRate, averageExcessPct: item.averageExcessPct })),
    note: settled.length < 20
      ? '样本不足 20 条，胜率与超额仅作观察，暂不据此调整准入阈值'
      : '样本已可参考：若重点推荐长期跑不出正超额，说明准入规则需要收紧',
  }
}
