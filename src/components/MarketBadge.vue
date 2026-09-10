<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ code: string }>()

const info = computed(() => {
  const c = props.code.toLowerCase()
  if (/^sh688/.test(c)) return { label: '科', title: '科创板', cls: 'star' }
  if (/^sh/.test(c)) return { label: '沪', title: '沪市主板', cls: 'sh' }
  if (/^sz30/.test(c)) return { label: '创', title: '创业板', cls: 'cyb' }
  if (/^sz/.test(c)) return { label: '深', title: '深市主板', cls: 'sz' }
  if (/^bj/.test(c)) return { label: '北', title: '北交所', cls: 'bj' }
  return { label: '?', title: '未知市场', cls: 'unknown' }
})
</script>

<template>
  <span class="market-badge" :class="info.cls" :title="info.title">{{ info.label }}</span>
</template>

<style scoped>
.market-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  flex-shrink: 0;
  color: #fff;
}
.market-badge.sh { background: #2563eb; }
.market-badge.sz { background: #0891b2; }
.market-badge.cyb { background: #ea580c; }
.market-badge.star { background: #b91c1c; }
.market-badge.bj { background: #15803d; }
.market-badge.unknown { background: #94a3b8; }
</style>
