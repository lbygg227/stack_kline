<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { init, dispose, type Chart } from 'klinecharts'
import { PERIODS, periodByKey } from '../types'
import { loadBarsForChart } from '../api'
import { useMarket } from '../composables/useMarket'

const props = defineProps<{ code: string; name: string }>()
const { state, setPeriod, isMobile } = useMarket()

const panelRef = ref<HTMLDivElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const periodKey = ref(state.periodKey)
const mainInd = ref('MA')
const subInd = ref('MACD')
const showIndicators = ref(false)

const MAIN_INDICATORS = [
  { key: 'MA', label: 'MA均线' },
  { key: 'EMA', label: 'EMA均线' },
  { key: 'BOLL', label: 'BOLL布林' },
  { key: 'SAR', label: 'SAR抛物线' },
  { key: 'none', label: '不显示' },
]
const SUB_INDICATORS = [
  { key: 'MACD', label: 'MACD' },
  { key: 'KDJ', label: 'KDJ' },
  { key: 'RSI', label: 'RSI' },
  { key: 'CCI', label: 'CCI' },
  { key: 'BIAS', label: 'BIAS乖离' },
  { key: 'WR', label: 'WR威廉' },
  { key: 'OBV', label: 'OBV能量' },
  { key: 'none', label: '不显示' },
]

const VOL_PANE = 'sub_vol'
const SUB_PANE = 'sub_tech'

let chart: Chart | null = null
let lastCode = ''

/** 应用主图/副图指标布局 */
function applyIndicators() {
  if (!chart) return
  // 主图指标（画在 K 线主图上）
  chart.removeIndicator({ paneId: 'candle_pane' })
  if (mainInd.value !== 'none') {
    chart.createIndicator({ name: mainInd.value, paneId: 'candle_pane' })
  }
  // 成交量（固定副图）
  chart.removeIndicator({ paneId: VOL_PANE })
  chart.createIndicator({ name: 'VOL', paneId: VOL_PANE })
  // 可选技术指标副图
  chart.removeIndicator({ paneId: SUB_PANE })
  if (subInd.value !== 'none') {
    chart.createIndicator({ name: subInd.value, paneId: SUB_PANE })
  }
}

function setupChart() {
  if (!containerRef.value) return
  chart = init(containerRef.value, {
    locale: 'zh-CN',
    styles: {
      grid: {
        horizontal: { color: '#eef0f3' },
        vertical: { color: '#eef0f3' },
      },
      candle: {
        bar: {
          compareRule: 'previous_close',
          upColor: '#ef232a',
          downColor: '#14b143',
          noChangeColor: '#8a8f99',
          upBorderColor: '#ef232a',
          downBorderColor: '#14b143',
          noChangeBorderColor: '#8a8f99',
          upWickColor: '#ef232a',
          downWickColor: '#14b143',
          noChangeWickColor: '#8a8f99',
        },
        priceMark: {
          last: {
            show: true,
            upColor: '#ef232a',
            downColor: '#14b143',
            noChangeColor: '#8a8f99',
            line: { style: 'dashed' },
          },
        },
      },
      xAxis: {
        tickText: { color: '#8a8f99' },
      },
      yAxis: {
        tickText: { color: '#8a8f99' },
      },
      crosshair: {
        horizontal: {
          line: { color: '#a6adb8', size: 1 },
          text: { backgroundColor: '#4e5560' },
        },
        vertical: {
          line: { color: '#a6adb8', size: 1 },
          text: { backgroundColor: '#4e5560' },
        },
      },
    },
  })
  if (!chart) return

  chart.setDataLoader({
    getBars: ({ type, timestamp, symbol, callback }) => {
      loading.value = true
      const code = (symbol.ticker ?? props.code) as string
      loadBarsForChart({ code, periodKey: periodKey.value, type, timestamp: timestamp ?? null })
        .then(({ bars, more }) => callback(bars, more))
        .catch(() => callback([], { forward: false, backward: false }))
        .finally(() => {
          loading.value = false
        })
    },
  })

  applyIndicators()
  chart.setSymbol({ ticker: props.code, pricePrecision: 2, volumePrecision: 0 })
  lastCode = props.code
}

function onPeriodChange(key: string) {
  periodKey.value = key
  setPeriod(key)
  if (!chart) return
  const spec = periodByKey(key)
  chart.setPeriod({ type: spec.timespan, span: spec.multiplier })
}

function zoomIn() {
  if (!chart) return
  const len = chart.getDataList().length || 1
  chart.zoomAtDataIndex(1.2, len - 1)
}
function zoomOut() {
  if (!chart) return
  const len = chart.getDataList().length || 1
  chart.zoomAtDataIndex(0.8, len - 1)
}
function resetView() {
  if (!chart) return
  const p = chart.getPeriod()
  if (p) chart.setPeriod({ type: p.type, span: p.span })
}
function scrollLatest() {
  chart?.scrollToRealTime()
}

function toggleFullscreen() {
  if (!panelRef.value) return
  if (document.fullscreenElement) {
    void document.exitFullscreen()
  } else {
    void panelRef.value.requestFullscreen?.()
  }
}

watch(
  () => props.code,
  (code) => {
    if (!chart || code === lastCode) return
    lastCode = code
    chart.setSymbol({ ticker: code, pricePrecision: 2, volumePrecision: 0 })
  },
)

watch(mainInd, applyIndicators)
watch(subInd, applyIndicators)

function onResize() {
  chart?.resize()
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  setupChart()
  window.addEventListener('resize', onResize)
  // 监听容器尺寸变化（面板切换/工具栏换行等），自动重算图表尺寸
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => chart?.resize())
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  resizeObserver?.disconnect()
  resizeObserver = null
  if (chart) {
    dispose(chart)
    chart = null
  }
})
</script>

<template>
  <div ref="panelRef" class="kline-panel">
    <div class="kline-toolbar">
      <div class="period-tabs">
        <button
          v-for="p in PERIODS"
          :key="p.key"
          class="btn"
          :class="{ active: periodKey === p.key }"
          @click="onPeriodChange(p.key)"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="toolbar-right">
        <span class="fq-tag">前复权</span>
        <select v-if="!isMobile" v-model="mainInd" class="select" title="主图指标">
          <option v-for="m in MAIN_INDICATORS" :key="m.key" :value="m.key">{{ m.label }}</option>
        </select>
        <select v-if="!isMobile" v-model="subInd" class="select" title="副图指标">
          <option v-for="s in SUB_INDICATORS" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <button v-if="isMobile" class="btn" @click="showIndicators = true">指标</button>
        <button class="btn" @click="zoomIn" title="放大">放大</button>
        <button class="btn" @click="zoomOut" title="缩小">缩小</button>
        <button class="btn" @click="resetView" title="复位">复位</button>
        <button class="btn" @click="scrollLatest" title="最新">最新</button>
        <button class="btn" @click="toggleFullscreen" title="全屏">全屏</button>
      </div>
    </div>

    <Transition name="sheet">
      <div v-if="isMobile && showIndicators" class="ind-mask" @click="showIndicators = false">
        <div class="ind-sheet" @click.stop>
          <div class="ind-sheet-head">
            <span>指标设置</span>
            <button class="btn" @click="showIndicators = false">完成</button>
          </div>
          <label class="ind-row">
            <span>主图指标</span>
            <select v-model="mainInd" class="select">
              <option v-for="m in MAIN_INDICATORS" :key="m.key" :value="m.key">{{ m.label }}</option>
            </select>
          </label>
          <label class="ind-row">
            <span>副图指标</span>
            <select v-model="subInd" class="select">
              <option v-for="s in SUB_INDICATORS" :key="s.key" :value="s.key">{{ s.label }}</option>
            </select>
          </label>
        </div>
      </div>
    </Transition>

    <div class="kline-body">
      <div ref="containerRef" class="kline-canvas"></div>
      <div v-if="loading" class="kline-loading">数据加载中…</div>
    </div>
  </div>
</template>

<style scoped>
.kline-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.kline-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  flex-wrap: wrap;
}

.period-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.fq-tag {
  font-size: 12px;
  color: var(--text-3);
  padding: 2px 8px;
  border: 1px dashed var(--border);
  border-radius: 4px;
}

.kline-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.kline-canvas {
  position: absolute;
  inset: 0;
  touch-action: none;
}

.kline-loading {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 14px;
  background: rgba(31, 35, 41, 0.75);
  color: #fff;
  border-radius: 12px;
  font-size: 12px;
  z-index: 5;
}

.ind-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.ind-sheet {
  width: 100%;
  background: var(--panel);
  border-radius: 12px 12px 0 0;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ind-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 700;
}

.ind-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--text-2);
}

.ind-row .select {
  flex: 1;
  height: 34px;
  font-size: 13px;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.2s;
}
.sheet-enter-active .ind-sheet,
.sheet-leave-active .ind-sheet {
  transition: transform 0.2s;
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .ind-sheet,
.sheet-leave-to .ind-sheet {
  transform: translateY(100%);
}

@media (max-width: 820px) {
  .kline-toolbar {
    flex-wrap: nowrap;
    gap: 6px;
    padding: 6px 8px;
  }

  .period-tabs {
    flex: 1;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 4px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .period-tabs::-webkit-scrollbar {
    display: none;
  }
  .period-tabs .btn {
    flex-shrink: 0;
    padding: 5px 9px;
    font-size: 12px;
  }

  .toolbar-right {
    flex-wrap: nowrap;
    gap: 4px;
    flex-shrink: 0;
  }
  .toolbar-right .btn {
    padding: 5px 7px;
    font-size: 11px;
  }
  .fq-tag {
    display: none;
  }
}
</style>
