<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMarket } from '../composables/useMarket'
import { usePullRefresh } from '../composables/usePullRefresh'
import MarketBadge from './MarketBadge.vue'

const { state, watchlist, selectStock, removeFromWatchlistMany, displayQuote, refreshQuotes } = useMarket()
const { distance: ptrDistance, refreshing: ptrRefreshing, onTouchStart: ptrStart, onTouchMove: ptrMove, onTouchEnd: ptrEnd } = usePullRefresh(refreshQuotes)

const managing = ref(false)
const selected = ref<string[]>([])

const list = computed(() =>
  watchlist.value.map((w) => ({ info: w, quote: displayQuote(w.code) })),
)

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const fmt = (n?: number, digits = 2) => (n === undefined ? '--' : n.toFixed(digits))

const allSelected = computed(() => watchlist.value.length > 0 && selected.value.length === watchlist.value.length)

function enterManage() {
  managing.value = true
  selected.value = []
}

function exitManage() {
  managing.value = false
  selected.value = []
}

function toggleSelect(code: string) {
  const idx = selected.value.indexOf(code)
  if (idx >= 0) selected.value.splice(idx, 1)
  else selected.value.push(code)
}

function toggleSelectAll() {
  selected.value = allSelected.value ? [] : watchlist.value.map((w) => w.code)
}

function removeSelected() {
  if (selected.value.length === 0) return
  if (!window.confirm(`确认将选中的 ${selected.value.length} 只股票移出自选？`)) return
  removeFromWatchlistMany(selected.value)
  exitManage()
}

function onItemClick(code: string, name: string) {
  if (managing.value) {
    toggleSelect(code)
    return
  }
  selectStock(code, name)
}
</script>

<template>
  <aside class="watchlist">
    <div class="wl-head">
      <span class="wl-title">自选股</span>
      <span class="wl-count">{{ watchlist.length }}</span>
      <button class="wl-manage-btn" @click="managing ? exitManage() : enterManage()">
        {{ managing ? '完成' : '管理' }}
      </button>
    </div>

    <div v-if="managing" class="wl-batch-bar">
      <button class="wl-batch-btn" @click="toggleSelectAll">
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
      <span class="wl-batch-count">已选 {{ selected.length }} / {{ watchlist.length }}</span>
      <button class="wl-batch-btn danger" :disabled="selected.length === 0" @click="removeSelected">
        删除选中
      </button>
    </div>

    <div class="wl-grid-head" :class="{ managing }">
      <span v-if="managing" class="wl-check-head"></span>
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
      <button
        v-for="{ info, quote } in list"
        :key="info.code"
        class="wl-item"
        :class="{ active: state.currentCode === info.code, managing }"
        @click="onItemClick(info.code, info.name)"
      >
        <span v-if="managing" class="wl-check" :class="{ checked: selected.includes(info.code) }"></span>
        <span class="wl-name">
          <span class="wl-title-line"><MarketBadge :code="info.code" />{{ info.name }}</span>
          <span class="wl-code num">{{ info.code.toUpperCase() }}</span>
        </span>
        <span class="num wl-price" :class="quote ? pctCls(quote.changePct) : 'flat'">
          {{ fmt(quote?.price) }}
        </span>
        <span class="num wl-pct" :class="quote ? pctCls(quote.changePct) : 'flat'">
          {{ quote ? (quote.changePct > 0 ? '+' : '') + quote.changePct.toFixed(2) + '%' : '--' }}
        </span>
      </button>

      <div v-if="watchlist.length === 0" class="wl-empty">
        暂无自选。在行情页点「☆ 加自选」，或在全市场列表点星标加入。
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
.wl-manage-btn {
  margin-left: auto;
  padding: 3px 9px;
  border: 1px solid rgba(30, 111, 255, 0.3);
  border-radius: 6px;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
}
.wl-manage-btn:hover {
  background: rgba(30, 111, 255, 0.06);
}

.wl-batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(30, 111, 255, 0.05);
}
.wl-batch-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.wl-batch-btn.danger {
  color: var(--up);
  border-color: rgba(239, 35, 42, 0.35);
  background: rgba(239, 35, 42, 0.06);
}
.wl-batch-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.wl-batch-count {
  flex: 1;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

.wl-grid-head,
.wl-item {
  display: grid;
  grid-template-columns: 1fr 52px 56px;
  gap: 3px;
  align-items: center;
}
.wl-grid-head.managing,
.wl-item.managing {
  grid-template-columns: 22px 1fr 52px 56px;
}
.wl-check-head {
  width: 16px;
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

.wl-item {
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-bottom: 1px solid #f0f1f4;
  background: var(--panel);
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

.wl-check {
  width: 16px;
  height: 16px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--panel);
  position: relative;
  flex-shrink: 0;
}
.wl-check.checked {
  background: var(--primary);
  border-color: var(--primary);
}
.wl-check.checked::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 3px;
  height: 7px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.wl-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-weight: 600;
  color: var(--text-1);
}
.wl-title-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
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
    grid-template-columns: 1fr 70px 74px;
  }
  .wl-grid-head.managing,
  .wl-item.managing {
    grid-template-columns: 24px 1fr 70px 74px;
  }
}
</style>
