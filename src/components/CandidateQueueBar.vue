<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { upsertWatchCandidate } from '../api'
import { useResearch } from '../composables/useResearch'
import { useMarket } from '../composables/useMarket'
import type { CandidateStatus } from '../types'

const {
  candidates,
  activeCandidateCode,
  refreshCandidates,
  openCandidate,
  removeCandidate,
  nextCandidate,
  prevCandidate,
  goFullChart,
} = useResearch()
const { watchlist } = useMarket()

const syncing = ref(false)
const notice = ref('')

onMounted(() => {
  void refreshCandidates()
})

const statusLabel = (s: CandidateStatus) =>
  ({ observe: '观察', hold: '暂存', reject: '否决' }[s])

async function pick(code: string, name: string) {
  await openCandidate(code, { name, enqueue: false, goWorkbench: true, source: 'manual' })
}

async function removeOne(e: Event, code: string, name: string) {
  e.stopPropagation()
  if (!window.confirm(`从观察队列移除「${name}」？不影响自选股。`)) return
  try {
    await removeCandidate(code)
    notice.value = `已移除 ${name}`
  } catch (err) {
    notice.value = err instanceof Error ? err.message : String(err)
  }
}

async function importWatchlist() {
  if (!watchlist.value.length) {
    notice.value = '自选为空'
    return
  }
  syncing.value = true
  notice.value = ''
  try {
    let n = 0
    for (const s of watchlist.value) {
      await upsertWatchCandidate({
        code: s.code,
        name: s.name,
        source: 'manual',
        context: { reason: '来自自选股', note: '盯盘自选送入研究池' },
      })
      n++
    }
    await refreshCandidates()
    notice.value = `已将 ${n} 只自选送入观察队列`
  } catch (e) {
    notice.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <div class="cq">
    <div class="cq-head">
      <b>观察队列</b>
      <span>{{ candidates.length }}</span>
      <div class="cq-actions">
        <button class="btn" :disabled="syncing || !watchlist.length" @click="importWatchlist">
          {{ syncing ? '导入中…' : '自选送入观察' }}
        </button>
        <button class="btn" :disabled="!candidates.length" @click="prevCandidate">上一只</button>
        <button class="btn" :disabled="!candidates.length" @click="nextCandidate">下一只</button>
        <button class="btn" :disabled="!activeCandidateCode" @click="goFullChart()">完整行情</button>
        <button class="btn" @click="refreshCandidates">刷新</button>
      </div>
    </div>
    <div v-if="notice" class="cq-notice">{{ notice }}</div>
    <div v-if="!candidates.length" class="cq-empty">
      选股结果点股票，或点「自选送入观察」把盯盘列表送进研究池。分析候选不必再加自选。
    </div>
    <div v-else class="cq-list">
      <div
        v-for="c in candidates"
        :key="c.code"
        class="cq-item"
        :class="{ active: c.code === activeCandidateCode }"
        @click="pick(c.code, c.name)"
      >
        <button class="cq-remove" title="移出观察队列" @click="removeOne($event, c.code, c.name)">✕</button>
        <span class="cq-name">{{ c.name }}<small>{{ c.code.toUpperCase() }}</small></span>
        <span class="cq-meta">
          <i :class="`st-${c.status}`">{{ statusLabel(c.status) }}</i>
          <template v-if="c.sustainability"> · {{ c.sustainability.score.toFixed(0) }}分</template>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cq { border-bottom: 1px solid var(--border); background: var(--panel-2); }
.cq-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px; }
.cq-head span { color: var(--text-3); }
.cq-actions { margin-left: auto; display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.cq-notice { padding: 0 12px 8px; color: var(--up); font-size: 11px; }
.cq-empty { padding: 8px 12px 10px; color: var(--text-3); font-size: 11px; line-height: 1.5; }
.cq-list { display: flex; gap: 6px; overflow-x: auto; padding: 0 12px 10px; }
.cq-item { position: relative; flex: 0 0 auto; min-width: 120px; padding: 7px 22px 7px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel); text-align: left; cursor: pointer; color: inherit; }
.cq-item.active { border-color: var(--primary); }
.cq-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
}
.cq-remove:hover { color: var(--down); background: rgba(239, 35, 42, .08); }
.cq-name { display: block; font-size: 12px; font-weight: 600; }
.cq-name small { margin-left: 4px; color: var(--text-3); font-weight: 400; }
.cq-meta { display: block; margin-top: 3px; color: var(--text-3); font-size: 10px; }
.st-observe { color: var(--primary); font-style: normal; }
.st-hold { color: #d99000; font-style: normal; }
.st-reject { color: var(--down); font-style: normal; }
</style>
