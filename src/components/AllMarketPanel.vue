<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { SnapshotStock } from '../types'
import { fetchSnapshot } from '../api'
import { useMarket } from '../composables/useMarket'
import { useResearch } from '../composables/useResearch'
import { usePullRefresh } from '../composables/usePullRefresh'
import { SW1_INDUSTRIES } from '../data/stocks'
import MarketBadge from './MarketBadge.vue'

const { isMobile, addToWatchlist, isInWatchlist, selectStock, setView, setMobileTab } = useMarket()
const { openCandidate, seedScreener } = useResearch()

function goWatch(s: { code: string; name: string }) {
  selectStock(s.code, s.name)
  if (isMobile.value) setMobileTab('market')
  else setView('market')
}

function starStock(e: Event, code: string, name: string) {
  e.stopPropagation()
  addToWatchlist(code, name)
}
const { distance: ptrDistance, refreshing: ptrRefreshing, onTouchStart: ptrStart, onTouchMove: ptrMove, onTouchEnd: ptrEnd } = usePullRefresh(() => loadSnapshot(true))

const stocks = ref<SnapshotStock[]>([])
const status = ref<'ready' | 'fetching' | 'refreshing'>('fetching')
const progress = ref({ page: 0, count: 0 })
const error = ref('')
const kw = ref('')
const industryFilter = ref('')
const focusTag = ref('')
const sortKey = ref<'code' | 'name' | 'price' | 'changePct' | 'amount' | 'turnover' | 'mktcap' | 'pe' | 'pb' | 'volumeRatio'>('changePct')
const asc = ref(false)
const renderCount = ref(300)

let pollTimer: number | undefined
const sheetMode = ref<'industry' | 'focus' | 'sort' | null>(null)

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
  { key: 'volumeRatio', label: '量比' },
  { key: 'price', label: '现价' },
  { key: 'mktcap', label: '总市值' },
  { key: 'pe', label: '市盈率' },
  { key: 'pb', label: '市净率' },
  { key: 'code', label: '代码' },
  { key: 'name', label: '名称' },
]

const FOCUS_TAGS: Array<{ key: string; label: string; match: (s: SnapshotStock) => boolean }> = [
  { key: 'strong', label: '强势', match: (s) => s.changePct >= 5 },
  { key: 'volume', label: '放量', match: (s) => s.volumeRatio >= 2 },
  { key: 'active', label: '高换手', match: (s) => s.turnover >= 5 },
  { key: 'large', label: '大成交', match: (s) => s.amount >= 1e9 },
  { key: 'value', label: '低估值', match: (s) => s.pe > 0 && s.pe < 20 && s.pb > 0 && s.pb < 2 },
  { key: 'broken', label: '破净', match: (s) => s.pb > 0 && s.pb < 1 },
  { key: 'limitup', label: '涨停', match: (s) => s.changePct >= 9.8 },
  { key: 'drop', label: '超跌', match: (s) => s.changePct <= -5 },
]

const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase()
  const ind = industryFilter.value
  const focus = FOCUS_TAGS.find((t) => t.key === focusTag.value)
  return stocks.value.filter((s) => {
    if (ind && (s.industry ?? '其他') !== ind) return false
    if (focus && !focus.match(s)) return false
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

interface SectorStat {
  industry: string
  avg: number
  up: number
  down: number
  amount: number
  leader: SnapshotStock | null
  count: number
}

const sectorStats = computed<SectorStat[]>(() => {
  const map = new Map<string, SectorStat>()
  for (const s of stocks.value) {
    const industry = s.industry ?? '其他'
    const st = map.get(industry) ?? { industry, avg: 0, up: 0, down: 0, amount: 0, leader: null, count: 0 }
    st.avg += s.changePct
    st.amount += s.amount
    st.count += 1
    if (s.changePct > 0) st.up += 1
    else if (s.changePct < 0) st.down += 1
    if (!st.leader || s.changePct > st.leader.changePct) st.leader = s
    map.set(industry, st)
  }
  const arr = [...map.values()]
  for (const st of arr) st.avg = st.avg / Math.max(1, st.count)
  arr.sort((a, b) => b.avg - a.avg)
  return arr
})

const topSectors = computed(() => sectorStats.value.slice(0, 10))

const overview = computed(() => {
  const list = stocks.value
  let up = 0
  let down = 0
  let flat = 0
  let limitUp = 0
  let limitDown = 0
  let totalAmount = 0
  let avgChange = 0
  for (const s of list) {
    if (s.changePct > 0) up += 1
    else if (s.changePct < 0) down += 1
    else flat += 1
    if (s.changePct >= 9.8) limitUp += 1
    if (s.changePct <= -9.8) limitDown += 1
    totalAmount += s.amount
    avgChange += s.changePct
  }
  return {
    total: list.length,
    up,
    down,
    flat,
    limitUp,
    limitDown,
    totalAmount: totalAmount / 1e12,
    avgChange: list.length ? avgChange / list.length : 0,
    topIndustry: sectorStats.value[0]?.industry ?? '—',
  }
})

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
    renderCount.value += 300
  }
}

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const fmtPrice = (v: number) => v.toFixed(2)
const fmtPct = (v: number) => (v > 0 ? '+' : '') + v.toFixed(2) + '%'
const fmtAmount = (v: number) => (v / 1e8).toFixed(1)
const fmtVolRatio = (v: number) => (v > 0 ? v.toFixed(2) : '--')
const fmtPe = (v: number) => (v > 0 ? v.toFixed(1) : v < 0 ? '亏损' : '--')
const fmtPb = (v: number) => (v > 0 ? v.toFixed(2) : '--')
const fmtMktcap = (v: number) => (v > 0 ? (v / 1e8).toFixed(0) + '亿' : '--')
const fmtWanYi = (v: number) => v.toFixed(2) + '万亿'

function rowTags(s: SnapshotStock): string[] {
  const tags: string[] = []
  if (s.changePct >= 5) tags.push('强势')
  if (s.volumeRatio >= 2) tags.push('放量')
  if (s.turnover >= 5) tags.push('人气')
  if (s.pe > 0 && s.pe < 20 && s.pb > 0 && s.pb < 2) tags.push('低估')
  if (s.pb > 0 && s.pb < 1) tags.push('破净')
  if (s.changePct <= -5) tags.push('超跌')
  return tags.slice(0, 3)
}

loadSnapshot()

onBeforeUnmount(() => window.clearTimeout(pollTimer))
</script>

<template>
  <div class="all-market">
    <div class="am-overview">
      <div class="ov-card"><span>上涨</span><b class="up">{{ overview.up }}</b></div>
      <div class="ov-card"><span>下跌</span><b class="down">{{ overview.down }}</b></div>
      <div class="ov-card"><span>平盘</span><b>{{ overview.flat }}</b></div>
      <div class="ov-card"><span>涨停</span><b class="up">{{ overview.limitUp }}</b></div>
      <div class="ov-card"><span>跌停</span><b class="down">{{ overview.limitDown }}</b></div>
      <div class="ov-card ov-wide"><span>总成交额</span><b>{{ fmtWanYi(overview.totalAmount) }}</b></div>
      <div class="ov-card ov-wide"><span>领涨行业</span><b class="up">{{ overview.topIndustry }}</b></div>
    </div>

    <div class="am-sector-strip">
      <button class="am-sector-chip all" :class="{ active: industryFilter === '' }" @click="industryFilter = ''">全部</button>
      <button
        v-for="st in topSectors"
        :key="st.industry"
        class="am-sector-chip"
        :class="{ active: industryFilter === st.industry }"
        @click="industryFilter = industryFilter === st.industry ? '' : st.industry"
      >
        <span>{{ st.industry }}</span>
        <b :class="pctCls(st.avg)">{{ fmtPct(st.avg) }}</b>
      </button>
    </div>

    <div class="am-toolbar">
      <input v-model="kw" type="text" placeholder="过滤名称/代码" class="am-search" />
      <button
        v-if="industryFilter"
        class="btn"
        @click="seedScreener({ industry: industryFilter, note: `来自全市场行业：${industryFilter}` })"
      >
        用此行业选股
      </button>
      <template v-if="isMobile">
        <button class="btn" @click="sheetMode = 'industry'">行业{{ industryFilter ? '：' + industryFilter : '' }}</button>
        <button class="btn" @click="sheetMode = 'focus'">聚焦{{ focusTag ? '：' + (FOCUS_TAGS.find((t) => t.key === focusTag)?.label ?? '') : '' }}</button>
        <button class="btn" @click="sheetMode = 'sort'">排序：{{ SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? '' }}</button>
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

    <div class="am-focus-bar">
      <button
        v-for="t in FOCUS_TAGS"
        :key="t.key"
        class="am-focus-chip"
        :class="{ active: focusTag === t.key }"
        @click="focusTag = focusTag === t.key ? '' : t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <Transition name="sheet">
      <div v-if="isMobile && sheetMode" class="am-filter-mask" @click="sheetMode = null">
        <div class="am-filter-sheet" @click.stop>
          <div class="am-filter-head">
            <span>{{ sheetMode === 'industry' ? '选择行业' : sheetMode === 'focus' ? '聚焦条件' : '选择排序' }}</span>
            <button class="btn" @click="sheetMode = null">完成</button>
          </div>
          <div class="am-filter-chips">
            <template v-if="sheetMode === 'industry'">
              <button class="am-chip" :class="{ active: industryFilter === '' }" @click="industryFilter = ''; sheetMode = null">全部</button>
              <button
                v-for="ind in SW1_INDUSTRIES"
                :key="ind"
                class="am-chip"
                :class="{ active: industryFilter === ind }"
                @click="industryFilter = ind; sheetMode = null"
              >
                {{ ind }}
              </button>
            </template>
            <template v-else-if="sheetMode === 'focus'">
              <button class="am-chip" :class="{ active: focusTag === '' }" @click="focusTag = ''; sheetMode = null">全部</button>
              <button
                v-for="t in FOCUS_TAGS"
                :key="t.key"
                class="am-chip"
                :class="{ active: focusTag === t.key }"
                @click="focusTag = t.key; sheetMode = null"
              >
                {{ t.label }}
              </button>
            </template>
            <template v-else>
              <button
                v-for="o in SORT_OPTIONS"
                :key="o.key"
                class="am-chip"
                :class="{ active: sortKey === o.key }"
                @click="sortKey = o.key; sheetMode = null"
              >
                {{ o.label }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </Transition>

    <div class="am-grid-head">
      <span></span>
      <span>名称 / 代码</span>
      <span class="num">现价</span>
      <span class="num">涨跌幅</span>
      <span class="num">成交额</span>
      <span></span>
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
      <div
        v-for="s in visible"
        :key="s.code"
        class="am-item"
        @click="goWatch(s)"
      >
        <button
          class="am-star"
          :class="{ on: isInWatchlist(s.code) }"
          :title="isInWatchlist(s.code) ? '已在自选' : '加入自选'"
          @click="starStock($event, s.code, s.name)"
        >
          {{ isInWatchlist(s.code) ? '★' : '☆' }}
        </button>
        <span class="am-name">
          {{ s.name }}
          <span class="am-code num"><MarketBadge :code="s.code" /> {{ s.code.toUpperCase() }} · {{ s.industry ?? '其他' }}</span>
        </span>
        <span class="num am-price" :class="pctCls(s.changePct)">{{ fmtPrice(s.price) }}</span>
        <span class="num am-pct" :class="pctCls(s.changePct)">{{ fmtPct(s.changePct) }}</span>
        <span class="num am-amount">{{ fmtAmount(s.amount) }}亿</span>
        <span class="am-metrics">
          <span class="am-metric">换手 <b>{{ s.turnover.toFixed(2) }}%</b></span>
          <span class="am-metric">量比 <b>{{ fmtVolRatio(s.volumeRatio) }}</b></span>
          <span class="am-metric">市值 <b>{{ fmtMktcap(s.mktcap) }}</b></span>
          <span class="am-metric">PE <b>{{ fmtPe(s.pe) }}</b></span>
          <span class="am-metric">PB <b>{{ fmtPb(s.pb) }}</b></span>
          <span v-for="tag in rowTags(s)" :key="tag" class="am-tag">{{ tag }}</span>
        </span>
        <button
          class="am-research"
          title="送入研究观察"
          @click.stop="openCandidate(s.code, { name: s.name, industry: s.industry, source: 'industry', context: { industry: s.industry, reason: `全市场 · ${s.industry ?? '未知行业'}` } })"
        >
          研
        </button>
      </div>
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
  background: var(--panel);
}

.am-overview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.ov-card {
  min-width: 58px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ov-wide {
  min-width: 120px;
}
.ov-card span {
  font-size: 10px;
  color: var(--text-3);
}
.ov-card b {
  font-size: 14px;
  font-weight: 700;
}

.am-sector-strip {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  scrollbar-width: none;
}
.am-sector-strip::-webkit-scrollbar {
  display: none;
}
.am-sector-chip {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.am-sector-chip.active {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(30, 111, 255, 0.08);
}
.am-sector-chip.all {
  font-weight: 600;
}
.am-sector-chip b {
  font-weight: 600;
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

.am-focus-bar {
  display: flex;
  gap: 6px;
  padding: 7px 10px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  scrollbar-width: none;
}
.am-focus-bar::-webkit-scrollbar {
  display: none;
}
.am-focus-chip {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}
.am-focus-chip.active {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(30, 111, 255, 0.08);
  font-weight: 600;
}

.am-grid-head,
.am-item {
  display: grid;
  grid-template-columns: 28px 1.3fr 72px 78px 90px 32px;
  gap: 8px;
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
.am-star,
.am-research {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
}
.am-star.on {
  color: #d99000;
}
.am-research {
  font-size: 11px;
  font-weight: 700;
  color: var(--primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 4px;
}
.am-research:hover {
  border-color: var(--primary);
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
.am-pct {
  padding: 3px 6px;
  border-radius: 4px;
}
.am-item .am-pct.up {
  background: rgba(239, 35, 42, 0.08);
}
.am-item .am-pct.down {
  background: rgba(20, 177, 67, 0.08);
}
.am-amount {
  text-align: right;
  color: var(--text-2);
  font-size: 11px;
}

.am-metrics {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed var(--border);
}
.am-metric {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
.am-metric b {
  color: var(--text-1);
  font-weight: 600;
  margin-left: 2px;
}
.am-tag {
  padding: 1px 6px;
  border-radius: 9px;
  background: rgba(30, 111, 255, 0.08);
  color: var(--primary);
  font-size: 10px;
  white-space: nowrap;
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
  .am-overview,
  .am-sector-strip,
  .am-toolbar,
  .am-focus-bar {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .am-overview::-webkit-scrollbar,
  .am-sector-strip::-webkit-scrollbar,
  .am-toolbar::-webkit-scrollbar,
  .am-focus-bar::-webkit-scrollbar {
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

  .am-grid-head,
  .am-item {
    grid-template-columns: 24px 1fr 56px 62px 32px;
    gap: 4px;
  }
  .am-amount {
    display: none;
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
