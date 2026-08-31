<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { PrefetchProgress, SnapshotStock, UpdateStatus } from '../types'
import { fetchSnapshot, getPrefetchProgress, getUpdateStatus, runUpdate, startPrefetch } from '../api'
import { useMarket } from '../composables/useMarket'
import { usePullRefresh } from '../composables/usePullRefresh'
import { SW1_INDUSTRIES } from '../data/stocks'

const { selectStock, isMobile } = useMarket()
const { distance: ptrDistance, refreshing: ptrRefreshing, onTouchStart: ptrStart, onTouchMove: ptrMove, onTouchEnd: ptrEnd } = usePullRefresh(() => loadSnapshot(true))

const stocks = ref<SnapshotStock[]>([])
const status = ref<'ready' | 'fetching' | 'refreshing'>('fetching')
const progress = ref({ page: 0, count: 0 })
const error = ref('')
const kw = ref('')
const industryFilter = ref('')
const sortKey = ref<'code' | 'name' | 'price' | 'changePct' | 'amount' | 'turnover' | 'mktcap' | 'pe'>('changePct')
const asc = ref(false)
const renderCount = ref(300)
const prefetchProg = ref<PrefetchProgress>({ running: false, done: 0, total: 0, failed: 0 })

let pollTimer: number | undefined
const sheetMode = ref<'industry' | 'sort' | null>(null)

async function loadSnapshot(force = false) {
  try {
    const resp = await fetchSnapshot(force)
    if (resp.status === 'ready' && resp.stocks) {
      stocks.value = resp.stocks
      status.value = 'ready'
      return
    }
    status.value = resp.status
    progress.value = resp.progress ?? { page: 0, count: 0 }
    pollTimer = window.setTimeout(() => void loadSnapshot(), 2000)
  } catch (e) {
    error.value = String(e)
    status.value = 'fetching'
    pollTimer = window.setTimeout(() => void loadSnapshot(), 3000)
  }
}

const SORT_OPTIONS: Array<{ key: typeof sortKey.value; label: string }> = [
  { key: 'changePct', label: '涨跌幅' },
  { key: 'amount', label: '成交额' },
  { key: 'turnover', label: '换手率' },
  { key: 'price', label: '现价' },
  { key: 'mktcap', label: '总市值' },
  { key: 'pe', label: '市盈率' },
  { key: 'code', label: '代码' },
  { key: 'name', label: '名称' },
]

const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase()
  const ind = industryFilter.value
  return stocks.value.filter((s) => {
    if (ind && (s.industry ?? '其他') !== ind) return false
    if (!q) return true
    return s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)
  })
})

const sorted = computed(() => {
  const arr = [...filtered.value]
  const k = sortKey.value
  const dir = asc.value ? 1 : -1
  arr.sort((a, b) => {
    if (k === 'code' || k === 'name') return dir * a[k].localeCompare(b[k], 'zh')
    return dir * ((a[k] as number) - (b[k] as number))
  })
  return arr
})

const visible = computed(() => sorted.value.slice(0, renderCount.value))

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
    renderCount.value += 300
  }
}

async function doPrefetch() {
  if (prefetchProg.value.running) return
  await startPrefetch('day')
  pollPrefetch()
}

async function pollPrefetch() {
  const p = await getPrefetchProgress()
  prefetchProg.value = p
  if (p.running) {
    pollTimer = window.setTimeout(pollPrefetch, 1000)
  }
}

/* ---- 每日自动更新状态 ---- */
const updateStatus = ref<UpdateStatus | null>(null)
const updateBusy = ref(false)

async function loadUpdateStatus() {
  try {
    updateStatus.value = await getUpdateStatus()
  } catch {
    /* 忽略 */
  }
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

const fmtTime = (ts: number) => {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const pct = (p: PrefetchProgress) => (p.total > 0 ? Math.round((p.done / p.total) * 100) + '%' : '0%')
const fmtPrice = (v: number) => v.toFixed(2)
const fmtPct = (v: number) => (v > 0 ? '+' : '') + v.toFixed(2) + '%'
const fmtAmount = (v: number) => (v / 1e8).toFixed(1) // 元 -> 亿

loadSnapshot()
void pollPrefetch()
void loadUpdateStatus()

onBeforeUnmount(() => window.clearTimeout(pollTimer))
</script>

<template>
  <div class="all-market">
    <div class="am-toolbar">
      <input v-model="kw" type="text" placeholder="过滤名称/代码" class="am-search" />
      <template v-if="isMobile">
        <button class="btn" @click="sheetMode = 'industry'">
          行业{{ industryFilter ? '：' + industryFilter : '' }}
        </button>
        <button class="btn" @click="sheetMode = 'sort'">
          排序：{{ SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? '' }}
        </button>
      </template>
      <template v-else>
        <select v-model="industryFilter" class="select">
          <option value="">全部行业</option>
          <option v-for="ind in SW1_INDUSTRIES" :key="ind" :value="ind">{{ ind }}</option>
        </select>
        <select v-model="sortKey" class="select">
          <option v-for="o in SORT_OPTIONS" :key="o.key" :value="o.key">按{{ o.label }}</option>
        </select>
      </template>
      <button class="btn" :class="{ active: asc }" @click="asc = !asc">{{ asc ? '升序' : '降序' }}</button>
      <button class="btn" @click="loadSnapshot(true)" :disabled="status === 'refreshing'">
        {{ status === 'refreshing' ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <Transition name="sheet">
      <div v-if="isMobile && sheetMode" class="am-filter-mask" @click="sheetMode = null">
        <div class="am-filter-sheet" @click.stop>
          <div class="am-filter-head">
            <span>{{ sheetMode === 'industry' ? '选择行业' : '选择排序' }}</span>
            <button class="btn" @click="sheetMode = null">完成</button>
          </div>
          <div v-if="sheetMode === 'industry'" class="am-filter-chips">
            <button
              class="am-chip"
              :class="{ active: industryFilter === '' }"
              @click="industryFilter = ''; sheetMode = null"
            >
              全部
            </button>
            <button
              v-for="ind in SW1_INDUSTRIES"
              :key="ind"
              class="am-chip"
              :class="{ active: industryFilter === ind }"
              @click="industryFilter = ind; sheetMode = null"
            >
              {{ ind }}
            </button>
          </div>
          <div v-else class="am-filter-chips">
            <button
              v-for="o in SORT_OPTIONS"
              :key="o.key"
              class="am-chip"
              :class="{ active: sortKey === o.key }"
              @click="sortKey = o.key; sheetMode = null"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <div class="am-prefetch">
      <button class="btn" @click="doPrefetch" :disabled="prefetchProg.running">
        {{ prefetchProg.running ? '预取中…' : '全量预取日K' }}
      </button>
      <div v-if="prefetchProg.running" class="am-progress">
        <div class="am-progress-bar" :style="{ width: pct(prefetchProg) }"></div>
        <span class="am-progress-text num">
          {{ prefetchProg.done }}/{{ prefetchProg.total }}
          <template v-if="prefetchProg.failed">（失败 {{ prefetchProg.failed }}）</template>
        </span>
      </div>
      <span v-else-if="prefetchProg.total > 0" class="am-cached num">
        已缓存 {{ prefetchProg.total - prefetchProg.failed }} 只日K
      </span>
      <span v-else class="am-hint">预取后策略/浏览不依赖网络</span>
    </div>

    <div class="am-update">
      <span class="am-update-label">⏰ 每日自动更新</span>
      <span v-if="updateStatus" class="am-update-time">
        {{ updateStatus.plan.map((p) => p.time).join(' / ') }}（交易日）
        <template v-if="updateStatus.lastRun"> · 上次 {{ fmtTime(updateStatus.lastRun) }}</template>
        <template v-if="!updateStatus.isTradingDay"> · 今日非交易日</template>
      </span>
      <span v-else class="am-update-time">状态加载中…</span>
      <button
        class="btn"
        @click="doRunUpdate"
        :disabled="updateBusy || (updateStatus?.running ?? false)"
        :title="updateStatus?.lastResult ?? ''"
      >
        {{ updateBusy || updateStatus?.running ? '更新中…' : '立即更新' }}
      </button>
    </div>
    <div v-if="updateStatus?.lastResult" class="am-update-result">{{ updateStatus.lastResult }}</div>

    <div class="am-grid-head">
      <span>名称 / 代码</span>
      <span class="num">现价</span>
      <span class="num">涨跌幅</span>
      <span class="num">成交额</span>
    </div>

    <div v-if="status === 'fetching'" class="am-status">
      <div class="spinner"></div>
      正在抓取全市场数据… 第 {{ progress.page }} 页
      <div class="am-sub">首次约 30~60 秒，之后自动缓存到本地</div>
    </div>
    <div v-else-if="error" class="am-status down">{{ error }}</div>
    <div v-else-if="stocks.length === 0" class="am-status">暂无数据</div>

    <div
      v-else
      class="am-list"
      @scroll="onScroll"
      @touchstart.passive="ptrStart"
      @touchmove.passive="ptrMove"
      @touchend.passive="ptrEnd"
    >
      <div class="ptr" :class="{ refreshing: ptrRefreshing }" :style="{ height: ptrDistance + 'px' }">
        {{ ptrRefreshing ? '刷新中…' : ptrDistance >= 55 ? '释放刷新' : '下拉刷新' }}
      </div>
      <button
        v-for="s in visible"
        :key="s.code"
        class="am-item"
        @click="selectStock(s.code, s.name)"
      >
        <span class="am-name">
          {{ s.name }}
          <span class="am-code num">{{ s.code.toUpperCase() }} · {{ s.industry ?? '其他' }}</span>
        </span>
        <span class="num am-price" :class="pctCls(s.changePct)">{{ fmtPrice(s.price) }}</span>
        <span class="num am-pct" :class="pctCls(s.changePct)">{{ fmtPct(s.changePct) }}</span>
        <span class="num am-amount">{{ fmtAmount(s.amount) }}亿</span>
      </button>
      <div class="am-end num">
        {{ visible.length }}/{{ sorted.length }} 条
        <template v-if="visible.length < sorted.length">（继续滚动加载）</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.all-market {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.am-toolbar {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  background: var(--panel-2);
}
.am-search {
  flex: 1;
  min-width: 80px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: none;
  font-size: 12px;
}
.am-search:focus {
  border-color: var(--primary);
}

.am-prefetch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.am-progress {
  position: relative;
  flex: 1;
  height: 18px;
  border-radius: 9px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  overflow: hidden;
}
.am-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #1e6fff, #4d94ff);
  transition: width 0.4s;
}
.am-progress-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--text-1);
}
.am-cached,
.am-hint {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

.am-update {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.am-update-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}
.am-update-time {
  flex: 1;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-update-result {
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.am-grid-head,
.am-item {
  display: grid;
  grid-template-columns: 1fr 62px 64px 70px;
  gap: 6px;
  align-items: center;
}
.am-grid-head {
  padding: 6px 10px;
  font-size: 11px;
  color: var(--text-3);
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}

.am-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.ptr {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--text-3);
  transition: height 0.2s;
}
.ptr.refreshing {
  color: var(--primary);
}
.am-item {
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-bottom: 1px solid #f0f1f4;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}
.am-item:hover {
  background: rgba(30, 111, 255, 0.05);
}
.am-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-weight: 600;
}
.am-code {
  font-size: 10px;
  color: var(--text-3);
  font-weight: 400;
}
.am-price,
.am-pct {
  text-align: right;
  font-weight: 600;
}
.am-amount {
  text-align: right;
  color: var(--text-2);
  font-size: 11px;
}
.am-end {
  padding: 8px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}

.am-filter-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.am-filter-sheet {
  width: 100%;
  max-height: 70vh;
  overflow-y: auto;
  background: var(--panel);
  border-radius: 12px 12px 0 0;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
}

.am-filter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 10px;
}

.am-filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.am-chip {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.am-chip.active {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(30, 111, 255, 0.08);
  font-weight: 600;
}

.am-status {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 13px;
  padding: 20px;
}
.am-sub {
  font-size: 11px;
  color: var(--text-3);
}
.spinner {
  width: 22px;
  height: 22px;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 820px) {
  .am-toolbar {
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 6px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .am-toolbar::-webkit-scrollbar {
    display: none;
  }
  .am-search {
    flex: 0 0 auto;
    width: 130px;
  }
  .am-toolbar .select,
  .am-toolbar .btn {
    flex-shrink: 0;
  }

  /* 移动端默认收起数据维护类操作，列表更纯净 */
  .am-prefetch,
  .am-update,
  .am-update-result {
    display: none;
  }

  .am-grid-head,
  .am-item {
    grid-template-columns: 1fr 56px 62px 58px;
    gap: 4px;
  }
  .am-item {
    padding: 10px 10px;
    min-height: 48px;
  }
  .am-list {
    -webkit-overflow-scrolling: touch;
  }
}
</style>
