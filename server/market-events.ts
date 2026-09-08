/**
 * 一级资讯事件：采集、落盘、标的/板块映射，并挂接二级博主观点。
 * 不做自动下单，只提供观察候选所需的事实层。
 */

import { createHash } from 'node:crypto'
import type { SnapshotStock } from './eastmoney.ts'
import { hasNewsProvider, searchNews, type NewsItem } from './news.ts'
import { fetchJin10AShareFlashes, fetchJin10AShareNews, hasJin10, isJunkNewsTitle } from './jin10.ts'
import { listOpinionDocuments, type OpinionDocument } from './opinions.ts'
import { readJson, writeJson } from './store.ts'

export type MarketEventKind = 'announcement' | 'regulatory' | 'news'

export interface MarketEvent {
  id: string
  title: string
  url: string
  snippet: string
  source?: string
  provider: string
  query: string
  publishedAt: number
  capturedAt: number
  kind: MarketEventKind
  strength: number
  codes: string[]
  names: string[]
  industries: string[]
}

export interface EventOpinionLink {
  documentId: string
  authorName: string
  platform: string
  title: string
  publishedAt: number
  url: string
  stance: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  thesis: string
  code?: string
  name?: string
  industry?: string
}

export interface MarketEventCard extends MarketEvent {
  opinionCount: number
}

export interface MarketEventDetail extends MarketEvent {
  opinions: EventOpinionLink[]
}

export interface EventStockRef {
  code: string
  name: string
  industry?: string
  amount?: number
  changePct?: number
}

export interface EventUniverse {
  codes: Set<string>
  industries: Set<string>
}

interface EventStore {
  version: 1
  updatedAt: number
  lastCollectAt?: number
  lastProvider?: string
  events: MarketEvent[]
}

const STORE_FILE = 'market-events.json'
const MAX_EVENTS = 400
const MAX_CODES = 8
const DAY_MS = 24 * 60 * 60 * 1000

const ANNOUNCEMENT_RE = /公告|披露|年报|半年报|季报|增持|减持|回购|分红|配股|增发|业绩预/
const REGULATORY_RE = /监管|问询|处罚|立案|警示|核查|通报|证监会|交易所函/

const KIND_STRENGTH: Record<MarketEventKind, number> = {
  announcement: 3,
  regulatory: 2,
  news: 1,
}

const KIND_LABEL: Record<MarketEventKind, string> = {
  announcement: '公告',
  regulatory: '监管',
  news: '新闻',
}

const MARKET_QUERIES = ['A股 最新 公告', 'A股 监管 问询 处罚']

const SW1_INDUSTRIES: string[] = [
  '机械设备', '医药生物', '基础化工', '电子', '电力设备', '建筑装饰', '汽车', '计算机', '传媒',
  '交通运输', '有色金属', '房地产', '轻工制造', '公用事业', '食品饮料', '纺织服饰', '通信', '国防军工',
  '环保', '商贸零售', '农林牧渔', '非银金融', '家用电器', '建筑材料', '社会服务', '石油石化', '钢铁',
  '银行', '煤炭', '综合', '美容护理',
]

const FALLBACK_STOCKS: EventStockRef[] = [
  { code: 'sh600519', name: '贵州茅台', industry: '食品饮料' },
  { code: 'sz300750', name: '宁德时代', industry: '电力设备' },
  { code: 'sz002594', name: '比亚迪', industry: '汽车' },
  { code: 'sz000858', name: '五粮液', industry: '食品饮料' },
  { code: 'sh601318', name: '中国平安', industry: '非银金融' },
  { code: 'sh600036', name: '招商银行', industry: '银行' },
  { code: 'sz000333', name: '美的集团', industry: '家用电器' },
  { code: 'sh601012', name: '隆基绿能', industry: '电力设备' },
  { code: 'sz002475', name: '立讯精密', industry: '电子' },
  { code: 'sh688981', name: '中芯国际', industry: '电子' },
]

export function eventKindLabel(kind: MarketEventKind): string {
  return KIND_LABEL[kind]
}

export function classifyEventKind(text: string): MarketEventKind {
  if (ANNOUNCEMENT_RE.test(text)) return 'announcement'
  if (REGULATORY_RE.test(text)) return 'regulatory'
  return 'news'
}

export function parsePublishedAt(raw?: string, fallback = Date.now()): number {
  if (!raw?.trim()) return fallback
  const text = raw.trim()
  const iso = Date.parse(text)
  if (Number.isFinite(iso)) return iso
  const cn = text.match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})/)
  if (cn) {
    const t = new Date(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3])).getTime()
    if (Number.isFinite(t)) return t
  }
  const rel = text.match(/(\d+)\s*(分钟|小时|天|日)前/)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    const ms = unit === '分钟' ? n * 60_000 : unit.startsWith('小时') ? n * 3_600_000 : n * DAY_MS
    return fallback - ms
  }
  return fallback
}

export function eventIdFromUrl(url: string): string {
  const normalized = url.split('#')[0].split('?')[0].replace(/\/+$/, '')
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

function digitsOf(code: string): string {
  const m = code.toLowerCase().match(/(\d{6})$/)
  return m?.[1] ?? ''
}

/** 主题词 → 申万一级（正文不写行业名时的启发式，零 LLM） */
const THEME_INDUSTRY_RULES: Array<{ industry: string; patterns: RegExp[] }> = [
  { industry: '房地产', patterns: [/宅地|土拍|拿地|房价|楼市|房企|房地产|保障房|公积金贷款/] },
  { industry: '银行', patterns: [/人民币兑|在岸人民币|离岸人民币|LPR|存准|降准|降息|加息|信贷|存款利率|银行股/] },
  { industry: '非银金融', patterns: [/券商|保险资金|险资|股指期货|两融|印花税|IPO审核|再融资/] },
  { industry: '电力设备', patterns: [/光伏|锂电|储能|新能源车电池|风电|逆变器|硅料/] },
  { industry: '汽车', patterns: [/新能源车|智能驾驶|车企|汽车销量|乘用车/] },
  { industry: '电子', patterns: [/半导体|芯片|光刻|存储芯片|消费电子|PCB/] },
  { industry: '计算机', patterns: [/人工智能|大模型|算力|信创|软件国产化|数据要素/] },
  { industry: '通信', patterns: [/5G|6G|光模块|运营商资本开支|卫星互联网/] },
  { industry: '医药生物', patterns: [/集采|医保谈判|创新药|医疗器械|CXO|生物医药|减肥药|脑机接口/] },
  { industry: '食品饮料', patterns: [/白酒|啤酒|软饮料|乳制品|餐饮消费/] },
  { industry: '有色金属', patterns: [/铜价|铝价|锂价|黄金价格|稀土|工业金属/] },
  { industry: '石油石化', patterns: [/原油|成品油|天然气价格|炼化/] },
  { industry: '煤炭', patterns: [/动力煤|焦煤|煤价|煤矿/] },
  { industry: '国防军工', patterns: [/军工|航空发动机|导弹|舰船|国防预算|商业航天|低空经济/] },
  { industry: '机械设备', patterns: [/机器人|人形机器人|减速器|伺服|工业母机|工程机械/] },
  { industry: '传媒', patterns: [/游戏版号|网络游戏|影视|短剧|文化传媒|AIGC/] },
  { industry: '社会服务', patterns: [/旅游|酒店|景区|免税|教育服务/] },
  { industry: '美容护理', patterns: [/医美|化妆品|美容护理/] },
]

export function inferIndustriesFromThemes(text: string): string[] {
  const hay = text.replace(/\s+/g, '')
  const found: string[] = []
  for (const rule of THEME_INDUSTRY_RULES) {
    if (rule.patterns.some((re) => re.test(hay)) && !found.includes(rule.industry)) {
      found.push(rule.industry)
    }
  }
  return found
}

export function mapEventTargets(
  text: string,
  stocks: EventStockRef[],
): { codes: string[]; names: string[]; industries: string[] } {
  const hay = text.replace(/\s+/g, '')
  const byCode = new Map(stocks.map((s) => [s.code.toLowerCase(), s]))
  const byDigits = new Map<string, EventStockRef>()
  for (const s of stocks) {
    const d = digitsOf(s.code)
    if (d && !byDigits.has(d)) byDigits.set(d, s)
  }

  const hits = new Map<string, EventStockRef>()
  const named = [...stocks].sort((a, b) => b.name.length - a.name.length)
  for (const s of named) {
    const name = s.name.trim()
    if (name.length < 2) continue
    if (hay.includes(name)) hits.set(s.code.toLowerCase(), s)
    if (hits.size >= MAX_CODES) break
  }

  for (const m of hay.matchAll(/(?:sh|sz|bj)?(\d{6})(?:\.s[hz])?/gi)) {
    const stock = byDigits.get(m[1]) ?? byCode.get(m[0].toLowerCase())
    if (stock) hits.set(stock.code.toLowerCase(), stock)
    if (hits.size >= MAX_CODES) break
  }

  const industries = [...SW1_INDUSTRIES]
    .sort((a, b) => b.length - a.length)
    .filter((ind) => hay.includes(ind))

  for (const industry of inferIndustriesFromThemes(hay)) {
    if (!industries.includes(industry)) industries.push(industry)
  }
  const limitedIndustries = industries.slice(0, 6)

  const selected = [...hits.values()].slice(0, MAX_CODES)
  for (const s of selected) {
    if (s.industry && SW1_INDUSTRIES.includes(s.industry) && !limitedIndustries.includes(s.industry)) {
      limitedIndustries.push(s.industry)
    }
  }

  return {
    codes: selected.map((s) => s.code),
    names: selected.map((s) => s.name),
    industries: limitedIndustries.slice(0, 8),
  }
}

export function newsItemToEvent(
  item: NewsItem,
  extras: { provider: string; query: string; stocks: EventStockRef[]; capturedAt?: number },
): MarketEvent | null {
  if (isJunkNewsTitle(item.title) || !item.url?.trim()) return null
  const capturedAt = extras.capturedAt ?? Date.now()
  const text = `${item.title} ${item.snippet}`
  const kind = classifyEventKind(text)
  const mapped = mapEventTargets(text, extras.stocks)
  return {
    id: eventIdFromUrl(item.url),
    title: item.title.trim(),
    url: item.url,
    snippet: item.snippet.trim(),
    source: item.source,
    provider: extras.provider,
    query: extras.query,
    publishedAt: parsePublishedAt(item.date, capturedAt),
    capturedAt,
    kind,
    strength: KIND_STRENGTH[kind],
    codes: mapped.codes,
    names: mapped.names,
    industries: mapped.industries,
  }
}

export function matchOpinionsToEvent(
  event: MarketEvent,
  documents: OpinionDocument[],
  now = Date.now(),
): EventOpinionLink[] {
  if (event.codes.length === 0 && event.industries.length === 0) return []
  const codeSet = new Set(event.codes.map((c) => c.toLowerCase()))
  const industrySet = new Set(event.industries)
  const from = event.publishedAt - DAY_MS
  const to = Math.max(event.publishedAt + 7 * DAY_MS, now + DAY_MS)
  const links: EventOpinionLink[] = []

  for (const doc of documents) {
    if (doc.publishedAt < from || doc.publishedAt > to) continue
    for (const claim of doc.claims) {
      const codeHit = claim.code ? codeSet.has(claim.code.toLowerCase()) : false
      const industryHit = claim.industry ? industrySet.has(claim.industry) : false
      if (!codeHit && !industryHit) continue
      links.push({
        documentId: doc.id,
        authorName: doc.authorName,
        platform: doc.platform,
        title: doc.title,
        publishedAt: doc.publishedAt,
        url: doc.url,
        stance: claim.stance,
        confidence: claim.confidence,
        thesis: claim.thesis,
        code: claim.code,
        name: claim.name,
        industry: claim.industry,
      })
    }
  }

  links.sort((a, b) => b.publishedAt - a.publishedAt || b.confidence - a.confidence)
  return links.slice(0, 20)
}

function emptyStore(): EventStore {
  return { version: 1, updatedAt: 0, events: [] }
}

function loadStore(): EventStore {
  const raw = readJson<EventStore>(STORE_FILE)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.events)) return emptyStore()
  return raw
}

function saveStore(store: EventStore): void {
  writeJson(STORE_FILE, store)
}

export function upsertEvents(incoming: MarketEvent[], meta?: { provider?: string; collectedAt?: number }): MarketEvent[] {
  const store = loadStore()
  const byId = new Map(store.events.map((e) => [e.id, e]))
  for (const event of incoming) {
    const prev = byId.get(event.id)
    if (!prev) {
      byId.set(event.id, event)
      continue
    }
    byId.set(event.id, {
      ...prev,
      ...event,
      codes: event.codes.length ? event.codes : prev.codes,
      names: event.names.length ? event.names : prev.names,
      industries: event.industries.length ? event.industries : prev.industries,
      capturedAt: prev.capturedAt,
    })
  }
  const events = [...byId.values()]
    .sort((a, b) => b.publishedAt - a.publishedAt || b.strength - a.strength)
    .slice(0, MAX_EVENTS)
  saveStore({
    version: 1,
    updatedAt: Date.now(),
    lastCollectAt: meta?.collectedAt ?? store.lastCollectAt,
    lastProvider: meta?.provider ?? store.lastProvider,
    events,
  })
  return events
}

export function listMarketEvents(filters: {
  days?: number
  kind?: MarketEventKind
  industry?: string
  code?: string
  /** 为 true 且同时给了 code/industry 时：代码命中或行业命中均可（工作台证据） */
  related?: boolean
  q?: string
  limit?: number
} = {}): { events: MarketEventCard[]; lastCollectAt?: number; lastProvider?: string; total: number } {
  const store = loadStore()
  const days = Math.max(1, Math.min(60, filters.days ?? 7))
  const since = Date.now() - days * DAY_MS
  const q = filters.q?.trim().toLowerCase()
  const code = filters.code?.trim().toLowerCase()
  const industry = filters.industry?.trim()
  const documents = listOpinionDocuments({ limit: 500 })
  const events = store.events
    .filter((e) => e.publishedAt >= since)
    .filter((e) => !filters.kind || e.kind === filters.kind)
    .filter((e) => {
      if (filters.related && (code || industry)) {
        const codeHit = code ? e.codes.some((c) => c.toLowerCase() === code) : false
        const industryHit = industry ? e.industries.includes(industry) : false
        return codeHit || industryHit
      }
      if (industry && !e.industries.includes(industry)) return false
      if (code && !e.codes.some((c) => c.toLowerCase() === code)) return false
      return true
    })
    .filter((e) => !q || `${e.title} ${e.snippet} ${e.names.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (filters.related && code) {
        const aHit = a.codes.some((c) => c.toLowerCase() === code) ? 1 : 0
        const bHit = b.codes.some((c) => c.toLowerCase() === code) ? 1 : 0
        if (bHit !== aHit) return bHit - aHit
      }
      return b.publishedAt - a.publishedAt || b.strength - a.strength
    })
    .slice(0, Math.max(1, Math.min(200, filters.limit ?? 80)))
    .map((e) => ({ ...e, opinionCount: matchOpinionsToEvent(e, documents).length }))
  return {
    events,
    lastCollectAt: store.lastCollectAt,
    lastProvider: store.lastProvider,
    total: events.length,
  }
}

export function getMarketEvent(id: string): MarketEventDetail | null {
  const event = loadStore().events.find((e) => e.id === id)
  if (!event) return null
  return {
    ...event,
    opinions: matchOpinionsToEvent(event, listOpinionDocuments({ limit: 500 })),
  }
}

export function getRecentEventUniverse(days = 7): EventUniverse {
  const since = Date.now() - Math.max(1, Math.min(60, days)) * DAY_MS
  const codes = new Set<string>()
  const industries = new Set<string>()
  for (const event of loadStore().events) {
    if (event.publishedAt < since) continue
    for (const code of event.codes) codes.add(code.toLowerCase())
    for (const industry of event.industries) industries.add(industry)
  }
  return { codes, industries }
}

export function stockHitsEventUniverse(stock: { code: string; industry?: string }, universe: EventUniverse): boolean {
  if (universe.codes.has(stock.code.toLowerCase())) return true
  return !!stock.industry && universe.industries.has(stock.industry)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickCollectQueries(stocks: EventStockRef[], watchlist: string[], maxQueries: number): string[] {
  const queries = [...MARKET_QUERIES]
  const byAmount = [...stocks].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
  const industries: string[] = []
  for (const s of byAmount) {
    if (s.industry && SW1_INDUSTRIES.includes(s.industry) && !industries.includes(s.industry)) {
      industries.push(s.industry)
    }
    if (industries.length >= 4) break
  }
  for (const industry of industries) queries.push(`A股 ${industry} 最新 新闻 公告`)

  const watchSet = new Set(watchlist.map((c) => c.toLowerCase()))
  const watchStocks = stocks.filter((s) => watchSet.has(s.code.toLowerCase())).slice(0, 6)
  for (const s of watchStocks) queries.push(`${s.name} ${s.code.toUpperCase()} 股票 最新消息 公告`)

  const movers = [...stocks]
    .filter((s) => typeof s.changePct === 'number' && Math.abs(s.changePct) >= 5)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
    .slice(0, 4)
  for (const s of movers) {
    const q = `${s.name} ${s.code.toUpperCase()} 股票 最新消息 公告`
    if (!queries.includes(q)) queries.push(q)
  }

  return queries.slice(0, maxQueries)
}

export async function collectMarketEvents(options: {
  stocks?: EventStockRef[] | SnapshotStock[]
  watchlist?: string[]
  maxQueries?: number
} = {}): Promise<{
  created: number
  total: number
  queries: number
  provider: string
  message?: string
}> {
  const canNews = hasNewsProvider()
  const canJin10 = hasJin10()
  if (!canNews && !canJin10) {
    return {
      created: 0,
      total: loadStore().events.length,
      queries: 0,
      provider: 'none',
      message: '未配置新闻搜索 Key 或金十 MCP Token，无法采集一级资讯',
    }
  }

  const stocks = (options.stocks?.length ? options.stocks : FALLBACK_STOCKS) as EventStockRef[]
  const queries = canNews ? pickCollectQueries(stocks, options.watchlist ?? [], options.maxQueries ?? 14) : []
  const before = new Set(loadStore().events.map((e) => e.id))
  const incoming: MarketEvent[] = []
  const providers: string[] = []

  if (canJin10) {
    try {
      const flashes = await fetchJin10AShareFlashes()
      if (flashes.length) providers.push('jin10')
      for (const item of flashes) {
        const event = newsItemToEvent(item, { provider: 'jin10', query: 'jin10-flash', stocks })
        if (event) incoming.push(event)
      }
    } catch (e) {
      console.warn('[market-events] 金十快讯采集失败: ', e)
    }
    try {
      const articles = await fetchJin10AShareNews()
      if (articles.length) providers.push('jin10')
      for (const item of articles) {
        const event = newsItemToEvent(item, { provider: 'jin10', query: 'jin10-news', stocks })
        if (event) incoming.push(event)
      }
    } catch (e) {
      console.warn('[market-events] 金十资讯采集失败: ', e)
    }
  }

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]
    const result = await searchNews(query, 6)
    if (result.provider !== 'none') providers.push(result.provider)
    for (const item of result.items) {
      const event = newsItemToEvent(item, { provider: result.provider, query, stocks })
      if (event) incoming.push(event)
    }
    if (i < queries.length - 1) await sleep(200)
  }

  const provider = [...new Set(providers)].join('+') || 'none'
  const events = upsertEvents(incoming, { provider, collectedAt: Date.now() })
  const created = incoming.filter((e) => !before.has(e.id)).length
  return {
    created,
    total: events.length,
    queries: queries.length + (canJin10 ? 2 : 0),
    provider,
    message: incoming.length === 0 ? '本次未检索到新资讯，可稍后重试' : undefined,
  }
}

/** 交易时段轻量定时采集（金十 + 可选新闻），不跑 LLM */
export class MarketEventCollectScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRunAt = 0
  private running = false
  private readonly intervalMs: number

  constructor(intervalMinutes = 20) {
    this.intervalMs = Math.max(5, intervalMinutes) * 60_000
  }

  start(getContext: () => { stocks: EventStockRef[]; watchlist?: string[] }) {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(getContext), 60_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private inWindow(): boolean {
    // 金十/一级资讯是 7x24 持续更新的信息源，不限制交易日或交易时段。
    return true
  }

  async tick(getContext: () => { stocks: EventStockRef[]; watchlist?: string[] }) {
    if (this.running || !this.inWindow()) return
    if (Date.now() - this.lastRunAt < this.intervalMs) return
    if (!hasJin10() && !hasNewsProvider()) return
    this.running = true
    this.lastRunAt = Date.now()
    try {
      const ctx = getContext()
      const result = await collectMarketEvents({
        stocks: ctx.stocks,
        watchlist: ctx.watchlist ?? [],
        maxQueries: hasNewsProvider() ? 6 : 0,
      })
      console.log(
        `[market-events] 定时采集 +${result.created}（共 ${result.total}）· ${result.provider}`,
      )
    } catch (e) {
      console.warn('[market-events] 定时采集失败: ', e)
    } finally {
      this.running = false
    }
  }
}
