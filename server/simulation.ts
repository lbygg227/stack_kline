/**
 * 推荐模拟盘：把历史推荐按固定规则虚拟建仓、持有到期平仓，用于直观查看推荐效果。
 */

import type { KLineBar } from './tencent.ts'
import { readJson, writeJson } from './store.ts'

const STORE_FILE = 'simulation.json'
const RECORD_FILE = 'recommendation-records.json'
const INITIAL_CAPITAL = 1_000_000
const POSITION_SIZE = 50_000
const MAX_POSITIONS = 30
const MAX_NEW_PER_SYNC = 20

export interface SimulationPosition {
  id: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  entryDate: string
  entryPrice: number
  shares: number
  cost: number
  horizonDays: number
  target?: number
  stopLoss?: number
}

export interface SimulationTrade {
  id: string
  code: string
  name: string
  style: string
  signalDate: string
  entryDate: string
  entryPrice: number
  exitDate: string
  exitPrice: number
  shares: number
  returnPct: number
  pnl: number
  horizonDays: number
}

export interface SimulationStore {
  version: 1
  initialCapital: number
  cash: number
  positions: SimulationPosition[]
  trades: SimulationTrade[]
  processed: string[]
  createdAt: number
  updatedAt: number
}

type RecommendationRecord = {
  id: string
  code: string
  name: string
  style: string
  channels: string[]
  signalDate: string
  horizonDays: number
  confidence: number
  levels?: { entry?: number; target?: number; stopLoss?: number }
  createdAt: number
}

type RecordStore = { version: number; records: RecommendationRecord[] }

function emptyStore(): SimulationStore {
  const now = Date.now()
  return {
    version: 1,
    initialCapital: INITIAL_CAPITAL,
    cash: INITIAL_CAPITAL,
    positions: [],
    trades: [],
    processed: [],
    createdAt: now,
    updatedAt: now,
  }
}

function loadStore(): SimulationStore {
  const raw = readJson<SimulationStore>(STORE_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.positions)) return emptyStore()
  return raw
}

function saveStore(store: SimulationStore): void {
  writeJson(STORE_FILE, { ...store, updatedAt: Date.now() } satisfies SimulationStore)
}

function loadRecords(): RecommendationRecord[] {
  const raw = readJson<RecordStore>(RECORD_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) return []
  return raw.records
}

const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => new Date(msOf(timestamp)).toISOString().slice(0, 10)

function indexOfSignal(bars: KLineBar[], signalDate: string): number {
  return bars.findIndex((bar) => dayOf(bar.timestamp) >= signalDate)
}

export async function syncSimulation(
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<SimulationStore> {
  const store = loadStore()
  const processed = new Set(store.processed)
  const records = loadRecords()
    .filter((record) => /^(sh|sz|bj)\d{6}$/.test(record.code))
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate) || b.confidence - a.confidence)

  // 1) 先处理到期平仓，释放资金
  const openPositions: SimulationPosition[] = []
  for (const position of store.positions) {
    const bars = (await loadBars(position.code).catch(() => []))
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
    const entryIndex = bars.findIndex((bar) => dayOf(bar.timestamp) === position.entryDate)
    const exitIndex = entryIndex >= 0 ? entryIndex + position.horizonDays : -1
    const exitBar = exitIndex >= 0 ? bars[exitIndex] : undefined
    if (!exitBar?.close) {
      openPositions.push(position)
      continue
    }
    const proceeds = position.shares * exitBar.close
    store.cash += proceeds
    store.trades.push({
      id: position.id,
      code: position.code,
      name: position.name,
      style: position.style,
      signalDate: position.signalDate,
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      exitDate: dayOf(exitBar.timestamp),
      exitPrice: exitBar.close,
      shares: position.shares,
      returnPct: (exitBar.close / position.entryPrice - 1) * 100,
      pnl: proceeds - position.cost,
      horizonDays: position.horizonDays,
    })
  }
  store.positions = openPositions

  // 2) 再按时间顺序开新仓
  let opened = 0
  for (const record of records) {
    if (opened >= MAX_NEW_PER_SYNC) break
    if (store.positions.length >= MAX_POSITIONS) break
    const id = record.code + ':' + record.signalDate
    if (processed.has(id)) continue
    if (store.cash < POSITION_SIZE) break
    const bars = (await loadBars(record.code).catch(() => []))
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
    const index = indexOfSignal(bars, record.signalDate)
    if (index < 0 || index + 1 >= bars.length) continue
    const entryBar = bars[index + 1]
    const entryPrice = entryBar.open
    if (!entryPrice || entryPrice <= 0) continue
    const shares = Math.floor(POSITION_SIZE / entryPrice)
    if (shares <= 0) continue
    const cost = shares * entryPrice
    if (cost > store.cash) continue
    store.cash -= cost
    store.positions.push({
      id,
      code: record.code,
      name: record.name,
      style: record.style,
      channels: record.channels,
      signalDate: record.signalDate,
      entryDate: dayOf(entryBar.timestamp),
      entryPrice,
      shares,
      cost,
      horizonDays: Math.max(1, record.horizonDays || 5),
      target: record.levels?.target,
      stopLoss: record.levels?.stopLoss,
    })
    processed.add(id)
    opened += 1
  }

  // 3) 开仓后再次检查是否已经到期（历史推荐可能当天就能平仓）
  const stillOpen: SimulationPosition[] = []
  for (const position of store.positions) {
    const bars = (await loadBars(position.code).catch(() => []))
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
    const entryIndex = bars.findIndex((bar) => dayOf(bar.timestamp) === position.entryDate)
    const exitIndex = entryIndex >= 0 ? entryIndex + position.horizonDays : -1
    const exitBar = exitIndex >= 0 ? bars[exitIndex] : undefined
    if (!exitBar?.close) {
      stillOpen.push(position)
      continue
    }
    const proceeds = position.shares * exitBar.close
    store.cash += proceeds
    store.trades.push({
      id: position.id,
      code: position.code,
      name: position.name,
      style: position.style,
      signalDate: position.signalDate,
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      exitDate: dayOf(exitBar.timestamp),
      exitPrice: exitBar.close,
      shares: position.shares,
      returnPct: (exitBar.close / position.entryPrice - 1) * 100,
      pnl: proceeds - position.cost,
      horizonDays: position.horizonDays,
    })
  }
  store.positions = stillOpen

  store.processed = [...processed]
  saveStore(store)
  return store
}

export async function getSimulationSnapshot(loadBars: (code: string) => Promise<KLineBar[]>): Promise<{
  initialCapital: number
  cash: number
  positionValue: number
  totalEquity: number
  totalReturnPct: number
  winRate: number
  trades: SimulationTrade[]
  positions: Array<SimulationPosition & { currentPrice: number; marketValue: number; returnPct: number }>
  equityCurve: Array<{ date: string; value: number }>
  updatedAt: number
}> {
  const store = loadStore()
  const positions: Array<SimulationPosition & { currentPrice: number; marketValue: number; returnPct: number }> = []
  let positionValue = 0
  for (const position of store.positions) {
    const bars = (await loadBars(position.code).catch(() => []))
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
    const latest = bars[bars.length - 1]
    const currentPrice = latest?.close ?? position.entryPrice
    const marketValue = position.shares * currentPrice
    positionValue += marketValue
    positions.push({
      ...position,
      currentPrice,
      marketValue,
      returnPct: (currentPrice / position.entryPrice - 1) * 100,
    })
  }
  const totalEquity = store.cash + positionValue
  const trades = [...store.trades].sort((a, b) => b.exitDate.localeCompare(a.exitDate))
  const equityCurve: Array<{ date: string; value: number }> = []
  let equity = store.initialCapital
  for (const trade of [...store.trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate))) {
    equity += trade.pnl
    equityCurve.push({ date: trade.exitDate, value: equity })
  }
  equityCurve.push({ date: dayOf(Date.now()), value: totalEquity })
  const wins = trades.filter((trade) => trade.returnPct > 0).length
  return {
    initialCapital: store.initialCapital,
    cash: store.cash,
    positionValue,
    totalEquity,
    totalReturnPct: (totalEquity / store.initialCapital - 1) * 100,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    trades,
    positions,
    equityCurve,
    updatedAt: store.updatedAt,
  }
}

export function resetSimulation(): void {
  saveStore(emptyStore())
}
