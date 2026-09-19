/**
 * 按板块拆分推荐：主板 / 创业板 / 科创板 / 北交所。
 *
 * 目的：推荐一多就没法看。全量列表保留，但每块给「重点推荐」（默认最多 5 个），
 * 且重点必须通过个股历史回测准入（见 signal-backtest.ts），宁缺毋滥。
 */

export type BoardKey = 'main' | 'gem' | 'star' | 'bse'

export interface BoardDefinition {
  key: BoardKey
  label: string
  hint: string
  focusLimit: number
}

export const BOARD_DEFINITIONS: BoardDefinition[] = [
  { key: 'main', label: '主板', hint: '沪市 60 / 深市 00（含原中小板）', focusLimit: 5 },
  { key: 'gem', label: '创业板', hint: '深市 300 开头，20% 涨跌幅', focusLimit: 5 },
  { key: 'star', label: '科创板', hint: '沪市 688 开头，20% 涨跌幅', focusLimit: 5 },
  { key: 'bse', label: '北交所', hint: '北交所，30% 涨跌幅', focusLimit: 5 },
]

/** 板块归属：按代码前缀判断，未识别的一律归主板（并在 UI 上不特殊标注） */
export function boardOf(code: string): BoardKey {
  const value = (code ?? '').toLowerCase()
  if (value.startsWith('bj')) return 'bse'
  if (value.startsWith('sz30')) return 'gem'
  if (value.startsWith('sh688')) return 'star'
  return 'main'
}

export function boardLabel(key: BoardKey): string {
  return BOARD_DEFINITIONS.find((item) => item.key === key)?.label ?? '主板'
}
