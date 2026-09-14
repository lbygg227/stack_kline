/**
 * 每日复盘摘要：把当天的推荐、观察名单、结算结果、归因结论和权重状态压成一页。
 *
 * - 结构化 sections 供前端展示，text 供推送（Server酱/钉钉/飞书/企业微信/通用 webhook）
 * - 落盘 data/daily-digest.json（最新）+ data/digest-history.json（历史）
 * - 不配置推送渠道时只本地保存，不会静默失败
 */

import type { KLineBar } from './tencent.ts'
import { readJson, writeJson } from './store.ts'
import { buildRecommendationAttribution } from './recommendation-attribution.ts'
import { buildTodayRecommendations, type RecommendationListResponse } from './recommendations.ts'
import { getConfidenceScale, getRecommendationWeightState, getTargetFactor } from './recommendation-weights.ts'
import { getReasonGuard } from './recommendation-guard.ts'
import type { SnapshotStock } from './eastmoney.ts'

const LATEST_FILE = 'daily-digest.json'
const HISTORY_FILE = 'digest-history.json'
const MAX_HISTORY = 60

export interface DigestSection {
  title: string
  lines: string[]
}

export interface DigestPushResult {
  pushed: boolean
  channel?: string
  error?: string
}

export interface DailyDigest {
  date: string
  generatedAt: number
  sections: DigestSection[]
  text: string
  stats: {
    recommendCount: number
    observeCount: number
    settledToday: number
    matured: number
    winRate: number
    averageReturnPct: number
    averageExcessPct: number
  }
  push: DigestPushResult
}

const fmtPct = (value: number): string => (value >= 0 ? '+' : '') + value.toFixed(2) + '%'

/**
 * 交易日口径与推荐记录保持一致：用 UTC 日期。
 * A 股收盘后到次日开盘前，UTC 日期仍等于最近一个交易日，不会提前滚到第二天。
 */
function todayString(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** 推送渠道：按环境变量自动选择 */
function resolveChannel(): { channel: string; url: string; body: (title: string, text: string) => unknown } | null {
  const generic = process.env.DAILY_DIGEST_WEBHOOK
  if (generic) {
    return { channel: 'webhook', url: generic, body: (title, text) => ({ title, text }) }
  }
  const serverChan = process.env.SERVERCHAN_KEY
  if (serverChan) {
    return {
      channel: 'serverchan',
      url: 'https://sctapi.ftqq.com/' + serverChan + '.send',
      body: (title, text) => ({ title, desp: text }),
    }
  }
  const dingtalk = process.env.DINGTALK_WEBHOOK
  if (dingtalk) {
    return { channel: 'dingtalk', url: dingtalk, body: (_title, text) => ({ msgtype: 'text', text: { content: text } }) }
  }
  const feishu = process.env.FEISHU_WEBHOOK
  if (feishu) {
    return { channel: 'feishu', url: feishu, body: (_title, text) => ({ msg_type: 'text', content: { text } }) }
  }
  const wecom = process.env.WECOM_WEBHOOK
  if (wecom) {
    return { channel: 'wecom', url: wecom, body: (_title, text) => ({ msgtype: 'text', text: { content: text } }) }
  }
  return null
}

export function digestPushChannel(): string | null {
  return resolveChannel()?.channel ?? null
}

async function send(text: string, title: string): Promise<DigestPushResult> {
  const target = resolveChannel()
  if (!target) return { pushed: false, error: '未配置推送渠道（DAILY_DIGEST_WEBHOOK / SERVERCHAN_KEY / DINGTALK_WEBHOOK / FEISHU_WEBHOOK / WECOM_WEBHOOK）' }
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target.body(title, text)),
    })
    if (!res.ok) return { pushed: false, channel: target.channel, error: 'HTTP ' + res.status }
    return { pushed: true, channel: target.channel }
  } catch (e) {
    return { pushed: false, channel: target.channel, error: e instanceof Error ? e.message : String(e) }
  }
}

function renderText(digest: Omit<DailyDigest, 'text' | 'push'>): string {
  const lines = ['【A股研究复盘】' + digest.date, '']
  for (const section of digest.sections) {
    lines.push('— ' + section.title + ' —')
    for (const line of section.lines) lines.push(line)
    lines.push('')
  }
  return lines.join('\n').trim()
}

export async function buildDailyDigest(input: {
  stocks: SnapshotStock[]
  loadBars: (code: string) => Promise<KLineBar[]>
  recommendations?: RecommendationListResponse
  date?: string
  push?: boolean
}): Promise<DailyDigest> {
  const recommendations = input.recommendations ?? buildTodayRecommendations(input.stocks)
  const date = input.date ?? recommendations.items[0]?.signalDate ?? todayString()
  const attribution = await buildRecommendationAttribution(input.loadBars, { limit: 300 })
  const guard = getReasonGuard()
  const weightState = getRecommendationWeightState()

  const settledToday = attribution.outcomes.filter((outcome) => outcome.exitDate === date)
  const wins = settledToday.filter((outcome) => (outcome.returnPct ?? 0) > 0)
  const beatBench = settledToday.filter((outcome) => (outcome.excessPct ?? 0) > 0)

  const sections: DigestSection[] = []
  const market = recommendations.market
  if (market) {
    sections.push({
      title: '市场温度',
      lines: [
        '上涨 ' + market.upCount + ' / 下跌 ' + market.downCount + '，涨停 ' + market.limitUpCount + ' / 跌停 ' + market.limitDownCount,
        '平均涨跌 ' + fmtPct(market.avgChangePct) + '，成交 ' + market.totalAmountYi.toFixed(2) + ' 万亿，' +
          (market.riskOff ? '风险偏好偏低（趋势/打板权重已下调）' : market.riskOn ? '风险偏好偏高（趋势/打板权重已上调）' : '情绪中性'),
      ],
    })
  }

  sections.push({
    title: '今日推荐 TOP ' + Math.min(8, recommendations.items.length),
    lines: recommendations.items.slice(0, 8).map((item, index) =>
      (index + 1) + '. ' + item.name + '(' + item.code.toUpperCase() + ') ' + item.style + ' 置信 ' + item.confidence +
      ' 目标 ' + (item.levels.target?.toFixed(2) ?? '--') + ' 止损 ' + (item.levels.stopLoss?.toFixed(2) ?? '--') +
      ' 理由：' + (item.reasonSummary?.topLabels.slice(0, 3).join('、') ?? item.thesis),
    ),
  })

  if (recommendations.observing.length) {
    sections.push({
      title: '观察名单 ' + recommendations.observing.length + ' 只（未列入推荐）',
      lines: recommendations.observing.slice(0, 6).map((item) => item.name + '：' + (item.guard?.note || '命中准入守卫')),
    })
  }

  sections.push({
    title: '今日结算 ' + settledToday.length + ' 笔',
    lines: settledToday.length
      ? [
          '盈利 ' + wins.length + ' / 亏损 ' + (settledToday.length - wins.length) + '，跑赢大盘 ' + beatBench.length + ' 笔',
          ...settledToday.slice(0, 6).map((outcome) =>
            outcome.name + ' ' + outcome.signalDate + '→' + outcome.exitDate + ' 收益 ' + fmtPct(outcome.returnPct ?? 0) +
            '，超额 ' + (outcome.excessPct == null ? '--' : fmtPct(outcome.excessPct)) +
            (outcome.hitTarget ? '（目标命中）' : outcome.hitStop ? '（触发止损）' : ''),
          ),
        ]
      : ['今日没有到期的推荐，暂无需结算。'],
  })

  sections.push({
    title: '累计表现',
    lines: [
      '成熟样本 ' + attribution.stats.matured + ' 个，胜率 ' + attribution.stats.winRate.toFixed(1) + '%，平均收益 ' +
        fmtPct(attribution.stats.averageReturnPct) + '，平均超额 ' + fmtPct(attribution.stats.averageExcessPct),
      '目标命中率 ' + attribution.bias.targetHitRate.toFixed(0) + '%，止损触发率 ' + attribution.bias.stopHitRate.toFixed(0) +
        '%，置信度校准误差 ' + attribution.bias.expectedCalibrationError.toFixed(1) + 'pct',
    ],
  })

  sections.push({
    title: '归因结论',
    lines: attribution.byDimension.length
      ? attribution.byDimension.map((item) =>
          item.label + '：' + item.samples + ' 样本，跑赢大盘 ' + item.excessHitRate.toFixed(0) + '%，平均超额 ' +
          fmtPct(item.averageExcessPct) + ' → ' + item.verdict,
        )
      : ['暂无成熟样本，无法归因。'],
  })

  if (attribution.suggestions.length) {
    sections.push({ title: '策略调整建议', lines: attribution.suggestions.slice(0, 5) })
  }

  sections.push({
    title: '权重与守卫',
    lines: [
      '目标价系数 ' + getTargetFactor().toFixed(2) + '，置信度缩放 ' + getConfidenceScale().toFixed(2),
      '冷理由 ' + guard.penalized.length + ' 个，可信理由 ' + guard.trusted.length + ' 个' +
        (guard.penalized.length ? '：' + guard.penalized.map((item) => item.label).join('、') : ''),
      weightState.adjustments.length ? '最近一次权重调整：' + weightState.adjustments[0].reason : '尚未按归因校准过权重',
    ],
  })

  const base: Omit<DailyDigest, 'text' | 'push'> = {
    date,
    generatedAt: Date.now(),
    sections,
    stats: {
      recommendCount: recommendations.items.length,
      observeCount: recommendations.observing.length,
      settledToday: settledToday.length,
      matured: attribution.stats.matured,
      winRate: attribution.stats.winRate,
      averageReturnPct: attribution.stats.averageReturnPct,
      averageExcessPct: attribution.stats.averageExcessPct,
    },
  }
  const text = renderText(base)
  const push = input.push ? await send(text, 'A股研究复盘 ' + date) : { pushed: false as const }
  const digest: DailyDigest = { ...base, text, push }
  saveDigest(digest)
  return digest
}

export function saveDigest(digest: DailyDigest): void {
  writeJson(LATEST_FILE, digest)
  const raw = readJson<{ version: 1; digests: DailyDigest[] }>(HISTORY_FILE)
  const digests = (raw && Array.isArray(raw.digests) ? raw.digests : []).filter((item) => item.date !== digest.date)
  writeJson(HISTORY_FILE, { version: 1, digests: [digest, ...digests].slice(0, MAX_HISTORY) })
}

export function getLatestDigest(): DailyDigest | null {
  return readJson<DailyDigest>(LATEST_FILE)
}

export function listDigests(limit = 20): DailyDigest[] {
  const raw = readJson<{ version: 1; digests: DailyDigest[] }>(HISTORY_FILE)
  const digests = raw && Array.isArray(raw.digests) ? raw.digests : []
  return digests.slice(0, Math.max(1, Math.min(MAX_HISTORY, limit)))
}

/** 每个交易日收盘后自动生成（默认 15:05–16:30 窗口内触发一次） */
export class DailyDigestScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastDate = ''
  private running = false

  start(getContext: () => { stocks: SnapshotStock[]; loadBars: (code: string) => Promise<KLineBar[]>; push: boolean }) {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(getContext), 60_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 收盘后窗口：北京时间 15:05 – 16:30，周一至周五 */
  private inWindow(now = new Date()): boolean {
    const beijing = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
    const day = beijing.getDay()
    if (day === 0 || day === 6) return false
    const minutes = beijing.getHours() * 60 + beijing.getMinutes()
    return minutes >= 15 * 60 + 5 && minutes <= 16 * 60 + 30
  }

  async tick(getContext: () => { stocks: SnapshotStock[]; loadBars: (code: string) => Promise<KLineBar[]>; push: boolean }) {
    if (this.running || !this.inWindow()) return
    const date = todayString()
    if (this.lastDate === date) return
    this.running = true
    try {
      const ctx = getContext()
      if (!ctx.stocks.length) return
      const digest = await buildDailyDigest({ stocks: ctx.stocks, loadBars: ctx.loadBars, date, push: ctx.push })
      this.lastDate = date
      console.log(
        '[digest] 每日复盘已生成 ' + date + '：推荐 ' + digest.stats.recommendCount + '、观察 ' + digest.stats.observeCount +
        '、结算 ' + digest.stats.settledToday + (digest.push.pushed ? '，已推送(' + digest.push.channel + ')' : ''),
      )
    } catch (e) {
      console.warn('[digest] 生成失败: ', e)
    } finally {
      this.running = false
    }
  }
}

/** 补推/重推最新一期 */
export async function pushLatestDigest(): Promise<DigestPushResult> {
  const latest = getLatestDigest()
  if (!latest) return { pushed: false, error: '还没有生成过复盘摘要' }
  const result = await send(latest.text, 'A股研究复盘 ' + latest.date)
  saveDigest({ ...latest, push: result })
  return result
}
