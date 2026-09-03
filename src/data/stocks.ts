import type { StockInfo } from '../types'

/** 顶部指数栏 */
export const INDEX_LIST: StockInfo[] = [
  { code: 'sh000001', market: 'sh', name: '上证指数', type: 'zs' },
  { code: 'sz399001', market: 'sz', name: '深证成指', type: 'zs' },
  { code: 'sz399006', market: 'sz', name: '创业板指', type: 'zs' },
  { code: 'sh000688', market: 'sh', name: '科创50', type: 'zs' },
  { code: 'sh000300', market: 'sh', name: '沪深300', type: 'zs' },
]

/** 默认自选股 */
export const DEFAULT_WATCHLIST: StockInfo[] = [
  { code: 'sh600519', market: 'sh', name: '贵州茅台', type: 'gp_a' },
  { code: 'sz300750', market: 'sz', name: '宁德时代', type: 'gp_a' },
  { code: 'sz002594', market: 'sz', name: '比亚迪', type: 'gp_a' },
  { code: 'sz000858', market: 'sz', name: '五粮液', type: 'gp_a' },
  { code: 'sh601318', market: 'sh', name: '中国平安', type: 'gp_a' },
  { code: 'sh600036', market: 'sh', name: '招商银行', type: 'gp_a' },
  { code: 'sh601398', market: 'sh', name: '工商银行', type: 'gp_a' },
  { code: 'sh600030', market: 'sh', name: '中信证券', type: 'gp_a' },
  { code: 'sz000001', market: 'sz', name: '平安银行', type: 'gp_a' },
  { code: 'sz000333', market: 'sz', name: '美的集团', type: 'gp_a' },
  { code: 'sz000651', market: 'sz', name: '格力电器', type: 'gp_a' },
  { code: 'sh600900', market: 'sh', name: '长江电力', type: 'gp_a' },
  { code: 'sh601899', market: 'sh', name: '紫金矿业', type: 'gp_a' },
  { code: 'sh600276', market: 'sh', name: '恒瑞医药', type: 'gp_a' },
  { code: 'sh600887', market: 'sh', name: '伊利股份', type: 'gp_a' },
  { code: 'sz002415', market: 'sz', name: '海康威视', type: 'gp_a' },
  { code: 'sz002714', market: 'sz', name: '牧原股份', type: 'gp_a' },
  { code: 'sz300059', market: 'sz', name: '东方财富', type: 'gp_a' },
  { code: 'sh601012', market: 'sh', name: '隆基绿能', type: 'gp_a' },
  { code: 'sz002475', market: 'sz', name: '立讯精密', type: 'gp_a' },
  { code: 'sz000725', market: 'sz', name: '京东方A', type: 'gp_a' },
  { code: 'sh688981', market: 'sh', name: '中芯国际', type: 'gp_a' },
  { code: 'sz300760', market: 'sz', name: '迈瑞医疗', type: 'gp_a' },
  { code: 'sh600309', market: 'sh', name: '万华化学', type: 'gp_a' },
]

/** 本地搜索池（真实接口不可用时兜底；也可直接命中常见股票） */
export const SEARCH_POOL: StockInfo[] = [
  ...DEFAULT_WATCHLIST,
  { code: 'sh601888', market: 'sh', name: '中国中免', type: 'gp_a' },
  { code: 'sh603288', market: 'sh', name: '海天味业', type: 'gp_a' },
  { code: 'sh600436', market: 'sh', name: '片仔癀', type: 'gp_a' },
  { code: 'sh603259', market: 'sh', name: '药明康德', type: 'gp_a' },
  { code: 'sz300015', market: 'sz', name: '爱尔眼科', type: 'gp_a' },
  { code: 'sh600031', market: 'sh', name: '三一重工', type: 'gp_a' },
  { code: 'sz000002', market: 'sz', name: '万科A', type: 'gp_a' },
  { code: 'sh600048', market: 'sh', name: '保利发展', type: 'gp_a' },
  { code: 'sh601668', market: 'sh', name: '中国建筑', type: 'gp_a' },
  { code: 'sh600050', market: 'sh', name: '中国联通', type: 'gp_a' },
  { code: 'sh600941', market: 'sh', name: '中国移动', type: 'gp_a' },
  { code: 'sz000063', market: 'sz', name: '中兴通讯', type: 'gp_a' },
  { code: 'sz002371', market: 'sz', name: '北方华创', type: 'gp_a' },
  { code: 'sh603501', market: 'sh', name: '韦尔股份', type: 'gp_a' },
  { code: 'sz300124', market: 'sz', name: '汇川技术', type: 'gp_a' },
  { code: 'sz300274', market: 'sz', name: '阳光电源', type: 'gp_a' },
  { code: 'sh600438', market: 'sh', name: '通威股份', type: 'gp_a' },
  { code: 'sz002466', market: 'sz', name: '天齐锂业', type: 'gp_a' },
  { code: 'sz002460', market: 'sz', name: '赣锋锂业', type: 'gp_a' },
  { code: 'sz300014', market: 'sz', name: '亿纬锂能', type: 'gp_a' },
  { code: 'sz300122', market: 'sz', name: '智飞生物', type: 'gp_a' },
  { code: 'sz000661', market: 'sz', name: '长春高新', type: 'gp_a' },
  { code: 'sz000538', market: 'sz', name: '云南白药', type: 'gp_a' },
  { code: 'sh600570', market: 'sh', name: '恒生电子', type: 'gp_a' },
  { code: 'sh688111', market: 'sh', name: '金山办公', type: 'gp_a' },
  { code: 'sz002230', market: 'sz', name: '科大讯飞', type: 'gp_a' },
  { code: 'sz002027', market: 'sz', name: '分众传媒', type: 'gp_a' },
  { code: 'sz002352', market: 'sz', name: '顺丰控股', type: 'gp_a' },
  { code: 'sh601816', market: 'sh', name: '京沪高铁', type: 'gp_a' },
  { code: 'sh600028', market: 'sh', name: '中国石化', type: 'gp_a' },
  { code: 'sh601857', market: 'sh', name: '中国石油', type: 'gp_a' },
]

export function stockNameOf(code: string): string {
  const hit =
    SEARCH_POOL.find((s) => s.code === code) ??
    INDEX_LIST.find((s) => s.code === code)
  return hit?.name ?? code
}

/** 申万一级行业（31 个，与 tickflow 标的池对齐） */
export const SW1_INDUSTRIES = [
  '机械设备',
  '医药生物',
  '基础化工',
  '电子',
  '电力设备',
  '建筑装饰',
  '汽车',
  '计算机',
  '传媒',
  '交通运输',
  '有色金属',
  '房地产',
  '轻工制造',
  '公用事业',
  '食品饮料',
  '纺织服饰',
  '通信',
  '国防军工',
  '环保',
  '商贸零售',
  '农林牧渔',
  '非银金融',
  '家用电器',
  '建筑材料',
  '社会服务',
  '石油石化',
  '钢铁',
  '银行',
  '煤炭',
  '综合',
  '美容护理',
] as const

/** 本地关键词搜索（兜底） */
export function searchLocal(keyword: string): StockInfo[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return []
  const pool = [...SEARCH_POOL, ...INDEX_LIST]
  return pool
    .filter(
      (s) =>
        s.name.toLowerCase().includes(kw) ||
        s.code.toLowerCase().includes(kw) ||
        s.code.replace(/^(sh|sz)/, '').startsWith(kw),
    )
    .slice(0, 20)
}
