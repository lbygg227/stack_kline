/**
 * 个股分析引擎（服务端，规则型）。
 * 评分模型移植自 daily_stock_analysis 的 src/stock_analyzer.py：
 *   趋势(30) + 乖离率(20) + 量能(15) + 支撑(10) + MACD(15) + RSI(10)
 * 信号映射与 decision-scale-v1 对齐：
 *   80-100 strong_buy / 60-79 buy / 40-59 watch / 20-39 reduce / 0-19 sell
 */

import { getKlineWithCache } from './tencent.ts'
import { boll, macd, rsi, sma } from './indicators.ts'

export type AnalysisSignalKey = 'strong_buy' | 'buy' | 'watch' | 'reduce' | 'sell'

export interface AnalysisDimension {
  key: string
  name: string
  score: number
  max: number
  detail: string
  tone: 'bullish' | 'bearish' | 'neutral'
}

export interface AnalysisTrend {
  status: string
  alignment: string
  trendStrength: number
  ma5: number
  ma10: number
  ma20: number
  ma60: number
  biasMa5: number
  biasMa10: number
  biasMa20: number
}

export interface AnalysisMacd {
  dif: number
  dea: number
  bar: number
  status: string
  signal: string
}

export interface AnalysisRsi {
  rsi6: number
  rsi12: number
  rsi24: number
  status: string
  signal: string
}

export interface AnalysisVolume {
  ratio5d: number
  status: string
  meaning: string
}

export interface AnalysisLevels {
  support: number[]
  resistance: number[]
  stopLoss: number
  target: number
}

export interface AiCommentary {
  oneSentence: string
  commentary: string
  confidence: string
  model?: string
}

export interface StockAnalysisResult {
  code: string
  name: string
  price: number
  changePct: number
  score: number
  signalKey: AnalysisSignalKey | 'unknown'
  signalLabel: string
  summary: string
  dimensions: AnalysisDimension[]
  trend: AnalysisTrend
  macd: AnalysisMacd
  rsi: AnalysisRsi
  volume: AnalysisVolume
  levels: AnalysisLevels
  reasons: string[]
  risks: string[]
  dataQuality: 'full' | 'partial' | 'insufficient'
  disclaimer: string
  ai?: AiCommentary | null
}

const round = (n: number, digits = 2): number => {
  const p = 10 ** digits
  return Math.round(n * p) / p
}

const isFiniteNum = (v: number): boolean => typeof v === 'number' && isFinite(v)

const SIGNAL_BANDS: Array<{ min: number; max: number; key: AnalysisSignalKey; label: string }> = [
  { min: 80, max: 100, key: 'strong_buy', label: '强烈买入' },
  { min: 60, max: 79, key: 'buy', label: '买入' },
  { min: 40, max: 59, key: 'watch', label: '观望' },
  { min: 20, max: 39, key: 'reduce', label: '减仓' },
  { min: 0, max: 19, key: 'sell', label: '卖出' },
]

const signalForScore = (score: number): { key: AnalysisSignalKey; label: string } => {
  const band = SIGNAL_BANDS.find((b) => score >= b.min && score <= b.max)
  return band ? { key: band.key, label: band.label } : { key: 'watch', label: '观望' }
}

/** 缩容去重，保留最多 n 个（按与现价的距离排序，不改变传入顺序） */
const unique = (values: number[]): number[] => {
  const out: number[] = []
  for (const v of values) {
    if (isFiniteNum(v) && v > 0 && !out.some((x) => Math.abs(x - v) < 1e-6)) out.push(v)
  }
  return out
}

const sortAsc = (values: number[]): number[] => [...values].sort((a, b) => a - b)
const sortDesc = (values: number[]): number[] => [...values].sort((a, b) => b - a)

export async function analyzeStock(code: string, name?: string): Promise<StockAnalysisResult> {
  const bars = await getKlineWithCache(code, 'day')
  const fallback: StockAnalysisResult = {
    code,
    name: name ?? code,
    price: 0,
    changePct: 0,
    score: 0,
    signalKey: 'watch',
    signalLabel: '数据不足',
    summary: 'K 线数据不足，无法完成完整分析。',
    dimensions: [],
    trend: { status: '数据不足', alignment: '', trendStrength: 0, ma5: 0, ma10: 0, ma20: 0, ma60: 0, biasMa5: 0, biasMa10: 0, biasMa20: 0 },
    macd: { dif: 0, dea: 0, bar: 0, status: '数据不足', signal: '' },
    rsi: { rsi6: 0, rsi12: 0, rsi24: 0, status: '数据不足', signal: '' },
    volume: { ratio5d: 0, status: '数据不足', meaning: '' },
    levels: { support: [], resistance: [], stopLoss: 0, target: 0 },
    reasons: [],
    risks: [],
    dataQuality: 'insufficient',
    disclaimer: '本分析由技术指标自动生成，仅供参考，不构成投资建议',
  }
  if (bars.length < 20) return fallback

  const dataQuality: StockAnalysisResult['dataQuality'] = bars.length >= 60 ? 'full' : 'partial'
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp)
  const closes = sorted.map((b) => b.close)
  const highs = sorted.map((b) => b.high)
  const lows = sorted.map((b) => b.low)
  const volumes = sorted.map((b) => b.volume || 0)
  const last = sorted[sorted.length - 1]
  const prev = sorted[sorted.length - 2]
  const price = last.close

  // 均线
  const ma5Arr = sma(closes, 5)
  const ma10Arr = sma(closes, 10)
  const ma20Arr = sma(closes, 20)
  const ma60Arr = bars.length >= 60 ? sma(closes, 60) : ma20Arr
  const i = closes.length - 1
  const ma5 = ma5Arr[i] ?? 0
  const ma10 = ma10Arr[i] ?? 0
  const ma20 = ma20Arr[i] ?? 0
  const ma60 = ma60Arr[i] ?? 0

  // 乖离率
  const bias = (ma: number) => (ma > 0 ? ((price - ma) / ma) * 100 : 0)
  const biasMa5 = bias(ma5)
  const biasMa10 = bias(ma10)
  const biasMa20 = bias(ma20)

  // 趋势
  let trendStatus = '盘整'
  let trendStrength = 50
  if (ma5 > ma10 && ma10 > ma20) {
    const prevIdx = Math.max(0, i - 5)
    const prevSpread = ma20 > 0 ? ((ma5Arr[prevIdx]! - ma20Arr[prevIdx]!) / ma20Arr[prevIdx]!) * 100 : 0
    const currSpread = ma20 > 0 ? ((ma5 - ma20) / ma20) * 100 : 0
    if (currSpread > prevSpread && currSpread > 5) {
      trendStatus = '强势多头'
      trendStrength = 90
    } else {
      trendStatus = '多头排列'
      trendStrength = 75
    }
  } else if (ma5 > ma10 && ma10 <= ma20) {
    trendStatus = '弱势多头'
    trendStrength = 55
  } else if (ma5 < ma10 && ma10 < ma20) {
    const prevIdx = Math.max(0, i - 5)
    const prevSpread = ma5 > 0 ? ((ma20Arr[prevIdx]! - ma5Arr[prevIdx]!) / ma5Arr[prevIdx]!) * 100 : 0
    const currSpread = ma5 > 0 ? ((ma20 - ma5) / ma5) * 100 : 0
    if (currSpread > prevSpread && currSpread > 5) {
      trendStatus = '强势空头'
      trendStrength = 10
    } else {
      trendStatus = '空头排列'
      trendStrength = 25
    }
  } else if (ma5 < ma10 && ma10 >= ma20) {
    trendStatus = '弱势空头'
    trendStrength = 40
  }

  // 量能
  let ratio5d = 0
  if (volumes.length >= 6) {
    const prev5 = volumes.slice(volumes.length - 6, volumes.length - 1)
    const avg = prev5.reduce((s, v) => s + v, 0) / Math.max(1, prev5.length)
    if (avg > 0) ratio5d = (last.volume || 0) / avg
  }
  const priceChangePct = prev.close > 0 ? ((price - prev.close) / prev.close) * 100 : 0
  let volumeStatus = '量能正常'
  let volumeMeaning = '量能正常'
  if (ratio5d >= 1.5) {
    if (priceChangePct > 0) {
      volumeStatus = '放量上涨'
      volumeMeaning = '放量上涨，多头力量强劲'
    } else {
      volumeStatus = '放量下跌'
      volumeMeaning = '放量下跌，注意风险'
    }
  } else if (ratio5d <= 0.7) {
    if (priceChangePct > 0) {
      volumeStatus = '缩量上涨'
      volumeMeaning = '缩量上涨，上攻动能不足'
    } else {
      volumeStatus = '缩量回调'
      volumeMeaning = '缩量回调，洗盘特征明显（好）'
    }
  }

  // 支撑压力
  const support: number[] = []
  if (ma5 > 0 && Math.abs(price - ma5) / ma5 <= 0.02 && price >= ma5) support.push(ma5)
  if (ma10 > 0 && Math.abs(price - ma10) / ma10 <= 0.02 && price >= ma10) support.push(ma10)
  if (ma20 > 0 && price >= ma20) support.push(ma20)
  const recent20Low = lows.slice(Math.max(0, lows.length - 20)).reduce((a, b) => Math.min(a, b), price)
  if (recent20Low < price) support.push(recent20Low)
  const resistance: number[] = []
  const recent20High = highs.slice(Math.max(0, highs.length - 20)).reduce((a, b) => Math.max(a, b), price)
  if (recent20High > price) resistance.push(recent20High)
  const bollRes = boll(closes)
  const bollUpper = bollRes.upper[i]
  if (bollUpper !== null && bollUpper > price) resistance.push(bollUpper)
  const supportLevels = unique(sortDesc(support.filter((v) => v > 0 && v < price))).slice(0, 2)
  const resistanceLevels = unique(sortAsc(resistance.filter((v) => v > price))).slice(0, 2)
  const recent10Low = lows.slice(Math.max(0, lows.length - 10)).reduce((a, b) => Math.min(a, b), price)
  const stopLoss = round(Math.min(recent10Low * 0.98, (supportLevels[0] ?? recent10Low) * 0.98))
  const target = round(resistanceLevels[0] ?? price * 1.05)

  // MACD
  const macdRes = macd(closes)
  const dif = macdRes.dif[i]
  const dea = macdRes.dea[i]
  const bar = macdRes.hist[i]
  const prevDifDea = macdRes.dif[i - 1] - macdRes.dea[i - 1]
  const currDifDea = dif - dea
  const isGoldenCross = prevDifDea <= 0 && currDifDea > 0
  const isDeathCross = prevDifDea >= 0 && currDifDea < 0
  const isCrossingUpZero = macdRes.dif[i - 1] <= 0 && dif > 0
  const isCrossingDownZero = macdRes.dif[i - 1] >= 0 && dif < 0
  let macdStatus = '多头'
  let macdSignal = '✓ 多头排列，持续上涨'
  if (isGoldenCross && dif > 0) {
    macdStatus = '零轴上金叉'
    macdSignal = '⭐ 零轴上金叉，强烈买入信号'
  } else if (isCrossingUpZero) {
    macdStatus = '上穿零轴'
    macdSignal = '⚡ DIF 上穿零轴，趋势转强'
  } else if (isGoldenCross) {
    macdStatus = '金叉'
    macdSignal = '✅ 金叉，趋势向上'
  } else if (isDeathCross) {
    macdStatus = '死叉'
    macdSignal = '❌ 死叉，趋势向下'
  } else if (isCrossingDownZero) {
    macdStatus = '下穿零轴'
    macdSignal = '⚠️ DIF 下穿零轴，趋势转弱'
  } else if (dif < 0 && dea < 0) {
    macdStatus = '空头'
    macdSignal = '⚠️ 空头排列，持续下跌'
  }

  // RSI
  const rsi6 = rsi(closes, 6)[i]
  const rsi12 = rsi(closes, 12)[i]
  const rsi24 = rsi(closes, 24)[i]
  let rsiStatus = '中性'
  let rsiSignal = `RSI 中性（${rsi12.toFixed(1)}），震荡整理中`
  if (rsi12 > 70) {
    rsiStatus = '超买'
    rsiSignal = `⚠️ RSI 超买（${rsi12.toFixed(1)} > 70），短期回调风险高`
  } else if (rsi12 > 60) {
    rsiStatus = '强势'
    rsiSignal = `✅ RSI 强势（${rsi12.toFixed(1)}），多头力量充足`
  } else if (rsi12 >= 40) {
    rsiStatus = '中性'
    rsiSignal = `RSI 中性（${rsi12.toFixed(1)}），震荡整理中`
  } else if (rsi12 >= 30) {
    rsiStatus = '弱势'
    rsiSignal = `⚡ RSI 弱势（${rsi12.toFixed(1)}），关注反弹`
  } else {
    rsiStatus = '超卖'
    rsiSignal = `⭐ RSI 超卖（${rsi12.toFixed(1)} < 30），反弹机会大`
  }

  // 评分
  const trendScores: Record<string, number> = {
    强势多头: 30,
    多头排列: 26,
    弱势多头: 18,
    盘整: 12,
    弱势空头: 8,
    空头排列: 4,
    强势空头: 0,
  }
  const trendScore = trendScores[trendStatus] ?? 12
  let score = trendScore
  const reasons: string[] = []
  const risks: string[] = []

  if (['强势多头', '多头排列'].includes(trendStatus)) reasons.push(`✅ ${trendStatus}，顺势做多`)
  if (['空头排列', '强势空头'].includes(trendStatus)) risks.push(`⚠️ ${trendStatus}，不宜做多`)

  // 乖离率（20 分，强趋势放宽）
  const baseThreshold = 5
  const isStrongTrend = trendStatus === '强势多头' && trendStrength >= 70
  const effectiveThreshold = isStrongTrend ? baseThreshold * 1.5 : baseThreshold
  let biasScore = 0
  let biasDetail = ''
  const biasValue = isFiniteNum(biasMa5) ? biasMa5 : 0
  if (biasValue < 0) {
    if (biasValue > -3) {
      biasScore = 20
      biasDetail = `价格略低于 MA5（${biasValue.toFixed(1)}%），回踩买点`
    } else if (biasValue > -5) {
      biasScore = 16
      biasDetail = `价格回踩 MA5（${biasValue.toFixed(1)}%），观察支撑`
    } else {
      biasScore = 8
      biasDetail = `乖离率过大（${biasValue.toFixed(1)}%），可能破位`
    }
  } else if (biasValue < 2) {
    biasScore = 18
    biasDetail = `价格贴近 MA5（${biasValue.toFixed(1)}%），介入好时机`
  } else if (biasValue < baseThreshold) {
    biasScore = 14
    biasDetail = `价格略高于 MA5（${biasValue.toFixed(1)}%），可小仓介入`
  } else if (biasValue > effectiveThreshold) {
    biasScore = 4
    biasDetail = `乖离率过高（${biasValue.toFixed(1)}% > ${effectiveThreshold.toFixed(1)}%），严禁追高`
  } else if (isStrongTrend) {
    biasScore = 10
    biasDetail = `强势趋势中乖离率偏高（${biasValue.toFixed(1)}%），可轻仓追踪`
  } else {
    biasScore = 4
    biasDetail = `乖离率过高（${biasValue.toFixed(1)}% > ${baseThreshold}%），严禁追高`
  }
  score += biasScore
  if (biasScore >= 16) reasons.push(`✅ ${biasDetail}`)
  else if (biasScore <= 4) risks.push(`❌ ${biasDetail}`)

  // 量能（15 分）
  const volumeScores: Record<string, number> = {
    缩量回调: 15,
    放量上涨: 12,
    量能正常: 10,
    缩量上涨: 6,
    放量下跌: 0,
  }
  const volumeScore = volumeScores[volumeStatus] ?? 8
  score += volumeScore
  if (volumeStatus === '缩量回调') reasons.push('✅ 缩量回调，主力洗盘')
  if (volumeStatus === '放量下跌') risks.push('⚠️ 放量下跌，注意风险')

  // 支撑（10 分）
  let supportScore = 0
  if (support.includes(ma5)) {
    supportScore += 5
    reasons.push('✅ MA5 支撑有效')
  }
  if (support.includes(ma10)) {
    supportScore += 5
    reasons.push('✅ MA10 支撑有效')
  }
  score += supportScore

  // MACD（15 分）
  const macdScores: Record<string, number> = {
    零轴上金叉: 15,
    金叉: 12,
    上穿零轴: 10,
    多头: 8,
    空头: 2,
    下穿零轴: 0,
    死叉: 0,
  }
  const macdScore = macdScores[macdStatus] ?? 5
  score += macdScore
  if (['零轴上金叉', '金叉'].includes(macdStatus)) reasons.push(`✅ ${macdSignal}`)
  else if (['死叉', '下穿零轴'].includes(macdStatus)) risks.push(`⚠️ ${macdSignal}`)
  else reasons.push(macdSignal)

  // RSI（10 分）
  const rsiScores: Record<string, number> = {
    超卖: 10,
    强势: 8,
    中性: 5,
    弱势: 3,
    超买: 0,
  }
  const rsiScore = rsiScores[rsiStatus] ?? 5
  score += rsiScore
  if (['超卖', '强势'].includes(rsiStatus)) reasons.push(`✅ ${rsiSignal}`)
  else if (rsiStatus === '超买') risks.push(`⚠️ ${rsiSignal}`)
  else reasons.push(rsiSignal)

  const { key: signalKey, label: signalLabel } = signalForScore(score)
  const trendBullish = ['强势多头', '多头排列'].includes(trendStatus)
  const summary =
    score >= 80
      ? '多项指标共振看多，趋势与量能配合较好，可执行买入计划。'
      : score >= 60
        ? trendBullish
          ? '趋势偏多，回踩关键均线可逢低关注。'
          : '综合评分偏多，但需等待趋势确认。'
        : score >= 40
          ? '多空信号分歧，建议观望等待更明确的方向。'
          : score >= 20
            ? '风险明显抬升，建议降低仓位、控制风险。'
            : '趋势或风险显著恶化，建议优先离场观望。'

  return {
    code,
    name: name ?? code,
    price: round(price),
    changePct: round(priceChangePct),
    score,
    signalKey,
    signalLabel,
    summary,
    dimensions: [
      { key: 'trend', name: '趋势', score: trendScore, max: 30, detail: trendStatus, tone: trendScore >= 18 ? 'bullish' : trendScore <= 8 ? 'bearish' : 'neutral' },
      { key: 'bias', name: '乖离率', score: biasScore, max: 20, detail: biasDetail, tone: biasScore >= 16 ? 'bullish' : biasScore <= 4 ? 'bearish' : 'neutral' },
      { key: 'volume', name: '量能', score: volumeScore, max: 15, detail: volumeMeaning, tone: volumeScore >= 12 ? 'bullish' : volumeScore === 0 ? 'bearish' : 'neutral' },
      { key: 'support', name: '支撑', score: supportScore, max: 10, detail: supportScore > 0 ? '均线构成有效支撑' : '暂未回踩到关键均线支撑', tone: supportScore > 0 ? 'bullish' : 'neutral' },
      { key: 'macd', name: 'MACD', score: macdScore, max: 15, detail: macdSignal, tone: macdScore >= 12 ? 'bullish' : macdScore <= 2 ? 'bearish' : 'neutral' },
      { key: 'rsi', name: 'RSI', score: rsiScore, max: 10, detail: rsiSignal, tone: rsiScore >= 8 ? 'bullish' : rsiScore === 0 ? 'bearish' : 'neutral' },
    ],
    trend: {
      status: trendStatus,
      alignment: ma5 > ma10 && ma10 > ma20 ? 'MA5>MA10>MA20' : ma5 < ma10 && ma10 < ma20 ? 'MA5<MA10<MA20' : '均线缠绕',
      trendStrength,
      ma5: round(ma5),
      ma10: round(ma10),
      ma20: round(ma20),
      ma60: round(ma60),
      biasMa5: round(biasMa5),
      biasMa10: round(biasMa10),
      biasMa20: round(biasMa20),
    },
    macd: { dif: round(dif, 4), dea: round(dea, 4), bar: round(bar, 4), status: macdStatus, signal: macdSignal },
    rsi: { rsi6: round(rsi6, 1), rsi12: round(rsi12, 1), rsi24: round(rsi24, 1), status: rsiStatus, signal: rsiSignal },
    volume: { ratio5d: round(ratio5d), status: volumeStatus, meaning: volumeMeaning },
    levels: { support: supportLevels.map((v) => round(v)), resistance: resistanceLevels.map((v) => round(v)), stopLoss, target },
    reasons,
    risks,
    dataQuality,
    disclaimer: '本分析由技术指标自动生成，仅供参考，不构成投资建议',
  }
}
