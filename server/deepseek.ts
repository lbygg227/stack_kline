/**
 * DeepSeek 大模型调用（AI 选股：自然语言 -> 结构化选股条件）。
 * 仅存于服务端；key 可用环境变量 DEEPSEEK_API_KEY 覆盖。
 */

import type { StrategyConditions } from './strategy.ts'

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || 'sk-34b23596183e4c7bb2b6429894043ddf'
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

const SW1_LIST = [
  '机械设备', '医药生物', '基础化工', '电子', '电力设备', '建筑装饰', '汽车', '计算机', '传媒',
  '交通运输', '有色金属', '房地产', '轻工制造', '公用事业', '食品饮料', '纺织服饰', '通信', '国防军工',
  '环保', '商贸零售', '农林牧渔', '非银金融', '家用电器', '建筑材料', '社会服务', '石油石化', '钢铁',
  '银行', '煤炭', '综合', '美容护理',
].join('、')

const SYSTEM_PROMPT = `你是 A 股选股助手，把用户的自然语言选股需求解析成结构化条件，输出 JSON。

可选行业（申万一级，必须严格匹配其一）：${SW1_LIST}

可选技术指标：
- none（不限） / ma5_10_cross_up（MA5上穿MA10金叉）/ ma5_10_cross_down（MA5下穿MA10死叉）
- above_ma20（站上20日线）/ below_ma20（跌破20日线）
- macd_golden（MACD金叉）/ macd_dead（MACD死叉）
- kdj_golden（KDJ金叉）/ kdj_dead（KDJ死叉）
- rsi_oversold（RSI超卖）/ rsi_overbought（RSI超买）/ boll_break_up（突破布林上轨）

输出 JSON（缺省字段用 null）：
{
  "industry": "医药生物" 或 null,
  "minChangePct": null, "maxChangePct": null,
  "minTurnover": null, "minVolumeRatio": null,
  "minPe": null, "maxPe": null,
  "minMktcap": null, "maxMktcap": null,
  "minAmount": null,
  "minPrice": null, "maxPrice": null,
  "indicator": "macd_golden" 或 "none",
  "pool": "all" 或 "watchlist",
  "explanation": "一句话说明解析出的选股条件"
}

规则：
1. 行业必须严格匹配上面 31 个行业之一；"医药/医药股"→医药生物，"白酒/消费"→食品饮料，"券商/保险"→非银金融，"新能源/光伏/锂电"→电力设备，"半导体/芯片"→电子，"AI/软件"→计算机。
2. 市值(mktcap)、成交额(amount) 单位是亿元；市盈率(pe)、涨跌幅(changePct)、换手率(turnover)、量比(volumeRatio) 是数值/百分比。
3. 用户说"金叉"默认 MACD 金叉；"站上20日线"→above_ma20；"突破"且提布林→boll_break_up。
4. 用户明确说"自选股里"才用 pool=watchlist，否则 all。
5. 未提及的条件一律 null。只输出 JSON 本身，不要任何解释文字。`

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
      minMktcap: num(parsed.minMktcap),
      maxMktcap: num(parsed.maxMktcap),
      minAmount: num(parsed.minAmount),
      minPrice: num(parsed.minPrice),
      maxPrice: num(parsed.maxPrice),
      indicator: (parsed.indicator as StrategyConditions['indicator']) ?? 'none',
      pool: parsed.pool === 'watchlist' ? 'watchlist' : 'all',
      watchlist: [],
    },
    explanation: parsed.explanation ?? '',
  }
}
