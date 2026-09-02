import type { KLineBar } from './tencent.ts'
import type { OpinionDocument, OpinionPlatform, OpinionStance } from './opinions.ts'

export interface OpinionBacktestConfig {
  platform?: OpinionPlatform
  subscriptionId?: string
  startDate?: string
  endDate?: string
  holdingDays?: number
  benchmarkCode: string
}

export interface OpinionBacktestEvent {
  documentId: string
  claimId: string
  platform: OpinionPlatform
  authorName: string
  code: string
  name: string
  stance: Exclude<OpinionStance, 'neutral'>
  publishedAt: number
  signalDate: string
  entryDate: string
  exitDate: string
  holdingDays: number
  confidence: number
  forwardReturnPct: number
  benchmarkReturnPct?: number
  directionalReturnPct: number
  directionalExcessPct?: number
  correct: boolean
  thesis: string
}

export interface OpinionAuthorPerformance {
  authorName: string
  evaluated: number
  correct: number
  hitRate: number
  averageDirectionalReturnPct: number
  averageDirectionalExcessPct?: number
  reliability: number
}

export interface OpinionBacktestResult {
  mode: 'opinion_event_study'
  config: OpinionBacktestConfig
  metrics: {
    totalClaims: number
    evaluated: number
    skipped: number
    hitRate: number
    averageForwardReturnPct: number
    averageDirectionalReturnPct: number
    medianDirectionalReturnPct: number
    averageDirectionalExcessPct?: number
  }
  events: OpinionBacktestEvent[]
  authors: OpinionAuthorPerformance[]
  skipped: Array<{ documentId: string; claimId: string; reason: string }>
  warnings: string[]
}

const DAY = 86_400_000
const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => new Date(msOf(timestamp)).toISOString().slice(0, 10)
const round = (value: number, digits = 4): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const directionOf = (stance: OpinionStance): number => stance === 'bullish' ? 1 : -1
const inRange = (date: string, start?: string, end?: string): boolean =>
  (!start || date >= start) && (!end || date <= end)

function returnBetween(
  barsByDate: Map<string, KLineBar>,
  entryDate: string,
  exitDate: string,
): number | undefined {
  const entry = barsByDate.get(entryDate)
  const exit = barsByDate.get(exitDate)
  if (!entry?.open || !exit?.close) return undefined
  return (exit.close / entry.open - 1) * 100
}

function authorPerformance(events: OpinionBacktestEvent[]): OpinionAuthorPerformance[] {
  const grouped = new Map<string, OpinionBacktestEvent[]>()
  for (const event of events) {
    const list = grouped.get(event.authorName) ?? []
    list.push(event)
    grouped.set(event.authorName, list)
  }
  return [...grouped.entries()].map(([authorName, items]) => {
    const directional = items.map((item) => item.directionalReturnPct)
    const excess = items
      .map((item) => item.directionalExcessPct)
      .filter((value): value is number => value !== undefined)
    const correct = items.filter((item) => item.correct).length
    const hitRate = correct / items.length
    // Beta(2,2) 先验抑制小样本极端结果，再用方向收益做轻量修正。
    const bayesianHitRate = (correct + 2) / (items.length + 4)
    const returnAdjustment = Math.max(-0.1, Math.min(0.1, mean(directional) / 100))
    return {
      authorName,
      evaluated: items.length,
      correct,
      hitRate: round(hitRate * 100, 2),
      averageDirectionalReturnPct: round(mean(directional)),
      averageDirectionalExcessPct: excess.length ? round(mean(excess)) : undefined,
      reliability: round(Math.max(0, Math.min(1, bayesianHitRate + returnAdjustment)), 4),
    }
  }).sort((a, b) => b.reliability - a.reliability || b.evaluated - a.evaluated)
}

export async function runOpinionBacktest(
  documents: OpinionDocument[],
  rawConfig: Partial<OpinionBacktestConfig>,
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<OpinionBacktestResult> {
  const config: OpinionBacktestConfig = {
    platform: rawConfig.platform === 'zhihu' || rawConfig.platform === 'xueqiu'
      ? rawConfig.platform
      : undefined,
    subscriptionId: rawConfig.subscriptionId || undefined,
    startDate: rawConfig.startDate || undefined,
    endDate: rawConfig.endDate || undefined,
    holdingDays: rawConfig.holdingDays
      ? Math.max(1, Math.min(250, Math.round(rawConfig.holdingDays)))
      : undefined,
    benchmarkCode: /^(sh|sz)\d{6}$/.test(rawConfig.benchmarkCode ?? '')
      ? rawConfig.benchmarkCode!
      : 'sh000300',
  }
  const selected = documents
    .filter((document) => document.status === 'analyzed')
    .filter((document) => !config.platform || document.platform === config.platform)
    .filter((document) => !config.subscriptionId || document.subscriptionId === config.subscriptionId)
  const claims = selected.flatMap((document) =>
    document.claims
      .filter((claim) => claim.code && claim.stance !== 'neutral')
      .map((claim) => ({ document, claim })),
  )
  const cache = new Map<string, Promise<KLineBar[]>>()
  const cachedBars = (code: string) => {
    let task = cache.get(code)
    if (!task) {
      task = loadBars(code).then((bars) =>
        bars
          .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
          .sort((a, b) => a.timestamp - b.timestamp),
      )
      cache.set(code, task)
    }
    return task
  }
  const benchmarkBars = await cachedBars(config.benchmarkCode).catch(() => [])
  const benchmarkByDate = new Map(benchmarkBars.map((bar) => [dayOf(bar.timestamp), bar]))
  const events: OpinionBacktestEvent[] = []
  const skipped: OpinionBacktestResult['skipped'] = []

  for (const { document, claim } of claims) {
    const signalDate = new Date(document.publishedAt).toISOString().slice(0, 10)
    if (!inRange(signalDate, config.startDate, config.endDate)) continue
    let bars: KLineBar[]
    try {
      bars = await cachedBars(claim.code!)
    } catch (error) {
      skipped.push({
        documentId: document.id,
        claimId: claim.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const entryIndex = bars.findIndex((bar) => dayOf(bar.timestamp) > signalDate)
    const holdingDays = config.holdingDays ?? Math.max(1, Math.min(250, claim.horizonDays))
    const exitIndex = entryIndex + holdingDays - 1
    if (entryIndex < 0 || exitIndex >= bars.length) {
      skipped.push({ documentId: document.id, claimId: claim.id, reason: '发布时间后的行情数据不足' })
      continue
    }
    const entryBar = bars[entryIndex]
    const exitBar = bars[exitIndex]
    if (!entryBar.open || !exitBar.close) {
      skipped.push({ documentId: document.id, claimId: claim.id, reason: '入场或退出价格无效' })
      continue
    }
    const entryDate = dayOf(entryBar.timestamp)
    const exitDate = dayOf(exitBar.timestamp)
    const forwardReturnPct = (exitBar.close / entryBar.open - 1) * 100
    const benchmarkReturnPct = returnBetween(benchmarkByDate, entryDate, exitDate)
    const direction = directionOf(claim.stance)
    const directionalReturnPct = forwardReturnPct * direction
    const directionalExcessPct = benchmarkReturnPct === undefined
      ? undefined
      : (forwardReturnPct - benchmarkReturnPct) * direction
    events.push({
      documentId: document.id,
      claimId: claim.id,
      platform: document.platform,
      authorName: document.authorName,
      code: claim.code!,
      name: claim.name ?? claim.code!,
      stance: claim.stance as Exclude<OpinionStance, 'neutral'>,
      publishedAt: document.publishedAt,
      signalDate,
      entryDate,
      exitDate,
      holdingDays,
      confidence: claim.confidence,
      forwardReturnPct: round(forwardReturnPct),
      benchmarkReturnPct: benchmarkReturnPct === undefined ? undefined : round(benchmarkReturnPct),
      directionalReturnPct: round(directionalReturnPct),
      directionalExcessPct: directionalExcessPct === undefined ? undefined : round(directionalExcessPct),
      correct: directionalReturnPct > 0,
      thesis: claim.thesis,
    })
  }

  const directional = events.map((event) => event.directionalReturnPct)
  const directionalExcess = events
    .map((event) => event.directionalExcessPct)
    .filter((value): value is number => value !== undefined)
  return {
    mode: 'opinion_event_study',
    config,
    metrics: {
      totalClaims: claims.length,
      evaluated: events.length,
      skipped: skipped.length,
      hitRate: round(events.length ? events.filter((event) => event.correct).length / events.length * 100 : 0, 2),
      averageForwardReturnPct: round(mean(events.map((event) => event.forwardReturnPct))),
      averageDirectionalReturnPct: round(mean(directional)),
      medianDirectionalReturnPct: round(median(directional)),
      averageDirectionalExcessPct: directionalExcess.length ? round(mean(directionalExcess)) : undefined,
    },
    events: events.sort((a, b) => b.publishedAt - a.publishedAt),
    authors: authorPerformance(events),
    skipped,
    warnings: [
      '观点发布时间为唯一信号时点，统一从下一交易日开盘观察，避免使用文章发布当日收盘前未知信息。',
      '看空观点按方向判断计算，不代表A股可直接执行融券或做空交易。',
      `当前每只标的最多约 ${Math.round(500 * DAY / DAY)} 根日K，近期观点可能尚未走完观察期。`,
    ],
  }
}
