/**
 * 全市场快照层 — v0.0.5
 * 东财 clist 榜单接口拉取沪深全市场 A 股日线快照
 * （沪/深主板 + 创业板 + 科创板，不含北交所）
 *
 * Host 优先级：push2delay（延时行情，日级选股够用）→ push2
 * 部分网络环境（代理/TUN）会拒绝 push2/push2his，push2delay 通常可达。
 * 快照缓存 TTL 跟随 Cache 类：盘中 30s / 盘后 300s。
 */

const { Cache } = require('../helpers');
const { number, batchRun, DATA_DIR } = require('./utils');
const { requestText } = require('./market');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');

const HOSTS = ['https://push2delay.eastmoney.com', 'https://push2.eastmoney.com'];
// m:0+t:6 深主板A / m:0+t:80 创业板 / m:1+t:2 沪主板A / m:1+t:23 科创板
const FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
// f2现价 f3涨跌幅 f6成交额 f8换手率 f10量比 f12代码 f13市场 f14名称
// f20总市值 f21流通市值 f24 60日涨跌幅 f25年初至今涨跌幅 f26上市日期
const FIELDS = 'f2,f3,f6,f8,f10,f12,f13,f14,f20,f21,f24,f25,f26';
const PAGE_SIZE = 100; // 服务端单页上限（实测 pz>100 仍只返回 100 条）
const MAX_PAGES = 80;

const cache = new Cache();
const UNIVERSE_DISK_CACHE = join(DATA_DIR, 'cache', 'universe.json');
const DISK_TTL_MS = 3600000; // 磁盘缓存 1 小时

function pageUrl(host, pn) {
  return `${host}/api/qt/clist/get?pn=${pn}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f6`
    + `&fs=${encodeURIComponent(FS)}&fields=${FIELDS}`;
}

async function fetchPage(host, pn) {
  const text = await requestText(pageUrl(host, pn));
  const data = JSON.parse(text);
  return data?.data || null;
}

function mapRow(row) {
  return {
    code: String(row.f12),
    market: row.f13 === 1 ? 'sh' : 'sz',
    name: String(row.f14 || ''),
    price: number(row.f2),
    changePct: number(row.f3),
    amount: number(row.f6),        // 成交额（元）
    turnoverPct: number(row.f8),   // 换手率 %
    volumeRatio: number(row.f10),  // 量比
    totalCap: number(row.f20),     // 总市值（元）
    floatCap: number(row.f21),     // 流通市值（元）
    chg60d: number(row.f24),       // 60 日涨跌幅 %
    chgYtd: number(row.f25),       // 年初至今涨跌幅 %
    listDate: String(row.f26 || ''), // 上市日期 YYYYMMDD
  };
}

function validRow(s) {
  // 只保留沪深 A 股代码段且有成交（停牌股 price/amount 为 0）
  return /^[036]\d{5}$/.test(s.code) && s.price > 0;
}

/**
 * 获取全市场快照
 * @returns {{date:string, fetchedAt:string, expected:number, count:number, partial:boolean, stocks:Array}}
 */
async function getUniverse({ force = false } = {}) {
  const cacheKey = cache.key('universe');
  if (!force) {
    const cached = cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
    // 磁盘缓存（重启后免重扫全市场）
    try {
      const disk = JSON.parse(await readFile(UNIVERSE_DISK_CACHE, 'utf8'));
      if (disk && disk.fetchedAt && Date.now() - new Date(disk.fetchedAt).getTime() < DISK_TTL_MS && Array.isArray(disk.stocks) && disk.stocks.length > 100) {
        return { ...disk, cached: true, disk: true };
      }
    } catch {}
  }

  let host = null, first = null, lastError = null;
  for (const h of HOSTS) {
    try {
      first = await fetchPage(h, 1);
      if (first && first.diff) { host = h; break; }
    } catch (e) { lastError = e; }
  }
  if (!host) throw lastError || new Error('全市场快照获取失败');

  const total = Number(first.total) || first.diff.length;
  const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
  const rows = [...first.diff];

  const pageIdx = [];
  for (let p = 2; p <= totalPages; p++) pageIdx.push(p);
  const rest = await batchRun(pageIdx, pn => fetchPage(host, pn), 6);
  let failedPages = 0;
  for (const r of rest) {
    if (r.status === 'fulfilled' && r.value?.diff) rows.push(...r.value.diff);
    else failedPages++;
  }

  // 按成交额排序 + 分页期间榜单漂移，页边界可能重复，按 code 去重
  const seen = new Set();
  const stocks = [];
  for (const row of rows) {
    const s = mapRow(row);
    if (!validRow(s) || seen.has(s.code)) continue;
    seen.add(s.code);
    stocks.push(s);
  }

  const now = new Date();
  const result = {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    fetchedAt: now.toISOString(),
    expected: total,
    count: stocks.length,
    partial: failedPages > 0,
    stocks,
  };
  cache.set(cacheKey, result);
  // 写磁盘缓存（失败静默）
  try { await mkdir(join(DATA_DIR, 'cache'), { recursive: true }); await writeFile(UNIVERSE_DISK_CACHE, JSON.stringify(result)); } catch {}
  return result;
}

module.exports = { getUniverse, mapRow, validRow, PAGE_SIZE, HOSTS };
