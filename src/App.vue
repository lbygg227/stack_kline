<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TopBar from './components/TopBar.vue'
import MarketList from './components/MarketList.vue'
import StockList from './components/StockList.vue'
import AllMarketPanel from './components/AllMarketPanel.vue'
import QuoteHeader from './components/QuoteHeader.vue'
import KLineChart from './components/KLineChart.vue'
import TradePanel from './components/TradePanel.vue'
import StrategyPanel from './components/StrategyPanel.vue'
import OpinionPanel from './components/OpinionPanel.vue'
import DataManagePanel from './components/DataManagePanel.vue'
import NewsEventPanel from './components/NewsEventPanel.vue'
import TodayRecommendations from './components/TodayRecommendations.vue'
import BacktestResearch from './components/BacktestResearch.vue'
import SimulationPanel from './components/SimulationPanel.vue'
import DailyDigest from './components/DailyDigest.vue'
import LimitUpPanel from './components/LimitUpPanel.vue'
import ThesisDesk from './components/ThesisDesk.vue'
import { useMarket } from './composables/useMarket'
import type { MobileTab } from './composables/useMarket'

const { state, isMobile, mobileTab, refreshQuotes, setMobileTab, toggleTradePanel } = useMarket()
let timer: number | undefined

/**
 * 移动端底部导航：13 项平铺在手机上一项只有 30px，既点不准也不好看。
 * 收敛成「4 个高频 + 更多面板」，其余页面进面板里按分组列出。
 */
const MOBILE_TABS: Array<{ key: MobileTab; label: string; icon: string }> = [
  { key: 'recommend', label: '推荐', icon: '🎯' },
  { key: 'thesis', label: '观点', icon: '💡' },
  { key: 'market', label: '行情', icon: '📈' },
  { key: 'limit-up', label: '涨停', icon: '🔥' },
]

const MOBILE_MORE_GROUPS: Array<{ title: string; items: Array<{ key: MobileTab; label: string; icon: string }> }> = [
  {
    title: '研究',
    items: [
      { key: 'all', label: '全市场', icon: '📊' },
      { key: 'strategy', label: '选股器', icon: '🔍' },
      { key: 'opinion', label: '观点研究', icon: '📝' },
      { key: 'events', label: '资讯事件', icon: '📰' },
    ],
  },
  {
    title: '复盘',
    items: [
      { key: 'backtest', label: '回测研究', icon: '🧪' },
      { key: 'simulation', label: '模拟盘', icon: '💼' },
      { key: 'digest', label: '每日复盘', icon: '🗒️' },
    ],
  },
  {
    title: '工具',
    items: [
      { key: 'watchlist', label: '自选股', icon: '⭐' },
      { key: 'trade', label: '交易', icon: '💰' },
      { key: 'data', label: '数据管理', icon: '🗄️' },
    ],
  },
]

const showMoreTabs = ref(false)
const moreActive = computed(() => MOBILE_MORE_GROUPS.some((g) => g.items.some((i) => i.key === mobileTab.value)))

function pickMobileTab(key: MobileTab) {
  setMobileTab(key)
  showMoreTabs.value = false
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void refreshQuotes()
  }
}

onMounted(() => {
  const { initMobile } = useMarket()
  initMobile()
  void refreshQuotes()
  timer = window.setInterval(() => {
    // 页面不可见时暂停轮询，省电省流量
    if (document.visibilityState === 'visible') void refreshQuotes()
  }, 5000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  window.clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="app">
    <TopBar />

    <!-- 移动端：底部导航单页切换 -->
    <template v-if="isMobile">
      <div class="mobile-main">
        <div v-if="mobileTab === 'recommend'" class="mobile-page">
          <TodayRecommendations />
        </div>
        <div v-else-if="mobileTab === 'market'" class="mobile-market">
          <QuoteHeader />
          <KLineChart :code="state.currentCode" :name="state.currentName" />
        </div>
        <StockList v-else-if="mobileTab === 'watchlist'" />
        <AllMarketPanel v-else-if="mobileTab === 'all'" />
        <NewsEventPanel v-else-if="mobileTab === 'events'" />
        <StrategyPanel v-else-if="mobileTab === 'strategy'" />
        <BacktestResearch v-else-if="mobileTab === 'backtest'" />
        <SimulationPanel v-else-if="mobileTab === 'simulation'" />
        <DailyDigest v-else-if="mobileTab === 'digest'" />
        <LimitUpPanel v-else-if="mobileTab === 'limit-up'" />
        <ThesisDesk v-else-if="mobileTab === 'thesis'" />
        <OpinionPanel v-else-if="mobileTab === 'opinion'" />
        <TradePanel v-else-if="mobileTab === 'trade'" />
        <DataManagePanel v-else-if="mobileTab === 'data'" />
      </div>
    </template>

    <!-- 桌面端：顶部 Tab 页面切换 -->
    <template v-else>
      <TodayRecommendations v-if="state.view === 'recommend'" class="page-view" />
      <StrategyPanel v-else-if="state.view === 'strategy'" class="page-view" />
      <BacktestResearch v-else-if="state.view === 'backtest'" class="page-view" />
      <SimulationPanel v-else-if="state.view === 'simulation'" class="page-view" />
      <DailyDigest v-else-if="state.view === 'digest'" class="page-view" />
      <LimitUpPanel v-else-if="state.view === 'limit-up'" class="page-view" />
      <ThesisDesk v-else-if="state.view === 'thesis'" class="page-view" />
      <NewsEventPanel v-else-if="state.view === 'events'" class="page-view" />
      <OpinionPanel v-else-if="state.view === 'opinion'" class="page-view" />
      <AllMarketPanel v-else-if="state.view === 'all-market'" class="page-view" />
      <DataManagePanel v-else-if="state.view === 'data'" class="page-view" />
      <div v-else class="main">
        <MarketList />
        <div class="center">
          <QuoteHeader />
          <KLineChart :code="state.currentCode" :name="state.currentName" />
        </div>
        <button class="trade-toggle" @click="toggleTradePanel" :title="state.showTradePanel ? '隐藏盘口' : '显示盘口'">
          {{ state.showTradePanel ? '▶' : '◀' }}
          <span class="trade-toggle-label">盘口</span>
        </button>
        <Transition name="slide-right">
          <TradePanel v-if="state.showTradePanel" />
        </Transition>
      </div>
    </template>

    <nav v-if="isMobile" class="mobile-nav">
      <button
        v-for="t in MOBILE_TABS"
        :key="t.key"
        class="mn-item"
        :class="{ active: mobileTab === t.key }"
        @click="pickMobileTab(t.key)"
      >
        <span class="mn-icon">{{ t.icon }}</span>
        <span>{{ t.label }}</span>
      </button>
      <button
        class="mn-item"
        :class="{ active: moreActive || showMoreTabs }"
        @click="showMoreTabs = !showMoreTabs"
      >
        <span class="mn-icon">☰</span>
        <span>更多</span>
      </button>
    </nav>

    <Transition name="sheet">
      <div v-if="isMobile && showMoreTabs" class="more-sheet">
        <div class="more-head">
          <b>全部功能</b>
          <button class="more-close" @click="showMoreTabs = false">✕</button>
        </div>
        <div v-for="group in MOBILE_MORE_GROUPS" :key="group.title" class="more-group">
          <div class="more-title">{{ group.title }}</div>
          <div class="more-items">
            <button
              v-for="item in group.items"
              :key="item.key"
              class="more-item"
              :class="{ active: mobileTab === item.key }"
              @click="pickMobileTab(item.key)"
            >
              <span class="mi-icon">{{ item.icon }}</span>
              <span class="mi-label">{{ item.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
}

.main {
  flex: 1;
  display: flex;
  gap: 6px;
  padding: 6px;
  min-height: 0;
}

.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  min-height: 0;
}

.center > :last-child {
  flex: 1;
  min-height: 0;
}

.trade-toggle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 24px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text-3);
  font-size: 10px;
  cursor: pointer;
  padding: 8px 0;
  transition: color 0.15s;
}
.trade-toggle:hover {
  color: var(--primary);
  border-color: var(--primary);
}
.trade-toggle-label {
  writing-mode: vertical-rl;
  font-size: 11px;
}

.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.2s ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  opacity: 0;
  transform: translateX(20px);
  width: 0 !important;
  overflow: hidden;
}

.page-view {
  flex: 1;
  min-height: 0;
  margin: 10px;
}

.mobile-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
}

.mobile-market {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mobile-market > :last-child {
  flex: 1;
  min-height: 0;
}

.mobile-main > :not(.mobile-market) {
  flex: 1;
  min-height: 0;
  border-radius: 6px;
  overflow: hidden;
}

.mobile-nav {
  display: none;
}
.more-sheet {
  display: none;
}

@media (max-width: 820px) {
  .main {
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    overflow-y: auto;
  }

  .center {
    flex: 1 1 auto;
    min-height: 0;
  }

  .page-view {
    margin: 8px;
  }

  .more-sheet {
    display: block;
  }

  .mobile-nav {
    display: flex;
    flex-shrink: 0;
    height: 54px;
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--panel);
    border-top: 1px solid var(--border);
    box-shadow: 0 -1px 4px rgba(31, 35, 41, 0.06);
    z-index: 20;
  }

  .mn-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border: none;
    background: transparent;
    color: var(--text-3);
    font-size: 11px;
    cursor: pointer;
    transition: color 0.15s;
  }
  .mn-item.active {
    color: var(--primary);
    font-weight: 600;
  }
  .mn-icon {
    font-size: 17px;
    line-height: 1;
  }
}

/* 移动端「更多」面板 */
.mobile-nav { position: relative; }
.more-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(54px + env(safe-area-inset-bottom));
  z-index: 30;
  max-height: 62vh;
  overflow-y: auto;
  padding: 12px 12px 16px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  border-radius: 14px 14px 0 0;
  box-shadow: 0 -8px 24px rgba(15, 23, 42, 0.14);
}
.more-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--text-1);
}
.more-close {
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  cursor: pointer;
}
.more-group { margin-bottom: 12px; }
.more-title {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.more-items {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.more-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}
.more-item.active {
  border-color: var(--primary);
  color: var(--primary);
  font-weight: 600;
}
.mi-icon { font-size: 17px; line-height: 1; }
.sheet-enter-active,
.sheet-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.sheet-enter-from,
.sheet-leave-to { opacity: 0; transform: translateY(12px); }
</style>
