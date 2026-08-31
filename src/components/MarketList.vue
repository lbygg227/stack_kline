<script setup lang="ts">
import { ref } from 'vue'
import StockList from './StockList.vue'
import AllMarketPanel from './AllMarketPanel.vue'

const tab = ref<'watch' | 'all'>('watch')

const TABS = [
  { key: 'watch', label: '自选' },
  { key: 'all', label: '全市场' },
] as const
</script>

<template>
  <aside class="market-list">
    <div class="ml-tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="ml-tab"
        :class="{ active: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}
      </button>
    </div>
    <div class="ml-body">
      <StockList v-if="tab === 'watch'" />
      <AllMarketPanel v-else />
    </div>
  </aside>
</template>

<style scoped>
.market-list {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex-shrink: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  overflow: hidden;
  min-height: 0;
}

.ml-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.ml-tab {
  flex: 1;
  padding: 9px 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.ml-tab:hover {
  color: var(--primary);
}
.ml-tab.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  background: rgba(30, 111, 255, 0.04);
}

.ml-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.ml-body > * {
  flex: 1;
  min-height: 0;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

@media (max-width: 820px) {
  .market-list {
    width: 100%;
    flex: 1;
  }
}
</style>
