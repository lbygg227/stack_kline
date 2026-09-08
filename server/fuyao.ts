/**
 * 同花顺扶摇 A 股 REST 客户端。
 * Key 仅来自服务端 .env：FUYAO_API_KEY
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* 无 .env 时沿用进程环境变量 */
}

const API_BASE = (process.env.FUYAO_API_BASE || 'https://fuyao.aicubes.cn').replace(/\/$/, '')
const API_KEY = (process.env.FUYAO_API_KEY || '').trim()

export type DragonTigerBoardType = 'all' | 'org' | 'hot_money'

export function hasFuyao(): boolean {
  return !!API_KEY
}

export interface DragonTigerConcept {
  name: string
}

export interface DragonTigerRawItem {
  thscode: string
  ticker?: string
  name: string
  change?: number | null
  net_value?: number | null
  net_rate?: number | null
  hot_rank?: number | null
  buy_value?: number | null
  sell_value?: number | null
  range_days?: number | null
  org_net_value?: number | null
  hot_money_net_value?: number | null
  limit_reason?: string | null
  concept_list?: DragonTigerConcept[] | null
}

export interface DragonTigerListResult {
  tradeDate: string
  boardType: DragonTigerBoardType
  stockCount: number
  items: DragonTigerRawItem[]
}

async function fuyaoGet(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
  if (!API_KEY) throw new Error('未配置 FUYAO_API_KEY')
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, v)
  }
  const url = `${API_BASE}${path}${qs.size ? `?${qs}` : ''}`
  const res = await fetch(url, {
    headers: {
      'X-api-key': API_KEY,
      Accept: 'application/json',
      'User-Agent': 'stock-kline/1.0',
    },
  })
  if (!res.ok) throw new Error(`fuyao http ${res.status}`)
  return await res.json()
}

/** 600519.SH / 000001.SZ / 830799.BJ -> sh600519 */
export function fromFuyaoThscode(thscode: string): string {
  const m = thscode.trim().match(/^(\d{6})\.(SH|SZ|BJ)$/i)
  if (!m) return thscode.trim().toLowerCase()
  return `${m[2].toLowerCase()}${m[1]}`
}

/** 拉取龙虎榜（缺省最近交易日） */
export async function fetchDragonTigerList(options: {
  date?: string
  boardType?: DragonTigerBoardType
} = {}): Promise<DragonTigerListResult> {
  const boardType = options.boardType ?? 'all'
  const raw = (await fuyaoGet('/api/a-share/special-data/dragon-tiger-list', {
    date: options.date,
    board_type: boardType,
  })) as {
    code?: number
    message?: string
    data?: {
      trade_date?: string
      board_type?: string
      stock_count?: number
      stock_items?: DragonTigerRawItem[]
    }
  }
  if (raw.code != null && raw.code !== 0) {
    throw new Error(raw.message || `fuyao dragon-tiger code ${raw.code}`)
  }
  const data = raw.data ?? {}
  return {
    tradeDate: data.trade_date || options.date || '',
    boardType: (data.board_type as DragonTigerBoardType) || boardType,
    stockCount: data.stock_count ?? (data.stock_items?.length ?? 0),
    items: Array.isArray(data.stock_items) ? data.stock_items : [],
  }
}
