import { computed, ref } from 'vue'
import {
  fetchWatchCandidates,
  removeWatchCandidate as apiRemoveCandidate,
  setWatchCandidateStatus as apiSetStatus,
  upsertWatchCandidate,
} from '../api'
import type {
  CandidateContext,
  CandidateSource,
  CandidateStatus,
  ScreenerSeed,
  WatchCandidate,
} from '../types'
import { stockNameOf } from '../data/stocks'
import { selectStock, setMobileTab, setView, isMobile, state as marketState } from './useMarket'

/** 观察队列（服务端持久化，前端缓存） */
const candidates = ref<WatchCandidate[]>([])
const activeCandidateCode = ref<string | null>(null)
const workbenchOpen = ref(false)
const loadingCandidates = ref(false)
/** 反向进料：行业/事件带回选股器 */
const screenerSeed = ref<ScreenerSeed | null>(null)

export type OpenCandidateOptions = {
  name?: string
  industry?: string
  source?: CandidateSource
  context?: CandidateContext
  /** 是否写入/更新观察队列，默认 true */
  enqueue?: boolean
  /** 打开后切到选股工作台，默认 true */
  goWorkbench?: boolean
  /** 同时更新行情当前股 */
  syncMarket?: boolean
}

export async function refreshCandidates(): Promise<WatchCandidate[]> {
  loadingCandidates.value = true
  try {
    candidates.value = await fetchWatchCandidates()
    return candidates.value
  } finally {
    loadingCandidates.value = false
  }
}

export function getActiveCandidate(): WatchCandidate | null {
  if (!activeCandidateCode.value) return null
  return candidates.value.find((c) => c.code === activeCandidateCode.value) ?? null
}

const activeIndex = computed(() => {
  if (!activeCandidateCode.value) return -1
  return candidates.value.findIndex((c) => c.code === activeCandidateCode.value)
})

export async function openCandidate(code: string, options: OpenCandidateOptions = {}): Promise<WatchCandidate | null> {
  const normalized = code.trim().toLowerCase()
  if (!/^(sh|sz|bj)\d{6}$/.test(normalized)) return null
  const name = options.name ?? stockNameOf(normalized)
  const enqueue = options.enqueue !== false
  const goWorkbench = options.goWorkbench !== false
  const syncMarket = options.syncMarket !== false

  let candidate: WatchCandidate | null = null
  if (enqueue) {
    candidate = await upsertWatchCandidate({
      code: normalized,
      name,
      industry: options.industry ?? options.context?.industry,
      source: options.source ?? 'manual',
      context: options.context,
    })
    const idx = candidates.value.findIndex((c) => c.code === normalized)
    if (idx >= 0) candidates.value.splice(idx, 1, candidate)
    else candidates.value.unshift(candidate)
  } else {
    candidate = candidates.value.find((c) => c.code === normalized) ?? null
  }

  activeCandidateCode.value = normalized
  if (syncMarket) selectStock(normalized, name)

  if (goWorkbench) {
    workbenchOpen.value = true
    if (isMobile.value) setMobileTab('strategy')
    else setView('strategy')
  }
  return candidate
}

export async function setCandidateStatus(code: string, status: CandidateStatus): Promise<void> {
  const updated = await apiSetStatus(code, status)
  const idx = candidates.value.findIndex((c) => c.code === updated.code)
  if (idx >= 0) candidates.value.splice(idx, 1, updated)
  else candidates.value.unshift(updated)
}

export async function removeCandidate(code: string): Promise<void> {
  const normalized = code.trim().toLowerCase()
  await apiRemoveCandidate(normalized)
  const idx = candidates.value.findIndex((c) => c.code === normalized)
  if (idx >= 0) candidates.value.splice(idx, 1)
  if (activeCandidateCode.value === normalized) {
    const next = candidates.value[Math.min(idx, candidates.value.length - 1)]
    activeCandidateCode.value = next?.code ?? null
    if (next) selectStock(next.code, next.name)
  }
}

export function nextCandidate(): string | null {
  if (candidates.value.length === 0) return null
  const i = activeIndex.value
  const next = candidates.value[(i + 1) % candidates.value.length]
  activeCandidateCode.value = next.code
  selectStock(next.code, next.name)
  workbenchOpen.value = true
  return next.code
}

export function prevCandidate(): string | null {
  if (candidates.value.length === 0) return null
  const i = activeIndex.value < 0 ? 0 : activeIndex.value
  const prev = candidates.value[(i - 1 + candidates.value.length) % candidates.value.length]
  activeCandidateCode.value = prev.code
  selectStock(prev.code, prev.name)
  workbenchOpen.value = true
  return prev.code
}

export function closeWorkbench() {
  workbenchOpen.value = false
}

export function openWorkbench() {
  workbenchOpen.value = true
  if (isMobile.value) setMobileTab('strategy')
  else setView('strategy')
}

/** 从行业/事件跳转选股器并预填条件 */
export function seedScreener(seed: ScreenerSeed) {
  screenerSeed.value = seed
  if (isMobile.value) setMobileTab('strategy')
  else setView('strategy')
}

export function consumeScreenerSeed(): ScreenerSeed | null {
  const seed = screenerSeed.value
  screenerSeed.value = null
  return seed
}

export function goFullChart(code?: string, name?: string) {
  const c = code ?? activeCandidateCode.value ?? marketState.currentCode
  const n = name ?? candidates.value.find((x) => x.code === c)?.name ?? marketState.currentName
  selectStock(c, n)
  activeCandidateCode.value = c
  if (isMobile.value) setMobileTab('market')
  else setView('market')
}

export function useResearch() {
  return {
    candidates,
    activeCandidateCode,
    workbenchOpen,
    loadingCandidates,
    screenerSeed,
    activeIndex,
    refreshCandidates,
    getActiveCandidate,
    openCandidate,
    setCandidateStatus,
    removeCandidate,
    nextCandidate,
    prevCandidate,
    closeWorkbench,
    openWorkbench,
    seedScreener,
    consumeScreenerSeed,
    goFullChart,
  }
}
