<script setup lang="ts">
import { ref } from 'vue'
import { fetchBatchAnalysis } from '../api'
import type { BatchAnalysisItem } from '../types'

const emit = defineEmits<{ close: [] }>()

const input = ref('')
const withNews = ref(true)
const withAi = ref(false)
const running = ref(false)
const error = ref('')
const items = ref<BatchAnalysisItem[]>([])
const provider = ref('')

const normalizeCode = (raw: string): string | null => {
  const v = raw.trim().toLowerCase()
  if (/^(sh|sz|bj)\d{6}$/.test(v)) return v
  if (/^\d{6}$/.test(v)) {
    if (v[0] === '6') return 'sh' + v
    if (v[0] === '0' || v[0] === '3') return 'sz' + v
    if (v[0] === '4' || v[0] === '8') return 'bj' + v
  }
  return null
}

const parseCodes = (): string[] => {
  const parts = input.value.split(/[\s,，;；]+/)
  const out: string[] = []
  for (const p of parts) {
    const c = normalizeCode(p)
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

async function run() {
  const codes = parseCodes()
  if (codes.length === 0) {
    error.value = '请输入股票代码，例如：600519、000858、300750'
    return
  }
  running.value = true
  error.value = ''
  items.value = []
  provider.value = ''
  try {
    const res = await fetchBatchAnalysis(codes, withNews.value, withAi.value)
    items.value = res.items
    provider.value = res.newsProvider
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

const pctCls = (v: number | undefined) => (v === undefined ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const fmtPct = (v: number | undefined) => (v === undefined ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%')
const fmt = (n: number | undefined, digits = 2) => (n === undefined ? '--' : n.toFixed(digits))
</script>

<template>
  <div class="ba-mask" @click.self="emit('close')">
    <div class="ba-panel">
      <div class="ba-head">
        <div class="ba-title">
          <span class="ba-title-main">个股批量分析</span>
          <span class="ba-title-sub">技术指标 + 策略命中 + 舆情 + 可选 AI</span>
        </div>
        <button class="ba-close" @click="emit('close')">✕</button>
      </div>

      <div class="ba-body">
        <div class="ba-form">
          <textarea
            v-model="input"
            rows="3"
            placeholder="输入股票代码，用空格/逗号/换行分隔，例如：600519 000858 300750"
          ></textarea>
          <div class="ba-opts">
            <label class="ba-check">
              <input v-model="withNews" type="checkbox" />
              带舆情新闻
            </label>
            <label class="ba-check">
              <input v-model="withAi" type="checkbox" />
              AI 简报（较慢）
            </label>
            <button class="ba-run" :disabled="running" @click="run">
              {{ running ? '分析中…' : '开始分析' }}
            </button>
          </div>
          <div v-if="error" class="ba-error down">{{ error }}</div>
          <div v-else-if="provider" class="ba-provider">新闻源：{{ provider }}</div>
        </div>

        <div v-if="items.length" class="ba-list">
          <div v-for="it in items" :key="it.code" class="ba-item">
            <div class="ba-item-head">
              <span class="ba-name">{{ it.name }}</span>
              <span class="num ba-code">{{ it.code.toUpperCase() }}</span>
              <span class="num ba-price" :class="pctCls(it.changePct)">{{ fmt(it.price) }}</span>
              <span class="num ba-pct" :class="pctCls(it.changePct)">{{ fmtPct(it.changePct) }}</span>
              <span v-if="it.score !== undefined" class="ba-score">{{ it.score }}分</span>
              <span v-if="it.signalLabel" class="ba-signal">{{ it.signalLabel }}</span>
            </div>

            <div v-if="it.error" class="ba-item-error down">{{ it.error }}</div>

            <div v-if="it.strategies?.length" class="ba-chips">
              <span v-for="s in it.strategies" :key="s.key" class="ba-chip">{{ s.name }}</span>
            </div>

            <div v-if="it.summary" class="ba-summary">{{ it.summary }}</div>

            <div v-if="it.news?.length" class="ba-news">
              <div class="ba-news-title">📰 舆情</div>
              <a v-for="(n, idx) in it.news" :key="n.url + idx" class="ba-news-item" :href="n.url" target="_blank" rel="noopener">
                <span class="ba-news-t">{{ n.title }}</span>
                <span class="ba-news-s">{{ n.snippet }}</span>
              </a>
            </div>

            <div v-if="it.ai" class="ba-ai">
              <div class="ba-ai-one">💡 {{ it.ai.oneSentence }}</div>
              <pre class="ba-ai-comment">{{ it.ai.commentary }}</pre>
              <div class="ba-ai-risk down">⚠️ {{ it.ai.risk }}</div>
              <div class="ba-ai-meta">置信度：{{ it.ai.confidence }}<template v-if="it.ai.model"> · {{ it.ai.model }}</template></div>
            </div>
          </div>
        </div>

        <div v-else-if="!running" class="ba-empty">输入代码后点击「开始分析」</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ba-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 260;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.ba-panel {
  width: 100%;
  max-width: 860px;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-radius: 14px 14px 0 0;
  overflow: hidden;
}

.ba-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  flex-shrink: 0;
}
.ba-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ba-title-main {
  font-size: 15px;
  font-weight: 700;
}
.ba-title-sub {
  font-size: 11px;
  color: var(--text-3);
}
.ba-close {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: var(--panel);
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
}

.ba-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
}

.ba-form textarea {
  width: 100%;
  min-height: 64px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
}
.ba-form textarea:focus {
  border-color: var(--primary);
}
.ba-opts {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.ba-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.ba-run {
  margin-left: auto;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
}
.ba-run:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ba-error {
  margin-top: 8px;
  font-size: 12px;
}
.ba-provider {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-3);
}

.ba-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}
.ba-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: var(--panel-2);
}
.ba-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ba-name {
  font-size: 14px;
  font-weight: 700;
}
.ba-code {
  font-size: 11px;
  color: var(--text-3);
}
.ba-price {
  font-size: 13px;
}
.ba-pct {
  font-size: 12px;
}
.ba-score {
  margin-left: auto;
  font-size: 12px;
  color: var(--primary);
  font-weight: 700;
}
.ba-signal {
  font-size: 12px;
  color: var(--text-2);
}
.ba-item-error {
  margin-top: 6px;
  font-size: 12px;
}
.ba-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.ba-chip {
  padding: 3px 8px;
  border: 1px solid rgba(30, 111, 255, 0.25);
  border-radius: 12px;
  background: rgba(30, 111, 255, 0.06);
  color: var(--primary);
  font-size: 11px;
}
.ba-summary {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
.ba-news {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ba-news-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
}
.ba-news-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-decoration: none;
  border-left: 2px solid var(--border);
  padding-left: 8px;
}
.ba-news-t {
  font-size: 12px;
  color: var(--text-1);
}
.ba-news-s {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
}
.ba-ai {
  margin-top: 8px;
  padding: 8px;
  border-radius: 6px;
  background: rgba(30, 111, 255, 0.05);
}
.ba-ai-one {
  font-size: 12px;
  font-weight: 600;
}
.ba-ai-comment {
  white-space: pre-wrap;
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
.ba-ai-risk {
  font-size: 11px;
}
.ba-ai-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
}
.ba-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--text-3);
}
</style>
