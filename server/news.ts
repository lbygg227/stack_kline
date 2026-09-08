/**
 * 舆情/新闻搜索客户端（服务端）。
 * 首选 Anspire Search（与 AI 点评共用 ANSPIRE_API_KEYS）；
 * 也兼容 Tavily / Brave / SerpAPI（配置后自动降级）。
 * Key 仅保存在服务端 .env（已 gitignore），不进入前端。
 */

import { API_KEYS } from './anspire.ts'

try {
  // Node 22 支持 loadEnvFile；Vite 只把 .env 注入 import.meta.env，不注入 process.env
  process.loadEnvFile('.env')
} catch {
  /* 没有 .env 时使用进程已有环境变量 */
}

export interface NewsItem {
  title: string
  url: string
  snippet: string
  date?: string
  source?: string
}

export interface NewsSearchResult {
  provider: string
  items: NewsItem[]
}

const firstKey = (name: string): string => {
  const keys = (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return keys[0] ?? ''
}

const queryFor = (name: string, code: string): string =>
  `${name} ${code.toUpperCase()} 股票 最新消息 公告 研报 舆情`

const fmtDateTime = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function searchAnspire(query: string, key: string, topK = 6): Promise<NewsItem[]> {
  const url = new URL('https://plugin.anspire.cn/api/ntsearch/search')
  const now = new Date()
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  url.searchParams.set('query', query)
  url.searchParams.set('top_k', String(topK))
  url.searchParams.set('FromTime', fmtDateTime(from))
  url.searchParams.set('ToTime', fmtDateTime(now))
  url.searchParams.set('region_mode', '2')
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
    },
  })
  if (!res.ok) throw new Error(`anspire http ${res.status}`)
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; date?: string }>
  }
  return (json.results ?? []).slice(0, topK).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 220),
    date: r.date,
  })).filter((r) => r.title && r.url)
}

async function searchTavily(query: string, key: string, topK = 6): Promise<NewsItem[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      api_key: key,
      query,
      topic: 'news',
      max_results: topK,
      days: 7,
      include_raw_content: false,
    }),
  })
  if (!res.ok) throw new Error(`tavily http ${res.status}`)
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>
  }
  return (json.results ?? []).slice(0, topK).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 220),
    date: r.published_date,
  })).filter((r) => r.title && r.url)
}

async function searchBrave(query: string, key: string, topK = 6): Promise<NewsItem[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(topK))
  url.searchParams.set('search_lang', 'zh')
  url.searchParams.set('freshness', 'pm')
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': key,
    },
  })
  if (!res.ok) throw new Error(`brave http ${res.status}`)
  const json = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }> }
  }
  return (json.web?.results ?? []).slice(0, topK).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.description ?? '').slice(0, 220),
    date: r.page_age,
  })).filter((r) => r.title && r.url)
}

async function searchSerpapi(query: string, key: string, topK = 6): Promise<NewsItem[]> {
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google_news')
  url.searchParams.set('q', query)
  url.searchParams.set('api_key', key)
  url.searchParams.set('num', String(topK))
  url.searchParams.set('hl', 'zh-cn')
  url.searchParams.set('gl', 'cn')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`serpapi http ${res.status}`)
  const json = (await res.json()) as {
    news_results?: Array<{ title?: string; link?: string; snippet?: string; date?: string; source?: { name?: string } }>
  }
  return (json.news_results ?? []).slice(0, topK).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: (r.snippet ?? '').slice(0, 220),
    date: r.date,
    source: r.source?.name,
  })).filter((r) => r.title && r.url)
}

type NewsProvider = {
  name: string
  key: string
  run: (q: string, k: string, topK: number) => Promise<NewsItem[]>
}

function newsProviders(): NewsProvider[] {
  return [
    { name: 'anspire', key: API_KEYS[0] ?? '', run: searchAnspire },
    { name: 'tavily', key: firstKey('TAVILY_API_KEYS'), run: searchTavily },
    { name: 'brave', key: firstKey('BRAVE_API_KEYS'), run: searchBrave },
    { name: 'serpapi', key: firstKey('SERPAPI_API_KEYS'), run: searchSerpapi },
  ]
}

export function hasNewsProvider(): boolean {
  return newsProviders().some((p) => !!p.key)
}

export async function searchNews(query: string, topK = 6): Promise<NewsSearchResult> {
  const q = query.trim()
  if (!q) return { provider: 'none', items: [] }
  for (const p of newsProviders()) {
    if (!p.key) continue
    try {
      const items = await p.run(q, p.key, topK)
      if (items.length > 0) return { provider: p.name, items }
    } catch (e) {
      console.warn(`[news] ${p.name} 搜索失败: `, e)
    }
  }
  return { provider: 'none', items: [] }
}

export async function searchStockNews(name: string, code: string): Promise<NewsSearchResult> {
  return searchNews(queryFor(name, code), 6)
}
