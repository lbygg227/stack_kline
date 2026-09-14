/**
 * 基本面画像：把行情快照里的财务字段（估值/盈利/成长/质量/资金）整理成可读、可验证的结论。
 * 这些结论会作为「推荐理由」进入推荐记录，并在回测阶段参与逐维归因。
 */

import type { SnapshotStock } from './eastmoney.ts'

export interface FundamentalProfile {
  industry?: string
  peTtm?: number
  peStatic?: number
  pb?: number
  roe?: number
  revenueYi?: number
  revenueYoy?: number
  netProfitYi?: number
  profitYoy?: number
  grossMargin?: number
  netMargin?: number
  debtRatio?: number
  mainNetInflowYi?: number
  mainNetInflowPct?: number
  mktcapYi?: number
  industryPeMedian?: number
  industryPePercentile?: number
  valuationLabel?: string
  growthLabel?: string
  qualityLabel?: string
  rating: 'strong' | 'neutral' | 'weak'
  bullets: string[]
}

/** 单个可验证的基本面信号，最终会被组装成推荐理由 */
export interface FundamentalSignal {
  key: string
  label: string
  detail: string
  /** 该理由对结论的贡献权重 0~1 */
  weight: number
  /** 该理由自身的强度 0~100 */
  strength: number
  metrics: Record<string, number | string>
  /** 事后验证口径：什么情况算这条理由成立 */
  expect: string
}

export interface IndustryValuation {
  industry: string
  peMedian: number
  pbMedian: number
  count: number
  /** 行业 PE 样本，用于计算个股真实估值分位 */
  peList: number[]
}

const positive = (value?: number): number | undefined =>
  typeof value === 'number' && isFinite(value) && value > 0 ? value : undefined

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 按申万一级行业统计估值中位数，用于个股估值分位。 */
export function buildIndustryValuation(stocks: SnapshotStock[]): Map<string, IndustryValuation> {
  const bucket = new Map<string, { pe: number[]; pb: number[] }>()
  for (const stock of stocks) {
    const industry = stock.industry
    if (!industry) continue
    const item = bucket.get(industry) ?? { pe: [], pb: [] }
    const pe = positive(stock.peTtm) ?? positive(stock.pe)
    if (pe && pe < 300) item.pe.push(pe)
    const pb = positive(stock.pb)
    if (pb && pb < 30) item.pb.push(pb)
    bucket.set(industry, item)
  }
  const result = new Map<string, IndustryValuation>()
  for (const [industry, item] of bucket) {
    result.set(industry, {
      industry,
      peMedian: median(item.pe),
      pbMedian: median(item.pb),
      count: item.pe.length,
      peList: item.pe,
    })
  }
  return result
}

const pct = (value: number, digits = 1): string => value.toFixed(digits) + '%'
const yi = (value: number): string => (value / 1e8).toFixed(2) + '亿'

/**
 * 构建基本面画像 + 结构化信号。
 * 财务字段缺失（老快照/降级源）时只输出可得的部分，不会编造数值。
 */
export function buildFundamentalProfile(
  stock: SnapshotStock,
  industryValuation?: Map<string, IndustryValuation>,
): { profile: FundamentalProfile; signals: FundamentalSignal[] } {
  const peTtm = positive(stock.peTtm) ?? positive(stock.pe)
  const pb = positive(stock.pb)
  const roe = typeof stock.roe === 'number' && isFinite(stock.roe) ? stock.roe : undefined
  const revenueYoy = typeof stock.revenueYoy === 'number' && isFinite(stock.revenueYoy) ? stock.revenueYoy : undefined
  const profitYoy = typeof stock.profitYoy === 'number' && isFinite(stock.profitYoy) ? stock.profitYoy : undefined
  const grossMargin = typeof stock.grossMargin === 'number' && isFinite(stock.grossMargin) ? stock.grossMargin : undefined
  const netMargin = typeof stock.netMargin === 'number' && isFinite(stock.netMargin) ? stock.netMargin : undefined
  const debtRatio = typeof stock.debtRatio === 'number' && isFinite(stock.debtRatio) ? stock.debtRatio : undefined
  const mainNetInflow = typeof stock.mainNetInflow === 'number' ? stock.mainNetInflow : undefined
  const mainNetInflowPct = typeof stock.mainNetInflowPct === 'number' ? stock.mainNetInflowPct : undefined
  const industry = stock.industry
  const valuation = industry ? industryValuation?.get(industry) : undefined

  const signals: FundamentalSignal[] = []
  const bullets: string[] = []

  // ---- 估值 ----
  let industryPePercentile: number | undefined
  let valuationLabel: string | undefined
  if (peTtm) {
    const peers = valuation?.count ? valuation : undefined
    const industryPeMedian = peers?.peMedian
    if (industryPeMedian && industryPeMedian > 0) {
      const ratio = peTtm / industryPeMedian
      // 真实分位：行业内有百分之多少的标的比它便宜
      if (peers?.peList.length) {
        const cheaper = peers.peList.filter((value) => value <= peTtm).length
        industryPePercentile = Math.max(1, Math.min(99, Math.round(cheaper / peers.peList.length * 100)))
      } else {
        industryPePercentile = Math.max(1, Math.min(99, Math.round(50 * ratio)))
      }
      if (ratio <= 0.7) valuationLabel = '低估'
      else if (ratio <= 1.15) valuationLabel = '合理'
      else valuationLabel = '偏高'
      bullets.push(
        'PE(TTM) ' + peTtm.toFixed(1) + '，' + industry + '行业中位 ' + industryPeMedian.toFixed(1) +
        '，处于行业 ' + industryPePercentile + '% 估值分位（行业中位倍数 ' + (ratio * 100).toFixed(0) + '%），估值' + valuationLabel,
      )
    } else {
      valuationLabel = peTtm <= 25 ? '低估' : peTtm <= 60 ? '合理' : '偏高'
      bullets.push('PE(TTM) ' + peTtm.toFixed(1) + '，估值' + valuationLabel + '（缺少行业样本）')
    }
    const strength = valuationLabel === '低估' ? 82 : valuationLabel === '合理' ? 60 : 34
    signals.push({
      key: 'valuation',
      label: '估值 ' + valuationLabel,
      detail:
        'PE(TTM) ' + peTtm.toFixed(1) +
        (industryPeMedian && industryPeMedian > 0
          ? '，行业中位 ' + industryPeMedian.toFixed(1) + '，行业估值分位 ' + industryPePercentile + '%（越低越便宜）'
          : '') +
        (pb ? '，PB ' + pb.toFixed(2) : ''),
      weight: 0.24,
      strength,
      metrics: {
        peTtm: Number(peTtm.toFixed(2)),
        pb: pb ? Number(pb.toFixed(2)) : 0,
        industryPeMedian: industryPeMedian ? Number(industryPeMedian.toFixed(2)) : 0,
        pePercentile: industryPePercentile ?? 0,
      },
      expect: '基本面低估 → 中期（10 日以上）相对行业中位数应有超额收益',
    })
  } else if (stock.pe <= 0) {
    valuationLabel = '亏损'
    bullets.push('PE 为负（TTM 亏损），基本面不支持估值型逻辑')
    signals.push({
      key: 'valuation_loss',
      label: '公司亏损',
      detail: 'PE(TTM) 为负，估值维度无支撑',
      weight: 0.2,
      strength: 22,
      metrics: { peTtm: 0 },
      expect: '亏损标的应更多依赖资金/事件驱动，若仅靠基本面入选即为误判',
    })
  }

  // ---- 成长 ----
  let growthLabel: string | undefined
  if (profitYoy != null || revenueYoy != null) {
    const profit = profitYoy ?? 0
    const revenue = revenueYoy ?? 0
    growthLabel = profit >= 50 ? '高增长' : profit >= 15 ? '稳健增长' : profit >= 0 ? '微增' : '下滑'
    const strength = profit >= 100 ? 90 : profit >= 50 ? 80 : profit >= 15 ? 66 : profit >= 0 ? 50 : profit >= -30 ? 34 : 20
    const parts: string[] = []
    if (profitYoy != null) parts.push('净利润同比 ' + pct(profitYoy))
    if (revenueYoy != null) parts.push('营收同比 ' + pct(revenueYoy))
    if (stock.netProfit) parts.push('净利润 ' + yi(stock.netProfit))
    if (stock.revenue) parts.push('营收 ' + yi(stock.revenue))
    bullets.push('业绩' + growthLabel + '：' + parts.join('，'))
    signals.push({
      key: 'growth',
      label: '业绩' + growthLabel,
      detail: parts.join('，'),
      weight: 0.26,
      strength,
      metrics: {
        profitYoy: profitYoy != null ? Number(profitYoy.toFixed(1)) : 0,
        revenueYoy: revenueYoy != null ? Number(revenueYoy.toFixed(1)) : 0,
        netProfitYi: stock.netProfit ? Number((stock.netProfit / 1e8).toFixed(2)) : 0,
      },
      expect: '业绩高增 → 未来 5~20 日应跑赢同行业，且回撤幅度小于板块',
    })
    if (revenue > 0 && profit < 0) {
      bullets.push('增收不增利（营收 +' + pct(revenue) + ' / 净利 ' + pct(profit) + '），成本或费用端存在压力')
    }
  }

  // ---- 质量 ----
  let qualityLabel: string | undefined
  if (roe != null) {
    qualityLabel = roe >= 15 ? '优秀' : roe >= 8 ? '良好' : roe > 0 ? '一般' : '较差'
    const strength = roe >= 20 ? 88 : roe >= 15 ? 78 : roe >= 8 ? 62 : roe > 0 ? 45 : 26
    bullets.push(
      'ROE ' + pct(roe) + '（' + qualityLabel + '）' +
      (grossMargin != null ? '，毛利率 ' + pct(grossMargin) : '') +
      (netMargin != null ? '，净利率 ' + pct(netMargin) : ''),
    )
    signals.push({
      key: 'quality',
      label: 'ROE ' + qualityLabel,
      detail:
        'ROE ' + pct(roe) +
        (grossMargin != null ? '，毛利率 ' + pct(grossMargin) : '') +
        (netMargin != null ? '，净利率 ' + pct(netMargin) : ''),
      weight: 0.18,
      strength,
      metrics: {
        roe: Number(roe.toFixed(2)),
        grossMargin: grossMargin != null ? Number(grossMargin.toFixed(2)) : 0,
        netMargin: netMargin != null ? Number(netMargin.toFixed(2)) : 0,
      },
      expect: 'ROE 优秀 → 下跌时抗跌，反弹时弹性更好',
    })
  }

  // ---- 财务健康 ----
  if (debtRatio != null && debtRatio > 0) {
    const risky = debtRatio >= 70
    bullets.push('资产负债率 ' + pct(debtRatio) + (risky ? '（偏高，注意偿债压力）' : '（结构健康）'))
    signals.push({
      key: 'balance',
      label: risky ? '负债偏高' : '负债健康',
      detail: '资产负债率 ' + pct(debtRatio),
      weight: 0.12,
      strength: risky ? 32 : 64,
      metrics: { debtRatio: Number(debtRatio.toFixed(2)) },
      expect: '高负债标的在风险偏好下行时波动更大',
    })
  }

  // ---- 当日主力资金（与资金通道互证）----
  if (mainNetInflow != null && mainNetInflow !== 0) {
    const inflow = mainNetInflow > 0
    bullets.push('当日主力' + (inflow ? '净流入 ' : '净流出 ') + yi(Math.abs(mainNetInflow)) + (mainNetInflowPct != null ? '（占比 ' + pct(mainNetInflowPct, 2) + '）' : ''))
    signals.push({
      key: 'main_flow',
      label: inflow ? '主力净流入' : '主力净流出',
      detail: '当日主力' + (inflow ? '净流入 ' : '净流出 ') + yi(Math.abs(mainNetInflow)) + (mainNetInflowPct != null ? '，占比 ' + pct(mainNetInflowPct, 2) : ''),
      weight: 0.2,
      strength: inflow ? Math.min(90, 55 + Math.abs(mainNetInflowPct ?? 0) * 3) : 28,
      metrics: {
        mainNetInflowYi: Number((mainNetInflow / 1e8).toFixed(3)),
        mainNetInflowPct: mainNetInflowPct != null ? Number(mainNetInflowPct.toFixed(2)) : 0,
      },
      expect: '主力净流入 → 次日及 3 日内应维持强势或至少不破当日均价',
    })
  }

  const weighted = signals.filter((s) => s.label !== '主力净流出')
  const totalWeight = weighted.reduce((sum, s) => sum + s.weight, 0)
  const avgStrength = totalWeight ? weighted.reduce((sum, s) => sum + s.weight * s.strength, 0) / totalWeight : 0
  const rating: FundamentalProfile['rating'] = avgStrength >= 70 ? 'strong' : avgStrength >= 50 ? 'neutral' : 'weak'

  return {
    profile: {
      industry,
      peTtm: peTtm ? Number(peTtm.toFixed(2)) : undefined,
      peStatic: positive(stock.peStatic),
      pb: pb ? Number(pb.toFixed(2)) : undefined,
      roe: roe != null ? Number(roe.toFixed(2)) : undefined,
      revenueYi: stock.revenue ? Number((stock.revenue / 1e8).toFixed(2)) : undefined,
      revenueYoy: revenueYoy != null ? Number(revenueYoy.toFixed(1)) : undefined,
      netProfitYi: stock.netProfit ? Number((stock.netProfit / 1e8).toFixed(2)) : undefined,
      profitYoy: profitYoy != null ? Number(profitYoy.toFixed(1)) : undefined,
      grossMargin: grossMargin != null ? Number(grossMargin.toFixed(2)) : undefined,
      netMargin: netMargin != null ? Number(netMargin.toFixed(2)) : undefined,
      debtRatio: debtRatio != null ? Number(debtRatio.toFixed(2)) : undefined,
      mainNetInflowYi: mainNetInflow != null ? Number((mainNetInflow / 1e8).toFixed(3)) : undefined,
      mainNetInflowPct: mainNetInflowPct != null ? Number(mainNetInflowPct.toFixed(2)) : undefined,
      mktcapYi: stock.mktcap ? Number((stock.mktcap / 1e4).toFixed(1)) : undefined,
      industryPeMedian: valuation?.peMedian ? Number(valuation.peMedian.toFixed(2)) : undefined,
      industryPePercentile,
      valuationLabel,
      growthLabel,
      qualityLabel,
      rating,
      bullets,
    },
    signals,
  }
}
