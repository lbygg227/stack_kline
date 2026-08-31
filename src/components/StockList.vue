<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMarket } from '../composables/useMarket'
import { usePullRefresh } from '../composables/usePullRefresh'

const { state, watchlist, selectStock, removeFromWatchlist, displayQuote, refreshQuotes } = useMarket()
const { distance: ptrDistance, refreshing: ptrRefreshing, onTouchStart: ptrStart, onTouchMove: ptrMove, onTouchEnd: ptrEnd } = usePullRefresh(refreshQuotes)

const swipedCode = ref('')
let touchStartX = 0
let touchStartY = 0

const list = computed(() =>
  watchlist.value.map((w) => ({ info: w, quote: displayQuote(w.code) })),
)

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const fmt = (n?: number, digits = 2) => (n === undefined ? '--' : n.toFixed(digits))

function onItemClick(code: string, name: string) {
  if (swipedCode.value === code) {
    swipedCode.value = ''
    return
  }
  swipedCode.value = ''
  selectStock(code, name)
}

function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  touchStartX = t.clientX
  touchStartY = t.clientY
}

function onTouchMove(e: TouchEvent) {
  const t = e.touches[0]
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy)) {
    swipedCode.value = dx < 0 ? (e.currentTarget as HTMLElement).dataset.code ?? '' : ''
  }
}

function onTouchEnd() {
  // 距离在 move 中已处理；这里仅保留用于将来微调
}
</script>

<template>
  <aside class="watchlist">
    <div class="wl-head">
      <span class="wl-title">自选股</span>
      <span class="wl-count">{{ watchlist.length }}</span>
    </div>
    <div class="wl-grid-head">
      <span>名称</span>
      <span class="num">最新价</span>
      <span class="num">涨跌幅</span>
    </div>
    <div
      class="wl-list"
      @touchstart.passive="ptrStart"
      @touchmove.passive="ptrMove"
      @touchend.passive="ptrEnd"
    >
      <div class="ptr" :class="{ refreshing: ptrRefreshing }" :style="{ height: ptrDistance + 'px' }">
        {{ ptrRefreshing ? '刷新中…' : ptrDistance >= 55 ? '释放刷新' : '下拉刷新' }}
      </div>
      <div
        v-for="{ info, quote } in list"
        :key="info.code"
        class="wl-item-wrap"
        :class="{ swiped: swipedCode === info.code }"
      >
        <button class="wl-delete" @click="removeFromWatchlist(info.code)">删除</button>
        <button
          class="wl-item"
          :class="{ active: state.currentCode === info.code }"
          :data-code="info.code"
          @click="onItemClick(info.code, info.name)"
          @touchstart.passive="onTouchStart"
          @touchmove.passive="onTouchMove"
          @touchend.passive="onTouchEnd"
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

      <div v-if="watchlist.length === 0" class="wl-empty">
        暂无自选，请到「市场」页选择股票
      </div>
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
  -webkit-overflow-scrolling: touch;
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

.wl-item-wrap {
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid #f0f1f4;
}

.wl-delete {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 72px;
  border: none;
  background: var(--up);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.wl-item {
  position: relative;
  width: 100%;
  padding: 9px 12px;
  border: none;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  transition: transform 0.2s, background 0.12s;
}
.wl-item-wrap.swiped .wl-item {
  transform: translateX(-72px);
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

.wl-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
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
