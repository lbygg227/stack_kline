import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backtestLimitUpPools,
  classifySectorStage,
  computeSectorTrends,
  type DayPool,
  type SectorHistoryFile,
} from './limit-up-history.ts'

function pool(partial: Partial<DayPool> & Pick<DayPool, 'date'>): DayPool {
  return {
    limitUp: {},
    limitDown: [],
    broken: [],
    nextPremium: {},
    nextChange: {},
    hold3: {},
    hold3FromClose: {},
    sealedAllDay: {},
    maxBoard: 0,
    ladder: {},
    ...partial,
  }
}

test('打板收益与接力收益按不同口径统计', () => {
  const pools: DayPool[] = [
    pool({
      date: '2026-01-05',
      limitUp: { sh600000: 1, sh600001: 2 },
      nextPremium: { sh600000: 5, sh600001: -3 },
      nextChange: { sh600000: 8, sh600001: -6 },
      hold3: { sh600000: 6, sh600001: -4 },
      hold3FromClose: { sh600000: 10, sh600001: -8 },
      maxBoard: 2,
      ladder: { '1': 1, '2': 1 },
    }),
    pool({
      date: '2026-01-06',
      limitUp: { sh600002: 1 },
      nextPremium: { sh600002: 2 },
      nextChange: { sh600002: 4 },
      hold3: { sh600002: 1 },
      hold3FromClose: { sh600002: 3 },
      maxBoard: 1,
      ladder: { '1': 1 },
    }),
  ]
  const result = backtestLimitUpPools(pools, { minSamples: 1 })
  assert.equal(result.overall.samples, 3)
  // 全样本打板均值 = (8 - 6 + 4)/3 = 2
  assert.equal(result.overall.averageNextChange, 2)
  // 接力均值 = (5 - 3 + 2)/3 ≈ 1.33
  assert.equal(result.overall.averageNextPremium, 1.33)
  assert.equal(result.overall.nextChangeWinRate, 66.7)
  // 按板位分组：首板 2 个样本、2 板 1 个
  const first = result.byBoard.find((item) => item.bucket === '1板')
  assert.equal(first?.samples, 2)
})

test('一字板样本被可成交口径剔除', () => {
  const pools: DayPool[] = [
    pool({
      date: '2026-01-05',
      limitUp: { sh600000: 1, sh600001: 1 },
      nextPremium: { sh600000: 9, sh600001: 1 },
      nextChange: { sh600000: 12, sh600001: 2 },
      sealedAllDay: { sh600000: true, sh600001: false },
      maxBoard: 1,
      ladder: { '1': 2 },
    }),
    pool({ date: '2026-01-06', limitUp: {}, maxBoard: 0 }),
  ]
  const result = backtestLimitUpPools(pools, { minSamples: 1 })
  assert.equal(result.overall.samples, 2)
  assert.equal(result.executable.excluded, 1, '一字板样本应被剔除')
  assert.equal(result.executable.overall.samples, 1)
  assert.equal(result.executable.overall.averageNextChange, 2, '剩余样本是可成交的那只')
})
const SECTOR_DATES = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13', '2026-01-14']

function sectorSeries(name: string, counts: number[], changes: number[]): SectorHistoryFile['sectors'][number] {
  return {
    name,
    type: 'concept',
    points: counts.map((count, index) => ({
      date: SECTOR_DATES[index],
      count,
      maxBoard: count ? 1 : 0,
      avgChangePct: changes[index] ?? 0,
      amountYi: 10,
      upCount: 1,
      downCount: 0,
    })),
  }
}

test('板块阶段区分「刚启动」和「已经涨了一周」', () => {
  const file: SectorHistoryFile = {
    version: 1,
    updatedAt: Date.now(),
    startDate: SECTOR_DATES[0],
    endDate: SECTOR_DATES.at(-1) as string,
    dates: SECTOR_DATES,
    sectors: [
      // 连续第 2 天出现涨停、5 日涨幅还没走出来 → 刚启动
      sectorSeries('刚启动概念', [0, 0, 0, 0, 0, 0, 1, 2], [0, 0, 0, 0, 0, 0, 1.5, 1]),
      // 连续 3 天升温、5 日涨幅 3.5% → 持续升温
      sectorSeries('持续升温概念', [0, 0, 0, 0, 0, 1, 2, 3], [0, 0, 0, 0, 0, 1, 1, 1.5]),
      // 连续 3 天升温、5 日涨幅 9.26% → 已在高位
      sectorSeries('高位概念', [0, 0, 0, 0, 1, 1, 2, 3], [0, 0, 0, 0, 0, 2, 3, 4]),
      // 涨停家数持续萎缩 + 近 5 日累计下跌 → 退潮
      sectorSeries('退潮概念', [4, 4, 3, 2, 2, 1, 1, 1], [-2, -1, -3, -3, -2, -2, -1, -1]),
    ],
  }
  const trends = computeSectorTrends(file, { limit: 20 })
  const stageOf = (name: string) => trends.find((item) => item.name === name)?.stage
  assert.equal(stageOf('刚启动概念'), '刚启动')
  assert.equal(stageOf('持续升温概念'), '持续升温')
  assert.equal(stageOf('高位概念'), '高位')
  assert.equal(stageOf('退潮概念'), '退潮')
  // 5 日动量按日涨幅复利累计：1.02 × 1.03 × 1.04 = 1.0926
  assert.equal(trends.find((item) => item.name === '高位概念')?.change5d, 9.26)
})

test('板块阶段判定阈值可解释', () => {
  assert.equal(classifySectorStage({ trend: '升温', streak: 1, today: 2, change5d: 0.5 }), '刚启动')
  // 只有 1 家涨停，点火证据不足
  assert.equal(classifySectorStage({ trend: '升温', streak: 1, today: 1, change5d: 0.5 }), '持续升温')
  // 刚出现 2 天但 5 日动量仍为负 → 还没走出来
  assert.equal(classifySectorStage({ trend: '升温', streak: 2, today: 3, change5d: -2 }), '震荡')
  assert.equal(classifySectorStage({ trend: '升温', streak: 3, today: 3, change5d: 3 }), '持续升温')
  assert.equal(classifySectorStage({ trend: '升温', streak: 3, today: 3, change5d: 9 }), '高位')
  // 宽概念 streak 常年很长，但涨幅没走出来时不能算高位
  assert.equal(classifySectorStage({ trend: '升温', streak: 5, today: 4, change5d: 2 }), '持续升温')
  assert.equal(classifySectorStage({ trend: '升温', streak: 5, today: 4, change5d: 5 }), '高位')
  assert.equal(classifySectorStage({ trend: '退潮', streak: 0, today: 0, change5d: -5 }), '退潮')
  assert.equal(classifySectorStage({ trend: '持平', streak: 2, today: 3, change5d: 6 }), '震荡')
})
