# 行情中心 · K线看盘（同花顺风格 Web 演示）

一个类似同花顺看盘界面的 Web 行情项目：**全市场真实行情 + 专业 K 线图 + 策略选股 + 盘口模拟交易**。

- 技术栈：Vue 3 + TypeScript + Vite + [klinecharts](https://klinecharts.com)（v10，专业 K 线库）
- 数据源：
  - K 线（日/周/月/分钟）、实时报价、五档盘口、标的信息、全市场行情：**TickFlow 行情 API**（官方、稳定、前复权）
  - 全市场快照：TickFlow 全市场行情（`quotes?universes`）为主源；PE/PB/量比/市值 为慢变量，从东财历史快照继承（东财不可达时自动降级）
  - 行业分类（申万一级 31 个）：TickFlow 标的池，落盘 `data/industry.json`
  - AI 选股：DeepSeek 大模型（`deepseek-chat`）
  - 搜索：腾讯智能搜索；指数报价：腾讯 qt 兜底
- 每日自动更新：`12:00` 午间刷新快照、`15:35` 收盘后完整更新（快照 + 行业 + 全量日 K 预取），交易日自动执行
- 数据落盘：所有看过的 K 线自动缓存到 `data/kline-cache/`，支持一键「全量预取日K」把全市场日 K 写入本地
- 断网兜底：接口不可用时前端自动降级为本地模拟数据，界面仍可完整演示
- 配色遵循 A 股习惯：**红涨绿跌**

> API Key 仅保存在服务端（`server/tickflow.ts`，可用环境变量 `TICKFLOW_API_KEY` 覆盖），前端只走 `/api/*` 代理，不接触 key。

## 功能

| 模块 | 说明 |
| --- | --- |
| K 线图 | 分时 / 5分 / 15分 / 30分 / 60分 / 日K / 周K / 月K，前复权，滚轮缩放、拖动、十字光标、最新价标记 |
| 主图指标 | MA / EMA / BOLL / SAR（可关闭），叠加在 K 线上 |
| 副图指标 | 固定成交量 + MACD / KDJ / RSI / CCI / BIAS / WR / OBV（可切换） |
| 历史加载 | 向左拖动到最早位置自动分页加载更早的 K 线（日/周/月） |
| 报价头 | 现价、涨跌、今开/昨收/最高/最低/量额/换手/量比/振幅/市盈率/市值 |
| 自选股 | 左侧列表实时刷新，点击切换个股 |
| 全市场 | 左侧「全市场」页：约 5550 只 A 股，按名称/代码/行业过滤，按涨跌幅/成交额/换手/市值/量比等排序，滚动加载 |
| 板块行业 | 申万一级行业（31 个）：全市场列表显示行业标签 + 按行业过滤；选股器按行业筛选 |
| 指数栏 | 上证指数 / 深证成指 / 创业板指 / 科创50 / 沪深300 |
| 搜索 | 全市场按名称 / 代码搜索（腾讯智能搜索），回车选第一条 |
| 选股器 | 左侧「选股器」页：基础条件（涨跌幅/换手/量比/PE/市值/成交额/价格/行业）+ 技术形态策略（均线金叉/缩量回踩/放量突破/底部放量/箱体震荡/一阳夹三阴/多头趋势/情绪周期/龙头策略/缠论底背驰/波浪回踩/热点题材）+ 量化多因子策略（均衡多因子/蓝筹收益质量/资金热度/双低选股/稳健价值/超跌反转/趋势质量/低波质量，取交集）+ 技术指标（MA金叉、站上MA20、MACD/KDJ金叉、RSI超卖、BOLL突破等），标的池可选全市场或自选；策略参考 `daily_stock_analysis` 的 analysis skills 与 AlphaSift 选股策略 |
| 策略实验室 | 支持事件回测、组合回测和参数优化：多策略 AND/OR、动态阈值、实验方案保存、资金/仓位/T+1/涨跌停约束；参数优化采用训练/样本外切分并限制组合数量 |
| 观点研究 | 知乎/雪球双板块：按博主 ID、昵称或主页添加订阅，保存原文版本，DeepSeek 抽取标的、方向、期限、逻辑、风险、失效条件和原文证据；支持分页增量采集、短文详情补取、自动重试与同步日志、观点共识评分、按发布时间回测及博主可靠性统计 |
| 融合选股 | 先执行技术/基本条件初筛，再按观点时效、置信度和一致性加权；可要求必须存在看多共识，并对高置信看空观点执行风险否决 |
| 历史数据 | TickFlow 前复权日/周/月 K 线支持按数量或起止日期获取（单次最多 10000 根）；策略回测默认使用 2000 根；每日保存 PE/PB/市值等截面快照用于未来时点回测 |
| 个股研究档案 | 从个股分析面板保存当前技术结论或手工研究笔记；每次修订保留版本，可对比字段变化，并将命中该股票的博主观点合并为证据时间线 |
| 运行与存储 | 观点、研究档案和快照使用 fsync + 原子替换落盘；提供健康检查、API 集成测试及构建产物/API 一体的独立常驻入口 |
| AI 选股 | 「选股器」页顶部对话框：输入自然语言（如「医药行业、市值100亿以上、MACD金叉」），DeepSeek 解析成条件并自动执行选股 |
| 个股分析 | 报价头「分析」按钮：技术指标多维度评分（趋势/乖离率/量能/支撑/MACD/RSI）+ 关键价位 + 买卖信号；可点击「AI 深度点评」用 Anspire 生成自然语言点评 |
| 批量分析 | 选股器页「批量分析」按钮：输入一组股票代码，批量输出技术评分、命中策略、舆情新闻（Anspire Search，可降级 Tavily/Brave/SerpAPI）与 AI 简报（DeepSeek 优先，Anspire 兜底） |
| 全量预取 | 「全市场」页一键预取全市场日 K 到本地缓存（约 5500 只，批量接口约 1 分钟，之后策略/浏览秒级返回） |
| 每日自动更新 | 交易日 12:00 午间刷新快照、15:35 收盘后完整更新（快照 + 行业 + 日 K 预取）；「全市场」页可查看状态、手动「立即更新」 |
| 盘口交易 | 买卖五档（点击档位填充价格）、价格/手数输入、模拟买入/卖出提示（纯演示） |

## 快速开始

```bash
npm install --cache /home/lby/code/.npm-cache   # 本机 npm 缓存受限时需指定缓存目录
npm run dev
# 本机打开 http://127.0.0.1:5173
```

需要自动同步博主内容时，先复制环境变量模板：

```bash
cp .env.example .env
# 至少填写 ZHIHU_ACCESS_SECRET 或 XUEQIU_COOKIE
```

知乎使用数据开放平台 `Access Secret`；雪球时间线受风控保护，需要登录后的完整 Cookie。没有这两项凭据时，观点板块的手动导入、原文留档和 AI 分析仍可使用。

### 📱 手机/远程访问（Cloudflare quick tunnel）

`npm run dev` 启动后会自动尝试建立 Cloudflare 免费公网隧道（无需账号/域名，自动 HTTPS），终端会打印：

```text
  ============================================
  [远程访问] 公网地址（手机/任意设备可打开）
  https://xxx.trycloudflare.com
  ============================================
```

手机浏览器打开该地址即可访问（界面已适配移动端：底部导航栏切换行情/自选全市场/交易/选股，顶部搜索与指数栏可滑动）。桌面端顶栏会显示绿色「远程访问」徽标，点击复制公网地址。

- cloudflared 二进制来源：优先 `CLOUDFLARED_BIN` 环境变量，其次 `node_modules/cloudflared`（已作为 devDependency），最后回退到系统 `PATH` 中的 `cloudflared`。
- 若 `cloudflared` 不可用，Vite dev server 会在控制台提示，不影响本地访问。
- 不想启动隧道：`STOCK_KLINE_TUNNEL=0 npm run dev`。
- 公网 URL 每次重启会变化；quick tunnel 的 URL 是公开的，本项目无敏感操作，生产化需自行加访问控制。

> 提示：若 `npm install` 报 `/home/lby/.npm` 权限错误，是因为环境预设了
> `npm_config_cache=/home/lby/.npm`，用 `--cache <可写目录>` 覆盖即可（本项目已内置 `.npmrc`）。

首次打开「全市场」页会触发全市场快照抓取（约 30 秒，自动落盘），之后秒开。
运行技术指标类选股前，建议先在「全市场」页执行「全量预取日K」。

## 无人值守数据更新（每日自动）

数据服务与 Web 页面解耦，可独立常驻运行。交易日自动更新计划：

| 时间 | 任务 |
| --- | --- |
| 12:00 午间 | 刷新全市场快照（上午盘数据） |
| 15:35 收盘后 | 完整更新：快照 + **慢变量（PE/PB/量比/市值，东财）** + 行业映射 + 全量日 K 预取 |

慢变量每天收盘后刷新一次（东财不可达时静默保留旧值，不影响其它数据）。

```bash
# 方式一：常驻进程（推荐，内置调度，无需外部 cron）
nohup npm run updater > updater.log 2>&1 &

# 方式二：单次更新（可配合系统 crontab 定时调用）
npm run updater:once

# 示例 crontab（每个交易日 15:40 执行一次完整更新）
# 40 15 * * 1-5 cd /home/lby/code/stock-kline && npm run updater:once >> updater.log 2>&1
```

> 说明：`npm run dev` 时页面内也有同样的自动调度（冗余但幂等无害）；
> 无人值守场景只需让 `updater` 常驻即可，Web 页面开不开都照常落盘。

## 目录结构

```
server/                 # 数据服务（与 Vite 解耦，可独立运行）
├── service.ts          # 核心数据逻辑 + 状态（快照/报价/预取/行业/慢变量/调度）
├── plugin.ts           # Vite 插件（/api/* 路由，转发到 service）
├── updater.ts          # 独立更新进程入口（常驻/单次，无人值守）
├── tickflow.ts         # TickFlow API 客户端（K线/报价/盘口/标的信息/全市场行情）
├── eastmoney.ts        # 东财抓取（慢变量 PE/PB/量比/市值）
├── tencent.ts          # K 线读取（路由到 TickFlow）+ 磁盘缓存 + 批量预取
├── tencent-quote.ts    # 腾讯报价解析（指数兜底）
├── strategy.ts         # 策略引擎（MA/MACD/KDJ/RSI/BOLL 指标 + 条件筛选）
├── backtest.ts         # OHLCV 策略事件回测（次日开盘、固定持有期、费用/基准）
├── opinions.ts         # 观点订阅、原文版本、结构化观点与本地持久化
├── opinion-adapters.ts # 知乎开放平台 / 雪球时间线采集适配器
├── opinion-sync.ts     # 增量同步编排与分钟级监听
├── opinion-signals.ts  # 按时效、置信度、博主可靠性聚合标的共识
├── opinion-backtest.ts # 按文章发布时间执行观点事件回测
├── industry.ts         # 申万一级行业映射（code -> 行业名）
├── deepseek.ts         # DeepSeek 调用（自然语言 -> 选股条件）
├── scheduler.ts        # 每日自动更新调度器
├── net.ts              # fetch 走环境代理（直连行情源在本机被阻断）
└── store.ts            # data/ 目录文件读写
src/
├── api/
│   ├── index.ts        # 统一行情接口：真实数据优先，失败降级模拟
│   └── tencent.ts      # 腾讯搜索解析（\uXXXX 转义处理）
├── components/
│   ├── TopBar.vue      # 顶部：品牌 + 指数栏 + 搜索
│   ├── MarketList.vue  # 左侧容器（自选 / 全市场 / 选股器 三页签）
│   ├── StockList.vue   # 自选股列表
│   ├── AllMarketPanel.vue # 全市场列表（排序、过滤、预取）
│   ├── StrategyPanel.vue  # 选股器（条件 + 技术指标 + 结果）
│   ├── StrategyLab.vue    # 策略回测配置与结果
│   ├── OpinionPanel.vue   # 知乎 / 雪球观点研究双板块
│   ├── OpinionResearchPanel.vue # 观点回测与博主可靠性面板
│   ├── QuoteHeader.vue # 当前股票报价摘要
│   ├── KLineChart.vue  # K 线面板（klinecharts v10 DataLoader 模式 + 指标/周期工具栏）
│   └── TradePanel.vue  # 盘口五档 + 模拟交易
├── composables/
│   └── useMarket.ts    # 全局行情状态（当前股票/周期/报价轮询）
├── data/
│   ├── stocks.ts       # 指数、自选、搜索池
│   └── mock.ts         # 种子化模拟数据生成器（断网兜底）
├── styles/global.css   # 主题变量（红涨绿跌）
└── types.ts            # 领域类型与周期定义
data/                   # 运行时落盘数据（已 gitignore）：快照 + K 线缓存，可再生
```

## 接口一览（Vite dev server 提供）

| 接口 | 说明 |
| --- | --- |
| `GET /api/snapshot[?force=1]` | 全市场快照（首次自动抓取，之后读缓存；force 强制刷新） |
| `GET /api/kline?code&period&count&start&end` | K 线（TickFlow，最多 10000 根前复权、支持时间区间；带磁盘缓存） |
| `GET /api/data/coverage?codes=sh600519` | K线覆盖区间、复权口径、时点快照和历史字段限制 |
| `GET /api/quote?codes=...` | 实时报价（个股 TickFlow 五档+快照补字段；指数腾讯兜底） |
| `GET /api/search?q=...` | 腾讯智能搜索 |
| `GET /api/prefetch[?period=day]` / `GET /api/prefetch/progress` | 全量预取日 K 任务与进度 |
| `POST /api/strategy` | 选股策略（JSON body：基础条件 + 技术指标 + 行业 + 标的池） |
| `POST /api/fusion/screen` | 技术策略候选与知乎/雪球观点共识融合排序 |
| `GET /api/strategy-defs` | 服务端统一策略目录（分类、版本、历史长度、可回测能力） |
| `POST /api/backtests/run` | 固定持有期日线事件回测 |
| `POST /api/backtests/portfolio` | 带资金、仓位、整手和成交约束的组合回测 |
| `POST /api/backtests/optimize` | 参数网格搜索、训练区间排序和样本外独立复测 |
| `GET /api/analysis?code=sh600519` | 个股分析（规则版：评分 + 信号 + 维度 + 关键价位） |
| `POST /api/analysis/batch` | 批量个股分析（body: `codes[]`、`withNews`、`withAi`；技术评分 + 命中策略 + 舆情 + AI 简报） |
| `POST /api/analysis/ai` | 个股分析（AI 点评增强：规则分析 + Anspire 自然语言点评） |
| `GET /api/research/dossier` | 个股研究记录、历史版本和观点证据时间线 |
| `POST/DELETE /api/research/records` | 保存新结论/修订版本或删除研究记录 |
| `GET /api/research/compare` | 对比指定研究记录的两个历史版本 |
| `POST /api/ai-strategy` | AI 选股（自然语言 -> DeepSeek 解析 -> 策略引擎） |
| `GET/POST /api/opinions/subscriptions` | 查询或新增知乎/雪球博主订阅 |
| `PATCH/DELETE /api/opinions/subscriptions/:id` | 更新或删除订阅 |
| `GET /api/opinions/feed` | 查询已保存的观点原文与结构化观点 |
| `GET /api/opinions/signals` | 查询按时效、一致性和置信度聚合的标的观点信号 |
| `POST /api/opinions/backtest` | 从文章发布后的下一交易日回测观点方向 |
| `POST /api/opinions/ingest` | 手动导入原文并可选 AI 分析 |
| `POST /api/opinions/analyze` | 重新执行观点抽取 |
| `POST /api/opinions/sync` | 立即增量同步指定博主 |
| `GET /api/opinions/sync-logs` | 查询采集尝试、增量数量和失败原因 |
| `GET /api/update/status` / `POST /api/update/run` | 每日自动更新调度状态 / 手动触发完整更新 |
| `GET /api/health` | 独立服务健康、快照和观点调度状态 |

## 脚本

```bash
npm run dev      # 开发服务器 http://127.0.0.1:5173
npm run build    # vue-tsc 类型检查 + 生产构建
npm test         # 单元测试 + 本地 HTTP API 集成测试
npm run serve    # 独立常驻生产入口 http://127.0.0.1:4173（需先 build）
```
