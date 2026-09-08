<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMarket } from '../composables/useMarket'
import StockAnalysis from './StockAnalysis.vue'

const { state, toggleWatchlist, isInWatchlist } = useMarket()
const showAnalysis = ref(false)

const q = computed(() => state.quote)
const starred = computed(() => isInWatchlist(state.currentCode))

const cls = computed(() => {
  const c = (q.value?.changePct ?? 0)
  return c > 0 ? 'up' : c < 0 ? 'down' : 'flat'
})

const items = computed(() => {
  const it = q.value
  if (!it) return []
  const wan = (n: number) => (n / 1e4).toFixed(2)
  return [
    { label: '今开', value: it.open.toFixed(2) },
    { label: '昨收', value: it.prevClose.toFixed(2) },
    { label: '最高', value: it.high.toFixed(2), color: 'up' },
    { label: '最低', value: it.low.toFixed(2), color: 'down' },
    { label: '成交量', value: `${wan(it.volume)}万手` },
    { label: '成交额', value: `${(it.amount / 1e4).toFixed(2)}亿` },
    { label: '换手率', value: `${it.turnover.toFixed(2)}%` },
    { label: '量比', value: it.volumeRatio.toFixed(2) },
    { label: '振幅', value: `${it.amplitude.toFixed(2)}%` },
    { label: '市盈率', value: it.pe ? it.pe.toFixed(2) : '--' },
  ]
})

function onToggleWatch() {
  toggleWatchlist(state.currentCode, state.currentName)
}
</script>

<template>
  <div class="quote-header">
    <div class="qh-left">
      <div class="qh-name-row">
        <span class="qh-name">{{ state.currentName }}</span>
        <span class="qh-code num">{{ state.currentCode.toUpperCase() }}</span>
        <button
          class="qh-star-btn"
          :class="{ on: starred }"
          :title="starred ? '移出自选' : '加入自选'"
          @click="onToggleWatch"
        >
          {{ starred ? '★ 已自选' : '☆ 加自选' }}
        </button>
        <button class="qh-analysis-btn" @click="showAnalysis = true">📊 分析</button>
      </div>
      <template v-if="q">
        <div class="qh-price-row">
          <span class="num qh-price" :class="cls">{{ q.price.toFixed(2) }}</span>
          <span class="num qh-change" :class="cls">
            {{ q.change > 0 ? '+' : '' }}{{ q.change.toFixed(2) }}
          </span>
          <span class="num qh-pct" :class="cls">
            {{ q.changePct > 0 ? '+' : '' }}{{ q.changePct.toFixed(2) }}%
          </span>
        </div>
        <div class="qh-cap">
          总市值 <span class="num">{{ q.mktCapTotal.toFixed(0) }}亿</span>
          &nbsp;·&nbsp;流通市值 <span class="num">{{ q.mktCapFloat.toFixed(0) }}亿</span>
        </div>
      </template>
      <div v-else class="qh-loading">报价加载中…</div>
    </div>
    <div class="qh-stats">
      <div v-for="it in items" :key="it.label" class="qh-stat">
        <span class="qs-label">{{ it.label }}</span>
        <span class="num qs-value" :class="it.color ?? ''">{{ it.value }}</span>
      </div>
    </div>
  </div>

  <StockAnalysis
    v-if="showAnalysis"
    :code="state.currentCode"
    :name="state.currentName"
    @close="showAnalysis = false"
  />
</template>

<style scoped>
.quote-header {
  display: flex;
  align-items: stretch;
  gap: 20px;
  padding: 12px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
}

.qh-left {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-width: 240px;
}

.qh-name-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.qh-name {
  font-size: 18px;
  font-weight: 700;
}
.qh-analysis-btn {
  margin-left: 10px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel-2);
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.qh-analysis-btn:hover {
  border-color: var(--primary);
  background: rgba(30, 111, 255, 0.06);
}
.qh-star-btn {
  margin-left: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.qh-star-btn:hover {
  border-color: #d99000;
  color: #d99000;
}
.qh-star-btn.on {
  border-color: #d99000;
  background: rgba(217, 144, 0, 0.1);
  color: #d99000;
}
.qh-code {
  font-size: 12px;
  color: var(--text-3);
}

.qh-price-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.qh-price {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
}
.qh-change,
.qh-pct {
  font-size: 15px;
  font-weight: 600;
}

.qh-cap {
  font-size: 12px;
  color: var(--text-3);
}
.qh-loading {
  color: var(--text-3);
  font-size: 13px;
}

.qh-stats {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px 16px;
  align-content: center;
  border-left: 1px solid var(--border);
  padding-left: 20px;
}

.qh-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.qs-label {
  font-size: 11px;
  color: var(--text-3);
}
.qs-value {
  font-size: 14px;
  font-weight: 600;
}

@media (max-width: 820px) {
  .quote-header {
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
  }
  .qh-left {
    min-width: 0;
  }
  .qh-stats {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 14px;
    border-left: none;
    border-top: 1px solid var(--border);
    padding-left: 0;
    padding-top: 8px;
    -webkit-overflow-scrolling: touch;
  }
  .qh-stat {
    flex-shrink: 0;
    min-width: 58px;
  }
  .qh-name {
    font-size: 17px;
  }
  .qh-price {
    font-size: 26px;
  }
}
</style>
