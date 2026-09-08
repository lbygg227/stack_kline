<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  compareResearchRevisions,
  deleteResearchRecord,
  fetchResearchDossier,
  saveResearchRecord,
} from '../api'
import type { ResearchDossier, ResearchRecord, ResearchStance, StockAnalysisResult } from '../types'

const props = defineProps<{ code: string; name: string; analysis?: StockAnalysisResult | null }>()
const emit = defineEmits<{ close: [] }>()

const dossier = ref<ResearchDossier | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const editingId = ref('')
const title = ref('')
const thesis = ref('')
const stance = ref<ResearchStance>('neutral')
const horizonDays = ref(90)
const targetPrice = ref<number | undefined>()
const stopLoss = ref<number | undefined>()
const catalystsText = ref('')
const risksText = ref('')
const tagsText = ref('')
const comparison = ref<Array<{ field: string; before: unknown; after: unknown }>>([])

const splitList = (value: string) => value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean)
const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN')
const stanceLabel = (value: ResearchStance) => ({ bullish: '看多', bearish: '看空', neutral: '中性' })[value]

async function load() {
  loading.value = true
  error.value = ''
  try {
    dossier.value = await fetchResearchDossier(props.code)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function edit(record: ResearchRecord) {
  const revision = record.revisions.at(-1)
  if (!revision) return
  editingId.value = record.id
  title.value = revision.title
  thesis.value = revision.thesis
  stance.value = revision.stance
  horizonDays.value = revision.horizonDays
  targetPrice.value = revision.targetPrice
  stopLoss.value = revision.stopLoss
  catalystsText.value = revision.catalysts.join('\n')
  risksText.value = revision.risks.join('\n')
  tagsText.value = revision.tags.join('，')
  comparison.value = []
}

function resetForm() {
  editingId.value = ''
  title.value = ''
  thesis.value = ''
  stance.value = 'neutral'
  horizonDays.value = 90
  targetPrice.value = undefined
  stopLoss.value = undefined
  catalystsText.value = ''
  risksText.value = ''
  tagsText.value = ''
  comparison.value = []
}

async function save(source: 'manual' | 'analysis' = 'manual') {
  if (!thesis.value.trim()) {
    error.value = '请填写研究结论'
    return
  }
  error.value = ''
  try {
    await saveResearchRecord({
      id: editingId.value || undefined,
      code: props.code,
      name: props.name,
      source,
      title: title.value,
      thesis: thesis.value,
      stance: stance.value,
      horizonDays: horizonDays.value,
      targetPrice: targetPrice.value,
      stopLoss: stopLoss.value,
      catalysts: splitList(catalystsText.value),
      risks: splitList(risksText.value),
      tags: splitList(tagsText.value),
      snapshot: source === 'analysis' && props.analysis
        ? { score: props.analysis.score, signal: props.analysis.signalLabel, price: props.analysis.price, summary: props.analysis.summary }
        : undefined,
    })
    notice.value = editingId.value ? '已保存新版本' : '已保存研究记录'
    resetForm()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function captureAnalysis() {
  if (!props.analysis) return
  title.value = `${props.name} 技术分析快照`
  thesis.value = props.analysis.summary
  stance.value = props.analysis.signalKey === 'strong_buy' || props.analysis.signalKey === 'buy'
    ? 'bullish'
    : props.analysis.signalKey === 'reduce' || props.analysis.signalKey === 'sell'
      ? 'bearish'
      : 'neutral'
  targetPrice.value = props.analysis.levels.target
  stopLoss.value = props.analysis.levels.stopLoss
  catalystsText.value = props.analysis.dimensions.filter((item) => item.score > item.max * 0.65).map((item) => item.detail).join('\n')
  risksText.value = props.analysis.dimensions.filter((item) => item.score < item.max * 0.4).map((item) => item.detail).join('\n')
  tagsText.value = '技术分析，自动快照'
  await save('analysis')
}

async function compare(record: ResearchRecord) {
  if (record.currentVersion < 2) return
  try {
    comparison.value = await compareResearchRevisions(record.id, record.currentVersion - 1, record.currentVersion)
    editingId.value = record.id
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function remove(record: ResearchRecord) {
  await deleteResearchRecord(record.id)
  if (editingId.value === record.id) resetForm()
  await load()
}

const showValue = (value: unknown) => Array.isArray(value) ? value.join('、') : String(value ?? '--')
onMounted(load)
</script>

<template>
  <div class="rd-mask" @click.self="emit('close')">
    <div class="rd-panel">
      <header>
        <div><h2>{{ name }} 研究档案</h2><p>{{ code.toUpperCase() }} · 结论版本与观点证据时间线</p></div>
        <button class="btn" @click="emit('close')">关闭</button>
      </header>
      <div class="rd-layout">
        <section class="rd-editor">
          <h3>{{ editingId ? '修订研究结论' : '新增研究结论' }}</h3>
          <label>标题<input v-model="title" placeholder="本次研究主题" /></label>
          <label>核心结论<textarea v-model="thesis" rows="5" placeholder="为什么看多/看空，成立条件是什么"></textarea></label>
          <div class="rd-grid">
            <label>方向<select v-model="stance"><option value="bullish">看多</option><option value="neutral">中性</option><option value="bearish">看空</option></select></label>
            <label>期限（天）<input v-model.number="horizonDays" type="number" min="1" /></label>
            <label>目标价<input v-model.number="targetPrice" type="number" step="0.01" /></label>
            <label>止损价<input v-model.number="stopLoss" type="number" step="0.01" /></label>
          </div>
          <label>催化剂<textarea v-model="catalystsText" rows="2" placeholder="一行一项"></textarea></label>
          <label>风险<textarea v-model="risksText" rows="2" placeholder="一行一项"></textarea></label>
          <label>标签<input v-model="tagsText" placeholder="价值，医药，季度跟踪" /></label>
          <div class="rd-actions">
            <button class="btn rd-primary" @click="save()">保存{{ editingId ? '新版本' : '' }}</button>
            <button v-if="analysis && !editingId" class="btn" @click="captureAnalysis">保存当前分析快照</button>
            <button v-if="editingId" class="btn" @click="resetForm">取消修订</button>
          </div>
          <div v-if="notice" class="rd-notice">{{ notice }}</div>
          <div v-if="error" class="rd-error">{{ error }}</div>
          <div v-if="comparison.length" class="rd-compare">
            <h3>最近两版变化</h3>
            <div v-for="change in comparison" :key="change.field"><b>{{ change.field }}</b><del>{{ showValue(change.before) }}</del><ins>{{ showValue(change.after) }}</ins></div>
          </div>
        </section>

        <section class="rd-content">
          <h3>研究记录</h3>
          <div v-if="loading" class="rd-empty">加载中…</div>
          <article v-for="record in dossier?.records" :key="record.id" class="rd-record">
            <div><b>{{ record.revisions.at(-1)?.title }}</b><span>v{{ record.currentVersion }} · {{ formatTime(record.updatedAt) }}</span></div>
            <p>{{ record.revisions.at(-1)?.thesis }}</p>
            <small :class="`stance-${record.revisions.at(-1)?.stance}`">{{ stanceLabel(record.revisions.at(-1)?.stance ?? 'neutral') }}</small>
            <div class="rd-record-actions"><button @click="edit(record)">修订</button><button :disabled="record.currentVersion < 2" @click="compare(record)">版本对比</button><button class="danger" @click="remove(record)">删除</button></div>
          </article>
          <div v-if="!loading && !dossier?.records.length" class="rd-empty">尚未保存研究结论</div>

          <h3>证据时间线</h3>
          <article v-for="event in dossier?.timeline" :key="event.id" class="rd-event">
            <time>{{ formatTime(event.timestamp) }}</time>
            <b>{{
              event.type === 'opinion'
                ? `观点 · ${event.author}`
                : event.type === 'event'
                  ? `资讯 · ${event.eventKind === 'announcement' ? '公告' : event.eventKind === 'regulatory' ? '监管' : '新闻'}`
                  : `研究版本 v${event.version}`
            }}</b>
            <p>{{ event.summary }}</p>
            <a v-if="event.sourceUrl" :href="event.sourceUrl" target="_blank" rel="noreferrer">查看原文</a>
          </article>
          <div v-if="!dossier?.timeline.length" class="rd-empty">暂无研究或观点证据</div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rd-mask{position:fixed;inset:0;z-index:310;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.52)}.rd-panel{width:min(1120px,100%);max-height:95vh;overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:10px}header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--panel-2);border-bottom:1px solid var(--border)}h2,h3{margin:0}h2{font-size:16px}h3{margin-bottom:10px;font-size:12px}header p{margin:2px 0 0;color:var(--text-3);font-size:10px}.rd-layout{display:grid;grid-template-columns:420px 1fr}.rd-editor,.rd-content{padding:15px}.rd-editor{border-right:1px solid var(--border)}label{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;color:var(--text-3);font-size:10px}input,textarea,select{padding:7px;border:1px solid var(--border);border-radius:4px;background:var(--panel);color:var(--text-1)}.rd-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px}.rd-actions{display:flex;flex-wrap:wrap;gap:6px}.rd-primary{background:var(--primary);border-color:var(--primary);color:#fff}.rd-notice{margin-top:8px;color:var(--up)}.rd-error{margin-top:8px;color:var(--down)}.rd-record,.rd-event,.rd-compare{margin-bottom:8px;padding:10px;border:1px solid var(--border);border-radius:5px;background:var(--panel-2)}.rd-record>div:first-child{display:flex;justify-content:space-between}.rd-record span,.rd-event time{color:var(--text-3);font-size:9px}.rd-record p,.rd-event p{margin:6px 0;font-size:11px;line-height:1.5}.rd-record-actions{display:flex;gap:8px;margin-top:7px}.rd-record-actions button{padding:0;border:0;background:none;color:var(--primary);font-size:10px;cursor:pointer}.rd-record-actions .danger{color:var(--down)}.stance-bullish{color:var(--up)}.stance-bearish{color:var(--down)}.stance-neutral{color:var(--text-3)}.rd-event b,.rd-event time{display:block}.rd-event a{font-size:10px}.rd-empty{padding:20px;text-align:center;color:var(--text-3)}.rd-compare div{display:grid;grid-template-columns:90px 1fr 1fr;gap:7px;margin-top:6px;font-size:10px}.rd-compare del{color:var(--down)}.rd-compare ins{color:var(--up)}@media(max-width:820px){.rd-mask{padding:0;align-items:flex-end}.rd-panel{max-height:97vh;border-radius:12px 12px 0 0}.rd-layout{grid-template-columns:1fr}.rd-editor{border-right:0;border-bottom:1px solid var(--border)}}
</style>
