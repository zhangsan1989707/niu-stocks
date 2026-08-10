/**
 * 股票池管理 — P1-3 动态化
 * 从硬编码 STOCKS 数组改为 data/stocks.json 可配置
 * 首次运行自动从默认列表初始化
 */

const { join } = require('node:path');
const { DATA_DIR } = require('./utils');
const { readJson, writeJson } = require('./store');
const { mkdir } = require('node:fs/promises');

const STOCKS_FILE = join(DATA_DIR, 'stocks.json');

// 默认股票池（与原硬编码一致，保证向后兼容）
const DEFAULT_STOCKS = [
  // 白酒
  ['600519', '贵州茅台'], ['000858', '五粮液'], ['000568', '泸州老窖'], ['600809', '山西汾酒'], ['002304', '洋河股份'],
  // 新能源
  ['002594', '比亚迪'], ['300750', '宁德时代'], ['601012', '隆基绿能'], ['300274', '阳光电源'], ['600438', '通威股份'],
  // 半导体
  ['688981', '中芯国际'], ['002371', '北方华创'], ['603501', '韦尔股份'], ['688012', '中微公司'],
  // 消费电子
  ['002475', '立讯精密'], ['601138', '工业富联'], ['002241', '歌尔股份'],
  // 金融
  ['600036', '招商银行'], ['601318', '中国平安'], ['600030', '中信证券'], ['300059', '东方财富'],
  // 医药
  ['600276', '恒瑞医药'], ['300760', '迈瑞医疗'], ['603259', '药明康德'],
  // 汽车
  ['601127', '赛力斯'], ['000625', '长安汽车'], ['601633', '长城汽车'],
  // 稀土/资源
  ['600392', '盛和资源'], ['600111', '北方稀土'], ['601899', '紫金矿业'],
  // 通信/AI
  ['300308', '中际旭创'], ['000063', '中兴通讯'], ['002230', '科大讯飞'],
  // 军工/制造
  ['603197', '保隆科技'], ['000021', '深科技'], ['600893', '航发动力'],
  // 地产/基建
  ['000002', '万科A'], ['600048', '保利发展'],
  // 家电
  ['000333', '美的集团'], ['000651', '格力电器'],
  // 更多热门
  ['002415', '海康威视'], ['603986', '兆易创新'], ['600887', '伊利股份'], ['000001', '平安银行'],
  ['601857', '中国石油'], ['600028', '中国石化'], ['601088', '中国神华'], ['601166', '兴业银行'],
];

// 板块映射
const SECTOR_MAP = {
  '600519': '白酒', '000858': '白酒', '000568': '白酒', '600809': '白酒', '002304': '白酒',
  '002594': '新能源', '300750': '新能源', '601012': '新能源', '300274': '新能源', '600438': '新能源',
  '688981': '半导体', '002371': '半导体', '603501': '半导体', '688012': '半导体',
  '002475': '消费电子', '601138': '消费电子', '002241': '消费电子',
  '600036': '金融', '601318': '金融', '600030': '金融', '300059': '金融', '000001': '金融', '601166': '金融',
  '600276': '医药', '300760': '医药', '603259': '医药',
  '601127': '汽车', '000625': '汽车', '601633': '汽车',
  '600392': '稀土资源', '600111': '稀土资源', '601899': '稀土资源',
  '300308': '通信AI', '000063': '通信AI', '002230': '通信AI',
  '603197': '军工制造', '000021': '军工制造', '600893': '军工制造',
  '000002': '地产基建', '600048': '地产基建',
  '000333': '家电', '000651': '家电',
  '002415': '电子', '603986': '电子',
  '600887': '消费',
  '601857': '能源', '600028': '能源', '601088': '能源',
};

let _stocksCache = null;
let _stocksCacheTime = 0;

/**
 * 加载股票池（1 秒内复用缓存）
 * @returns {Promise<Array<[string, string]>>}
 */
async function loadStocks() {
  if (_stocksCache && Date.now() - _stocksCacheTime < 1000) return _stocksCache;
  await mkdir(DATA_DIR, { recursive: true });
  const data = await readJson(STOCKS_FILE, null);
  if (data && Array.isArray(data.stocks)) {
    _stocksCache = data.stocks.map(s => Array.isArray(s) ? s : [s.code, s.name]);
  } else {
    // 首次运行：从默认列表初始化
    _stocksCache = DEFAULT_STOCKS.slice();
    await writeJson(STOCKS_FILE, { stocks: _stocksCache.map(([code, name]) => ({ code, name })) });
  }
  _stocksCacheTime = Date.now();
  return _stocksCache;
}

/**
 * 保存股票池
 */
async function saveStocks(stocks) {
  _stocksCache = stocks;
  _stocksCacheTime = Date.now();
  await writeJson(STOCKS_FILE, { stocks: stocks.map(([code, name]) => ({ code, name })) });
}

/**
 * 添加股票到池中
 */
async function addStock(code, name) {
  const stocks = await loadStocks();
  if (!stocks.some(([c]) => c === code)) {
    stocks.push([code, name || code]);
    await saveStocks(stocks);
  }
  return stocks;
}

/**
 * 从池中删除股票
 */
async function removeStock(code) {
  const stocks = await loadStocks();
  const filtered = stocks.filter(([c]) => c !== code);
  await saveStocks(filtered);
  return filtered;
}

/**
 * 获取板块映射
 */
function getSector(code) {
  return SECTOR_MAP[code] || '其他';
}

module.exports = { loadStocks, saveStocks, addStock, removeStock, getSector, STOCKS_FILE, DEFAULT_STOCKS, SECTOR_MAP };
