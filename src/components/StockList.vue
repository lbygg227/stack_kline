<script setup lang="ts">
import { computed } from 'vue'
import { useMarket, WATCHLIST } from '../composables/useMarket'

const { state, selectStock, displayQuote } = useMarket()

const list = computed(() =>
  WATCHLIST.map((w) => ({ info: w, quote: displayQuote(w.code) })),
)

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const fmt = (n?: number, digits = 2) => (n === undefined ? '--' : n.toFixed(digits))
</script>

<template>
  <aside class="watchlist">
    <div class="wl-head">
      <span class="wl-title">自选股</span>
      <span class="wl-count">{{ WATCHLIST.length }}</span>
    </div>
    <div class="wl-grid-head">
      <span>名称</span>
      <span class="num">最新价</span>
      <span class="num">涨跌幅</span>
    </div>
    <div class="wl-list">
      <button
        v-for="{ info, quote } in list"
        :key="info.code"
        class="wl-item"
        :class="{ active: state.currentCode === info.code }"
        @click="selectStock(info.code, info.name)"
      >
        <span class="wl-name">
          {{ info.name }}
          <span class="wl-code num">{{ info.code.toUpperCase() }}</span>
        </span>
        <span class="num wl-price" :class="quote ? pctCls(quote.changePct) : 'flat'">
          {{ fmt(quote?.price) }}
        </span>
        <span class="num wl-pct" :class="quote ? pctCls(quote.changePct) : 'flat'">
          {{ quote ? (quote.changePct > 0 ? '+' : '') + quote.changePct.toFixed(2) + '%' : '--' }}
        </span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.watchlist {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  flex-shrink: 0;
  background: var(--panel);
  overflow: hidden;
}

.wl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.wl-title {
  font-size: 14px;
  font-weight: 700;
}
.wl-count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 7px;
}

.wl-grid-head,
.wl-item {
  display: grid;
  grid-template-columns: 1fr 74px 78px;
  gap: 6px;
  align-items: center;
}

.wl-grid-head {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-3);
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}

.wl-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.wl-item {
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-bottom: 1px solid #f0f1f4;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  transition: background 0.12s;
}
.wl-item:hover {
  background: rgba(30, 111, 255, 0.05);
}
.wl-item.active {
  background: rgba(30, 111, 255, 0.1);
  box-shadow: inset 3px 0 0 var(--primary);
}

.wl-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-weight: 600;
  color: var(--text-1);
}
.wl-code {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}
.wl-price {
  text-align: right;
  font-weight: 600;
}
.wl-pct {
  text-align: right;
  font-weight: 600;
  padding: 3px 6px;
  border-radius: 4px;
}
.wl-item .wl-pct.up {
  background: rgba(239, 35, 42, 0.08);
}
.wl-item .wl-pct.down {
  background: rgba(20, 177, 67, 0.08);
}

@media (max-width: 820px) {
  .wl-item {
    min-height: 52px;
    padding: 10px 12px;
  }
  .wl-item:active {
    background: rgba(30, 111, 255, 0.12);
  }
  .wl-grid-head,
  .wl-item {
    grid-template-columns: 1fr 82px 86px;
  }
}
</style>
