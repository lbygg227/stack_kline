<script setup lang="ts">
import { computed } from 'vue'
import type { SustainabilityReport } from '../types'

const props = defineProps<{
  report: SustainabilityReport | null
  loading?: boolean
  error?: string
}>()

const emit = defineEmits<{
  refresh: []
  status: [status: 'observe' | 'hold' | 'reject']
  save: []
}>()

const gradeLabel = computed(() => {
  const g = props.report?.grade
  if (g === 'track') return '可跟踪'
  if (g === 'cautious') return '谨慎观察'
  if (g === 'reject') return '建议否决'
  return '—'
})

const dims = computed(() => {
  const r = props.report
  if (!r) return []
  return [
    { key: 'technical', label: '技术', value: r.technical },
    { key: 'event', label: '事件', value: r.event },
    { key: 'opinion', label: '观点', value: r.opinion },
    { key: 'industry', label: '行业', value: r.industryScore },
  ]
})
</script>

<template>
  <section class="sc-card">
    <div class="sc-head">
      <div>
        <b>可持续性</b>
        <span class="sc-sub">技术 · 事件 · 观点 · 行业（不下单）</span>
      </div>
      <button class="btn" :disabled="loading" @click="emit('refresh')">
        {{ loading ? '评估中…' : '重新评估' }}
      </button>
    </div>
    <div v-if="error" class="sc-error">{{ error }}</div>
    <div v-else-if="!report && loading" class="sc-empty">正在聚合四维证据…</div>
    <div v-else-if="!report" class="sc-empty">点击重新评估生成分数</div>
    <template v-else>
      <div class="sc-score-row">
        <div class="sc-score" :class="`grade-${report.grade}`">
          <strong>{{ report.score.toFixed(0) }}</strong>
          <span>{{ gradeLabel }}</span>
        </div>
        <div class="sc-dims">
          <div v-for="d in dims" :key="d.key" class="sc-dim">
            <span>{{ d.label }}</span>
            <b>{{ d.value }}</b>
          </div>
        </div>
      </div>
      <div v-if="report.vetoes.length" class="sc-vetoes">
        <div v-for="(v, i) in report.vetoes" :key="i">否决：{{ v }}</div>
      </div>
      <ul class="sc-list">
        <li v-for="(r, i) in report.reasons.slice(0, 4)" :key="`r${i}`">{{ r }}</li>
      </ul>
      <ul v-if="report.risks.length" class="sc-list risk">
        <li v-for="(r, i) in report.risks.slice(0, 3)" :key="`k${i}`">风险：{{ r }}</li>
      </ul>
      <div class="sc-actions">
        <button class="btn" @click="emit('status', 'observe')">观察</button>
        <button class="btn sc-hold" @click="emit('status', 'hold')">暂存</button>
        <button class="btn sc-reject" @click="emit('status', 'reject')">否决</button>
        <button class="btn sc-save" @click="emit('save')">保存结论</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.sc-card { padding: 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); }
.sc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.sc-sub, .sc-empty { color: var(--text-3); font-size: 11px; }
.sc-error { color: var(--down); font-size: 12px; }
.sc-score-row { display: flex; gap: 12px; align-items: stretch; }
.sc-score { display: flex; flex-direction: column; justify-content: center; min-width: 72px; padding: 10px; border-radius: 6px; text-align: center; }
.sc-score strong { font-size: 28px; line-height: 1; }
.sc-score span { margin-top: 4px; font-size: 11px; }
.grade-track { background: rgba(20, 177, 67, .12); color: var(--up); }
.grade-cautious { background: rgba(217, 144, 0, .12); color: #d99000; }
.grade-reject { background: rgba(239, 35, 42, .1); color: var(--down); }
.sc-dims { flex: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.sc-dim { display: flex; justify-content: space-between; padding: 6px 8px; border-radius: 4px; background: var(--panel-2); font-size: 12px; }
.sc-vetoes { margin-top: 8px; padding: 8px; border-radius: 4px; background: rgba(239, 35, 42, .08); color: var(--down); font-size: 11px; line-height: 1.5; }
.sc-list { margin: 8px 0 0; padding-left: 16px; color: var(--text-2); font-size: 11px; line-height: 1.55; }
.sc-list.risk { color: #d99000; }
.sc-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.sc-hold { color: #d99000; }
.sc-reject { color: var(--down); }
.sc-save { border-color: var(--primary); color: var(--primary); }
</style>
