<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchDataHealth, fixData } from '../api'
import type { DataHealthReport } from '../types'

const report = ref<DataHealthReport | null>(null)
const fixing = ref(false)
const collapsed = ref(true)

async function load() {
  try {
    report.value = await fetchDataHealth()
  } catch {
    report.value = null
  }
}

async function fix() {
  fixing.value = true
  try {
    await fixData('all')
    // 补数据是后台任务（日K预取约 3 分钟），给用户一个提示后重查
    window.setTimeout(() => void load(), 8000)
  } finally {
    fixing.value = false
  }
}

const problems = computed(() => (report.value?.items ?? []).filter((item) => item.level !== 'ok'))
const visible = computed(() => Boolean(report.value && report.value.level !== 'ok'))

onMounted(() => void load())
</script>

<template>
  <div v-if="visible && report" class="health-banner" :class="report.level">
    <span class="hb-dot"></span>
    <b>数据滞后</b>
    <span class="hb-summary">
      最近已收盘交易日 {{ report.expectedTradingDate || '未知' }}，
      {{ problems.length }} 项数据落后：
      <span v-for="(item, index) in (collapsed ? problems.slice(0, 2) : problems)" :key="item.key">
        {{ index > 0 ? '；' : '' }}{{ item.label }} = {{ item.value }}<template v-if="item.expected">（应为 {{ item.expected }}）</template>
      </span>
    </span>
    <button class="hb-btn" @click="collapsed = !collapsed">{{ collapsed ? '全部' : '收起' }}</button>
    <button class="hb-btn primary" :disabled="fixing" @click="fix">{{ fixing ? '已触发…' : '立即补数据' }}</button>
  </div>
</template>

<style scoped>
.health-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 10px 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid #e08a2e;
  border-radius: 8px;
  background: rgba(224, 138, 46, 0.08);
  font-size: 12px;
  color: var(--text-2);
}
.health-banner.error {
  border-left-color: var(--down);
  background: rgba(20, 177, 67, 0.08);
}
.hb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #e08a2e;
}
.health-banner.error .hb-dot { background: var(--down); }
.hb-summary { flex: 1; min-width: 200px; line-height: 1.6; }
.hb-btn {
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  font-size: 11px;
  cursor: pointer;
}
.hb-btn.primary { border-color: var(--primary); color: var(--primary); }
</style>
