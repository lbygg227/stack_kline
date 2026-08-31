<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import TopBar from './components/TopBar.vue'
import MarketList from './components/MarketList.vue'
import StockList from './components/StockList.vue'
import AllMarketPanel from './components/AllMarketPanel.vue'
import QuoteHeader from './components/QuoteHeader.vue'
import KLineChart from './components/KLineChart.vue'
import TradePanel from './components/TradePanel.vue'
import StrategyPanel from './components/StrategyPanel.vue'
import { useMarket } from './composables/useMarket'
import type { MobileTab } from './composables/useMarket'

const { state, isMobile, mobileTab, refreshQuotes, setMobileTab } = useMarket()
let timer: number | undefined

const MOBILE_TABS: Array<{ key: MobileTab; label: string; icon: string }> = [
  { key: 'market', label: '行情', icon: '📈' },
  { key: 'watchlist', label: '自选', icon: '⭐' },
  { key: 'all', label: '市场', icon: '📊' },
  { key: 'strategy', label: '选股', icon: '🔍' },
  { key: 'trade', label: '交易', icon: '💰' },
]

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
        <div v-if="mobileTab === 'market'" class="mobile-market">
          <QuoteHeader />
          <KLineChart :code="state.currentCode" :name="state.currentName" />
        </div>
        <StockList v-else-if="mobileTab === 'watchlist'" />
        <AllMarketPanel v-else-if="mobileTab === 'all'" />
        <StrategyPanel v-else-if="mobileTab === 'strategy'" />
        <TradePanel v-else-if="mobileTab === 'trade'" />
      </div>
    </template>

    <!-- 桌面端：保持现有三栏布局 -->
    <template v-else>
      <StrategyPanel v-if="state.view === 'strategy'" class="page-view" />
      <div v-else class="main">
        <MarketList />
        <div class="center">
          <QuoteHeader />
          <KLineChart :code="state.currentCode" :name="state.currentName" />
        </div>
        <TradePanel />
      </div>
    </template>

    <nav v-if="isMobile" class="mobile-nav">
      <button
        v-for="t in MOBILE_TABS"
        :key="t.key"
        class="mn-item"
        :class="{ active: mobileTab === t.key }"
        @click="setMobileTab(t.key)"
      >
        <span class="mn-icon">{{ t.icon }}</span>
        <span>{{ t.label }}</span>
      </button>
    </nav>
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
  gap: 10px;
  padding: 10px;
  min-height: 0;
}

.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

.center > :last-child {
  flex: 1;
  min-height: 0;
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
</style>
