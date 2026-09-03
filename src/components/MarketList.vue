<script setup lang="ts">
import { ref } from 'vue'
import StockList from './StockList.vue'

const collapsed = ref(false)
</script>

<template>
  <aside class="market-list" :class="{ collapsed }">
    <button class="ml-toggle" @click="collapsed = !collapsed" :title="collapsed ? '展开自选' : '收起自选'">
      {{ collapsed ? '▶' : '◀' }}
    </button>
    <template v-if="!collapsed">
      <div class="ml-head">自选股</div>
      <div class="ml-body">
        <StockList />
      </div>
    </template>
    <div v-else class="ml-collapsed-labels">
      <span class="ml-collapsed-label" @click="collapsed = false">自选</span>
    </div>
  </aside>
</template>

<style scoped>
.market-list {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 200px;
  flex-shrink: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  overflow: hidden;
  min-height: 0;
  transition: width 0.2s ease;
}
.market-list.collapsed {
  width: 36px;
}

.ml-toggle {
  position: absolute;
  top: 6px;
  right: 4px;
  z-index: 5;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text-3);
  font-size: 10px;
  line-height: 20px;
  text-align: center;
  cursor: pointer;
  transition: color 0.15s;
}
.ml-toggle:hover { color: var(--primary); }
.collapsed .ml-toggle {
  position: static;
  width: 100%;
  margin-top: 6px;
  border: none;
  border-radius: 0;
}

.ml-collapsed-labels {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
}
.ml-collapsed-label {
  writing-mode: vertical-rl;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px 2px;
  border-radius: 3px;
  transition: color 0.15s;
}
.ml-collapsed-label:hover { color: var(--primary); }

.ml-head {
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
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
  .market-list.collapsed { width: 100%; }
  .ml-toggle { display: none; }
  .ml-collapsed-labels { display: none; }
}
</style>
