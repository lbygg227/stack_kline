/**
 * 行情数据服务（核心逻辑 + 状态，与 Vite 插件解耦）。
 * 供两个入口复用：
 * - server/plugin.ts   Vite dev server 插件（HTTP 路由）
 * - server/updater.ts  独立常驻更新进程（无人值守）
 *
 * 数据源：TickFlow 为主（全市场行情 / K 线 / 报价 / 盘口 / 行业 / 标的信息）；
 * 慢变量 PE/PB/量比/市值 每天收盘后从东财刷新一次（失败保留旧值）。
 */

import { initNetwork } from './net.ts'
import { readJson, writeJson } from './store.ts'
import { buildSnapshotFromTickflow, fetchMarketSnapshot, type SnapshotStock } from './eastmoney.ts'
import { batchKlines } from './tencent.ts'
import { runStrategy as executeStrategy } from './strategy.ts'
import {
  fetchTickDepth,
  fetchTickInstruments,
  fetchTickQuotes,
  toTickSymbol,
  type TickDepth,
  type TickInstrument,
  type TickQuote,
} from './tickflow.ts'
import { fetchTencentQuotes, type Quote } from './tencent-quote.ts'
import { buildIndustryMap, loadIndustryMap, type IndustryMap } from './industry.ts'
import { createScheduler, type UpdateTaskName } from './scheduler.ts'

initNetwork()

/* ============ 全市场快照 ============ */

interface SnapshotFile {
  fetchedAt: number
  stocks: SnapshotStock[]
}

export interface PointInTimeSnapshot {
  capturedAt: number
  asOfDate: string
  file: string
  count: number
  fields: string[]
  source: 'tickflow+eastmoney'
}

interface SnapshotHistoryIndex {
  snapshots: PointInTimeSnapshot[]
}

function archiveSnapshot(snapshot: SnapshotFile) {
  const capturedAt = Date.now()
  const asOfDate = new Date(capturedAt).toISOString().slice(0, 10)
  const file = `snapshot-history/${asOfDate}.json`
  writeJson(file, {
    capturedAt,
    asOfDate,
    source: 'tickflow+eastmoney',
    fieldsAvailableAt: ['price', 'changePct', 'volume', 'amount', 'turnover', 'volumeRatio', 'pe', 'pb', 'mktcap', 'nmc'],
    stocks: snapshot.stocks,
  })
  const index = readJson<SnapshotHistoryIndex>('snapshot-history/index.json') ?? { snapshots: [] }
  index.snapshots = index.snapshots.filter((item) => item.asOfDate !== asOfDate)
  index.snapshots.unshift({
    capturedAt,
    asOfDate,
    file,
    count: snapshot.stocks.length,
    fields: ['price', 'changePct', 'volume', 'amount', 'turnover', 'volumeRatio', 'pe', 'pb', 'mktcap', 'nmc'],
    source: 'tickflow+eastmoney',
  })
  index.snapshots = index.snapshots.slice(0, 1500)
  writeJson('snapshot-history/index.json', index)
}

export function listPointInTimeSnapshots(limit = 100): PointInTimeSnapshot[] {
  return (readJson<SnapshotHistoryIndex>('snapshot-history/index.json')?.snapshots ?? [])
    .slice(0, Math.max(1, Math.min(500, limit)))
}

const SNAPSHOT_TTL = 15 * 60 * 1000

let snapshotState: SnapshotFile | null = readJson<SnapshotFile>('market-snapshot.json')
let snapshotFetching = false
let snapshotProgress = { page: 0, count: 0 }

async function ensureSnapshot(force: boolean): Promise<SnapshotFile | null> {
  if (snapshotFetching) return null
  if (snapshotState && !force && Date.now() - snapshotState.fetchedAt < SNAPSHOT_TTL) return snapshotState
  snapshotFetching = true
  try {
    // 主源：TickFlow 全市场行情（稳定）；pe/pb/量比/市值 为慢变量，从旧快照继承
    const stocks = await buildSnapshotFromTickflow(snapshotState?.stocks ?? [])
    if (stocks.length === 0) throw new Error('snapshot empty')
    snapshotProgress = { page: 1, count: stocks.length }
    snapshotState = { fetchedAt: Date.now(), stocks }
    writeJson('market-snapshot.json', snapshotState)
    archiveSnapshot(snapshotState)
    return snapshotState
  } finally {
    snapshotFetching = false
  }
}

/* ============ 慢变量（PE/PB/量比/市值，来源：东财，每天收盘后一次） ============ */

async function refreshSlowVars(): Promise<{ detail: string }> {
  try {
    const em = await fetchMarketSnapshot()
    if (em.length === 0) throw new Error('eastmoney empty')
    const emMap = new Map(em.map((s) => [s.code, s]))
    if (snapshotState) {
      let updated = 0
      snapshotState.stocks = snapshotState.stocks.map((s) => {
        const e = emMap.get(s.code)
        if (!e) return s
        updated++
        return { ...s, pe: e.pe, pb: e.pb, volumeRatio: e.volumeRatio, mktcap: e.mktcap, nmc: e.nmc }
      })
      writeJson('market-snapshot.json', snapshotState)
      archiveSnapshot(snapshotState)
    }
    return { detail: `慢变量(PE/PB/量比/市值)刷新 ${em.length} 只` }
  } catch (e) {
    // 东财不可达时静默降级，保留旧值
    return { detail: `慢变量刷新跳过（东财不可达，保留旧值）` }
  }
}

/* ============ 行业映射 ============ */

let industryMap: IndustryMap | null = loadIndustryMap()
let industryBuilding = false

async function ensureIndustryMap(): Promise<IndustryMap | null> {
  if (industryMap) return industryMap
  if (industryBuilding) return null
  industryBuilding = true
  try {
    industryMap = await buildIndustryMap()
    return industryMap
  } catch (e) {
    console.warn('[industry] 构建失败', e)
    return null
  } finally {
    industryBuilding = false
  }
}

/* ============ 选股进度 ============ */

export interface StrategyRunProgress {
  running: boolean
  phase: 'idle' | 'preparing' | 'ai' | 'screening' | 'done'
  done: number
  total: number
  hits: number
  message: string
}

let strategyProgress: StrategyRunProgress = {
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  hits: 0,
  message: '',
}

function setStrategyProgress(partial: Partial<StrategyRunProgress>): void {
  strategyProgress = { ...strategyProgress, ...partial }
}

function beginStrategyPhase(phase: StrategyRunProgress['phase'], message: string): void {
  setStrategyProgress({ running: true, phase, done: 0, total: 0, hits: 0, message })
}

async function runStrategy(
  ...args: Parameters<typeof executeStrategy>
): Promise<Awaited<ReturnType<typeof executeStrategy>>> {
  const [snapshot, conds, getKline] = args
  beginStrategyPhase('preparing', '正在准备候选股…')
  try {
    const results = await executeStrategy(snapshot, conds, getKline, (done, total, hits = 0) => {
      setStrategyProgress({
        running: true,
        phase: 'screening',
        done,
        total,
        hits,
        message: total > 0 ? `正在扫描 ${done}/${total}` : '正在筛选…',
      })
    })
    setStrategyProgress({
      running: false,
      phase: 'done',
      done: strategyProgress.total || results.length,
      total: strategyProgress.total || results.length,
      hits: results.length,
      message: `完成，命中 ${results.length} 只`,
    })
    return results
  } catch (e) {
    setStrategyProgress({ running: false, phase: 'idle', message: '选股失败' })
    throw e
  }
}

/* ============ 全量预取 ============ */

let prefetch = { running: false, done: 0, total: 0, failed: 0 }

async function startPrefetch(period: string): Promise<void> {
  if (prefetch.running) return
  const snap = snapshotState ?? (await ensureSnapshot(false))
  if (!snap) return
  prefetch = { running: true, done: 0, total: snap.stocks.length, failed: 0 }
  try {
    await batchKlines(
      snap.stocks.map((s) => s.code),
      period,
      320,
      4,
      (done, total, failed) => {
        prefetch = { running: true, done, total, failed }
      },
    )
  } finally {
    prefetch.running = false
  }
}

/* ============ 实时报价 ============ */

const formatTime = (ts: number): string => {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const isIndexCode = (code: string) => /^(sh000|sz399)/.test(code)

async function buildQuotes(codes: string[]): Promise<Quote[]> {
  if (codes.length === 0) return []
  const indexCodes = codes.filter(isIndexCode)
  const stockCodes = codes.filter((c) => !isIndexCode(c))
  const result: Quote[] = []

  const snapMap = new Map<string, SnapshotStock>()
  for (const s of snapshotState?.stocks ?? []) snapMap.set(s.code, s)

  if (stockCodes.length > 0) {
    const symbols = stockCodes.map(toTickSymbol)
    const [qRes, dRes, iRes] = await Promise.allSettled([
      fetchTickQuotes(symbols),
      fetchTickDepth(symbols),
      fetchTickInstruments(symbols),
    ])
    const qMap = new Map<string, TickQuote>()
    const dMap = new Map<string, TickDepth>()
    const iMap = new Map<string, TickInstrument>()
    if (qRes.status === 'fulfilled') for (const q of qRes.value) qMap.set(q.symbol, q)
    if (dRes.status === 'fulfilled') for (const d of dRes.value) dMap.set(d.symbol, d)
    if (iRes.status === 'fulfilled') for (const i of iRes.value) iMap.set(i.symbol, i)

    for (const code of stockCodes) {
      const sym = toTickSymbol(code)
      const q = qMap.get(sym)
      if (!q) continue
      const inst = iMap.get(sym)
      const depth = dMap.get(sym)
      const snap = snapMap.get(code)
      const price = q.last_price || 0
      const mktCapTotal = inst?.ext?.total_shares
        ? (price * inst.ext.total_shares) / 1e8
        : (snap ? snap.mktcap / 1e4 : 0)
      const mktCapFloat = inst?.ext?.float_shares
        ? (price * inst.ext.float_shares) / 1e8
        : (snap ? snap.nmc / 1e4 : 0)
      result.push({
        code,
        name: q.ext?.name ?? inst?.name ?? snap?.name ?? code,
        price,
        prevClose: q.prev_close || 0,
        open: q.open || 0,
        high: q.high || 0,
        low: q.low || 0,
        change: q.ext?.change_amount ?? price - (q.prev_close || 0),
        changePct: (q.ext?.change_pct ?? 0) * 100,
        volume: q.volume || 0,
        amount: (q.amount || 0) / 1e4,
        turnover: (q.ext?.turnover_rate ?? 0) * 100,
        amplitude: (q.ext?.amplitude ?? 0) * 100,
        volumeRatio: snap?.volumeRatio ?? 0,
        pe: snap?.pe ?? 0,
        pb: snap?.pb ?? 0,
        mktCapFloat,
        mktCapTotal,
        upLimit: inst?.ext?.limit_up ?? 0,
        downLimit: inst?.ext?.limit_down ?? 0,
        bids: (depth?.bid_prices ?? []).slice(0, 5).map((p, i) => ({ price: p, volume: depth?.bid_volumes?.[i] ?? 0 })),
        asks: (depth?.ask_prices ?? []).slice(0, 5).map((p, i) => ({ price: p, volume: depth?.ask_volumes?.[i] ?? 0 })),
        time: formatTime(q.timestamp),
      })
    }

    const missing = stockCodes.filter((c) => !result.some((r) => r.code === c))
    if (missing.length > 0) {
      try {
        result.push(...(await fetchTencentQuotes(missing)))
      } catch {
        /* 忽略 */
      }
    }
  }

  if (indexCodes.length > 0) {
    try {
      result.push(...(await fetchTencentQuotes(indexCodes)))
    } catch {
      /* 忽略 */
    }
  }

  return result
}

/* ============ 每日自动更新调度 ============ */

const scheduler = createScheduler({
  snapshot: async () => {
    const s = await ensureSnapshot(true)
    return { detail: `全市场快照 ${s?.stocks.length ?? 0} 只` }
  },
  slowvars: refreshSlowVars,
  industry: async () => {
    const m = await buildIndustryMap()
    industryMap = m
    return { detail: `行业映射 ${Object.keys(m.map).length} 条` }
  },
  klines: async () => {
    await startPrefetch('day')
    return { detail: `日K预取 ${prefetch.done}/${prefetch.total}（失败 ${prefetch.failed}）` }
  },
} satisfies Record<UpdateTaskName, () => Promise<{ detail: string }>>)

/* ============ 导出 ============ */

export const service = {
  getSnapshotState: () => snapshotState,
  getSnapshotProgress: () => snapshotProgress,
  isSnapshotFetching: () => snapshotFetching,
  ensureSnapshot,
  getIndustryMap: () => industryMap,
  ensureIndustryMap,
  getPrefetch: () => prefetch,
  startPrefetch,
  buildQuotes,
  scheduler,
  /** 快照 + 行业合并（供策略 / AI / 快照接口复用） */
  stocksWithIndustry: () =>
    (snapshotState?.stocks ?? []).map((s) => ({ ...s, industry: industryMap?.map[s.code] ?? '其他' })),
  runStrategy,
  getStrategyProgress: () => strategyProgress,
  beginStrategyPhase,
}
