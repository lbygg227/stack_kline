/**
 * 可持续性评分：技术结构 + 事件质量 + 观点共识 + 行业位置。
 * 高置信看空 / 监管事件可硬否决。不下单，只给研究结论。
 */

import { analyzeStock, type StockAnalysisResult } from './analysis.ts'
import { listMarketEvents, type MarketEvent } from './market-events.ts'
import { listOpinionDocuments } from './opinions.ts'
import { buildOpinionSignals, type OpinionSignal } from './opinion-signals.ts'
import type { SnapshotStock } from './eastmoney.ts'
import type { SustainabilitySnapshot } from './watch-candidates.ts'

export interface SustainabilityReport extends SustainabilitySnapshot {
  code: string
  name: string
  industry?: string
  analysis?: Pick<StockAnalysisResult, 'score' | 'signalKey' | 'signalLabel' | 'summary' | 'reasons' | 'risks'>
  opinionSignal?: Pick<OpinionSignal, 'score' | 'stance' | 'confidence' | 'agreement' | 'authors' | 'claimCount'> | null
  events: Array<Pick<MarketEvent, 'id' | 'title' | 'kind' | 'strength' | 'publishedAt'>>
  industryChangePct?: number
}

const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n))

function scoreTechnical(analysis: StockAnalysisResult): { score: number; reasons: string[]; risks: string[] } {
  const reasons: string[] = []
  const risks: string[] = []
  const score = clamp(analysis.score)
  if (analysis.signalKey === 'strong_buy' || analysis.signalKey === 'buy') {
    reasons.push(`技术信号：${analysis.signalLabel}（${analysis.score}分）`)
  } else if (analysis.signalKey === 'reduce' || analysis.signalKey === 'sell') {
    risks.push(`技术偏弱：${analysis.signalLabel}（${analysis.score}分）`)
  } else {
    reasons.push(`技术中性：${analysis.signalLabel || '观察'}（${analysis.score}分）`)
  }
  if (analysis.risks?.length) risks.push(...analysis.risks.slice(0, 2))
  return { score, reasons, risks }
}

function scoreEvents(
  events: MarketEvent[],
  code: string,
): {
  score: number
  reasons: string[]
  risks: string[]
  vetoes: string[]
} {
  if (events.length === 0) {
    return { score: 55, reasons: ['近端无一级资讯，事件维中性'], risks: [], vetoes: [] }
  }
  const reasons: string[] = []
  const risks: string[] = []
  const vetoes: string[] = []
  let score = 50
  const codeNorm = code.toLowerCase()
  const namedRegulatory = events.filter(
    (e) => e.kind === 'regulatory' && e.codes.some((c) => c.toLowerCase() === codeNorm),
  )
  const industryRegulatory = events.filter(
    (e) => e.kind === 'regulatory' && !e.codes.some((c) => c.toLowerCase() === codeNorm),
  )
  const announcements = events.filter((e) => e.kind === 'announcement')
  if (namedRegulatory.length) {
    vetoes.push(`近端个股监管事件 ${namedRegulatory.length} 条（如：${namedRegulatory[0].title.slice(0, 28)}）`)
    score -= 35
    risks.push('监管/问询类事件削弱持续性')
  } else if (industryRegulatory.length) {
    score -= 12
    risks.push(`同行监管噪音 ${industryRegulatory.length} 条，降权但不硬否决`)
  }
  if (announcements.length) {
    score += Math.min(25, announcements.length * 8)
    reasons.push(`近端公告 ${announcements.length} 条，事实催化可跟踪`)
  }
  const newsOnly = events.filter((e) => e.kind === 'news')
  if (newsOnly.length && !announcements.length) {
    score += Math.min(10, newsOnly.length * 3)
    reasons.push(`近端普通资讯 ${newsOnly.length} 条`)
  }
  return { score: clamp(score), reasons, risks, vetoes }
}

function scoreOpinion(signal: OpinionSignal | undefined): {
  score: number
  reasons: string[]
  risks: string[]
  vetoes: string[]
} {
  if (!signal) {
    return { score: 50, reasons: ['暂无结构化博主共识'], risks: [], vetoes: [] }
  }
  const reasons: string[] = []
  const risks: string[] = []
  const vetoes: string[] = []
  // OpinionSignal.score 大致在 -100~100
  const mapped = clamp(50 + signal.score / 2)
  if (signal.stance === 'bearish' && signal.confidence >= 0.65 && signal.agreement >= 0.55) {
    vetoes.push(`高置信看空共识（一致度 ${Math.round(signal.agreement * 100)}%，置信 ${Math.round(signal.confidence * 100)}%）`)
  }
  if (signal.stance === 'bullish') {
    reasons.push(`${signal.authors.length} 位博主偏多，观点分 ${signal.score.toFixed(0)}`)
  } else if (signal.stance === 'bearish') {
    risks.push(`${signal.authors.length} 位博主偏空，观点分 ${signal.score.toFixed(0)}`)
  } else {
    reasons.push('博主观点分歧或中性')
  }
  return { score: mapped, reasons, risks, vetoes }
}

function scoreIndustry(
  stock: SnapshotStock | undefined,
  peers: SnapshotStock[],
): { score: number; reasons: string[]; risks: string[]; industryChangePct?: number } {
  if (!stock?.industry) {
    return { score: 50, reasons: ['行业信息不足'], risks: [] }
  }
  const same = peers.filter((s) => s.industry === stock.industry)
  if (same.length < 5) {
    return { score: 50, reasons: [`${stock.industry} 样本不足`], risks: [], industryChangePct: stock.changePct }
  }
  const avg = same.reduce((sum, s) => sum + s.changePct, 0) / same.length
  let score = 50 + avg * 4
  const reasons: string[] = []
  const risks: string[] = []
  if (avg >= 1) reasons.push(`${stock.industry} 今日偏强（板块均涨 ${avg.toFixed(2)}%）`)
  else if (avg <= -1) risks.push(`${stock.industry} 今日偏弱（板块均跌 ${avg.toFixed(2)}%）`)
  else reasons.push(`${stock.industry} 板块中性（均涨跌 ${avg.toFixed(2)}%）`)
  if (stock.changePct - avg >= 2) reasons.push('个股相对板块偏强')
  if (avg - stock.changePct >= 2) risks.push('个股相对板块偏弱')
  return { score: clamp(score), reasons, risks, industryChangePct: avg }
}

export async function buildSustainabilityReport(options: {
  code: string
  name?: string
  stocks?: SnapshotStock[]
  eventDays?: number
}): Promise<SustainabilityReport> {
  const code = options.code.trim().toLowerCase()
  const stocks = options.stocks ?? []
  const snap = stocks.find((s) => s.code === code)
  const name = options.name?.trim() || snap?.name || code
  const industry = snap?.industry

  const analysis = await analyzeStock(code, name)
  const tech = scoreTechnical(analysis)

  const eventList = listMarketEvents({
    code,
    days: options.eventDays ?? 7,
    limit: 30,
  }).events
  // 行业事件补充：无代码命中时用行业过滤
  const industryEvents = industry && eventList.length < 3
    ? listMarketEvents({ industry, days: options.eventDays ?? 7, limit: 20 }).events
      .filter((e) => !eventList.some((x) => x.id === e.id))
    : []
  const events = [...eventList, ...industryEvents].slice(0, 12)
  const evt = scoreEvents(events, code)

  const signals = buildOpinionSignals(listOpinionDocuments({ limit: 500 }), { maxAgeDays: 90 })
  const opinion = signals.find((s) => s.code === code)
  const opin = scoreOpinion(opinion)

  const ind = scoreIndustry(snap, stocks)

  const vetoes = [...evt.vetoes, ...opin.vetoes]
  const weights = { technical: 0.35, event: 0.2, opinion: 0.25, industry: 0.2 }
  let score = clamp(
    tech.score * weights.technical
    + evt.score * weights.event
    + opin.score * weights.opinion
    + ind.score * weights.industry,
  )
  if (vetoes.length) score = Math.min(score, 28)

  const grade: SustainabilitySnapshot['grade'] = vetoes.length || score < 35
    ? 'reject'
    : score >= 62
      ? 'track'
      : 'cautious'

  const reasons = [...tech.reasons, ...evt.reasons, ...opin.reasons, ...ind.reasons].slice(0, 8)
  const risks = [...tech.risks, ...evt.risks, ...opin.risks, ...ind.risks].slice(0, 8)

  return {
    code,
    name,
    industry,
    score: Math.round(score * 10) / 10,
    grade,
    technical: Math.round(tech.score),
    event: Math.round(evt.score),
    opinion: Math.round(opin.score),
    industryScore: Math.round(ind.score),
    reasons,
    risks,
    vetoes,
    generatedAt: Date.now(),
    analysis: {
      score: analysis.score,
      signalKey: analysis.signalKey,
      signalLabel: analysis.signalLabel,
      summary: analysis.summary,
      reasons: analysis.reasons,
      risks: analysis.risks,
    },
    opinionSignal: opinion
      ? {
          score: opinion.score,
          stance: opinion.stance,
          confidence: opinion.confidence,
          agreement: opinion.agreement,
          authors: opinion.authors,
          claimCount: opinion.claimCount,
        }
      : null,
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      strength: e.strength,
      publishedAt: e.publishedAt,
    })),
    industryChangePct: ind.industryChangePct,
  }
}
