<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DragonTigerBoardType, DragonTigerRecoItem, EventStockRecoItem, FundStockRecoItem, OpinionStockRecoItem, StrategyConditions, StrategyDefinition, StrategyProgress, StrategyResult } from '../types'
import { aiStrategy, fetchDragonTigerStatus, fetchDragonTigerStockReco, fetchEventStockReco, fetchFundRankStatus, fetchFundStockReco, fetchOpinionStockReco, fetchStrategyDefinitions, getStrategyProgress, refreshDragonTigerRank, refreshFundRank, runStrategy, upsertWatchCandidate } from '../api'
import { useMarket } from '../composables/useMarket'
import { useResearch } from '../composables/useResearch'
import { SW1_INDUSTRIES } from '../data/stocks'
import BatchAnalysisPanel from './BatchAnalysisPanel.vue'
import StrategyLab from './StrategyLab.vue'
import StrategyOptimizer from './StrategyOptimizer.vue'
import FusionPanel from './FusionPanel.vue'
import CandidateQueueBar from './CandidateQueueBar.vue'
import CandidateWorkbench from './CandidateWorkbench.vue'
import CandidateReviewPanel from './CandidateReviewPanel.vue'

const { setView, setMobileTab, isMobile, watchlist, state } = useMarket()
const {
  openCandidate,
  activeCandidateCode,
  getActiveCandidate,
  consumeScreenerSeed,
  refreshCandidates,
} = useResearch()

/* ---- 表单状态 ---- */
const f = ref({
  minChangePct: '',
  maxChangePct: '',
  minTurnover: '',
  minVolumeRatio: '',
  minPe: '',
  maxPe: '',
  minMktcap: '',
  maxMktcap: '',
  minAmount: '',
  maxPrice: '',
})
const pool = ref<'all' | 'watchlist'>('all')
const indicator = ref('none')
const industry = ref('')
const requireRecentEvent = ref(false)
const eventLookbackDays = ref('7')

const strategyDefinitions = ref<StrategyDefinition[]>([])
const technicalStrategies = computed(() => strategyDefinitions.value.filter((s) => s.category === 'technical'))
const quantStrategies = computed(() => strategyDefinitions.value.filter((s) => s.category === 'quant'))

const INDICATORS = [
  { key: 'none', label: '不限（仅快照条件）' },
  { key: 'ma5_10_cross_up', label: 'MA5 上穿 MA10（金叉）' },
  { key: 'ma5_10_cross_down', label: 'MA5 下穿 MA10（死叉）' },
  { key: 'above_ma20', label: '站上 MA20' },
  { key: 'below_ma20', label: '跌破 MA20' },
  { key: 'macd_golden', label: 'MACD 金叉' },
  { key: 'macd_dead', label: 'MACD 死叉' },
  { key: 'kdj_golden', label: 'KDJ 金叉' },
  { key: 'kdj_dead', label: 'KDJ 死叉' },
  { key: 'rsi_oversold', label: 'RSI 超卖（<30）' },
  { key: 'rsi_overbought', label: 'RSI 超买（>70）' },
  { key: 'boll_break_up', label: '突破 BOLL 上轨' },
]

/* ---- 运行 ---- */
const running = ref(false)
const error = ref('')
const results = ref<StrategyResult[]>([])
const ran = ref(false)
const progress = ref<StrategyProgress>({
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  hits: 0,
  message: '',
})
let progressTimer: number | undefined

function startProgressPoll() {
  stopProgressPoll()
  progress.value = { running: true, phase: 'preparing', done: 0, total: 0, hits: 0, message: '正在准备…' }
  progressTimer = window.setInterval(async () => {
    try {
      progress.value = await getStrategyProgress()
    } catch {
      /* 轮询失败不打断选股 */
    }
  }, 400)
}

function stopProgressPoll() {
  if (progressTimer !== undefined) {
    window.clearInterval(progressTimer)
    progressTimer = undefined
  }
}

const progressPct = computed(() => {
  if (progress.value.total > 0) return Math.min(100, Math.round((progress.value.done / progress.value.total) * 100))
  return progress.value.running ? 8 : 0
})
const progressIndeterminate = computed(() => progress.value.running && progress.value.total <= 0)
const showAdvanced = ref(!isMobile.value)
const selectedStrategies = ref<string[]>([])
const resultListRef = ref<HTMLDivElement | null>(null)
const showBatch = ref(false)
const showStrategyLab = ref(false)
const showOptimizer = ref(false)
const showFusion = ref(false)
const resultMode = ref<'technical' | 'event' | 'opinion' | 'fund' | 'dragon'>('technical')
const eventRecoDays = ref(7)
const eventReco = ref<EventStockRecoItem[]>([])
const eventRecoLoading = ref(false)
const eventRecoError = ref('')
const eventRecoRan = ref(false)
const opinionRecoDays = ref(60)
const opinionReco = ref<OpinionStockRecoItem[]>([])
const opinionRecoLoading = ref(false)
const opinionRecoError = ref('')
const opinionRecoRan = ref(false)
const opinionStanceFilter = ref<'all' | 'bullish' | 'bearish'>('all')
const fundRecoDays = ref(5)
const fundReco = ref<FundStockRecoItem[]>([])
const fundRecoLoading = ref(false)
const fundRecoError = ref('')
const fundRecoRan = ref(false)
const fundRefreshing = ref(false)
const fundPoolSize = ref(0)
const fundLastRefreshAt = ref<number | undefined>()
const fundMinConsecutive = ref(0)
const fundExcludeDown = ref(true)
const dragonBoardType = ref<DragonTigerBoardType>('all')
const dragonReco = ref<DragonTigerRecoItem[]>([])
const dragonRecoLoading = ref(false)
const dragonRecoError = ref('')
const dragonRecoRan = ref(false)
const dragonRefreshing = ref(false)
const dragonPoolSize = ref(0)
const dragonTradeDate = ref<string | undefined>()
const dragonLastRefreshAt = ref<number | undefined>()
const dragonConfigured = ref(true)
const dragonExcludeDown = ref(true)
const dragonNetOnly = ref(true)
const backtestDefaultCodes = computed(() => {
  const codes = watchlist.value.map((stock) => stock.code)
  return codes.length ? codes : [state.currentCode]
})

// 桌面端默认展开高级条件；移动端默认收起，突出 AI 输入
watch(isMobile, (v) => {
  showAdvanced.value = !v
})

onMounted(async () => {
  try {
    strategyDefinitions.value = await fetchStrategyDefinitions()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  await refreshCandidates()
  applyScreenerSeed()
})

async function loadEventReco() {
  eventRecoLoading.value = true
  eventRecoError.value = ''
  try {
    const resp = await fetchEventStockReco({
      days: eventRecoDays.value,
      limit: 40,
      watchlist: watchlist.value.map((s) => s.code),
    })
    eventReco.value = resp.items
    eventRecoRan.value = true
  } catch (e) {
    eventRecoError.value = e instanceof Error ? e.message : String(e)
  } finally {
    eventRecoLoading.value = false
  }
}

async function loadOpinionReco() {
  opinionRecoLoading.value = true
  opinionRecoError.value = ''
  try {
    const resp = await fetchOpinionStockReco({
      days: opinionRecoDays.value,
      limit: 40,
      stance: opinionStanceFilter.value,
    })
    opinionReco.value = resp.items
    opinionRecoRan.value = true
  } catch (e) {
    opinionRecoError.value = e instanceof Error ? e.message : String(e)
  } finally {
    opinionRecoLoading.value = false
  }
}

async function loadFundReco() {
  fundRecoLoading.value = true
  fundRecoError.value = ''
  try {
    const [resp, status] = await Promise.all([
      fetchFundStockReco({
        days: fundRecoDays.value,
        limit: 40,
        minConsecutive: fundMinConsecutive.value || undefined,
        excludeDown: fundExcludeDown.value ? -5 : undefined,
      }),
      fetchFundRankStatus().catch(() => null),
    ])
    fundReco.value = resp.items
    fundRecoRan.value = true
    fundPoolSize.value = resp.poolSize || status?.poolSize || 0
    fundLastRefreshAt.value = resp.lastRefreshAt ?? status?.lastRefreshAt
  } catch (e) {
    fundRecoError.value = e instanceof Error ? e.message : String(e)
  } finally {
    fundRecoLoading.value = false
  }
}

async function refreshFundPool() {
  fundRefreshing.value = true
  fundRecoError.value = ''
  try {
    const result = await refreshFundRank({
      watchlist: watchlist.value.map((s) => s.code),
      topAmount: 300,
    })
    fundPoolSize.value = result.poolSize
    fundLastRefreshAt.value = result.updatedAt
    await loadFundReco()
  } catch (e) {
    fundRecoError.value = e instanceof Error ? e.message : String(e)
  } finally {
    fundRefreshing.value = false
  }
}

async function loadDragonReco() {
  dragonRecoLoading.value = true
  dragonRecoError.value = ''
  try {
    const prefer =
      dragonBoardType.value === 'org' ? 'org' : dragonBoardType.value === 'hot_money' ? 'hot' : 'net'
    const [resp, status] = await Promise.all([
      fetchDragonTigerStockReco({
        boardType: dragonBoardType.value,
        prefer,
        limit: 40,
        minNet: dragonNetOnly.value ? 0 : -1e18,
        excludeDown: dragonExcludeDown.value ? -5 : undefined,
      }),
      fetchDragonTigerStatus().catch(() => null),
    ])
    dragonReco.value = resp.items
    dragonRecoRan.value = true
    dragonPoolSize.value = resp.poolSize || status?.poolSize || 0
    dragonTradeDate.value = resp.tradeDate ?? status?.tradeDate
    dragonLastRefreshAt.value = resp.lastRefreshAt ?? status?.lastRefreshAt
    dragonConfigured.value = resp.configured ?? status?.configured ?? true
  } catch (e) {
    dragonRecoError.value = e instanceof Error ? e.message : String(e)
  } finally {
    dragonRecoLoading.value = false
  }
}

async function refreshDragonPool() {
  dragonRefreshing.value = true
  dragonRecoError.value = ''
  try {
    const result = await refreshDragonTigerRank({ boardType: dragonBoardType.value })
    dragonPoolSize.value = result.poolSize
    dragonTradeDate.value = result.tradeDate
    dragonLastRefreshAt.value = result.updatedAt
    dragonConfigured.value = true
    await loadDragonReco()
  } catch (e) {
    dragonRecoError.value = e instanceof Error ? e.message : String(e)
  } finally {
    dragonRefreshing.value = false
  }
}

function switchResultMode(mode: 'technical' | 'event' | 'opinion' | 'fund' | 'dragon') {
  resultMode.value = mode
  if (mode === 'event' && !eventRecoRan.value) void loadEventReco()
  if (mode === 'opinion' && !opinionRecoRan.value) void loadOpinionReco()
  if (mode === 'fund' && !fundRecoRan.value) void loadFundReco()
  if (mode === 'dragon' && !dragonRecoRan.value) {
    void (async () => {
      const st = await fetchDragonTigerStatus().catch(() => null)
      dragonConfigured.value = st?.configured ?? true
      if (st?.configured && (st.poolSize ?? 0) === 0) await refreshDragonPool()
      else await loadDragonReco()
    })()
  }
}

watch(eventRecoDays, () => {
  if (resultMode.value === 'event') void loadEventReco()
})

watch([opinionRecoDays, opinionStanceFilter], () => {
  if (resultMode.value === 'opinion') void loadOpinionReco()
})

watch([fundRecoDays, fundMinConsecutive, fundExcludeDown], () => {
  if (resultMode.value === 'fund') void loadFundReco()
})

watch(dragonBoardType, () => {
  if (resultMode.value === 'dragon') void refreshDragonPool()
})

watch([dragonExcludeDown, dragonNetOnly], () => {
  if (resultMode.value === 'dragon') void loadDragonReco()
})

function applyScreenerSeed() {
  const seed = consumeScreenerSeed()
  if (!seed) return
  if (seed.industry) industry.value = seed.industry
  if (seed.requireRecentEvent) {
    requireRecentEvent.value = true
    if (seed.eventLookbackDays) {
      eventLookbackDays.value = String(seed.eventLookbackDays)
      eventRecoDays.value = seed.eventLookbackDays
    }
    switchResultMode('event')
  }
  if (seed.opinionDriven) {
    if (seed.opinionLookbackDays) opinionRecoDays.value = seed.opinionLookbackDays
    switchResultMode('opinion')
  }
  showAdvanced.value = true
  if (seed.note) aiExplanation.value = seed.note
}

onBeforeUnmount(() => stopProgressPoll())

function toggleStrategy(key: string) {
  const idx = selectedStrategies.value.indexOf(key)
  if (idx >= 0) selectedStrategies.value.splice(idx, 1)
  else selectedStrategies.value.push(key)
}

function scrollResultsTop() {
  resultListRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

function backToMarket() {
  if (isMobile.value) setMobileTab('market')
  else setView('market')
}

/* ---- AI 选股 ---- */
const aiText = ref('')
const aiRunning = ref(false)
const aiExplanation = ref('')

const n2s = (v: number | undefined) => (v === undefined ? '' : String(v))

async function aiSearch() {
  const t = aiText.value.trim()
  if (!t || aiRunning.value) return
  aiRunning.value = true
  error.value = ''
  results.value = []
  aiExplanation.value = ''
  ran.value = true
  startProgressPoll()
  try {
    const resp = await aiStrategy(t, watchlist.value.map((w) => w.code))
    aiExplanation.value = resp.explanation
    results.value = resp.results
    // 回填解析出的条件到表单
    const c = resp.conditions
    f.value = {
      minChangePct: n2s(c.minChangePct),
      maxChangePct: n2s(c.maxChangePct),
      minTurnover: n2s(c.minTurnover),
      minVolumeRatio: n2s(c.minVolumeRatio),
      minPe: n2s(c.minPe),
      maxPe: n2s(c.maxPe),
      minMktcap: n2s(c.minMktcap),
      maxMktcap: n2s(c.maxMktcap),
      minAmount: n2s(c.minAmount),
      maxPrice: n2s(c.maxPrice),
    }
    pool.value = c.pool
    indicator.value = c.indicator
    industry.value = c.industry ?? ''
    selectedStrategies.value = c.strategies ?? []
    requireRecentEvent.value = !!c.requireRecentEvent
    eventLookbackDays.value = n2s(c.eventLookbackDays) || '7'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    stopProgressPoll()
    try { progress.value = await getStrategyProgress() } catch { /* ignore */ }
    aiRunning.value = false
  }
}

const num = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() !== '' && isFinite(n) ? n : undefined
}

const conditions = computed<StrategyConditions>(() => ({
  minChangePct: num(f.value.minChangePct),
  maxChangePct: num(f.value.maxChangePct),
  minTurnover: num(f.value.minTurnover),
  minVolumeRatio: num(f.value.minVolumeRatio),
  minPe: num(f.value.minPe),
  maxPe: num(f.value.maxPe),
  minMktcap: num(f.value.minMktcap),
  maxMktcap: num(f.value.maxMktcap),
  minAmount: num(f.value.minAmount),
  maxPrice: num(f.value.maxPrice),
  industry: industry.value || undefined,
  requireRecentEvent: requireRecentEvent.value || undefined,
  eventLookbackDays: requireRecentEvent.value ? num(eventLookbackDays.value) ?? 7 : undefined,
  pool: pool.value,
  watchlist: watchlist.value.map((w) => w.code),
  strategies: selectedStrategies.value,
  indicator: indicator.value,
}))

async function run() {
  running.value = true
  error.value = ''
  results.value = []
  ran.value = true
  startProgressPoll()
  try {
    results.value = await runStrategy(conditions.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    stopProgressPoll()
    try { progress.value = await getStrategyProgress() } catch { /* ignore */ }
    running.value = false
  }
}

function resetForm() {
  f.value = {
    minChangePct: '',
    maxChangePct: '',
    minTurnover: '',
    minVolumeRatio: '',
    minPe: '',
    maxPe: '',
    minMktcap: '',
    maxMktcap: '',
    minAmount: '',
    maxPrice: '',
  }
  pool.value = 'all'
  indicator.value = 'none'
  industry.value = ''
  requireRecentEvent.value = false
  eventLookbackDays.value = '7'
  selectedStrategies.value = []
  results.value = []
  ran.value = false
}

async function openResult(r: StrategyResult) {
  await openCandidate(r.code, {
    name: r.name,
    source: 'strategy',
    context: {
      reason: r.reason,
      strategies: r.strategies,
      conditionsSummary: [
        industry.value && `行业 ${industry.value}`,
        requireRecentEvent.value && `近${eventLookbackDays.value || 7}日有一级事件`,
        selectedStrategies.value.length && `策略 ${selectedStrategies.value.join(',')}`,
      ].filter(Boolean).join(' · '),
    },
  })
}

async function openEventRecoItem(item: EventStockRecoItem) {
  await openCandidate(item.code, {
    name: item.name,
    industry: item.industry,
    source: 'event',
    context: {
      reason: item.reason,
      eventId: item.relatedEventIds[0],
      eventTitle: item.headlines[0],
      industry: item.industry,
      note: item.headlines.slice(0, 2).join(' · '),
    },
  })
}

async function enqueueAllResults() {
  for (const r of results.value.slice(0, 50)) {
    await upsertWatchCandidate({
      code: r.code,
      name: r.name,
      source: 'strategy',
      context: { reason: r.reason, strategies: r.strategies },
    })
  }
  await refreshCandidates()
}

async function enqueueAllEventReco() {
  for (const item of eventReco.value.slice(0, 50)) {
    await upsertWatchCandidate({
      code: item.code,
      name: item.name,
      industry: item.industry,
      source: 'event',
      context: {
        reason: item.reason,
        eventId: item.relatedEventIds[0],
        eventTitle: item.headlines[0],
        industry: item.industry,
      },
    })
  }
  await refreshCandidates()
}

async function openOpinionRecoItem(item: OpinionStockRecoItem) {
  await openCandidate(item.code, {
    name: item.name,
    industry: item.industry,
    source: 'opinion',
    context: {
      reason: item.reason,
      authors: item.authors,
      industry: item.industry,
      note: item.theses.slice(0, 2).join(' · '),
      recommendation: item.stance === 'bullish' ? 'recommend' : item.stance === 'bearish' ? 'avoid' : 'observe',
    },
  })
}

async function enqueueAllOpinionReco() {
  for (const item of opinionReco.value.slice(0, 50)) {
    await upsertWatchCandidate({
      code: item.code,
      name: item.name,
      industry: item.industry,
      source: 'opinion',
      context: {
        reason: item.reason,
        authors: item.authors,
        industry: item.industry,
        note: item.theses[0],
        recommendation: item.stance === 'bullish' ? 'recommend' : item.stance === 'bearish' ? 'avoid' : 'observe',
      },
    })
  }
  await refreshCandidates()
}

async function openFundRecoItem(item: FundStockRecoItem) {
  await openCandidate(item.code, {
    name: item.name,
    industry: item.industry,
    source: 'fund',
    context: {
      reason: item.reason,
      industry: item.industry,
      note: `主力近${item.lookbackDays}日 ${(item.mainNetSum / 1e8).toFixed(2)}亿`,
    },
  })
}

async function enqueueAllFundReco() {
  for (const item of fundReco.value.slice(0, 50)) {
    await upsertWatchCandidate({
      code: item.code,
      name: item.name,
      industry: item.industry,
      source: 'fund',
      context: { reason: item.reason, industry: item.industry },
    })
  }
  await refreshCandidates()
}

async function openDragonRecoItem(item: DragonTigerRecoItem) {
  await openCandidate(item.code, {
    name: item.name,
    industry: item.industry,
    source: 'dragon',
    context: {
      reason: item.reason,
      industry: item.industry,
      note: item.limitReason || item.concepts[0],
    },
  })
}

async function enqueueAllDragonReco() {
  for (const item of dragonReco.value.slice(0, 50)) {
    await upsertWatchCandidate({
      code: item.code,
      name: item.name,
      industry: item.industry,
      source: 'dragon',
      context: { reason: item.reason, industry: item.industry, note: item.limitReason },
    })
  }
  await refreshCandidates()
}

const activeCandidate = computed(() => getActiveCandidate())

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const fmtPct = (v: number) => (v > 0 ? '+' : '') + v.toFixed(2) + '%'
const sourceLabel = (s: EventStockRecoItem['source']) => (s === 'direct' ? '点名' : '板块代表')
const stanceLabel = (s: string) => ({ bullish: '看多', bearish: '看空', neutral: '中性' }[s] ?? s)
const dragonBoardLabel = (b: DragonTigerBoardType) =>
  ({ all: '全部', org: '机构', hot_money: '游资' }[b] ?? b)
const formatFundTime = (value?: number) => {
  if (!value) return '尚未刷新'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
const fmtYi = (v: number) => `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(2)}亿`
</script>

<template>
  <div class="strategy-page">
    <div class="sp-header">
      <button class="btn" @click="backToMarket">← 返回看盘</button>
      <span class="sp-title">研究选股</span>
      <span class="sp-sub">多通道选股 · 观察队列 · 可持续性验证</span>
      <div class="sp-header-actions">
        <button class="btn" @click="showStrategyLab = true">策略实验室</button>
        <button class="btn" @click="showOptimizer = true">参数优化</button>
        <button class="btn" @click="showFusion = true">融合选股</button>
        <button class="btn" @click="showBatch = true">批量分析</button>
      </div>
    </div>

    <CandidateQueueBar />
    <CandidateReviewPanel />

    <BatchAnalysisPanel v-if="showBatch" @close="showBatch = false" />
    <StrategyLab
      v-if="showStrategyLab"
      :strategies="strategyDefinitions"
      :selected-keys="selectedStrategies"
      :default-codes="backtestDefaultCodes"
      @close="showStrategyLab = false"
    />
    <StrategyOptimizer
      v-if="showOptimizer"
      :strategies="strategyDefinitions"
      :default-codes="backtestDefaultCodes"
      @close="showOptimizer = false"
    />
    <FusionPanel
      v-if="showFusion"
      :conditions="conditions"
      @close="showFusion = false"
    />

    <div class="sp-main">
      <!-- 左：选股条件 -->
      <div class="sp-form">
        <div class="ai-box">
          <textarea
            v-model="aiText"
            rows="3"
            placeholder="AI 选股：用自然语言描述条件，如「医药行业、市值100亿以上、MACD金叉、涨幅不超过5%」"
          ></textarea>
          <button class="btn st-run ai-run" :disabled="aiRunning || running" @click="aiSearch">
            {{ aiRunning ? '选股中…' : 'AI 选股' }}
          </button>
        </div>
        <div v-if="aiExplanation" class="ai-explain">🤖 解析：{{ aiExplanation }}</div>

        <div class="sp-section-title">
          <span>技术形态策略</span>
          <span class="st-tip-inline">可多选，取交集</span>
        </div>
        <div class="sp-strategy-chips">
          <button
            v-for="st in technicalStrategies"
            :key="st.key"
            class="sp-chip"
            :class="{ active: selectedStrategies.includes(st.key) }"
            :title="st.description"
            @click="toggleStrategy(st.key)"
          >
            {{ st.name }}
          </button>
        </div>

        <div class="sp-section-title">
          <span>量化多因子策略</span>
          <span class="st-tip-inline">单因子/多因子初筛</span>
        </div>
        <div class="sp-strategy-chips">
          <button
            v-for="st in quantStrategies"
            :key="st.key"
            class="sp-chip"
            :class="{ active: selectedStrategies.includes(st.key) }"
            :title="st.description"
            @click="toggleStrategy(st.key)"
          >
            {{ st.name }}
          </button>
        </div>

        <div class="sp-section-title">
          <span>高级条件</span>
          <button class="btn" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? '收起 ▲' : '展开 ▼' }}
          </button>
        </div>

        <template v-if="showAdvanced">
        <div class="st-row">
          <label>标的池</label>
          <select v-model="pool" class="select">
            <option value="all">全市场</option>
            <option value="watchlist">自选股</option>
          </select>
        </div>
        <div class="st-row">
          <label>行业</label>
          <select v-model="industry" class="select">
            <option value="">不限</option>
            <option v-for="ind in SW1_INDUSTRIES" :key="ind" :value="ind">{{ ind }}</option>
          </select>
        </div>
        <div class="st-row">
          <label>一级资讯</label>
          <div class="st-event">
            <label class="st-check">
              <input v-model="requireRecentEvent" type="checkbox" />
              近
            </label>
            <input v-model="eventLookbackDays" type="number" min="1" max="30" class="num st-event-days" :disabled="!requireRecentEvent" />
            <span>日须有事件</span>
          </div>
        </div>
        <div class="st-row">
          <label>涨跌幅 %</label>
          <div class="st-range">
            <input v-model="f.minChangePct" type="number" placeholder="≥" class="num" />
            <span>~</span>
            <input v-model="f.maxChangePct" type="number" placeholder="≤" class="num" />
          </div>
        </div>
        <div class="st-row">
          <label>换手率 % ≥</label>
          <input v-model="f.minTurnover" type="number" placeholder="如 3" class="num st-input" />
        </div>
        <div class="st-row">
          <label>量比 ≥</label>
          <input v-model="f.minVolumeRatio" type="number" placeholder="如 2" class="num st-input" />
        </div>
        <div class="st-row">
          <label>市盈率（亏损为负/0）</label>
          <div class="st-range">
            <input v-model="f.minPe" type="number" placeholder="≥" class="num" />
            <span>~</span>
            <input v-model="f.maxPe" type="number" placeholder="≤" class="num" />
          </div>
        </div>
        <div class="st-row">
          <label>总市值（亿）</label>
          <div class="st-range">
            <input v-model="f.minMktcap" type="number" placeholder="≥" class="num" />
            <span>~</span>
            <input v-model="f.maxMktcap" type="number" placeholder="≤" class="num" />
          </div>
        </div>
        <div class="st-row">
          <label>成交额（亿）≥</label>
          <input v-model="f.minAmount" type="number" placeholder="如 10" class="num st-input" />
        </div>
        <div class="st-row">
          <label>价格 ≤</label>
          <input v-model="f.maxPrice" type="number" placeholder="如 100" class="num st-input" />
        </div>
        <div class="st-row">
          <label>技术指标</label>
          <select v-model="indicator" class="select">
            <option v-for="it in INDICATORS" :key="it.key" :value="it.key">{{ it.label }}</option>
          </select>
        </div>

        <div class="st-actions">
          <button class="btn st-run" :disabled="running || aiRunning" @click="run">
            {{ running ? '选股中…' : '开始选股' }}
          </button>
          <button class="btn" @click="resetForm">重置</button>
        </div>
        <div class="st-tip">
          技术指标基于日K：首次运行需逐只拉取候选股K线（稍慢），建议先在「全市场」页执行「全量预取日K」，之后秒级返回。
        </div>
        </template>
      </div>

      <!-- 右：选股结果 -->
      <div class="sp-results">
        <div class="st-mode-tabs">
          <button
            :class="{ active: resultMode === 'technical' }"
            @click="switchResultMode('technical')"
          >
            技术选股
          </button>
          <button
            :class="{ active: resultMode === 'event' }"
            @click="switchResultMode('event')"
          >
            事件驱动
          </button>
          <button
            :class="{ active: resultMode === 'opinion' }"
            @click="switchResultMode('opinion')"
          >
            观点驱动
          </button>
          <button
            :class="{ active: resultMode === 'fund' }"
            @click="switchResultMode('fund')"
          >
            资金驱动
          </button>
          <button
            :class="{ active: resultMode === 'dragon' }"
            @click="switchResultMode('dragon')"
          >
            龙虎榜
          </button>
        </div>

        <template v-if="resultMode === 'event'">
          <div class="st-event-toolbar">
            <label>
              近
              <select v-model.number="eventRecoDays">
                <option :value="3">3 日</option>
                <option :value="7">7 日</option>
                <option :value="14">14 日</option>
              </select>
            </label>
            <button class="btn" :disabled="eventRecoLoading" @click="loadEventReco">
              {{ eventRecoLoading ? '聚合中…' : '刷新荐股' }}
            </button>
          </div>
          <div v-if="eventRecoError" class="st-error down">{{ eventRecoError }}</div>
          <div v-if="eventRecoLoading && !eventReco.length" class="st-empty">正在按事件聚合荐股…</div>
          <div v-else-if="eventRecoRan && !eventReco.length && !eventRecoError" class="st-empty">
            近端无可映射事件。请先到「资讯事件」采集，或等待带标的/板块的资讯入库。
          </div>
          <div v-else-if="eventReco.length" class="st-result-head">
            <span>事件荐股 {{ eventReco.length }} 只</span>
            <button class="btn" @click="enqueueAllEventReco">全部加入观察</button>
          </div>
          <div v-else-if="!eventRecoLoading" class="st-empty">
            切换到此页后点击「刷新荐股」，由一级资讯聚合出股票（点名优先，板块代表次之）。
          </div>
          <div v-if="eventReco.length" class="st-list">
            <button
              v-for="item in eventReco"
              :key="item.code"
              class="st-item st-event-item"
              :class="{ active: item.code === activeCandidateCode }"
              @click="openEventRecoItem(item)"
            >
              <span class="st-name">
                {{ item.name }}
                <span class="st-code num">{{ item.code.toUpperCase() }}</span>
                <span class="st-src" :class="item.source">{{ sourceLabel(item.source) }}</span>
              </span>
              <span class="num st-score">{{ item.score.toFixed(1) }}</span>
              <span class="st-reason">
                {{ item.reason }}
                <template v-if="item.headlines[0]"> · {{ item.headlines[0] }}</template>
              </span>
            </button>
          </div>
        </template>

        <template v-else-if="resultMode === 'opinion'">
          <div class="st-event-toolbar">
            <label>
              近
              <select v-model.number="opinionRecoDays">
                <option :value="30">30 日</option>
                <option :value="60">60 日</option>
                <option :value="90">90 日</option>
                <option :value="180">180 日</option>
              </select>
            </label>
            <label>
              立场
              <select v-model="opinionStanceFilter">
                <option value="all">全部</option>
                <option value="bullish">看多</option>
                <option value="bearish">看空</option>
              </select>
            </label>
            <button class="btn" :disabled="opinionRecoLoading" @click="loadOpinionReco">
              {{ opinionRecoLoading ? '聚合中…' : '刷新荐股' }}
            </button>
          </div>
          <div v-if="opinionRecoError" class="st-error down">{{ opinionRecoError }}</div>
          <div v-if="opinionRecoLoading && !opinionReco.length" class="st-empty">正在按观点共识聚合荐股…</div>
          <div v-else-if="opinionRecoRan && !opinionReco.length && !opinionRecoError" class="st-empty">
            近端无方向性观点共识。请到「观点研究」同步博主或导入原文并完成 AI 抽取。
          </div>
          <div v-else-if="opinionReco.length" class="st-result-head">
            <span>观点荐股 {{ opinionReco.length }} 只</span>
            <button class="btn" @click="enqueueAllOpinionReco">全部加入观察</button>
          </div>
          <div v-else-if="!opinionRecoLoading" class="st-empty">
            切换到此页后点击「刷新荐股」，由博主观点共识聚合出股票。
          </div>
          <div v-if="opinionReco.length" class="st-list">
            <button
              v-for="item in opinionReco"
              :key="item.code"
              class="st-item st-event-item"
              :class="{ active: item.code === activeCandidateCode }"
              @click="openOpinionRecoItem(item)"
            >
              <span class="st-name">
                {{ item.name }}
                <span class="st-code num">{{ item.code.toUpperCase() }}</span>
                <span class="st-src" :class="item.stance">{{ stanceLabel(item.stance) }}</span>
              </span>
              <span class="num st-score" :class="pctCls(item.score)">
                {{ item.score > 0 ? '+' : '' }}{{ item.score.toFixed(0) }}
              </span>
              <span class="st-reason">
                {{ item.reason }}
                <template v-if="item.theses[0]"> · {{ item.theses[0] }}</template>
              </span>
            </button>
          </div>
        </template>

        <template v-else-if="resultMode === 'fund'">
          <div class="st-event-toolbar st-fund-toolbar">
            <label>
              近
              <select v-model.number="fundRecoDays">
                <option :value="3">3 日</option>
                <option :value="5">5 日</option>
                <option :value="10">10 日</option>
              </select>
            </label>
            <label>
              连续≥
              <select v-model.number="fundMinConsecutive">
                <option :value="0">不限</option>
                <option :value="2">2 日</option>
                <option :value="3">3 日</option>
              </select>
            </label>
            <label class="st-check">
              <input v-model="fundExcludeDown" type="checkbox" />
              排除大跌
            </label>
          </div>
          <div class="st-event-toolbar">
            <span class="st-fund-meta">池 {{ fundPoolSize }} · {{ formatFundTime(fundLastRefreshAt) }}</span>
            <button class="btn" :disabled="fundRefreshing" @click="refreshFundPool">
              {{ fundRefreshing ? '刷新池中…' : '刷新资金池' }}
            </button>
            <button class="btn" :disabled="fundRecoLoading || fundPoolSize === 0" @click="loadFundReco">
              {{ fundRecoLoading ? '聚合中…' : '刷新荐股' }}
            </button>
          </div>
          <div v-if="fundRecoError" class="st-error down">{{ fundRecoError }}</div>
          <div v-if="fundRecoLoading && !fundReco.length" class="st-empty">正在聚合资金荐股…</div>
          <div v-else-if="fundPoolSize === 0 && !fundRefreshing" class="st-empty">
            资金池为空。点击「刷新资金池」拉取自选/观察/成交额前列标的的主力净流入（约数分钟）。
          </div>
          <div v-else-if="fundRecoRan && !fundReco.length && !fundRecoError" class="st-empty">
            池内暂无符合条件的净流入标的，可放宽连续流入或关闭「排除大跌」。
          </div>
          <div v-else-if="fundReco.length" class="st-result-head">
            <span>资金荐股 {{ fundReco.length }} 只</span>
            <button class="btn" @click="enqueueAllFundReco">全部加入观察</button>
          </div>
          <div v-if="fundReco.length" class="st-list">
            <button
              v-for="item in fundReco"
              :key="item.code"
              class="st-item st-event-item"
              :class="{ active: item.code === activeCandidateCode }"
              @click="openFundRecoItem(item)"
            >
              <span class="st-name">
                {{ item.name }}
                <span class="st-code num">{{ item.code.toUpperCase() }}</span>
                <span class="st-src fund">连{{ item.consecutiveInflowDays }}日</span>
              </span>
              <span class="num st-score up">{{ fmtYi(item.mainNetSum) }}</span>
              <span class="st-reason">{{ item.reason }}</span>
            </button>
          </div>
        </template>

        <template v-else-if="resultMode === 'dragon'">
          <div class="st-event-toolbar st-fund-toolbar">
            <label>
              榜单
              <select v-model="dragonBoardType">
                <option value="all">全部</option>
                <option value="org">机构</option>
                <option value="hot_money">游资</option>
              </select>
            </label>
            <label class="st-check">
              <input v-model="dragonNetOnly" type="checkbox" />
              仅净买入
            </label>
            <label class="st-check">
              <input v-model="dragonExcludeDown" type="checkbox" />
              排除大跌
            </label>
          </div>
          <div class="st-event-toolbar">
            <span class="st-fund-meta">
              {{ dragonTradeDate || '无交易日' }} · {{ dragonBoardLabel(dragonBoardType) }} ·
              池 {{ dragonPoolSize }} · {{ formatFundTime(dragonLastRefreshAt) }}
            </span>
            <button class="btn" :disabled="dragonRefreshing || !dragonConfigured" @click="refreshDragonPool">
              {{ dragonRefreshing ? '拉取中…' : '刷新龙虎榜' }}
            </button>
            <button class="btn" :disabled="dragonRecoLoading || dragonPoolSize === 0" @click="loadDragonReco">
              {{ dragonRecoLoading ? '聚合中…' : '刷新荐股' }}
            </button>
          </div>
          <div v-if="!dragonConfigured" class="st-error down">未配置 FUYAO_API_KEY，请写入服务端 .env 后重启。</div>
          <div v-if="dragonRecoError" class="st-error down">{{ dragonRecoError }}</div>
          <div v-if="dragonRecoLoading && !dragonReco.length" class="st-empty">正在聚合龙虎榜荐股…</div>
          <div v-else-if="dragonPoolSize === 0 && !dragonRefreshing && dragonConfigured" class="st-empty">
            龙虎榜为空。点击「刷新龙虎榜」拉取最近交易日上榜股（扶摇）。
          </div>
          <div v-else-if="dragonRecoRan && !dragonReco.length && !dragonRecoError" class="st-empty">
            暂无符合条件的上榜标的，可切换榜单或关闭「仅净买入 / 排除大跌」。
          </div>
          <div v-else-if="dragonReco.length" class="st-result-head">
            <span>龙虎荐股 {{ dragonReco.length }} 只</span>
            <button class="btn" @click="enqueueAllDragonReco">全部加入观察</button>
          </div>
          <div v-if="dragonReco.length" class="st-list">
            <button
              v-for="item in dragonReco"
              :key="item.code"
              class="st-item st-event-item"
              :class="{ active: item.code === activeCandidateCode }"
              @click="openDragonRecoItem(item)"
            >
              <span class="st-name">
                {{ item.name }}
                <span class="st-code num">{{ item.code.toUpperCase() }}</span>
                <span class="st-src dragon">{{ dragonBoardLabel(item.boardType) }}</span>
              </span>
              <span class="num st-score" :class="pctCls(item.netValue)">{{ fmtYi(item.netValue) }}</span>
              <span class="st-reason">{{ item.reason }}</span>
            </button>
          </div>
        </template>

        <template v-else>
        <div v-if="error" class="st-error down">{{ error }}</div>
        <div v-if="running || aiRunning" class="st-progress">
          <div class="st-progress-head">
            <span>{{ progress.message || '选股进行中…' }}</span>
            <span class="num" v-if="progress.total > 0">{{ progressPct }}%</span>
          </div>
          <div class="st-progress-track">
            <div
              class="st-progress-bar"
              :class="{ indeterminate: progressIndeterminate }"
              :style="progressIndeterminate ? undefined : { width: progressPct + '%' }"
            ></div>
          </div>
          <div class="st-progress-meta" v-if="progress.total > 0">
            已检查 {{ progress.done }}/{{ progress.total }}
            <template v-if="progress.hits"> · 已命中 {{ progress.hits }} 只</template>
          </div>
        </div>
        <div v-if="ran && !running && !aiRunning && results.length === 0 && !error" class="st-empty">
          没有符合条件的股票，试试放宽条件
        </div>
        <div v-else-if="results.length" class="st-result-head">
          <span>结果 {{ results.length }} 条</span>
          <button class="btn" @click="enqueueAllResults">全部加入观察</button>
        </div>
        <div v-else-if="!running && !aiRunning" class="st-empty">填写左侧条件后点击「开始选股」，或用 AI 选股输入自然语言</div>
        <button
          v-if="results.length > 8"
          class="st-back-top"
          @click="scrollResultsTop"
        >
          回到顶部 ↑
        </button>
        <div ref="resultListRef" v-if="results.length" class="st-list">
          <button
            v-for="r in results"
            :key="r.code"
            class="st-item"
            :class="{ active: r.code === activeCandidateCode }"
            @click="openResult(r)"
          >
            <span class="st-name">
              {{ r.name }}
              <span class="st-code num">{{ r.code.toUpperCase() }}</span>
            </span>
            <span class="num st-price" :class="pctCls(r.changePct)">{{ r.price.toFixed(2) }}</span>
            <span class="num st-pct" :class="pctCls(r.changePct)">{{ fmtPct(r.changePct) }}</span>
            <span class="st-reason">{{ r.reason }}</span>
          </button>
        </div>
        </template>
      </div>

      <CandidateWorkbench
        class="sp-workbench"
        :candidate="activeCandidate"
        :code="activeCandidateCode"
      />
    </div>
  </div>
</template>

<style scoped>
.strategy-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.sp-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.sp-title {
  font-size: 15px;
  font-weight: 700;
}
.sp-sub {
  font-size: 12px;
  color: var(--text-3);
}
.sp-header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.sp-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* 左：表单 */
.sp-form {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

/* 中：结果 */
.sp-results {
  position: relative;
  width: 320px;
  flex-shrink: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
}

.st-mode-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.st-mode-tabs button {
  flex: 1;
  height: 34px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.st-mode-tabs button.active {
  color: var(--primary);
  box-shadow: inset 0 -2px 0 var(--primary);
  background: var(--panel);
}
.st-event-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-3);
}
.st-event-toolbar select {
  height: 26px;
  margin: 0 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text-1);
}
.st-event-item .st-score {
  font-weight: 700;
  color: var(--primary);
}
.st-src {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
}
.st-src.direct {
  color: var(--up);
  background: rgba(20, 177, 67, .1);
}
.st-src.proxy {
  color: var(--text-3);
  background: var(--panel-2);
}
.st-src.bullish {
  color: var(--up);
  background: rgba(20, 177, 67, .1);
}
.st-src.bearish {
  color: var(--down);
  background: rgba(239, 35, 42, .08);
}
.st-src.neutral {
  color: var(--text-3);
  background: var(--panel-2);
}
.st-src.fund {
  color: #0f766e;
  background: rgba(15, 118, 110, .1);
}
.st-src.dragon {
  color: #b45309;
  background: rgba(180, 83, 9, .1);
}
.st-fund-toolbar {
  flex-wrap: wrap;
}
.st-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.st-fund-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-right: auto;
}

.sp-workbench {
  flex: 1;
  min-width: 0;
}

.ai-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-box textarea {
  width: 100%;
  min-height: 64px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
}
.ai-box textarea:focus {
  border-color: var(--primary);
}
.ai-run {
  align-self: flex-end;
}
.ai-explain {
  font-size: 11px;
  color: var(--text-2);
  background: rgba(30, 111, 255, 0.06);
  border: 1px solid rgba(30, 111, 255, 0.2);
  border-radius: 6px;
  padding: 6px 8px;
  line-height: 1.5;
}
.sp-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
  padding-top: 4px;
  border-top: 1px dashed var(--border);
}
.st-tip-inline {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}
.sp-strategy-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 6px;
}
.sp-chip {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.sp-chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.sp-chip.active {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(30, 111, 255, 0.08);
  font-weight: 600;
}
.sp-section-title .btn {
  font-size: 11px;
  padding: 3px 8px;
}

.st-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.st-row label {
  flex-shrink: 0;
}
.st-row .select {
  flex: 1;
}
.st-range {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}
.st-range input {
  flex: 1;
  min-width: 0;
}
.st-input {
  flex: 1;
}
.st-row input {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: none;
  font-size: 12px;
  text-align: right;
}
.st-row input:focus {
  border-color: var(--primary);
}
.st-event {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: flex-end;
  font-size: 12px;
  color: var(--text-2);
}
.st-check {
  display: flex;
  align-items: center;
  gap: 4px;
}
.st-check input {
  width: auto;
  height: auto;
  text-align: left;
}
.st-event-days {
  width: 52px;
  flex: 0 0 52px;
}

.st-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.st-run {
  flex: 1;
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  font-weight: 600;
}
.st-run:hover {
  background: #165cd6;
  color: #fff;
}
.st-run:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.st-tip {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}

.st-error {
  padding: 8px 12px;
  font-size: 12px;
}
.st-progress {
  margin: 12px 16px;
  padding: 12px 14px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.st-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.st-progress-track {
  position: relative;
  height: 8px;
  margin-top: 10px;
  border-radius: 999px;
  background: #e8edf5;
  overflow: hidden;
}
.st-progress-bar {
  height: 100%;
  width: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, #1e6fff, #4d94ff);
  transition: width 0.25s ease;
}
.st-progress-bar.indeterminate {
  width: 36%;
  animation: st-progress-slide 1.2s ease-in-out infinite;
}
.st-progress-meta {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-3);
}
@keyframes st-progress-slide {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(320%); }
}
.st-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}
.st-result-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}
.st-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
.st-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  -webkit-overflow-scrolling: touch;
}
.st-back-top {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 10;
  padding: 6px 12px;
  border: none;
  border-radius: 16px;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  box-shadow: 0 2px 8px rgba(30, 111, 255, 0.35);
  cursor: pointer;
}
.st-item {
  display: grid;
  grid-template-columns: 1fr 90px 90px;
  gap: 4px 12px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  border-bottom: 1px solid #f0f1f4;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  transition: background 0.12s;
}
.st-item:hover {
  background: rgba(30, 111, 255, 0.05);
}
.st-item.active {
  background: rgba(30, 111, 255, 0.08);
  box-shadow: inset 3px 0 0 var(--primary);
}
.st-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-weight: 600;
}
.st-code {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}
.st-price,
.st-pct {
  text-align: right;
  font-weight: 600;
}
.st-reason {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--text-3);
}

@media (max-width: 820px) {
  .sp-main {
    flex-direction: column;
  }
  .sp-form {
    width: 100%;
    flex-shrink: 1;
    border-right: none;
    border-bottom: 1px solid var(--border);
    max-height: 40%;
  }
  .sp-results {
    width: 100%;
    flex: 0 0 auto;
    max-height: 28%;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .sp-workbench {
    flex: 1;
    min-height: 220px;
  }
}
</style>
