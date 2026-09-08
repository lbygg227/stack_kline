/**
 * DeepSeek 大模型调用（AI 选股：自然语言 -> 结构化选股条件）。
 * 仅存于服务端；key 可用环境变量 DEEPSEEK_API_KEY 覆盖。
 */

import type { StrategyConditions } from './strategy.ts'
import { SCREENING_STRATEGIES } from './screening-strategies.ts'

try {
  process.loadEnvFile('.env')
} catch {
  /* 没有 .env 时使用进程已有环境变量 */
}

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || 'sk-34b23596183e4c7bb2b6429894043ddf'
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

const SW1_LIST = [
  '机械设备', '医药生物', '基础化工', '电子', '电力设备', '建筑装饰', '汽车', '计算机', '传媒',
  '交通运输', '有色金属', '房地产', '轻工制造', '公用事业', '食品饮料', '纺织服饰', '通信', '国防军工',
  '环保', '商贸零售', '农林牧渔', '非银金融', '家用电器', '建筑材料', '社会服务', '石油石化', '钢铁',
  '银行', '煤炭', '综合', '美容护理',
].join('、')

const STRATEGY_PROMPT = SCREENING_STRATEGIES
  .map((strategy) => `- ${strategy.key}（${strategy.name}）：${strategy.description}`)
  .join('\n')

const SYSTEM_PROMPT = `你是 A 股选股助手，把用户的自然语言选股需求解析成结构化条件，输出 JSON。

可选行业（申万一级，必须严格匹配其一）：${SW1_LIST}

可选技术指标：
- none（不限） / ma5_10_cross_up（MA5上穿MA10金叉）/ ma5_10_cross_down（MA5下穿MA10死叉）
- above_ma20（站上20日线）/ below_ma20（跌破20日线）
- macd_golden（MACD金叉）/ macd_dead（MACD死叉）
- kdj_golden（KDJ金叉）/ kdj_dead（KDJ死叉）
- rsi_oversold（RSI超卖）/ rsi_overbought（RSI超买）/ boll_break_up（突破布林上轨）

可选策略模板（可多选，取交集；只填写下面 key）：
${STRATEGY_PROMPT}

输出 JSON（缺省字段用 null）：
{
  "industry": "医药生物" 或 null,
  "minChangePct": null, "maxChangePct": null,
  "minTurnover": null, "minVolumeRatio": null,
  "minPe": null, "maxPe": null,
  "minPb": null, "maxPb": null,
  "minMktcap": null, "maxMktcap": null,
  "minAmount": null,
  "minPrice": null, "maxPrice": null,
  "indicator": "macd_golden" 或 "none",
  "strategies": [] 或 null,
  "pool": "all" 或 "watchlist",
  "requireRecentEvent": true 或 null,
  "eventLookbackDays": 7 或 null,
  "explanation": "一句话说明解析出的选股条件"
}

规则：
1. 行业必须严格匹配上面 31 个行业之一；"医药/医药股"→医药生物，"白酒/消费"→食品饮料，"券商/保险"→非银金融，"新能源/光伏/锂电"→电力设备，"半导体/芯片"→电子，"AI/软件"→计算机。
2. 市值(mktcap)、成交额(amount) 单位是亿元；市盈率(pe)、涨跌幅(changePct)、换手率(turnover)、量比(volumeRatio) 是数值/百分比。
3. 用户说"金叉"默认 MACD 金叉；"站上20日线"→above_ma20；"突破"且提布林→boll_break_up。
4. 用户明确说"自选股里"才用 pool=watchlist，否则 all。
5. 只有用户明确提到某个策略名称时，才把对应 key 放入 strategies 数组；例如"双低策略"→["dual_low"]，"资金热度"→["capital_heat"]，"缠论/底背驰"→["chan_theory"]；没提就填 null。
6. 用户说“有公告/有新闻/有资讯事件/近N日有事件”时，requireRecentEvent=true，eventLookbackDays 取用户说的天数，没说就 7；没提就都填 null。
7. 未提及的条件一律 null。只输出 JSON 本身，不要任何解释文字。`

interface AiParsed extends Partial<StrategyConditions> {
  explanation?: string
}

export async function parseNaturalLanguage(text: string): Promise<{ conds: StrategyConditions; explanation: string }> {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 1000,
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`deepseek http ${res.status}: ${err.slice(0, 200)}`)
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as AiParsed
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return typeof v === 'number' && isFinite(n) ? n : undefined
  }
  return {
    conds: {
      industry: typeof parsed.industry === 'string' ? parsed.industry : undefined,
      minChangePct: num(parsed.minChangePct),
      maxChangePct: num(parsed.maxChangePct),
      minTurnover: num(parsed.minTurnover),
      minVolumeRatio: num(parsed.minVolumeRatio),
      minPe: num(parsed.minPe),
      maxPe: num(parsed.maxPe),
      minPb: num(parsed.minPb),
      maxPb: num(parsed.maxPb),
      minMktcap: num(parsed.minMktcap),
      maxMktcap: num(parsed.maxMktcap),
      minAmount: num(parsed.minAmount),
      minPrice: num(parsed.minPrice),
      maxPrice: num(parsed.maxPrice),
      indicator: (parsed.indicator as StrategyConditions['indicator']) ?? 'none',
      strategies: Array.isArray(parsed.strategies)
        ? parsed.strategies.filter((s): s is string => typeof s === 'string' && SCREENING_STRATEGIES.some((d) => d.key === s))
        : undefined,
      pool: parsed.pool === 'watchlist' ? 'watchlist' : 'all',
      watchlist: [],
      requireRecentEvent: parsed.requireRecentEvent === true ? true : undefined,
      eventLookbackDays: num(parsed.eventLookbackDays),
    },
    explanation: parsed.explanation ?? '',
  }
}

export interface DeepSeekStockBriefInput {
  code: string
  name: string
  price: number
  score: number
  signalLabel: string
  trendStatus: string
  macdStatus: string
  rsiStatus: string
  volumeStatus: string
  support: number[]
  resistance: number[]
  strategyNames: string[]
  news: Array<{ title: string; snippet: string; date?: string }>
}

export interface StockBriefResult {
  oneSentence: string
  commentary: string
  confidence: string
  risk: string
}

/** 用 DeepSeek 生成个股简报（技术指标 + 策略命中 + 新闻，缺新闻时不编造） */
export async function generateStockBrief(input: DeepSeekStockBriefInput): Promise<StockBriefResult> {
  const system = `你是 A 股个股分析助手。根据给定的技术指标、策略命中和舆情线索，输出简洁可执行的简报。
不要编造新闻，不要承诺收益；如果新闻列表为空，只基于技术面与策略命中给出结论。`
  const user = `请分析下面这只股票，输出 JSON（不要输出其他文字）：
{
  "oneSentence": "一句话结论（40字内）",
  "commentary": "3-5 条要点，每条一行，覆盖趋势、量能、舆情、操作观察",
  "confidence": "高|中|低",
  "risk": "主要风险提示（60字内）"
}

输入数据：
${JSON.stringify(input)}`

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 800,
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`deepseek http ${res.status}: ${err.slice(0, 200)}`)
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as { oneSentence?: string; commentary?: string | string[]; confidence?: string; risk?: string }
  return {
    oneSentence: parsed.oneSentence ?? '',
    commentary: Array.isArray(parsed.commentary) ? parsed.commentary.join('\n') : (parsed.commentary ?? ''),
    confidence: parsed.confidence ?? '中',
    risk: parsed.risk ?? '',
  }
}

export interface RawOpinionClaim {
  code?: string
  name?: string
  industry?: string
  stance?: 'bullish' | 'bearish' | 'neutral'
  horizonDays?: number
  thesis?: string
  catalysts?: string[]
  risks?: string[]
  invalidation?: string
  confidence?: number
  evidenceQuote?: string
}

export async function extractOpinionDocument(input: {
  title: string
  content: string
  authorName: string
  publishedAt: number
}): Promise<{ summary: string; claims: RawOpinionClaim[]; model: string }> {
  const system = `你是财经观点信息抽取器。只根据输入原文提取作者明确表达的观点，不补充外部知识。
必须保留能在原文中逐字找到的短引用作为 evidenceQuote。没有明确标的或方向时可以返回空 claims。`
  const user = `请输出 JSON：
{
  "summary": "100字内客观摘要",
  "claims": [{
    "code": "A股代码，可未知",
    "name": "公司或行业名称",
    "industry": "行业，可未知",
    "stance": "bullish|bearish|neutral",
    "horizonDays": 20,
    "thesis": "观点核心逻辑",
    "catalysts": ["催化因素"],
    "risks": ["作者提到的风险"],
    "invalidation": "观点失效条件",
    "confidence": 0.0,
    "evidenceQuote": "原文逐字引用，最多100字"
  }]
}

作者：${input.authorName}
发布时间：${new Date(input.publishedAt).toISOString()}
标题：${input.title}
原文：
${input.content.slice(0, 18_000)}`
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 1800,
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`deepseek opinion http ${res.status}: ${err.slice(0, 200)}`)
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? '{}') as {
    summary?: string
    claims?: RawOpinionClaim[]
  }
  return {
    summary: parsed.summary?.trim() ?? '',
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    model: 'deepseek-chat',
  }
}
