<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { analyzeThesis, deleteThesis, discussThesis, fetchTheses, saveThesis } from '../api'
import type { MyThesisRecord, ThesisAnalyzeResponse, ThesisListResponse } from '../types'

const text = ref('')
const analyzing = ref(false)
const saving = ref(false)
const error = ref('')
const result = ref<ThesisAnalyzeResponse | null>(null)
const list = ref<ThesisListResponse | null>(null)
const activeRecord = ref<MyThesisRecord | null>(null)

const discussInput = ref('')
const discussing = ref(false)
const messages = ref<Array<{ role: 'user' | 'assistant'; content: string; needed?: string[] }>>([])

const STYLE_LABEL: Record<string, string> = {
  trend: '趋势',
  limit_up: '打板',
  pullback: '低吸',
  leader: '龙头',
  relay: '补涨',
  event: '事件',
  fund: '基本面',
  opinion: '观点',
}

const DIMENSION_LABEL: Record<string, string> = {
  board: '板块效应',
  fundamental: '基本面',
  technical: '技术面',
  fund: '资金面',
  dragon: '龙虎榜',
  event: '事件催化',
  opinion: '博主观点',
  industry: '行业',
  sentiment: '情绪周期',
}

const pack = computed(() => result.value?.pack)
const facts = computed(() => result.value?.facts ?? [])
const supportFacts = computed(() => facts.value.filter((fact) => fact.stance === 'support'))
const againstFacts = computed(() => facts.value.filter((fact) => fact.stance === 'against'))
const neutralFacts = computed(() => facts.value.filter((fact) => fact.stance === 'neutral'))

const conclusionLabel = computed(() => {
  const c = result.value?.verdict?.conclusion
  return c === 'support' ? '证据支持' : c === 'partial' ? '证据分歧' : c === 'against' ? '证据偏向反面' : ''
})

const conclusionClass = computed(() => {
  const c = result.value?.verdict?.conclusion
  return c === 'support' ? 'ok' : c === 'partial' ? 'warn' : c === 'against' ? 'bad' : ''
})

async function runAnalyze() {
  if (text.value.trim().length < 4) {
    error.value = '请先写下你的观点（至少 4 个字）'
    return
  }
  analyzing.value = true
  error.value = ''
  activeRecord.value = null
  messages.value = []
  try {
    result.value = await analyzeThesis({ text: text.value.trim() })
    if (!result.value.ok) error.value = result.value.reason ?? '未能识别标的'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    analyzing.value = false
  }
}

async function save() {
  if (!result.value?.structure) return
  saving.value = true
  try {
    await saveThesis({
      text: text.value.trim(),
      code: result.value.structure.code,
      structure: result.value.structure,
    })
    await loadList()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function loadList() {
  try {
    list.value = await fetchTheses()
  } catch {
    list.value = null
  }
}

async function remove(id: string) {
  await deleteThesis(id).catch(() => null)
  if (activeRecord.value?.id === id) activeRecord.value = null
  await loadList()
}

function openRecord(record: MyThesisRecord) {
  activeRecord.value = record
  result.value = null
  messages.value = []
}

async function send() {
  const question = discussInput.value.trim()
  if (!question) return
  const code = activeRecord.value?.code ?? result.value?.structure?.code
  if (!code) {
    error.value = '先让系统识别出标的，再展开讨论'
    return
  }
  messages.value.push({ role: 'user', content: question })
  discussInput.value = ''
  discussing.value = true
  try {
    const reply = await discussThesis({
      code,
      question,
      text: text.value.trim() || question,
      history: messages.value.map((item) => ({ role: item.role, content: item.content })),
    })
    messages.value.push({ role: 'assistant', content: reply.reply, needed: reply.neededData })
  } catch (e) {
    messages.value.push({ role: 'assistant', content: e instanceof Error ? e.message : String(e) })
  } finally {
    discussing.value = false
  }
}

function fmtTime(value: number) {
  const date = new Date(value)
  return String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0') + ' ' +
    String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

onMounted(() => void loadList())
</script>

<template>
  <div class="thesis">
    <header class="thesis-head">
      <div>
        <h2>我的观点</h2>
        <p>写下你的判断 → 系统用本地数据对你对账（含反证）→ 落成记录并按持有期结算</p>
      </div>
      <div v-if="list" class="thesis-stats">
        <span>追踪 <b>{{ list.stats.total }}</b></span>
        <span>已结算 <b>{{ list.stats.settled }}</b></span>
        <span>胜率 <b :class="list.stats.winRate >= 50 ? 'up' : 'down'">{{ list.stats.winRate }}%</b></span>
        <span>平均超额 <b :class="list.stats.averageExcessPct >= 0 ? 'up' : 'down'">{{ list.stats.averageExcessPct }}%</b></span>
      </div>
    </header>

    <div class="thesis-body">
      <!-- 左：输入与对话 -->
      <section class="thesis-input">
        <label class="ti-label">我的看法（带上股票名称或代码）</label>
        <textarea
          v-model="text"
          rows="4"
          placeholder="例如：固态电池这波是主线，先导基电是板块龙头，回调到 20 日线可以低吸，主力资金一直净流入"
        ></textarea>
        <div class="ti-actions">
          <button class="btn primary" :disabled="analyzing" @click="runAnalyze">
            {{ analyzing ? '对账中…' : '用数据对账' }}
          </button>
          <button class="btn" :disabled="!result?.structure || saving" @click="save">
            {{ saving ? '保存中…' : '落成观点并追踪' }}
          </button>
          <span v-if="result?.structure" class="ti-parsed">
            识别：{{ result.structure.name }}（{{ result.structure.code.toUpperCase() }}）·
            {{ result.structure.direction === 'bull' ? '看多' : result.structure.direction === 'bear' ? '看空' : '观察' }} ·
            {{ STYLE_LABEL[result.structure.style] }} · {{ result.structure.horizonDays }} 日
            <i v-if="result.parser === 'rule'">（规则解析）</i>
          </span>
        </div>
        <p v-if="error" class="ti-error">{{ error }}</p>

        <div class="ti-discuss">
          <div class="td-title">继续讨论（每条回应都会重新取证，不会顺着你说）</div>
          <div v-if="messages.length" class="td-messages">
            <div v-for="(item, index) in messages" :key="index" class="td-msg" :class="item.role">
              <div class="td-role">{{ item.role === 'user' ? '我' : 'AI' }}</div>
              <div class="td-content">{{ item.content }}</div>
              <div v-if="item.needed && item.needed.length" class="td-needed">
                需要补的数据：{{ item.needed.join('、') }}
              </div>
            </div>
          </div>
          <div class="td-input">
            <input
              v-model="discussInput"
              type="text"
              placeholder="例如：我觉得昨天那是洗盘，你怎么看"
              @keydown.enter="send"
            />
            <button class="btn" :disabled="discussing" @click="send">{{ discussing ? '…' : '发送' }}</button>
          </div>
        </div>

        <div v-if="list?.items.length" class="ti-list">
          <div class="td-title">我的观点记录（{{ list.items.length }}）</div>
          <button
            v-for="record in list.items"
            :key="record.id"
            class="ti-record"
            :class="{ active: activeRecord?.id === record.id }"
            @click="openRecord(record)"
          >
            <span class="tr-main">
              <b>{{ record.name }}</b>
              <span class="tr-tag">{{ record.direction === 'bull' ? '看多' : record.direction === 'bear' ? '看空' : '观察' }}</span>
              <span class="tr-tag muted">{{ STYLE_LABEL[record.style] }}</span>
              <span class="tr-score" :class="record.verdict.score >= 62 ? 'up' : record.verdict.score < 45 ? 'down' : ''">
                支持度 {{ record.verdict.score }}
              </span>
            </span>
            <span class="tr-sub">
              {{ fmtTime(record.createdAt) }} · 持有 {{ record.horizonDays }} 日 ·
              <template v-if="record.evaluation.status === 'settled'">
                收益 {{ record.evaluation.returnPct }}%，超额
                <b :class="(record.evaluation.excessPct ?? 0) >= 0 ? 'up' : 'down'">{{ record.evaluation.excessPct }}%</b>
              </template>
              <template v-else>待结算</template>
            </span>
          </button>
        </div>
      </section>

      <!-- 右：证据面板 -->
      <section class="thesis-evidence">
        <div v-if="!result?.ok && !activeRecord" class="te-empty">
          左侧写下你的观点后点「用数据对账」，这里会列出支持证据、反证、失效条件与历史同类情形。
        </div>

        <template v-else>
          <div class="te-conclusion" :class="conclusionClass">
            <div class="te-score">
              <b>{{ (result?.verdict ?? activeRecord?.verdict)?.score }}</b>
              <span>/100</span>
            </div>
            <div class="te-conclusion-text">
              <div class="te-conclusion-label">{{ conclusionLabel || activeRecord?.verdict.summary }}</div>
              <p>{{ (result?.verdict ?? activeRecord?.verdict)?.summary }}</p>
            </div>
          </div>

          <div v-if="(result?.similar ?? []).length" class="te-block">
            <h4>历史同类情形（引用本地回测）</h4>
            <ul class="te-list">
              <li v-for="(line, index) in result?.similar" :key="index">{{ line }}</li>
            </ul>
          </div>

          <div class="te-cols">
            <div class="te-block">
              <h4>支持证据（{{ supportFacts.length }}）</h4>
              <ul class="te-facts">
                <li v-for="fact in supportFacts" :key="fact.key" class="fact-support">
                  <b>{{ fact.label }}</b><span>{{ fact.detail }}</span>
                </li>
                <li v-if="!supportFacts.length" class="empty">暂无</li>
              </ul>
            </div>
            <div class="te-block">
              <h4>反证与风险（{{ againstFacts.length }}）</h4>
              <ul class="te-facts">
                <li v-for="fact in againstFacts" :key="fact.key" class="fact-against">
                  <b>{{ fact.label }}</b><span>{{ fact.detail }}</span>
                </li>
                <li v-if="!againstFacts.length" class="empty">暂无反向证据（样本有限，仍需谨慎）</li>
              </ul>
            </div>
          </div>

          <div v-if="(result?.claims ?? activeRecord?.claims ?? []).length" class="te-block">
            <h4>逐条逻辑判定</h4>
            <ul class="te-claims">
              <li
                v-for="(claim, index) in (result?.claims ?? activeRecord?.claims ?? [])"
                :key="index"
                :class="'claim-' + claim.verdict"
              >
                <div class="claim-head">
                  <span class="claim-verdict">
                    {{ claim.verdict === 'supported' ? '数据支持' : claim.verdict === 'refuted' ? '数据反对' : '数据不足' }}
                  </span>
                  <span class="claim-dim">{{ DIMENSION_LABEL[claim.dimension] ?? claim.dimension }}</span>
                  <span class="claim-text">{{ claim.text }}</span>
                </div>
                <div v-for="(line, i) in claim.evidence" :key="'e' + i" class="claim-line ok">+ {{ line }}</div>
                <div v-for="(line, i) in claim.counter" :key="'c' + i" class="claim-line bad">− {{ line }}</div>
              </li>
            </ul>
          </div>

          <div class="te-cols">
            <div class="te-block">
              <h4>失效条件（什么情况算我看错）</h4>
              <ul class="te-list">
                <li v-for="(line, index) in (result?.verdict ?? activeRecord?.verdict)?.invalidation ?? []" :key="index">{{ line }}</li>
              </ul>
            </div>
            <div class="te-block">
              <h4>关键观察点</h4>
              <ul class="te-list">
                <li v-for="(line, index) in (result?.verdict ?? activeRecord?.verdict)?.watch ?? []" :key="index">{{ line }}</li>
              </ul>
            </div>
          </div>

          <div v-if="neutralFacts.length" class="te-block">
            <h4>中性事实（仅陈列，不参与结论）</h4>
            <ul class="te-facts">
              <li v-for="fact in neutralFacts" :key="fact.key" class="fact-neutral">
                <b>{{ fact.label }}</b><span>{{ fact.detail }}</span><i>{{ fact.source }}</i>
              </li>
            </ul>
          </div>

          <div v-if="pack" class="te-block te-pack">
            <h4>数据快照</h4>
            <div class="pack-grid">
              <div><span>现价</span><b>{{ pack.price }}</b></div>
              <div><span>涨跌</span><b :class="pack.changePct >= 0 ? 'up' : 'down'">{{ pack.changePct.toFixed(2) }}%</b></div>
              <div><span>行业</span><b>{{ pack.industry ?? '--' }}</b></div>
              <div><span>板块</span><b>{{ pack.sector?.name ?? '--' }}</b></div>
              <div><span>板块阶段</span><b>{{ pack.sector?.stage ?? '--' }}</b></div>
              <div><span>板块 5 日</span><b>{{ pack.sector?.change5d ?? '--' }}%</b></div>
              <div><span>主力 5 日</span><b>{{ pack.fund?.mainNetSum5Yi ?? '--' }} 亿</b></div>
              <div><span>情绪相位</span><b>{{ pack.sentiment?.phase ?? '--' }}</b></div>
              <div><span>技术评分</span><b>{{ pack.analysis?.score ?? '--' }}</b></div>
            </div>
            <p v-if="pack.analysis?.risks?.length" class="pack-risks">风险提示：{{ pack.analysis.risks.join('；') }}</p>
          </div>

          <div v-if="activeRecord" class="te-block">
            <h4>原话与操作</h4>
            <p class="te-raw">{{ activeRecord.rawText }}</p>
            <button class="btn danger" @click="remove(activeRecord.id)">删除这条记录</button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.thesis {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}
.thesis-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.thesis-head h2 { margin: 0; font-size: 16px; }
.thesis-head p { margin: 4px 0 0; font-size: 12px; color: var(--text-3); }
.thesis-stats { display: flex; gap: 12px; font-size: 12px; color: var(--text-2); }
.thesis-stats b { font-weight: 600; }

.thesis-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(320px, 420px) 1fr;
  gap: 10px;
}
.thesis-input,
.thesis-evidence {
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.thesis-input textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.ti-label { display: block; margin-bottom: 6px; font-size: 12px; color: var(--text-2); }
.ti-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.ti-parsed { font-size: 11px; color: var(--text-3); }
.ti-parsed i { font-style: normal; opacity: .7; }
.ti-error { margin: 8px 0 0; font-size: 12px; color: var(--down); }

.ti-discuss, .ti-list { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.td-title { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--text-2); }
.td-messages { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; max-height: 260px; overflow-y: auto; }
.td-msg { padding: 8px 10px; border-radius: 8px; background: var(--panel-2); }
.td-msg.user { background: rgba(30, 111, 255, .08); }
.td-role { font-size: 11px; font-weight: 600; color: var(--text-3); margin-bottom: 2px; }
.td-content { font-size: 12px; line-height: 1.6; color: var(--text-1); }
.td-needed { margin-top: 6px; font-size: 11px; color: var(--text-3); }
.td-input { display: flex; gap: 6px; }
.td-input input {
  flex: 1;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  font-size: 12px;
}

.ti-record {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  text-align: left;
  cursor: pointer;
}
.ti-record.active { border-color: var(--primary); background: rgba(30, 111, 255, .08); }
.tr-main { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.tr-tag { padding: 0 6px; border: 1px solid var(--border); border-radius: 8px; font-size: 10px; color: var(--text-2); }
.tr-tag.muted { color: var(--text-3); }
.tr-score { margin-left: auto; font-size: 11px; color: var(--text-2); }
.tr-sub { font-size: 11px; color: var(--text-3); }

.te-empty { padding: 24px 8px; font-size: 13px; color: var(--text-3); line-height: 1.8; }
.te-conclusion {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: 10px;
  background: var(--panel-2);
}
.te-conclusion.ok { border-left-color: var(--up); }
.te-conclusion.warn { border-left-color: #e08a2e; }
.te-conclusion.bad { border-left-color: var(--down); }
.te-score { display: flex; align-items: baseline; gap: 2px; }
.te-score b { font-size: 26px; }
.te-score span { font-size: 11px; color: var(--text-3); }
.te-conclusion-label { font-size: 12px; font-weight: 600; color: var(--text-2); }
.te-conclusion-text p { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--text-1); }

.te-block { margin-top: 14px; }
.te-block h4 { margin: 0 0 6px; font-size: 12px; color: var(--text-2); }
.te-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.te-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.7; color: var(--text-2); }
.te-facts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.te-facts li { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; border-radius: 8px; font-size: 12px; line-height: 1.6; background: var(--panel-2); }
.te-facts li b { font-size: 11px; color: var(--text-2); }
.te-facts li i { font-style: normal; font-size: 10px; color: var(--text-3); }
.fact-support { border-left: 2px solid var(--up); }
.fact-against { border-left: 2px solid var(--down); }
.fact-neutral { border-left: 2px solid var(--border); }
.te-facts .empty { color: var(--text-3); }

.te-claims { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.te-claims li { padding: 8px 10px; border-radius: 8px; background: var(--panel-2); font-size: 12px; }
.claim-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.claim-verdict { font-size: 11px; font-weight: 600; }
.claim-supported .claim-verdict { color: var(--up); }
.claim-refuted .claim-verdict { color: var(--down); }
.claim-unknown .claim-verdict { color: var(--text-3); }
.claim-dim { font-size: 10px; color: var(--text-3); border: 1px solid var(--border); border-radius: 8px; padding: 0 6px; }
.claim-text { color: var(--text-1); }
.claim-line { margin-top: 4px; font-size: 11px; line-height: 1.6; }
.claim-line.ok { color: var(--text-2); }
.claim-line.bad { color: var(--text-2); }

.pack-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 10px; font-size: 12px; }
.pack-grid div { display: flex; justify-content: space-between; padding: 5px 8px; border-radius: 6px; background: var(--panel-2); }
.pack-grid span { color: var(--text-3); }
.pack-risks { margin: 8px 0 0; font-size: 11px; color: var(--text-3); }
.te-raw { margin: 0 0 8px; font-size: 12px; line-height: 1.7; color: var(--text-2); }

@media (max-width: 980px) {
  .thesis-body { grid-template-columns: 1fr; }
  .te-cols { grid-template-columns: 1fr; }
  .pack-grid { grid-template-columns: 1fr 1fr; }
}
</style>
