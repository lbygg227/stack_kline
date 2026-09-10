import { reactive, ref } from 'vue'
import type { Quote, StockInfo } from '../types'
import { DEFAULT_WATCHLIST, INDEX_LIST, stockNameOf } from '../data/stocks'
import { fetchQuotes } from '../api'
import { loadWatchlist, removeFromWatchlist as removeWatch, removeFromWatchlistMany as removeWatchMany, saveWatchlist, addToWatchlist as addWatch } from '../data/watchlist'

export type DesktopView = 'recommend' | 'market' | 'all-market' | 'events' | 'strategy' | 'opinion' | 'backtest' | 'simulation' | 'data'
export type MobileTab = 'recommend' | 'market' | 'watchlist' | 'all' | 'events' | 'strategy' | 'opinion' | 'backtest' | 'simulation' | 'trade' | 'data'

interface MarketState {
  currentCode: string
  currentName: string
  periodKey: string
  quote: Quote | null
  indexQuotes: Quote[]
  watchQuotes: Record<string, Quote>
  refreshing: boolean
  view: DesktopView
  showTradePanel: boolean
}

const state = reactive<MarketState>({
  currentCode: 'sh600519',
  currentName: '贵州茅台',
  periodKey: 'day',
  quote: null,
  indexQuotes: [],
  watchQuotes: {},
  refreshing: false,
  view: 'recommend',
  showTradePanel: false,
})

/** 是否移动端窄屏（与各组件 CSS 断点保持一致：820px） */
const isMobile = ref(false)
/** 移动端底部导航当前页 */
const mobileTab = ref<MobileTab>('market')
/** 自选股列表（localStorage 持久化） */
const watchlist = ref<StockInfo[]>(loadWatchlist())

let mobileMq: MediaQueryList | null = null
let mobileInitialized = false

/** 初始化移动端检测（App 挂载时调用，幂等） */
export function initMobile(): void {
  if (mobileInitialized) return
  mobileInitialized = true
  const apply = (mq: MediaQueryList | MediaQueryListEvent) => {
    isMobile.value = mq.matches
  }
  mobileMq = window.matchMedia('(max-width: 820px)')
  apply(mobileMq)
  mobileMq.addEventListener?.('change', apply)
}

const quoteMap = (list: Quote[]) => {
  const map: Record<string, Quote> = {}
  for (const q of list) map[q.code] = q
  return map
}

/** 刷新指数栏 + 自选列表 + 当前股票报价 */
export async function refreshQuotes() {
  if (state.refreshing) return
  state.refreshing = true
  try {
    const codes = [...INDEX_LIST.map((i) => i.code), ...watchlist.value.map((w) => w.code), state.currentCode]
    const unique = Array.from(new Set(codes))
    const list = await fetchQuotes(unique)
    const map = quoteMap(list)
    state.indexQuotes = INDEX_LIST.map((i) => map[i.code]).filter(Boolean) as Quote[]
    state.watchQuotes = map
    if (map[state.currentCode]) state.quote = map[state.currentCode]
  } finally {
    state.refreshing = false
  }
}

/** 选择股票：移动端自动切回行情页；桌面端保持现有联动 */
export function selectStock(code: string, name?: string) {
  if (code === state.currentCode) {
    if (isMobile.value) {
      mobileTab.value = 'market'
      state.view = 'market'
    }
    return
  }
  state.currentCode = code
  state.currentName = name ?? stockNameOf(code)
  if (isMobile.value) {
    mobileTab.value = 'market'
    state.view = 'market'
  }
  void refreshQuotes()
}

export function addToWatchlist(code: string, name?: string) {
  const next = addWatch(watchlist.value, code, name)
  if (next === watchlist.value) return false
  watchlist.value = next
  void refreshQuotes()
  return true
}

export function toggleWatchlist(code: string, name?: string) {
  if (watchlist.value.some((s) => s.code === code)) {
    removeFromWatchlist(code)
    return false
  }
  addToWatchlist(code, name)
  return true
}

export function isInWatchlist(code: string): boolean {
  return watchlist.value.some((s) => s.code === code)
}

export function removeFromWatchlist(code: string) {
  watchlist.value = removeWatch(watchlist.value, code)
  void refreshQuotes()
}

export function removeFromWatchlistMany(codes: string[]) {
  if (codes.length === 0) return
  watchlist.value = removeWatchMany(watchlist.value, codes)
  void refreshQuotes()
}

export function resetWatchlist() {
  watchlist.value = [...DEFAULT_WATCHLIST]
  saveWatchlist(watchlist.value)
  void refreshQuotes()
}

export function setPeriod(key: string) {
  state.periodKey = key
}

export function setView(view: DesktopView) {
  state.view = view
}

export function toggleTradePanel() {
  state.showTradePanel = !state.showTradePanel
}

export function setMobileTab(tab: MobileTab) {
  mobileTab.value = tab
  if (tab === 'strategy') state.view = 'strategy'
  else if (tab === 'opinion') state.view = 'opinion'
  else if (tab === 'data') state.view = 'data'
  else if (tab === 'all') state.view = 'all-market'
  else if (tab === 'events') state.view = 'events'
  else if (tab === 'recommend') state.view = 'recommend'
  else if (tab === 'backtest') state.view = 'backtest'
  else if (tab === 'simulation') state.view = 'simulation'
  else state.view = 'market'
}

/** 供顶部指数栏 / 自选列表展示用的简化摘要 */
export function displayQuote(code: string): Quote | undefined {
  return state.watchQuotes[code] ?? state.indexQuotes.find((q) => q.code === code)
}

export function useMarket() {
  return {
    state,
    isMobile,
    mobileTab,
    watchlist,
    refreshQuotes,
    selectStock,
    addToWatchlist,
    toggleWatchlist,
    isInWatchlist,
    removeFromWatchlist,
    removeFromWatchlistMany,
    resetWatchlist,
    setPeriod,
    setView,
    setMobileTab,
    displayQuote,
    initMobile,
    toggleTradePanel,
  }
}

export { INDEX_LIST, state, isMobile, mobileTab, watchlist }
