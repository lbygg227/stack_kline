import type { OpinionDocument, OpinionPlatform, OpinionStance } from './opinions.ts'

export interface OpinionSignalEvidence {
  documentId: string
  claimId: string
  authorName: string
  publishedAt: number
  stance: OpinionStance
  confidence: number
  thesis: string
  evidenceQuote: string
}

export interface OpinionSignal {
  code: string
  name: string
  industry?: string
  score: number
  stance: OpinionStance
  confidence: number
  agreement: number
  authors: string[]
  claimCount: number
  latestAt: number
  horizonDays: number
  theses: string[]
  risks: string[]
  evidence: OpinionSignalEvidence[]
}

export interface OpinionSignalOptions {
  platform?: OpinionPlatform
  now?: number
  maxAgeDays?: number
  authorReliability?: Record<string, number>
}

const DAY = 86_400_000
const round = (value: number, digits = 4): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const stanceValue = (stance: OpinionStance): number =>
  stance === 'bullish' ? 1 : stance === 'bearish' ? -1 : 0

export function buildOpinionSignals(
  documents: OpinionDocument[],
  options: OpinionSignalOptions = {},
): OpinionSignal[] {
  const now = options.now ?? Date.now()
  const maxAgeDays = Math.max(1, options.maxAgeDays ?? 180)
  const grouped = new Map<string, Array<{
    document: OpinionDocument
    claim: OpinionDocument['claims'][number]
    weight: number
  }>>()

  for (const document of documents) {
    if (document.status !== 'analyzed') continue
    if (options.platform && document.platform !== options.platform) continue
    const ageDays = Math.max(0, (now - document.publishedAt) / DAY)
    if (ageDays > maxAgeDays) continue
    for (const claim of document.claims) {
      if (!claim.code || claim.stance === 'neutral') continue
      const halfLife = Math.max(7, claim.horizonDays)
      const recency = Math.exp(-Math.LN2 * ageDays / halfLife)
      const reliability = options.authorReliability?.[document.authorName] ?? 0.5
      const authorWeight = 0.5 + Math.max(0, Math.min(1, reliability))
      const weight = Math.max(0.05, claim.confidence) * recency * authorWeight
      const list = grouped.get(claim.code) ?? []
      list.push({ document, claim, weight })
      grouped.set(claim.code, list)
    }
  }

  return [...grouped.entries()].map(([code, items]) => {
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0)
    const directionalWeight = items.reduce(
      (sum, item) => sum + stanceValue(item.claim.stance) * item.weight,
      0,
    )
    const score = totalWeight > 0 ? directionalWeight / totalWeight * 100 : 0
    const agreement = totalWeight > 0 ? Math.abs(directionalWeight) / totalWeight : 0
    const confidence = Math.min(1, totalWeight / 2) * agreement
    const ordered = [...items].sort((a, b) => b.document.publishedAt - a.document.publishedAt)
    const representative = ordered[0].claim
    const authors = [...new Set(ordered.map((item) => item.document.authorName))]
    const horizonDays = totalWeight > 0
      ? items.reduce((sum, item) => sum + item.claim.horizonDays * item.weight, 0) / totalWeight
      : 20
    return {
      code,
      name: representative.name ?? code,
      industry: representative.industry,
      score: round(score, 2),
      stance: score >= 15 ? 'bullish' : score <= -15 ? 'bearish' : 'neutral',
      confidence: round(confidence, 4),
      agreement: round(agreement, 4),
      authors,
      claimCount: items.length,
      latestAt: Math.max(...items.map((item) => item.document.publishedAt)),
      horizonDays: Math.max(1, Math.round(horizonDays)),
      theses: [...new Set(ordered.map((item) => item.claim.thesis).filter(Boolean))].slice(0, 5),
      risks: [...new Set(ordered.flatMap((item) => item.claim.risks).filter(Boolean))].slice(0, 5),
      evidence: ordered.slice(0, 10).map(({ document, claim }) => ({
        documentId: document.id,
        claimId: claim.id,
        authorName: document.authorName,
        publishedAt: document.publishedAt,
        stance: claim.stance,
        confidence: claim.confidence,
        thesis: claim.thesis,
        evidenceQuote: claim.evidenceQuote,
      })),
    } satisfies OpinionSignal
  }).sort((a, b) =>
    Math.abs(b.score) * b.confidence - Math.abs(a.score) * a.confidence ||
    b.latestAt - a.latestAt,
  )
}
