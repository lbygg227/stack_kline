<script setup lang="ts">
import { ref } from 'vue'
import { runFusionScreen } from '../api'
import type { FusionResult, OpinionPlatform, StrategyConditions } from '../types'
import { useMarket } from '../composables/useMarket'

const props = defineProps<{ conditions: StrategyConditions }>()
const emit = defineEmits<{ close: [] }>()
const { selectStock, setView, setMobileTab, isMobile } = useMarket()

const platform = ref<OpinionPlatform | ''>('')
const opinionRequired = ref(false)
const minOpinionScore = ref(15)
const technicalWeight = ref(65)
const opinionWeight = ref(35)
const running = ref(false)
const error = ref('')
const results = ref<FusionResult[]>([])
const counts = ref({ technical: 0, opinion: 0 })

async function run() {
  running.value = true
  error.value = ''
  results.value = []
  try {
    const response = await runFusionScreen(props.conditions, {
      platform: platform.value || undefined,
      opinionRequired: opinionRequired.value,
      minOpinionScore: minOpinionScore.value,
      technicalWeight: technicalWeight.value,
      opinionWeight: opinionWeight.value,
    })
    results.value = response.results
    counts.value = { technical: response.technicalCount, opinion: response.opinionSignalCount }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

function openStock(result: FusionResult) {
  selectStock(result.code, result.name)
  emit('close')
  if (isMobile.value) setMobileTab('market')
  else setView('market')
}

const recommendation = (value: FusionResult['recommendation']) =>
  ({ recommend: '推荐', observe: '观察', avoid: '回避' })[value]
const fmt = (value: number | undefined) => value === undefined ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(0)}`
</script>

<template>
  <div class="fp-mask" @click.self="emit('close')">
    <div class="fp-panel">
      <header>
        <div><h2>融合选股</h2><p>技术条件初筛 + 博主观点共识校验</p></div>
        <button class="btn" @click="emit('close')">关闭</button>
      </header>
      <section class="fp-config">
        <label><span>观点来源</span><select v-model="platform"><option value="">知乎 + 雪球</option><option value="zhihu">知乎</option><option value="xueqiu">雪球</option></select></label>
        <label><span>技术权重</span><input v-model.number="technicalWeight" type="number" min="0" max="100" /></label>
        <label><span>观点权重</span><input v-model.number="opinionWeight" type="number" min="0" max="100" /></label>
        <label><span>最低看多分</span><input v-model.number="minOpinionScore" type="number" min="-100" max="100" /></label>
        <label class="fp-check"><input v-model="opinionRequired" type="checkbox" /> 必须存在达到门槛的看多观点</label>
        <button class="btn fp-primary" :disabled="running" @click="run">{{ running ? '融合计算中…' : '运行融合选股' }}</button>
      </section>
      <div v-if="error" class="fp-error">{{ error }}</div>
      <div v-if="results.length || counts.technical" class="fp-summary">
        技术候选 {{ counts.technical }} 只 · 有效观点信号 {{ counts.opinion }} 只 · 融合输出 {{ results.length }} 只
      </div>
      <section class="fp-results">
        <article v-for="result in results" :key="result.code" class="fp-card" @click="openStock(result)">
          <div class="fp-top">
            <span><b>{{ result.name }}</b><small>{{ result.code.toUpperCase() }}</small></span>
            <strong :class="`rec-${result.recommendation}`">{{ recommendation(result.recommendation) }}</strong>
          </div>
          <div class="fp-scores">
            <span>融合 <b>{{ result.fusionScore.toFixed(1) }}</b></span>
            <span>技术 {{ result.technicalScore.toFixed(1) }}</span>
            <span>观点 {{ fmt(result.opinionScore) }}</span>
          </div>
          <p>{{ result.reasons.slice(0, 3).join('；') }}</p>
          <div v-if="result.authors.length" class="fp-muted">来源：{{ result.authors.join('、') }}</div>
          <div v-if="result.risks.length" class="fp-risk">风险：{{ result.risks.slice(0, 2).join('；') }}</div>
        </article>
        <div v-if="!running && counts.technical > 0 && results.length === 0" class="fp-empty">当前观点门槛下没有融合候选</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.fp-mask{position:fixed;inset:0;z-index:295;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.5)}.fp-panel{width:min(1000px,100%);max-height:94vh;overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:10px}header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--panel-2);border-bottom:1px solid var(--border)}h2{margin:0;font-size:16px}header p{margin:2px 0 0;color:var(--text-3);font-size:10px}.fp-config{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;align-items:end;padding:14px;border-bottom:1px solid var(--border)}.fp-config label{display:flex;flex-direction:column;gap:4px;color:var(--text-3);font-size:10px}.fp-config input,.fp-config select{min-width:0;padding:7px;border:1px solid var(--border);border-radius:4px;background:var(--panel);color:var(--text-1)}.fp-check{flex-direction:row!important;align-items:center}.fp-check input{width:auto}.fp-primary{background:var(--primary);border-color:var(--primary);color:#fff}.fp-error,.fp-summary{margin:10px 14px 0;font-size:11px}.fp-error{color:var(--down)}.fp-summary{color:var(--text-3)}.fp-results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:14px}.fp-card{padding:11px;border:1px solid var(--border);border-radius:6px;background:var(--panel-2);cursor:pointer}.fp-card:hover{border-color:var(--primary)}.fp-top{display:flex;justify-content:space-between}.fp-top small{display:block;color:var(--text-3);font-weight:400}.rec-recommend{color:var(--up)}.rec-observe{color:#d99000}.rec-avoid{color:var(--down)}.fp-scores{display:flex;gap:12px;margin:8px 0;font-size:11px}.fp-card p,.fp-muted,.fp-risk{margin:5px 0;font-size:10px;line-height:1.5}.fp-muted{color:var(--text-3)}.fp-risk{color:#d99000}.fp-empty{grid-column:1/-1;padding:30px;text-align:center;color:var(--text-3)}@media(max-width:820px){.fp-mask{padding:0;align-items:flex-end}.fp-panel{max-height:96vh;border-radius:12px 12px 0 0}.fp-config{grid-template-columns:repeat(2,1fr)}.fp-results{grid-template-columns:1fr}}
</style>
