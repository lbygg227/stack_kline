/**
 * Anspire 客户端（OpenAI 兼容接口）。
 * Anspire 同时支持 LLM 与联网搜索；这里用于股票分析的自然语言点评。
 * Key 读取：环境变量 ANSPIRE_API_KEYS（多个用逗号分隔，取第一个），
 * 未设置时回退到内置默认值（用户自己的 key）。
 *
 * 注意：Anspire 网关对 Node.js 的 TLS 指纹有风控（Node fetch/https 会 403），
 * 而 curl 直连稳定可用，因此这里用 curl 子进程调用。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

try {
  process.loadEnvFile('.env')
} catch {
  /* 没有 .env 时使用进程已有环境变量 */
}

const execFileAsync = promisify(execFile)

const DEFAULT_BASE_URL = 'https://open-gateway.anspire.cn/v6'
const DEFAULT_MODEL = 'deepseek-v4-pro'

export const API_KEYS = (process.env.ANSPIRE_API_KEYS ?? 'sk-eCVLTPkcWNji3lM15wv3CAp5oGo3h9gu').split(',').map((s) => s.trim()).filter(Boolean)
const BASE_URL = (process.env.ANSPIRE_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
const MODEL = process.env.ANSPIRE_LLM_MODEL ?? DEFAULT_MODEL

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AnspireChatOptions {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  json?: boolean
}

export async function anspireChat(opts: AnspireChatOptions): Promise<string> {
  if (API_KEYS.length === 0) throw new Error('未配置 ANSPIRE_API_KEYS')
  const url = `${BASE_URL}/chat/completions`
  const body = JSON.stringify({
    model: MODEL,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 600,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  })

  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { stdout } = await execFileAsync(
        'curl',
        ['-sS', '--max-time', '30', '-X', 'POST', url, '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${API_KEYS[0]}`, '-d', body],
        { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
      )
      const json = JSON.parse(stdout) as { choices?: Array<{ message?: { content?: string } }>; code?: string; detail?: string }
      if (json.code) throw new Error(json.detail || json.code)
      const content = json.choices?.[0]?.message?.content ?? ''
      if (!content.trim()) throw new Error('anspire empty content')
      return content
    } catch (e) {
      lastErr = e
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 用 Anspire 对规则分析结果生成自然语言点评。
 * 失败时抛错，由调用方回退到规则版文案。
 */
export async function generateAiCommentary(analysis: {
  code: string
  name: string
  price: number
  score: number
  signalLabel: string
  trend: { status: string; alignment: string; ma5: number; ma10: number; ma20: number }
  macd: { status: string; signal: string }
  rsi: { rsi12: number; status: string }
  volume: { status: string; meaning: string }
  levels: { support: number[]; resistance: number[]; stopLoss: number; target: number }
  reasons: string[]
  risks: string[]
}): Promise<{ oneSentence: string; commentary: string; confidence: string; model?: string }> {
  const system = `你是 A 股技术分析助手，根据给定的结构化指标数据生成简洁、口语化的个股点评。不要编造数据，不要给出收益承诺。`
  const user = `请根据以下技术分析数据，输出 JSON（不要输出其他文字）：
{
  "oneSentence": "一句话结论（40字内）",
  "commentary": "3-5 条要点，每条一行，包含趋势、量能、风险、操作建议",
  "confidence": "高|中|低"
}

技术分析数据：
${JSON.stringify(analysis)}`

  const content = await anspireChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    maxTokens: 600,
    json: true,
  })
  const parsed = JSON.parse(content) as { oneSentence?: string; commentary?: string; confidence?: string }
  return {
    oneSentence: parsed.oneSentence ?? '',
    commentary: parsed.commentary ?? '',
    confidence: parsed.confidence ?? '中',
    model: MODEL,
  }
}

export interface AnspireStockBrief {
  oneSentence: string
  commentary: string
  confidence: string
  risk: string
  model?: string
}

/** 结合技术分析 + 命中策略 + 舆情新闻，生成更完整的个股简报 */
export async function generateAiStockBrief(input: {
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
}): Promise<AnspireStockBrief> {
  const system = `你是 A 股个股分析助手。根据技术指标、策略命中和最新舆情，输出简洁、可执行的简报。
不要编造数据，不要承诺收益，风险提示必须具体。`
  const user = `请分析下面这只股票，输出 JSON（不要输出其他文字）：
{
  "oneSentence": "一句话结论（40字内）",
  "commentary": "3-5 条要点，每条一行，覆盖趋势、量能、舆情、操作观察",
  "confidence": "高|中|低",
  "risk": "主要风险提示（60字内）"
}

股票与技术面：
${JSON.stringify(input)}

请结合上面的技术分析、命中策略和新闻标题/摘要，给出结论。`

  const content = await anspireChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    maxTokens: 700,
    json: true,
  })
  const parsed = JSON.parse(content) as { oneSentence?: string; commentary?: string | string[]; confidence?: string; risk?: string }
  return {
    oneSentence: parsed.oneSentence ?? '',
    commentary: Array.isArray(parsed.commentary) ? parsed.commentary.join('\n') : (parsed.commentary ?? ''),
    confidence: parsed.confidence ?? '中',
    risk: parsed.risk ?? '',
    model: MODEL,
  }
}
