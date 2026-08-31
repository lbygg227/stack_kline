/**
 * 腾讯实时报价（qt.gtimg.cn，GBK 文本）解析 —— 服务端版。
 * 用于指数报价兜底（TickFlow 指数行情偶有缺失）与部分字段补充。
 */

export interface BidAsk {
  price: number
  volume: number
}

export interface Quote {
  code: string
  name: string
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  change: number
  changePct: number
  volume: number // 手
  amount: number // 万元
  turnover: number // %
  amplitude: number // %
  volumeRatio: number // 量比
  pe: number
  pb: number
  mktCapFloat: number // 亿
  mktCapTotal: number // 亿
  upLimit: number
  downLimit: number
  bids: BidAsk[]
  asks: BidAsk[]
  time: string
}

const num = (v: unknown): number => {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

const parseQuoteText = (text: string, nameFallback: (code: string) => string = (c) => c): Quote[] => {
  const quotes: Quote[] = []
  // 响应形如 v_sh600519="1~贵州茅台~600519~..."，code 以变量名 v_xxx 为准（含市场前缀）
  const re = /v_([a-z0-9]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const code = m[1] ?? ''
    const p = m[2].split('~')
    const price = num(p[3])
    if (!code || price <= 0) continue
    const bids = Array.from({ length: 5 }, (_, i) => ({ price: num(p[9 + i * 2]), volume: num(p[10 + i * 2]) }))
    const asks = Array.from({ length: 5 }, (_, i) => ({ price: num(p[19 + i * 2]), volume: num(p[20 + i * 2]) }))
    quotes.push({
      code,
      name: p[1] || nameFallback(code),
      price,
      prevClose: num(p[4]),
      open: num(p[5]),
      high: num(p[33]),
      low: num(p[34]),
      change: num(p[31]),
      changePct: num(p[32]),
      volume: num(p[36]),
      amount: num(p[37]),
      turnover: num(p[38]),
      amplitude: num(p[43]),
      volumeRatio: num(p[49]),
      pe: num(p[39]),
      pb: num(p[46]),
      mktCapFloat: num(p[44]),
      mktCapTotal: num(p[45]),
      upLimit: num(p[47]),
      downLimit: num(p[48]),
      bids,
      asks,
      time: p[30] ?? '',
    })
  }
  return quotes
}

/** 拉取并解析腾讯报价（经全局代理） */
export async function fetchTencentQuotes(codes: string[]): Promise<Quote[]> {
  if (codes.length === 0) return []
  const res = await fetch(`https://qt.gtimg.cn/q=${codes.join(',')}`)
  if (!res.ok) throw new Error(`tencent quote http ${res.status}`)
  const buf = await res.arrayBuffer()
  const text = new TextDecoder('gbk').decode(buf)
  return parseQuoteText(text)
}

export { parseQuoteText }
