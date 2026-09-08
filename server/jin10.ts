/**
 * 金十数据官方 MCP 客户端（HTTP + SSE）。
 * Token 仅来自服务端 .env：JIN10_MCP_TOKEN
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* 无 .env 时沿用进程环境变量 */
}

const MCP_URL = (process.env.JIN10_MCP_URL || 'https://mcp.jin10.com/mcp').trim()
const TOKEN = (process.env.JIN10_MCP_TOKEN || '').trim()
const PROTOCOL = process.env.JIN10_MCP_PROTOCOL_VERSION || '2025-11-25'

export function hasJin10(): boolean {
  return !!TOKEN
}

export interface Jin10FlashItem {
  title?: string
  content: string
  time: string
  url: string
}

export interface Jin10NewsItem {
  id?: string
  title: string
  introduction?: string
  content?: string
  time: string
  url: string
}

export interface Jin10CalendarItem {
  [key: string]: unknown
}

export interface Jin10Quote {
  code: string
  name: string
  open?: string
  close?: string
  high?: string
  low?: string
  volume?: number
  ups_percent?: string
  ups_price?: string
  time?: string
}

type McpResult = {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

function parseSseJson(raw: string): unknown {
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim()
      if (payload) return JSON.parse(payload)
    }
  }
  // 兼容纯 JSON
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  throw new Error('金十 MCP 响应无法解析')
}

async function mcpRequest(method: string, params: Record<string, unknown>, id = 1): Promise<unknown> {
  if (!TOKEN) throw new Error('未配置 JIN10_MCP_TOKEN')
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }),
  })
  if (!res.ok) throw new Error(`jin10 mcp http ${res.status}`)
  const text = await res.text()
  const json = parseSseJson(text) as {
    error?: { message?: string }
    result?: unknown
  }
  if (json.error) throw new Error(json.error.message || 'jin10 mcp error')
  return json.result
}

function unwrapToolPayload(result: McpResult): unknown {
  if (result.structuredContent != null) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  if (text) {
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text }
    }
  }
  return result
}

export async function callJin10Tool<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = (await mcpRequest('tools/call', { name, arguments: args }, Date.now() % 1_000_000)) as McpResult
  if (result.isError) throw new Error(`jin10 tool ${name} failed`)
  return unwrapToolPayload(result) as T
}

type ListPayload<T> = {
  status?: number
  message?: string
  data?: {
    items?: T[]
    has_more?: boolean
    cursor?: string
  } | null
}

function asItems<T>(payload: ListPayload<T>): T[] {
  if (payload.status && payload.status !== 200) {
    throw new Error(payload.message || `jin10 status ${payload.status}`)
  }
  return payload.data?.items ?? []
}

export async function listJin10Flash(cursor?: string): Promise<{
  items: Jin10FlashItem[]
  hasMore: boolean
  cursor?: string
}> {
  const args: Record<string, unknown> = {}
  if (cursor) args.cursor = cursor
  const payload = await callJin10Tool<ListPayload<Jin10FlashItem>>('list_flash', args)
  return {
    items: asItems(payload),
    hasMore: !!payload.data?.has_more,
    cursor: payload.data?.cursor,
  }
}

export async function searchJin10Flash(keyword: string): Promise<Jin10FlashItem[]> {
  const payload = await callJin10Tool<ListPayload<Jin10FlashItem>>('search_flash', { keyword })
  return asItems(payload)
}

export async function listJin10News(cursor?: string): Promise<{
  items: Jin10NewsItem[]
  hasMore: boolean
  cursor?: string
}> {
  const args: Record<string, unknown> = {}
  if (cursor) args.cursor = cursor
  const payload = await callJin10Tool<ListPayload<Jin10NewsItem>>('list_news', args)
  return {
    items: asItems(payload),
    hasMore: !!payload.data?.has_more,
    cursor: payload.data?.cursor,
  }
}

export async function searchJin10News(keyword: string, cursor?: string): Promise<Jin10NewsItem[]> {
  const args: Record<string, unknown> = { keyword }
  if (cursor) args.cursor = cursor
  const payload = await callJin10Tool<ListPayload<Jin10NewsItem>>('search_news', args)
  return asItems(payload)
}

export async function getJin10News(id: string): Promise<Jin10NewsItem | null> {
  const payload = await callJin10Tool<{ status?: number; data?: Jin10NewsItem | null }>('get_news', { id })
  return payload.data ?? null
}

export async function listJin10Calendar(): Promise<Jin10CalendarItem[]> {
  const payload = await callJin10Tool<{ status?: number; data?: Jin10CalendarItem[] | { items?: Jin10CalendarItem[] } | null }>(
    'list_calendar',
    {},
  )
  const data = payload.data
  if (Array.isArray(data)) return data
  if (data && Array.isArray((data as { items?: Jin10CalendarItem[] }).items)) {
    return (data as { items: Jin10CalendarItem[] }).items
  }
  return []
}

export async function getJin10Quote(code: string): Promise<Jin10Quote | null> {
  const payload = await callJin10Tool<{ status?: number; data?: Jin10Quote | null }>('get_quote', { code })
  return payload.data ?? null
}

/** 把金十快讯转成一级资讯采集用的 NewsItem 形态 */
export function flashToNewsItems(items: Jin10FlashItem[]): Array<{
  title: string
  url: string
  snippet: string
  date?: string
  source?: string
}> {
  return items
    .filter((item) => item.content?.trim() && item.url)
    .filter((item) => isAShareRelevantText(`${item.title ?? ''} ${item.content}`))
    .filter((item) => !isJunkNewsTitle(item.title?.trim() || item.content.split('\n')[0] || ''))
    .map((item) => {
      const content = item.content.trim()
      const title = (item.title?.trim() || content.split('\n')[0] || content).slice(0, 120)
      return {
        title,
        url: item.url,
        snippet: content.slice(0, 220),
        date: item.time,
        source: '金十快讯',
      }
    })
}

/** 排除纯海外宏观/商品噪音；保留 A 股或可映射主题 */
const ASHARE_HINT_RE =
  /A股|沪深|上证|深成|创业板|科创板|北交所|沪指|深指|两市|沪市|深市|港股通|陆股通|证监会|交易所|回购|公告|立案|问询|涨停|跌停|跌破|亿元|板块|个股|茅台|宁德|比亚迪|银行|券商|地产|房企|光伏|锂电|半导体|芯片|白酒|新能源/
const OFFSHORE_NOISE_RE =
  /美元指数|非农|美联储|欧央行|日央行|比特币|以太坊|欧美盘|美股收盘|纳斯达克|标普500|现货黄金|伦敦金|布伦特原油|欧元兑|英镑兑|日元兑/

export function isAShareRelevantText(text: string): boolean {
  const t = text.replace(/\s+/g, '')
  if (!t) return false
  if (OFFSHORE_NOISE_RE.test(t) && !ASHARE_HINT_RE.test(t)) return false
  return ASHARE_HINT_RE.test(t) || /宅地|土拍|LPR|降准|降息|集采|军工|算力|大模型/.test(t)
}

export function isJunkNewsTitle(title: string): boolean {
  return /行情数据|走势图|实时行情|最新价_|涨跌幅榜|搜狐证券|同花顺加自选|东方财富网-|个股频道/.test(title)
}

export async function fetchJin10AShareFlashes(): Promise<ReturnType<typeof flashToNewsItems>> {
  const [aShare, sh, general] = await Promise.all([
    searchJin10Flash('A股').catch(() => [] as Jin10FlashItem[]),
    searchJin10Flash('沪深').catch(() => [] as Jin10FlashItem[]),
    listJin10Flash().then((r) => r.items).catch(() => [] as Jin10FlashItem[]),
  ])
  const merged = [...aShare, ...sh, ...general]
  const seen = new Set<string>()
  const unique: Jin10FlashItem[] = []
  for (const item of merged) {
    if (!item.url || seen.has(item.url)) continue
    seen.add(item.url)
    unique.push(item)
  }
  return flashToNewsItems(unique).slice(0, 40)
}

export function newsArticleToNewsItems(items: Jin10NewsItem[]): Array<{
  title: string
  url: string
  snippet: string
  date?: string
  source?: string
}> {
  return items
    .filter((item) => item.title?.trim() && item.url)
    .filter((item) => isAShareRelevantText(`${item.title} ${item.introduction ?? ''} ${item.content ?? ''}`))
    .filter((item) => !isJunkNewsTitle(item.title))
    .map((item) => ({
      title: item.title.trim().slice(0, 120),
      url: item.url,
      snippet: (item.introduction || item.content || item.title).trim().slice(0, 220),
      date: item.time,
      source: '金十资讯',
    }))
}

export async function fetchJin10AShareNews(): Promise<ReturnType<typeof newsArticleToNewsItems>> {
  const [listed, searched] = await Promise.all([
    listJin10News().then((r) => r.items).catch(() => [] as Jin10NewsItem[]),
    searchJin10News('A股').catch(() => [] as Jin10NewsItem[]),
  ])
  const merged = [...searched, ...listed]
  const seen = new Set<string>()
  const unique: Jin10NewsItem[] = []
  for (const item of merged) {
    const key = item.url || item.id || item.title
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return newsArticleToNewsItems(unique).slice(0, 20)
}
