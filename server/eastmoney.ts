/**
 * 东方财富全市场行情快照抓取（A 股，约 5550 只）。
 * 接口：push2.eastmoney.com/api/qt/clist/get，分页 100/页，UTF-8 JSON，字段全（含量比）。
 * 沪深分开请求以便补充市场前缀（m:0=深，m:1=沪）。
 */

export interface SnapshotStock {
  code: string // 带市场前缀，如 sh600519
  name: string
  price: number
  change: number
  changePct: number
  open: number
  high: number
  low: number
  prevClose: number
  volume: number // 手
  amount: number // 元
  turnover: number // %
  volumeRatio: number // 量比
  pe: number
  pb: number
  mktcap: number // 万元
  nmc: number // 万元
  industry?: string // 申万一级行业（由 industry.ts 合并）
  // ---- 基本面（东财 clist 追加字段，缺失时为 0；用于推荐理由与事后归因）----
  peTtm?: number // f115 市盈率 TTM
  peStatic?: number // f114 市盈率（静）
  roe?: number // f37 加权净资产收益率 %
  revenue?: number // f40 营业总收入（元）
  revenueYoy?: number // f41 营业总收入同比 %
  netProfit?: number // f45 净利润（元）
  profitYoy?: number // f46 净利润同比 %
  grossMargin?: number // f49 销售毛利率 %
  netMargin?: number // f129 销售净利率 %
  debtRatio?: number // f57 资产负债率 %
  mainNetInflow?: number // f62 主力净流入（元）
  mainNetInflowPct?: number // f184 主力净占比 %
  emIndustry?: string // f100 东财行业
  concepts?: string[] // f103 概念板块
}

interface EmItem {
  f2?: number | string
  f3?: number | string
  f4?: number | string
  f5?: number | string
  f6?: number | string
  f8?: number | string
  f9?: number | string
  f10?: number | string
  f12?: string
  f14?: string
  f15?: number | string
  f16?: number | string
  f17?: number | string
  f18?: number | string
  f20?: number | string
  f21?: number | string
  f23?: number | string
  f37?: number | string
  f40?: number | string
  f41?: number | string
  f45?: number | string
  f46?: number | string
  f49?: number | string
  f57?: number | string
  f62?: number | string
  f100?: string
  f103?: string
  f114?: number | string
  f115?: number | string
  f129?: number | string
  f184?: number | string
}

import { fetchTickQuotesByUniverse, fromTickSymbol } from './tickflow.ts'

/** 东财 clist 接口（可选增强源，非必需） */

const num = (v: number | string | undefined): number => {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

const FIELDS =
  'f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f37,f40,f41,f45,f46,f49,f57,f62,f100,f103,f114,f115,f129,f184'

const FS_GROUPS = [
  { fs: 'm:0+t:6,m:0+t:80', prefix: 'sz' }, // 深主板 + 创业板
  { fs: 'm:1+t:2,m:1+t:23', prefix: 'sh' }, // 沪主板 + 科创板
]

/** 东财行情主机候选：延迟源可用性最好，作为首选；其余作为兜底 */
const EM_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com', '82.push2.eastmoney.com']
let preferredHost = EM_HOSTS[0]

async function fetchPage(fs: string, pn: number): Promise<{ total: number; items: EmItem[] }> {
  const hosts = [preferredHost, ...EM_HOSTS.filter((h) => h !== preferredHost)]
  let lastError: unknown
  for (const host of hosts) {
    const url =
      `https://${host}/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2` +
      `&fid=f6&fs=${fs}&fields=${FIELDS}`
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/' } })
        if (!res.ok) throw new Error(`eastmoney http ${res.status}`)
        const json = (await res.json()) as { data?: { total?: number; diff?: EmItem[] } }
        const data = json.data
        if (!data || !Array.isArray(data.diff)) throw new Error('eastmoney empty data')
        preferredHost = host
        return { total: data.total ?? 0, items: data.diff }
      } catch (e) {
        lastError = e
        await new Promise((r) => setTimeout(r, 400 * attempt))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'eastmoney unavailable'))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 抓取全市场沪深 A 股快照 */
export async function fetchMarketSnapshot(onProgress?: (page: number, count: number) => void): Promise<SnapshotStock[]> {
  const stocks: SnapshotStock[] = []
  let pageNo = 0
  for (const group of FS_GROUPS) {
    const first = await fetchPage(group.fs, 1)
    const total = first.total
    const pages = Math.max(1, Math.ceil(total / 100))
    for (let pn = 1; pn <= pages; pn++) {
      const { items } = pn === 1 ? first : await fetchPage(group.fs, pn)
      for (const it of items) {
        const code = `${group.prefix}${it.f12 ?? ''}`
        if (!/^(sh|sz)\d{6}$/.test(code)) continue
        const price = num(it.f2)
        const prevClose = num(it.f18)
        stocks.push({
          code,
          name: it.f14 ?? '',
          price,
          change: num(it.f4) || (prevClose > 0 ? price - prevClose : 0),
          changePct: num(it.f3),
          open: num(it.f17),
          high: num(it.f15),
          low: num(it.f16),
          prevClose,
          volume: num(it.f5),
          amount: num(it.f6),
          turnover: num(it.f8),
          volumeRatio: num(it.f10),
          pe: num(it.f9),
          pb: num(it.f23),
          mktcap: num(it.f20) / 1e4, // 元 -> 万元
          nmc: num(it.f21) / 1e4,
          peTtm: num(it.f115),
          peStatic: num(it.f114),
          roe: num(it.f37),
          revenue: num(it.f40),
          revenueYoy: num(it.f41),
          netProfit: num(it.f45),
          profitYoy: num(it.f46),
          grossMargin: num(it.f49),
          netMargin: num(it.f129),
          debtRatio: num(it.f57),
          mainNetInflow: num(it.f62),
          mainNetInflowPct: num(it.f184),
          emIndustry: typeof it.f100 === 'string' ? it.f100 : undefined,
          concepts: typeof it.f103 === 'string' && it.f103 !== '-' ? it.f103.split(',').filter(Boolean).slice(0, 12) : undefined,
        })
      }
      pageNo++
      onProgress?.(pageNo, stocks.length)
      await sleep(60)
    }
  }
  return stocks
}

/**
 * 慢变量合并：TickFlow 主源没有估值/财务/资金字段，这里把东财的对应字段合并进快照。
 * 合并后推荐理由与基本面画像才有真实数据可用。
 */
export function mergeSlowVars(target: SnapshotStock, source: SnapshotStock): SnapshotStock {
  return {
    ...target,
    pe: source.pe || target.pe,
    pb: source.pb || target.pb,
    volumeRatio: source.volumeRatio || target.volumeRatio,
    mktcap: source.mktcap || target.mktcap,
    nmc: source.nmc || target.nmc,
    peTtm: source.peTtm || target.peTtm,
    peStatic: source.peStatic || target.peStatic,
    roe: source.roe || target.roe,
    revenue: source.revenue || target.revenue,
    revenueYoy: source.revenueYoy || target.revenueYoy,
    netProfit: source.netProfit || target.netProfit,
    profitYoy: source.profitYoy || target.profitYoy,
    grossMargin: source.grossMargin || target.grossMargin,
    netMargin: source.netMargin || target.netMargin,
    debtRatio: source.debtRatio || target.debtRatio,
    mainNetInflow: source.mainNetInflow || target.mainNetInflow,
    mainNetInflowPct: source.mainNetInflowPct || target.mainNetInflowPct,
    emIndustry: source.emIndustry ?? target.emIndustry,
    concepts: source.concepts ?? target.concepts,
  }
}

/**
 * 快照兜底：东财不可达时，用 TickFlow 全市场行情（quotes?universes）重建快照。
 * pe/pb/量比/市值 为慢变量，从旧快照（oldSnapshot）按 code 继承；无旧值时置 0。
 */
export async function buildSnapshotFromTickflow(oldSnapshot: SnapshotStock[]): Promise<SnapshotStock[]> {
  const quotes = await fetchTickQuotesByUniverse('CN_Equity_A')
  const oldMap = new Map(oldSnapshot.map((s) => [s.code, s]))
  return quotes
    .map((q): SnapshotStock | null => {
      const code = fromTickSymbol(q.symbol)
      if (!/^(sh|sz)\d{6}$/.test(code)) return null
      const old = oldMap.get(code)
      const price = q.last_price || 0
      return {
        code,
        name: q.ext?.name ?? old?.name ?? code,
        price,
        change: q.ext?.change_amount ?? price - (q.prev_close || 0),
        changePct: (q.ext?.change_pct ?? 0) * 100,
        open: q.open || 0,
        high: q.high || 0,
        low: q.low || 0,
        prevClose: q.prev_close || 0,
        volume: q.volume || 0,
        amount: q.amount || 0,
        turnover: (q.ext?.turnover_rate ?? 0) * 100,
        volumeRatio: old?.volumeRatio ?? 0,
        pe: old?.pe ?? 0,
        pb: old?.pb ?? 0,
        mktcap: old?.mktcap ?? 0,
        nmc: old?.nmc ?? 0,
        peTtm: old?.peTtm ?? 0,
        peStatic: old?.peStatic ?? 0,
        roe: old?.roe ?? 0,
        revenue: old?.revenue ?? 0,
        revenueYoy: old?.revenueYoy ?? 0,
        netProfit: old?.netProfit ?? 0,
        profitYoy: old?.profitYoy ?? 0,
        grossMargin: old?.grossMargin ?? 0,
        netMargin: old?.netMargin ?? 0,
        debtRatio: old?.debtRatio ?? 0,
        mainNetInflow: old?.mainNetInflow ?? 0,
        mainNetInflowPct: old?.mainNetInflowPct ?? 0,
        emIndustry: old?.emIndustry,
        concepts: old?.concepts,
      } satisfies SnapshotStock
    })
    .filter((s): s is SnapshotStock => s !== null)
}
