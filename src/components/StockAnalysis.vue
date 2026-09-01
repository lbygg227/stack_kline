<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AiCommentary, StockAnalysisResult } from '../types'
import { fetchAiAnalysis, fetchAnalysis } from '../api'

const props = defineProps<{ code: string; name: string }>()
const emit = defineEmits<{ close: [] }>()

const loading = ref(false)
const error = ref('')
const data = ref<StockAnalysisResult | null>(null)
const aiLoading = ref(false)
const aiData = ref<AiCommentary | null>(null)

const signalCls = computed(() => {
  const k = data.value?.signalKey
  if (k === 'strong_buy' || k === 'buy') return 'bullish'
  if (k === 'reduce' || k === 'sell') return 'bearish'
  return 'neutral'
})

const ringStyle = computed(() => {
  const score = data.value?.score ?? 0
  const color = signalCls.value === 'bullish' ? '#ef232a' : signalCls.value === 'bearish' ? '#14b143' : '#8a8f99'
  return { background: `conic-gradient(${color} ${score * 3.6}deg, #eef0f3 0deg)` }
})

const fmt = (n: number | undefined, digits = 2) => (n === undefined ? '--' : n.toFixed(digits))

async function load() {
  if (!props.code) return
  loading.value = true
  error.value = ''
  aiData.value = null
  try {
    data.value = await fetchAnalysis(props.code)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    data.value = null
  } finally {
    loading.value = false
  }
}

async function loadAi() {
  if (!props.code || aiLoading.value) return
  aiLoading.value = true
  try {
    const res = await fetchAiAnalysis(props.code)
    data.value = res
    aiData.value = res.ai ?? null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiLoading.value = false
  }
}

watch(() => props.code, () => void load())
onMounted(() => void load())
</script>

<template>
  <div class="sa-mask" @click.self="emit('close')">
    <div class="sa-panel">
      <div class="sa-head">
        <div class="sa-title">
          <span class="sa-name">{{ data?.name ?? name }}</span>
          <span class="num sa-code">{{ code.toUpperCase() }}</span>
        </div>
        <button class="sa-close" @click="emit('close')">✕</button>
      </div>

      <div class="sa-body">
        <div v-if="loading" class="sa-status">分析计算中…</div>
        <div v-else-if="error" class="sa-status down">{{ error }}</div>

        <template v-else-if="data">
          <div class="sa-score-row">
            <div class="score-ring" :style="ringStyle">
              <div class="score-inner">
                <span class="num score-num">{{ data.score }}</span>
                <span class="score-label">{{ data.signalLabel }}</span>
              </div>
            </div>
            <div class="sa-price-block">
              <div class="num sa-price" :class="signalCls">{{ fmt(data.price) }}</div>
              <div class="num sa-pct" :class="signalCls">
                {{ data.changePct > 0 ? '+' : '' }}{{ fmt(data.changePct) }}%
              </div>
              <div class="sa-trend">{{ data.trend.status }} · 趋势强度 {{ data.trend.trendStrength }}</div>
            </div>
          </div>

          <div class="sa-summary">{{ data.summary }}</div>

          <div class="sa-section">
            <div class="sa-section-title">维度评分</div>
            <div v-for="d in data.dimensions" :key="d.key" class="sa-dim">
              <div class="sa-dim-head">
                <span>{{ d.name }}</span>
                <span class="num">{{ d.score }}/{{ d.max }}</span>
              </div>
              <div class="sa-dim-bar">
                <div class="sa-dim-fill" :class="d.tone" :style="{ width: (d.score / d.max) * 100 + '%' }"></div>
              </div>
              <div class="sa-dim-detail">{{ d.detail }}</div>
            </div>
          </div>

          <div class="sa-section">
            <div class="sa-section-title">关键价位</div>
            <div class="sa-levels">
              <div class="sa-level">
                <span>支撑</span>
                <span class="num">{{ data.levels.support.length ? data.levels.support.join(' / ') : '--' }}</span>
              </div>
              <div class="sa-level">
                <span>压力</span>
                <span class="num">{{ data.levels.resistance.length ? data.levels.resistance.join(' / ') : '--' }}</span>
              </div>
              <div class="sa-level">
                <span>止损</span>
                <span class="num down">{{ fmt(data.levels.stopLoss) }}</span>
              </div>
              <div class="sa-level">
                <span>目标</span>
                <span class="num up">{{ fmt(data.levels.target) }}</span>
              </div>
            </div>
          </div>

          <div class="sa-section">
            <div class="sa-section-title">技术指标</div>
            <div class="sa-ind-row">
              <span class="sa-ind-label">均线</span>
              <span class="num">{{ fmt(data.trend.ma5) }} / {{ fmt(data.trend.ma10) }} / {{ fmt(data.trend.ma20) }} / {{ fmt(data.trend.ma60) }}</span>
            </div>
            <div class="sa-ind-row">
              <span class="sa-ind-label">MACD</span>
              <span class="num">{{ data.macd.status }}（{{ data.macd.signal }}）</span>
            </div>
            <div class="sa-ind-row">
              <span class="sa-ind-label">RSI</span>
              <span class="num">{{ data.rsi.rsi6 }} / {{ data.rsi.rsi12 }} / {{ data.rsi.rsi24 }}（{{ data.rsi.status }}）</span>
            </div>
            <div class="sa-ind-row">
              <span class="sa-ind-label">量能</span>
              <span class="num">{{ data.volume.status }} · 量比(5日) {{ data.volume.ratio5d }}</span>
            </div>
          </div>

          <div v-if="data.reasons.length || data.risks.length" class="sa-section">
            <div class="sa-section-title">分析理由</div>
            <div v-for="r in data.reasons" :key="r" class="sa-reason up">✅ {{ r }}</div>
            <div v-for="r in data.risks" :key="r" class="sa-reason down">⚠️ {{ r }}</div>
          </div>

          <div class="sa-section sa-ai">
            <button v-if="!aiData && !aiLoading" class="sa-ai-btn" @click="loadAi">🤖 AI 深度点评</button>
            <div v-if="aiLoading" class="sa-ai-loading">AI 点评生成中，请稍候…</div>
            <template v-if="aiData">
              <div class="sa-ai-one">💡 {{ aiData.oneSentence }}</div>
              <pre class="sa-ai-comment">{{ aiData.commentary }}</pre>
              <div class="sa-ai-meta">置信度：{{ aiData.confidence }}<template v-if="aiData.model"> · {{ aiData.model }}</template></div>
            </template>
          </div>

          <div class="sa-disclaimer">⚠️ {{ data.disclaimer }}</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sa-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 250;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.sa-panel {
  width: 100%;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-radius: 14px 14px 0 0;
  overflow: hidden;
}

.sa-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  flex-shrink: 0;
}

.sa-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.sa-name {
  font-size: 15px;
  font-weight: 700;
}
.sa-code {
  font-size: 11px;
  color: var(--text-3);
}

.sa-close {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: var(--panel);
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
}

.sa-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
}

.sa-status {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-3);
}

.sa-score-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 0 10px;
}

.score-ring {
  width: 86px;
  height: 86px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.score-inner {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.score-num {
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
}
.score-label {
  font-size: 11px;
  color: var(--text-2);
}

.sa-price-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.sa-price {
  font-size: 24px;
  font-weight: 700;
}
.sa-pct {
  font-size: 14px;
  font-weight: 600;
}
.sa-trend {
  font-size: 12px;
  color: var(--text-3);
}

.sa-summary {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(30, 111, 255, 0.06);
  border: 1px solid rgba(30, 111, 255, 0.18);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
  margin-bottom: 8px;
}

.sa-section {
  padding: 10px 0;
  border-top: 1px solid #f0f1f4;
}
.sa-section-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 8px;
}

.sa-dim {
  margin-bottom: 8px;
}
.sa-dim-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 3px;
}
.sa-dim-bar {
  height: 6px;
  border-radius: 3px;
  background: #eef0f3;
  overflow: hidden;
}
.sa-dim-fill {
  height: 100%;
  border-radius: 3px;
}
.sa-dim-fill.bullish {
  background: var(--up);
}
.sa-dim-fill.bearish {
  background: var(--down);
}
.sa-dim-fill.neutral {
  background: #c9ced6;
}
.sa-dim-detail {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.4;
}

.sa-levels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.sa-level {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.sa-ind-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  padding: 4px 0;
  color: var(--text-2);
  line-height: 1.5;
}
.sa-ind-label {
  flex-shrink: 0;
  color: var(--text-3);
}

.sa-reason {
  font-size: 12px;
  padding: 3px 0;
  line-height: 1.5;
}

.sa-ai-btn {
  width: 100%;
  height: 38px;
  border: 1px dashed var(--primary);
  border-radius: 8px;
  background: rgba(30, 111, 255, 0.06);
  color: var(--primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.sa-ai-loading {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
.sa-ai-one {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-1);
  margin-bottom: 6px;
}
.sa-ai-comment {
  margin: 0;
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}
.sa-ai-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 6px;
}

.sa-disclaimer {
  padding: 8px 0 2px;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
  line-height: 1.5;
}

/* 桌面端：右侧抽屉 */
@media (min-width: 821px) {
  .sa-mask {
    align-items: stretch;
    justify-content: flex-end;
  }
  .sa-panel {
    width: 400px;
    max-height: 100%;
    height: 100%;
    border-radius: 12px 0 0 12px;
    box-shadow: -4px 0 20px rgba(31, 35, 41, 0.12);
  }
  .sa-body {
    padding: 12px 16px;
  }
}
</style>
