<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { FundFlowRankStatus, PrefetchProgress, UpdateStatus } from '../types'
import {
  collectMarketEvents,
  fetchFundRankStatus,
  fetchJin10Status,
  getPrefetchProgress,
  getUpdateStatus,
  startFundRankRefresh,
  runUpdate,
  startPrefetch,
  syncLatestDailyKlines,
} from '../api'

const prefetchProg = ref<PrefetchProgress>({ running: false, done: 0, total: 0, failed: 0 })
const latestBusy = ref(false)
const latestResult = ref('')
const error = ref('')
const updateStatus = ref<UpdateStatus | null>(null)
const updateBusy = ref(false)
const fundStatus = ref<FundFlowRankStatus | null>(null)
const fundResult = ref('')
const fundBusy = ref(false)
const eventBusy = ref(false)
const eventResult = ref('')
const jin10Configured = ref(false)

let pollTimer: number | undefined
let fundPollTimer: number | undefined

async function doPrefetch() {
  if (prefetchProg.value.running) return
  await startPrefetch('day')
  pollPrefetch()
}

async function syncAllLatest() {
  if (latestBusy.value) return
  latestBusy.value = true
  latestResult.value = ''
  error.value = ''
  try {
    const result = await syncLatestDailyKlines()
    const s = result.summary
    latestResult.value = `最新完整交易日 ${result.expectedDate ?? '未知'}：补齐 ${s.synced}，已最新 ${s.current}` +
      `${s.unavailable ? `，停牌或暂无数据 ${s.unavailable}` : ''}` +
      `${s.failed ? `，失败 ${s.failed}` : ''}`
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    latestBusy.value = false
  }
}

async function pollPrefetch() {
  const p = await getPrefetchProgress()
  prefetchProg.value = p
  if (p.running) {
    pollTimer = window.setTimeout(pollPrefetch, 1000)
  }
}

async function loadUpdateStatus() {
  try {
    updateStatus.value = await getUpdateStatus()
  } catch { /* ignore */ }
}

async function doRunUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  try {
    await runUpdate()
    updateStatus.value = await getUpdateStatus()
  } finally {
    updateBusy.value = false
  }
}

async function loadFundStatus() {
  try {
    fundStatus.value = await fetchFundRankStatus()
  } catch { /* ignore */ }
}

async function pollFundStatus() {
  await loadFundStatus()
  if (fundStatus.value?.progress.running) {
    fundPollTimer = window.setTimeout(pollFundStatus, 1000)
  } else {
    fundBusy.value = false
  }
}

async function doFundRefresh() {
  if (fundStatus.value?.progress.running || fundBusy.value) return
  fundBusy.value = true
  fundResult.value = ''
  try {
    await startFundRankRefresh()
    await pollFundStatus()
  } catch (e) {
    fundBusy.value = false
    fundResult.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadJin10Status() {
  try {
    jin10Configured.value = (await fetchJin10Status()).configured
  } catch { /* ignore */ }
}

async function doCollectEvents() {
  if (eventBusy.value) return
  eventBusy.value = true
  eventResult.value = ''
  try {
    const r = await collectMarketEvents()
    eventResult.value = `本次新增 ${r.created} 条 · 当前 ${r.total} 条 · 来源 ${r.provider}${r.message ? ' · ' + r.message : ''}`
  } catch (e) {
    eventResult.value = e instanceof Error ? e.message : String(e)
  } finally {
    eventBusy.value = false
  }
}

const fmtTime = (ts?: number) => {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const pct = (p: PrefetchProgress) => (p.total > 0 ? Math.round((p.done / p.total) * 100) + '%' : '0%')
const fundPct = computed(() => {
  const p = fundStatus.value?.progress
  return p && p.total > 0 ? Math.round((p.done / p.total) * 100) + '%' : '0%'
})

void pollPrefetch()
void loadUpdateStatus()
void loadFundStatus()
void loadJin10Status()

onBeforeUnmount(() => {
  window.clearTimeout(pollTimer)
  window.clearTimeout(fundPollTimer)
})
</script>

<template>
  <div class="data-manage">
    <h2 class="dm-title">数据管理</h2>

    <section class="dm-section">
      <h3 class="dm-label">全量预取日K</h3>
      <p class="dm-desc">将全市场所有股票的日K数据预取到本地，预取后策略/浏览不依赖网络。</p>
      <div class="dm-row">
        <button class="btn" @click="doPrefetch" :disabled="prefetchProg.running">
          {{ prefetchProg.running ? '预取中…' : '开始全量预取' }}
        </button>
        <span v-if="prefetchProg.running" class="dm-hint num">
          {{ prefetchProg.done }}/{{ prefetchProg.total }}
          <template v-if="prefetchProg.failed">（失败 {{ prefetchProg.failed }}）</template>
        </span>
        <span v-else-if="prefetchProg.total > 0" class="dm-hint num">
          已缓存 {{ prefetchProg.total - prefetchProg.failed }} 只日K
        </span>
      </div>
      <div v-if="prefetchProg.running" class="dm-progress">
        <div class="dm-progress-bar" :style="{ width: pct(prefetchProg) }"></div>
      </div>
    </section>

    <section class="dm-section">
      <h3 class="dm-label">检测并补齐最新日K</h3>
      <p class="dm-desc">检查本地缓存与最新交易日的差距，自动补齐缺失数据。</p>
      <div class="dm-row">
        <button class="btn" @click="syncAllLatest" :disabled="latestBusy">
          {{ latestBusy ? '检测补齐中…' : '开始检测补齐' }}
        </button>
      </div>
      <div v-if="latestResult" class="dm-result">{{ latestResult }}</div>
      <div v-if="error" class="dm-result dm-error">{{ error }}</div>
    </section>

    <section class="dm-section">
      <h3 class="dm-label">资金流数据</h3>
      <p class="dm-desc">刷新候选池个股主力资金流，供资金面选股与研究工作台使用。交易时段后会自动刷新一次，也可手动刷新。</p>
      <div class="dm-row">
        <button class="btn" @click="doFundRefresh" :disabled="fundStatus?.progress.running || fundBusy">
          {{ fundStatus?.progress.running || fundBusy ? '刷新中…' : '手动刷新资金流' }}
        </button>
        <span v-if="fundStatus" class="dm-hint">
          候选池 {{ fundStatus.poolSize }} 只 · 上次刷新 {{ fmtTime(fundStatus.lastRefreshAt) }}
        </span>
      </div>
      <div v-if="fundStatus?.progress.running" class="dm-progress">
        <div class="dm-progress-bar" :style="{ width: fundPct }"></div>
      </div>
      <div v-if="fundStatus?.progress.running" class="dm-hint">{{ fundStatus.progress.message }}</div>
      <div v-if="fundStatus?.lastError" class="dm-result dm-error">{{ fundStatus.lastError }}</div>
      <div v-if="fundResult" class="dm-result">{{ fundResult }}</div>
    </section>

    <section class="dm-section">
      <h3 class="dm-label">金十资讯 / 一级事件</h3>
      <p class="dm-desc">金十/一级资讯 7×24 定时采集；需要立即同步时可手动触发。</p>
      <div class="dm-row">
        <button class="btn" @click="doCollectEvents" :disabled="eventBusy">
          {{ eventBusy ? '采集中…' : '立即采集资讯' }}
        </button>
        <span class="dm-hint">{{ jin10Configured ? '金十已配置' : '金十未配置' }}</span>
      </div>
      <div v-if="eventResult" class="dm-result">{{ eventResult }}</div>
    </section>

    <section class="dm-section">
      <h3 class="dm-label">每日自动更新</h3>
      <div v-if="updateStatus" class="dm-update-info">
        <div class="dm-row">
          <span class="dm-desc">
            计划时间：{{ updateStatus.plan.map((p) => p.time).join(' / ') }}（交易日）
          </span>
        </div>
        <div class="dm-row">
          <span class="dm-desc">
            <template v-if="updateStatus.lastRun">上次执行：{{ fmtTime(updateStatus.lastRun) }}</template>
            <template v-if="!updateStatus.isTradingDay"> · 今日非交易日</template>
          </span>
          <button
            class="btn"
            @click="doRunUpdate"
            :disabled="updateBusy || (updateStatus?.running ?? false)"
          >
            {{ updateBusy || updateStatus?.running ? '更新中…' : '立即更新' }}
          </button>
        </div>
        <div v-if="updateStatus.lastResult" class="dm-result">{{ updateStatus.lastResult }}</div>
      </div>
      <div v-else class="dm-desc">状态加载中…</div>
    </section>
  </div>
</template>

<style scoped>
.data-manage {
  display: flex;
  flex-direction: column;
  gap: 0;
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px;
  max-width: 720px;
}

.dm-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-1);
  margin: 0 0 20px;
}

.dm-section {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}

.dm-label {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  margin: 0 0 6px;
}

.dm-desc {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 10px;
  line-height: 1.5;
}

.dm-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.dm-hint {
  font-size: 12px;
  color: var(--text-3);
}

.dm-progress {
  height: 6px;
  border-radius: 3px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  overflow: hidden;
  margin-top: 4px;
}

.dm-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #1e6fff, #4d94ff);
  transition: width 0.4s;
}

.dm-result {
  font-size: 12px;
  color: var(--text-2);
  padding: 8px 12px;
  background: var(--panel-2);
  border-radius: 6px;
  margin-top: 6px;
  line-height: 1.5;
}

.dm-error {
  color: var(--down);
}

.dm-update-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
