/**
 * 东方财富个股资金流向（主力/超大单/大单/中单/小单净流入）。
 * 接口：push2his.eastmoney.com/api/qt/stock/fflow/kline/get
 * klt=101 为日级别。
 * secid 格式：1.600519（沪）、0.002594（深）。
 *
 * 响应 klines 每条格式（逗号分隔）：
 *   日期, 主力净流入, 小单净流入, 中单净流入, 大单净流入, 超大单净流入
 *   (f51, f52,        f53,        f54,        f55,        f56)
 */

export interface FundFlowDay {
  date: string
  mainNet: number      // 主力净流入（大单+超大单）
  smallNet: number     // 小单净流入
  midNet: number       // 中单净流入
  bigNet: number       // 大单净流入
  superBigNet: number  // 超大单净流入
}

export interface FundFlowResult {
  code: string
  name: string
  days: FundFlowDay[]
}

function toSecid(code: string): string {
  const m = code.match(/^(sh|sz|bj)(\d{6})$/)
  if (!m) return code
  const market = m[1] === 'sh' ? '1' : m[1] === 'sz' ? '0' : '0'
  return `${market}.${m[2]}`
}

const num = (v: string | undefined): number => {
  if (!v || v === '-') return 0
  const n = Number(v)
  return isFinite(n) ? n : 0
}

export async function fetchFundFlow(code: string, days = 20): Promise<FundFlowResult> {
  const secid = toSecid(code)
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get` +
    `?lmt=${days}&klt=101&secid=${secid}` +
    `&fields1=f1,f2,f3,f7` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`

  const headers = { Referer: 'https://quote.eastmoney.com/' }

  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`eastmoney-fund http ${res.status}`)
      const json = (await res.json()) as {
        rc?: number
        data?: { code?: string; name?: string; klines?: string[] }
      }
      if (json.rc !== 0 || !json.data) throw new Error('eastmoney-fund empty response')

      const klines = json.data.klines ?? []
      const result: FundFlowDay[] = klines.map((line) => {
        const parts = line.split(',')
        return {
          date: parts[0] ?? '',
          mainNet: num(parts[1]),
          smallNet: num(parts[2]),
          midNet: num(parts[3]),
          bigNet: num(parts[4]),
          superBigNet: num(parts[5]),
        }
      })

      return {
        code,
        name: json.data.name ?? '',
        days: result,
      }
    } catch (e) {
      lastErr = e
      if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt))
    }
  }
  throw lastErr
}

/**
 * 获取当日实时资金流向汇总（取最后一条 kline 数据）。
 */
export async function fetchFundFlowToday(code: string): Promise<FundFlowDay | null> {
  const result = await fetchFundFlow(code, 1)
  return result.days.at(-1) ?? null
}
