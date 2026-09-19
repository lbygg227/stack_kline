<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMarket, INDEX_LIST } from '../composables/useMarket'
import { useResearch } from '../composables/useResearch'
import { fetchTunnelInfo, searchStocks } from '../api'
import type { StockInfo } from '../types'
import type { DesktopView } from '../composables/useMarket'

const { selectStock, displayQuote, setView, state, isMobile } = useMarket()
const {
  candidates,
  activeCandidateCode,
  activeIndex,
  nextCandidate,
  prevCandidate,
  openWorkbench,
  refreshCandidates,
} = useResearch()

const kw = ref('')
const results = ref<StockInfo[]>([])
const searching = ref(false)
const showDrop = ref(false)
const remoteUrl = ref('')
let timer: number | undefined

/** 移动端只展示 4 个核心指数（同花顺风格，不横向滚动） */
const visibleIndexes = computed(() =>
  isMobile.value ? INDEX_LIST.filter((i) => i.code !== 'sh000300') : INDEX_LIST,
)

onMounted(async () => {
  const info = await fetchTunnelInfo()
  remoteUrl.value = info.url ?? ''
  void refreshCandidates()
})

async function copyRemoteUrl() {
  if (!remoteUrl.value) return
  try {
    await navigator.clipboard.writeText(remoteUrl.value)
  } catch {
    /* 剪贴板不可用时忽略 */
  }
}

watch(kw, (v) => {
  window.clearTimeout(timer)
  if (!v.trim()) {
    results.value = []
    showDrop.value = false
    return
  }
  timer = window.setTimeout(async () => {
    searching.value = true
    results.value = await searchStocks(v)
    searching.value = false
    showDrop.value = true
  }, 300)
})

function pick(s: StockInfo) {
  selectStock(s.code, s.name)
  kw.value = ''
  results.value = []
  showDrop.value = false
}

function onEnter() {
  if (results.value.length) pick(results.value[0])
}

function onBlur() {
  window.setTimeout(() => (showDrop.value = false), 150)
}

onBeforeUnmount(() => window.clearTimeout(timer))

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')

/**
 * 导航信息架构（2026-09-17 重整）：
 *   一行顶部 = 身份/行情/搜索；二行 Tab = 功能导航。
 * 5 个常用页平铺 + 2 个分组长尾页 + 数据管理，避免原来「按钮和下拉混在一行」的拥挤。
 */
interface NavItem {
  view: DesktopView
  label: string
  hint: string
}

interface NavGroup {
  key: string
  label: string
  items: NavItem[]
}

const PRIMARY_TABS: NavItem[] = [
  { view: 'recommend', label: '今日推荐', hint: '按置信度排序的候选与理由' },
  { view: 'limit-up', label: '涨停板', hint: '涨停梯队、板块效应与情绪周期' },
  { view: 'market', label: 'K线看盘', hint: '分时与日线、盘口、自选' },
  { view: 'strategy', label: '选股器', hint: '条件选股与候选工作台' },
]

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'research',
    label: '研究',
    items: [
      { view: 'opinion', label: '观点研究', hint: '博主观点采集、抽取与回测' },
      { view: 'events', label: '资讯事件', hint: '金十快讯与题材事件' },
      { view: 'all-market', label: '全市场', hint: '全部 A 股筛选与排序' },
    ],
  },
  {
    key: 'review',
    label: '复盘',
    items: [
      { view: 'backtest', label: '回测研究', hint: '风格回测与荐股归因' },
      { view: 'simulation', label: '模拟盘', hint: '推荐模拟持仓与资金曲线' },
      { view: 'digest', label: '每日复盘', hint: '收盘摘要与推送' },
    ],
  },
]

const TOOL_ITEM: NavItem = { view: 'data', label: '数据管理', hint: '快照、缓存与数据源' }

const openMenu = ref('')
const navRef = ref<HTMLElement | null>(null)

function toggleMenu(key: string) {
  openMenu.value = openMenu.value === key ? '' : key
}

function pickView(view: DesktopView) {
  setView(view)
  openMenu.value = ''
}

function groupActive(group: NavGroup): boolean {
  return group.items.some((item) => item.view === state.view)
}

function onDocumentClick(event: MouseEvent) {
  if (!openMenu.value) return
  const target = event.target as Node | null
  if (navRef.value && target && !navRef.value.contains(target)) openMenu.value = ''
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>

<template>
  <header class="topbar">
    <div class="topbar-main">
      <div class="brand">
        <svg viewBox="0 0 32 32" width="24" height="24" class="brand-icon">
          <rect x="4" y="12" width="5" height="12" rx="1" fill="#ef232a" />
          <rect x="13.5" y="4" width="5" height="20" rx="1" fill="#1e6fff" />
          <rect x="23" y="8" width="5" height="16" rx="1" fill="#14b143" />
        </svg>
        <div class="brand-text">
          <div class="brand-name">A股研究终端</div>
          <div class="brand-sub">行情 · 涨停 · 观点 · 复盘</div>
        </div>
      </div>

      <nav class="index-bar">
        <button
          v-for="idx in visibleIndexes"
          :key="idx.code"
          class="index-chip"
          @click="selectStock(idx.code, idx.name)"
        >
          <span class="index-name">{{ idx.name }}</span>
          <template v-if="displayQuote(idx.code)">
            <span class="num index-price">{{ displayQuote(idx.code)!.price.toFixed(2) }}</span>
            <span class="num index-pct" :class="pctCls(displayQuote(idx.code)!.changePct)">
              {{ displayQuote(idx.code)!.changePct > 0 ? '+' : '' }}{{ displayQuote(idx.code)!.changePct.toFixed(2) }}%
            </span>
          </template>
          <span v-else class="index-pct flat">--</span>
        </button>
      </nav>

      <button
        v-if="remoteUrl && !isMobile"
        class="remote-chip"
        :title="remoteUrl + '（点击复制）'"
        @click="copyRemoteUrl"
      >
        <span class="remote-dot"></span>
        远程访问
      </button>

      <div class="search">
        <div class="search-box">
          <input
            v-model="kw"
            type="text"
            placeholder="搜索股票 / 代码"
            @focus="kw && results.length && (showDrop = true)"
            @blur="onBlur"
            @keydown.enter="onEnter"
          />
          <span v-if="searching" class="search-tip">搜索中…</span>
        </div>
        <div v-if="showDrop && results.length" class="search-drop">
          <button
            v-for="s in results"
            :key="s.code"
            class="search-item"
            @mousedown.prevent="pick(s)"
          >
            <span class="si-name">{{ s.name }}</span>
            <span class="si-code num">{{ s.code.toUpperCase() }}</span>
            <span class="si-market">{{ s.market === 'sh' ? '沪' : '深' }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="!isMobile" class="topbar-nav">
      <nav ref="navRef" class="nav-tabs">
        <button
          v-for="tab in PRIMARY_TABS"
          :key="tab.view"
          class="nav-tab"
          :class="{ active: state.view === tab.view }"
          :title="tab.hint"
          @click="pickView(tab.view)"
        >
          {{ tab.label }}
        </button>

        <div v-for="group in NAV_GROUPS" :key="group.key" class="nav-group">
          <button
            class="nav-tab nav-tab-group"
            :class="{ active: groupActive(group), open: openMenu === group.key }"
            @click.stop="toggleMenu(group.key)"
          >
            {{ group.label }}
            <span class="caret">▾</span>
          </button>
          <div v-if="openMenu === group.key" class="nav-menu">
            <button
              v-for="item in group.items"
              :key="item.view"
              class="nav-menu-item"
              :class="{ active: state.view === item.view }"
              @click.stop="pickView(item.view)"
            >
              <span class="nav-menu-label">{{ item.label }}</span>
              <span class="nav-menu-hint">{{ item.hint }}</span>
            </button>
          </div>
        </div>
      </nav>

      <div class="nav-right">
        <div v-if="candidates.length" class="queue-chip">
          <button class="btn" @click="prevCandidate">‹</button>
          <button class="queue-mid" @click="openWorkbench">
            候选 {{ activeIndex >= 0 ? activeIndex + 1 : 0 }}/{{ candidates.length }}
            <small v-if="activeCandidateCode">{{ activeCandidateCode.toUpperCase() }}</small>
          </button>
          <button class="btn" @click="nextCandidate">›</button>
        </div>
        <button
          class="nav-tab nav-tab-tool"
          :class="{ active: state.view === TOOL_ITEM.view }"
          :title="TOOL_ITEM.hint"
          @click="pickView(TOOL_ITEM.view)"
        >
          {{ TOOL_ITEM.label }}
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
  z-index: 10;
}

.topbar-main {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 50px;
  padding: 0 14px;
}

.topbar-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 40px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.brand-icon { flex-shrink: 0; }
.brand-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.15;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-3);
}

.nav-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 100%;
  min-width: 0;
  overflow-x: auto;
}
.nav-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.nav-tab:hover {
  color: var(--text-1);
  background: rgba(30, 111, 255, 0.06);
}
.nav-tab.active {
  color: var(--primary);
  font-weight: 600;
}
.nav-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--primary);
}
.nav-tab-group .caret {
  font-size: 9px;
  opacity: 0.7;
}
.nav-tab-group.open {
  color: var(--primary);
  background: rgba(30, 111, 255, 0.08);
}
.nav-group { position: relative; display: flex; }
.nav-menu {
  position: absolute;
  top: calc(100% + 1px);
  left: 0;
  z-index: 30;
  min-width: 210px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.16);
}
.nav-menu-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.nav-menu-item:hover { background: var(--panel-2); }
.nav-menu-item.active { background: rgba(30, 111, 255, 0.1); }
.nav-menu-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.nav-menu-item.active .nav-menu-label { color: var(--primary); }
.nav-menu-hint { font-size: 10px; color: var(--text-3); }

.nav-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.nav-tab-tool {
  border-radius: 6px;
  height: 28px;
  font-size: 12px;
  color: var(--text-3);
}
.nav-tab-tool.active::after { display: none; }
.nav-tab-tool.active { background: rgba(30, 111, 255, 0.1); }

.queue-chip {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
.queue-chip .btn {
  min-width: 26px;
  padding: 3px 6px;
}
.queue-mid {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 84px;
  padding: 2px 8px;
  border: 0;
  background: transparent;
  color: var(--text-1);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.queue-mid small {
  color: var(--text-3);
  font-weight: 400;
}

.remote-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 5px 10px;
  border: 1px dashed #14b143;
  border-radius: 12px;
  background: rgba(20, 177, 67, 0.06);
  color: #0f8f38;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.remote-chip:hover { background: rgba(20, 177, 67, 0.12); }
.remote-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #14b143;
  box-shadow: 0 0 0 3px rgba(20, 177, 67, 0.15);
  animation: remote-pulse 1.8s infinite;
}
@keyframes remote-pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(20, 177, 67, 0.15); }
  50% { box-shadow: 0 0 0 6px rgba(20, 177, 67, 0.08); }
}

.index-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
}
.index-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s, background 0.15s;
  font-size: 12px;
}
.index-chip:hover {
  border-color: var(--primary);
  background: rgba(30, 111, 255, 0.04);
}
.index-name { color: var(--text-2); }
.index-price { font-weight: 600; color: var(--text-1); }
.index-pct { font-weight: 600; }

.search {
  position: relative;
  flex-shrink: 0;
}
.search-box { position: relative; }
.search-box input {
  width: 220px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 16px;
  outline: none;
  font-size: 13px;
  background: var(--panel-2);
  transition: border-color 0.15s, background 0.15s;
}
.search-box input:focus {
  border-color: var(--primary);
  background: var(--panel);
}
.search-tip {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: var(--text-3);
}
.search-drop {
  position: absolute;
  top: 38px;
  right: 0;
  width: 300px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(31, 35, 41, 0.12);
  z-index: 100;
}
.search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.search-item:hover { background: rgba(30, 111, 255, 0.06); }
.si-name { color: var(--text-1); font-weight: 600; }
.si-code { color: var(--text-3); flex: 1; }
.si-market {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}

@media (max-width: 820px) {
  .topbar-main {
    height: auto;
    min-height: 50px;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: calc(8px + env(safe-area-inset-top)) 10px 8px;
  }
  .brand { order: 1; }
  .brand-sub { display: none; }
  .search {
    order: 3;
    width: 100%;
  }
  .search-box { width: 100%; }
  .search-box input { width: 100%; }
  .search-drop {
    left: 0;
    right: 0;
    width: 100%;
  }
  .index-bar {
    order: 4;
    width: 100%;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    overflow: hidden;
  }
  .index-chip {
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 5px 2px;
    border-radius: 8px;
  }
  .index-name { font-size: 11px; }
  .index-price { font-size: 12px; }
  .index-pct { font-size: 11px; }
}
</style>
