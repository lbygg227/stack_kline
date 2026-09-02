import { runBacktest, type BacktestResult } from './backtest.ts'
import { SCREENING_STRATEGIES } from './screening-strategies.ts'
import type { KLineBar } from './tencent.ts'

export interface StrategyParameterRange {
  min: number
  max: number
  step: number
}

export interface StrategyOptimizationConfig {
  strategyKey: string
  codes: string[]
  parameterRanges: Record<string, StrategyParameterRange>
  holdingDays: number
  splitRatio: number
  objective: 'averageExcess' | 'averageReturn' | 'winRate' | 'sharpe'
  minTrades: number
  benchmarkCode: string
  maxCombinations: number
}

export interface StrategyOptimizationTrial {
  parameters: Record<string, number>
  score: number
  trades: number
  winRate: number
  averageReturnPct: number
  averageExcessReturnPct?: number
  approximateSharpe?: number
}

export interface StrategyOptimizationResult {
  config: StrategyOptimizationConfig
  splitDate: string
  testStartDate: string
  combinations: number
  trials: StrategyOptimizationTrial[]
  bestParameters: Record<string, number>
  training: BacktestResult
  testing: BacktestResult
  degradationPct?: number
  warnings: string[]
}

const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => new Date(msOf(timestamp)).toISOString().slice(0, 10)
const round = (value: number, digits = 4): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function valuesFor(
  range: StrategyParameterRange | undefined,
  schema: { default: number; min: number; max: number; step: number },
): number[] {
  if (!range) return [schema.default]
  const min = Math.max(schema.min, Math.min(schema.max, Number(range.min)))
  const max = Math.max(min, Math.min(schema.max, Number(range.max)))
  const step = Math.max(schema.step, Number(range.step) || schema.step)
  const values: number[] = []
  for (let value = min; value <= max + step / 1000 && values.length < 12; value += step) {
    values.push(round(value, 6))
  }
  return values.length ? values : [schema.default]
}

function combinationsOf(
  entries: Array<[string, number[]]>,
  maxCombinations: number,
): Array<Record<string, number>> {
  let combinations: Array<Record<string, number>> = [{}]
  for (const [key, values] of entries) {
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [key]: value })))
    if (combinations.length > maxCombinations) {
      throw new Error(`参数组合数 ${combinations.length} 超过上限 ${maxCombinations}，请增大步长或缩小范围`)
    }
  }
  return combinations
}

function objectiveScore(result: BacktestResult, objective: StrategyOptimizationConfig['objective']): number {
  if (objective === 'averageExcess') return result.metrics.averageExcessReturnPct ?? -Infinity
  if (objective === 'averageReturn') return result.metrics.averageReturnPct
  if (objective === 'winRate') return result.metrics.winRate
  return result.metrics.approximateSharpe ?? -Infinity
}

export async function optimizeStrategy(
  raw: Partial<StrategyOptimizationConfig>,
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<StrategyOptimizationResult> {
  const definition = SCREENING_STRATEGIES.find((strategy) => strategy.key === raw.strategyKey)
  if (!definition?.backtestable) throw new Error('请选择一个可使用历史行情验证的策略')
  const codes = [...new Set(raw.codes ?? [])].filter((code) => /^(sh|sz|bj)\d{6}$/.test(code)).slice(0, 50)
  if (!codes.length) throw new Error('请提供至少一个有效股票代码')
  const config: StrategyOptimizationConfig = {
    strategyKey: definition.key,
    codes,
    parameterRanges: raw.parameterRanges ?? {},
    holdingDays: Math.max(1, Math.min(120, Math.round(raw.holdingDays ?? 20))),
    splitRatio: Math.max(0.5, Math.min(0.85, raw.splitRatio ?? 0.7)),
    objective: ['averageExcess', 'averageReturn', 'winRate', 'sharpe'].includes(raw.objective ?? '')
      ? raw.objective!
      : 'averageExcess',
    minTrades: Math.max(1, Math.round(raw.minTrades ?? 5)),
    benchmarkCode: /^(sh|sz)\d{6}$/.test(raw.benchmarkCode ?? '') ? raw.benchmarkCode! : 'sh000300',
    maxCombinations: Math.max(1, Math.min(200, Math.round(raw.maxCombinations ?? 100))),
  }
  const cache = new Map<string, Promise<KLineBar[]>>()
  const cachedLoad = (code: string) => {
    let task = cache.get(code)
    if (!task) {
      task = loadBars(code)
      cache.set(code, task)
    }
    return task
  }
  const loaded = await Promise.all(codes.map((code) => cachedLoad(code).catch(() => [])))
  const dates = [...new Set(loaded.flatMap((bars) => bars.map((bar) => dayOf(bar.timestamp))))].sort()
  if (dates.length < 60) throw new Error('历史交易日不足60日，无法进行训练/样本外切分')
  const splitIndex = Math.max(30, Math.min(dates.length - 20, Math.floor(dates.length * config.splitRatio)))
  const splitDate = dates[splitIndex - 1]
  const testStartDate = dates[splitIndex]
  const combinations = combinationsOf(
    definition.params.map((schema) => [schema.key, valuesFor(config.parameterRanges[schema.key], schema)]),
    config.maxCombinations,
  )
  const evaluated: Array<{ trial: StrategyOptimizationTrial; result: BacktestResult }> = []
  for (const parameters of combinations) {
    const result = await runBacktest({
      strategyKeys: [definition.key],
      strategyParams: { [definition.key]: parameters },
      codes,
      holdingDays: config.holdingDays,
      combineMode: 'all',
      endDate: splitDate,
      benchmarkCode: config.benchmarkCode,
    }, cachedLoad)
    const score = result.metrics.trades >= config.minTrades
      ? objectiveScore(result, config.objective)
      : -Infinity
    evaluated.push({
      result,
      trial: {
        parameters,
        score: Number.isFinite(score) ? round(score) : -999999,
        trades: result.metrics.trades,
        winRate: result.metrics.winRate,
        averageReturnPct: result.metrics.averageReturnPct,
        averageExcessReturnPct: result.metrics.averageExcessReturnPct,
        approximateSharpe: result.metrics.approximateSharpe,
      },
    })
  }
  evaluated.sort((a, b) => b.trial.score - a.trial.score || b.trial.trades - a.trial.trades)
  const best = evaluated[0]
  if (!best || best.trial.score <= -999999) {
    throw new Error(`训练区间没有参数组合达到最少 ${config.minTrades} 个交易样本`)
  }
  const testing = await runBacktest({
    strategyKeys: [definition.key],
    strategyParams: { [definition.key]: best.trial.parameters },
    codes,
    holdingDays: config.holdingDays,
    combineMode: 'all',
    startDate: testStartDate,
    benchmarkCode: config.benchmarkCode,
  }, cachedLoad)
  const testScore = objectiveScore(testing, config.objective)
  const degradationPct = Number.isFinite(testScore) && Math.abs(best.trial.score) > 1e-9
    ? (testScore - best.trial.score) / Math.abs(best.trial.score) * 100
    : undefined
  return {
    config,
    splitDate,
    testStartDate,
    combinations: combinations.length,
    trials: evaluated.slice(0, 30).map((item) => item.trial),
    bestParameters: best.trial.parameters,
    training: best.result,
    testing,
    degradationPct: degradationPct === undefined ? undefined : round(degradationPct),
    warnings: [
      '参数只在训练区间排序，样本外区间不参与选参。',
      '组合数量受上限约束，但多次尝试仍可能产生数据挖掘偏差，应优先选择邻域稳定且逻辑可解释的参数。',
      '样本外交易数过少时，结果不应作为策略有效性的结论。',
    ],
  }
}
