<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchCandidateReviewStats } from '../api'
import type { CandidateReviewStats } from '../types'
import { useResearch } from '../composables/useResearch'

const stats = ref<CandidateReviewStats | null>(null)
const error = ref('')
const { openWorkbench, refreshCandidates } = useResearch()

async function load() {
  error.value = ''
  try {
    stats.value = await fetchCandidateReviewStats()
    await refreshCandidates()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(load)
</script>

<template>
  <section class="cr">
    <div class="cr-head">
      <div>
        <b>观察复盘</b>
        <span>队列状态分布 · 方法校准入口（不承诺收益）</span>
      </div>
      <div class="cr-actions">
        <button class="btn" @click="load">刷新</button>
        <button class="btn" @click="openWorkbench">打开工作台</button>
      </div>
    </div>
    <div v-if="error" class="cr-error">{{ error }}</div>
    <div v-else-if="!stats" class="cr-muted">加载中…</div>
    <div v-else class="cr-grid">
      <div class="cr-card"><span>队列总数</span><b>{{ stats.total }}</b></div>
      <div class="cr-card"><span>观察中</span><b>{{ stats.byStatus.observe }}</b></div>
      <div class="cr-card"><span>暂存</span><b class="hold">{{ stats.byStatus.hold }}</b></div>
      <div class="cr-card"><span>否决</span><b class="down">{{ stats.byStatus.reject }}</b></div>
      <div class="cr-card"><span>已评可持续性</span><b>{{ stats.withSustainability }}</b></div>
      <div class="cr-card"><span>平均分</span><b>{{ stats.avgScore ?? '—' }}</b></div>
    </div>
    <div v-if="stats" class="cr-sources">
      <span v-for="(n, key) in stats.bySource" :key="key" class="cr-tag">{{ key }} {{ n }}</span>
    </div>
  </section>
</template>

<style scoped>
.cr { margin: 8px 12px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); }
.cr-head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.cr-head span, .cr-muted { color: var(--text-3); font-size: 11px; }
.cr-actions { display: flex; gap: 6px; }
.cr-error { margin-top: 8px; color: var(--down); font-size: 12px; }
.cr-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
.cr-card { padding: 8px; border-radius: 5px; background: var(--panel-2); }
.cr-card span { display: block; color: var(--text-3); font-size: 10px; }
.cr-card b { display: block; margin-top: 4px; font-size: 16px; }
.hold { color: #d99000; }
.down { color: var(--down); }
.cr-sources { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cr-tag { padding: 2px 7px; border-radius: 99px; border: 1px solid var(--border); font-size: 10px; color: var(--text-2); }
@media (max-width: 820px) {
  .cr-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
</style>
