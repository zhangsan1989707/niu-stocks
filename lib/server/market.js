/**
 * 行情数据层
 * 从 server.js 提取的行情获取、K线、搜索、指数功能
 */

const { readFile, writeFile, mkdir, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { Cache } = require('../helpers');
const { number, market, logFallback, batchRun, DATA_DIR } = require('./utils');
const { updateJson, CHECK_HISTORY_DIR } = require('./store');

const cache = new Cache();
// Phase 1: K线磁盘缓存（重启免重拉）
const KLINE_DISK_DIR = join(DATA_DIR, 'kline');

/** K线磁盘缓存 TTL：盘后（15:30 后）12 小时（覆盖到次日开盘），盘中 5 分钟 */
function klineDiskTTL() {
  const d = new Date();
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes >= 15 * 60 + 30 || minutes < 9 * 60 ? 12 * 3600000 : 5 * 60000;
}

async function readKlineDisk(key) {
  try {
    const file = join(KLINE_DISK_DIR, key + '.json');
    const disk = JSON.parse(await readFile(file, 'utf8'));
    if (disk && Array.isArray(disk.candles) && disk.candles.length && Date.now() - disk.fetchedAt < klineDiskTTL()) {
      return disk.candles;
    }
  } catch {}
  return null;
}
async function writeKlineDisk(key, candles) {
  try {
    await mkdir(KLINE_DISK_DIR, { recursive: true });
    await writeFile(join(KLINE_DISK_DIR, key + '.json'), JSON.stringify({ key, fetchedAt: Date.now(), candles }));
  } catch {}
}

// --- 网络请求 ---
async function requestText(url, encoding = 'utf-8') {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 StockHealthStation/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`行情服务返回 ${response.status}`);
  return new TextDecoder(encoding).decode(await response.arrayBuffer());
}

// --- 远程搜索 ---
async function remoteSearch(q) {
  try {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`;
    const text = await requestText(url);
    const data = JSON.parse(text);
    if (!data.QuotationCodeTable?.Data) return [];
    return data.QuotationCodeTable.Data
      .filter(x => x.Code && x.Name && /^[0368]\d{5}$/.test(x.Code))
      .map(x => ({ code: x.Code, name: x.Name }));
  } catch { return []; }
}

// --- 实时行情 ---
async function tencentQuote(code) {
  const text = await requestText(`https://qt.gtimg.cn/q=${market(code)}${code}`, 'gbk');
  const values = (text.match(/"([^"]*)"/) || [, ''])[1].split('~');
  if (values.length < 50 || !values[1]) throw new Error('未找到该股票');
  return {
    code, name: values[1], price: number(values[3]), previousClose: number(values[4]),
    open: number(values[5]), volume: number(values[6]), high: number(values[33]), low: number(values[34]),
    change: number(values[31]), changePct: number(values[32]), amountWan: number(values[37]),
    turnoverPct: number(values[38]), pe: number(values[39]), marketCapYi: number(values[44]),
    pb: number(values[46]), volumeRatio: number(values[49]), updatedAt: values[30] || '', source: '腾讯财经',
  };
}

async function eastmoneyQuote(code) {
  const secid = `${market(code) === 'sh' ? 1 : 0}.${code}`;
  const text = await requestText(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=f57,f58,f43,f44,f45,f46,f47,f48,f50,f51,f52,f60,f116,f162,f167,f168,f170`);
  const data = JSON.parse(text).data;
  if (!data?.f58) throw new Error('备用行情源未找到该股票');
  return {
    code, name: data.f58, price: number(data.f43), previousClose: number(data.f60),
    open: number(data.f46), volume: number(data.f47), high: number(data.f44), low: number(data.f45),
    change: number(data.f51), changePct: number(data.f170), amountWan: number(data.f48) / 10000,
    turnoverPct: number(data.f168), pe: number(data.f162), marketCapYi: number(data.f116) / 1e8,
    pb: number(data.f167), volumeRatio: number(data.f50), updatedAt: new Date().toISOString(), source: '东方财富',
  };
}

async function quote(code) {
  const cacheKey = cache.key('quote', code);
  const cached = cache.get(cacheKey);
  if (cached) { cached.cached = true; return cached; }
  let result, source = '腾讯财经';
  try { result = await tencentQuote(code); }
  catch (e) { logFallback(code, '腾讯财经', '东方财富', e.message); source = '东方财富'; result = await eastmoneyQuote(code); }
  if (result) result.source = source;
  cache.set(cacheKey, result);
  return result;
}

// --- K线数据 ---
async function tencentKlines(code) {
  const prefix = market(code);
  const text = await requestText(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,320,qfq`);
  const payload = JSON.parse(text).data?.[`${prefix}${code}`];
  const rows = payload?.qfqday || payload?.day || [];
  if (!rows.length) throw new Error('K线数据暂不可用');
  return rows.map(row => ({ date: row[0], open: number(row[1]), close: number(row[2]), high: number(row[3]), low: number(row[4]), volume: number(row[5]) }));
}

async function eastmoneyKlines(code) {
  const secid = `${market(code) === 'sh' ? 1 : 0}.${code}`;
  const text = await requestText(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=0&end=20500000&lmt=320`);
  const rows = JSON.parse(text).data?.klines || [];
  if (!rows.length) throw new Error('备用K线源暂不可用');
  return rows.map(row => { const x = row.split(','); return { date: x[0], open: number(x[1]), close: number(x[2]), high: number(x[3]), low: number(x[4]), volume: number(x[5]) }; });
}

/** 直读磁盘 K 线（不检查 TTL、不触发网络）——历史回填用 */
async function klineFromDisk(code) {
  try {
    const file = join(KLINE_DISK_DIR, 'k_' + code + '.json');
    const disk = JSON.parse(await readFile(file, 'utf8'));
    if (disk && Array.isArray(disk.candles) && disk.candles.length) return disk.candles;
  } catch {}
  return null;
}

async function klines(code) {
  const cacheKey = cache.key('klines', code);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  // 磁盘缓存（Phase 1）
  const disk = await readKlineDisk('k_' + code);
  if (disk) { cache.set(cacheKey, disk); return disk; }
  let result;
  try { result = await tencentKlines(code); }
  catch (e) { logFallback(code, '腾讯K线', '东方财富K线', e.message); result = await eastmoneyKlines(code); }
  cache.set(cacheKey, result);
  await writeKlineDisk('k_' + code, result);
  return result;
}
/** klines 网络兜底版：磁盘优先（含 TTL 过期），网络失败返回磁盘旧数据 */
async function klinesSafe(code) {
  const cacheKey = cache.key('klines', code);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try { return await klines(code); }
  catch (e) {
    // 网络失败：回退磁盘（忽略 TTL）
    try {
      const file = join(KLINE_DISK_DIR, 'k_' + code + '.json');
      const disk = JSON.parse(await readFile(file, 'utf8'));
      if (disk && Array.isArray(disk.candles) && disk.candles.length) { cache.set(cacheKey, disk.candles); return disk.candles; }
    } catch {}
    throw e;
  }
}

// --- 指数K线（sh000001 上证指数 / sh000300 沪深300 等）---
// 指数无复权概念，腾讯接口直接返回 day 序列
/** 直读磁盘指数 K 线（不检查 TTL、不触发网络） */
async function indexKlinesFromDisk(symbol = 'sh000300', limit = 320) {
  try {
    const file = join(KLINE_DISK_DIR, 'idx_' + symbol + '_' + limit + '.json');
    const disk = JSON.parse(await readFile(file, 'utf8'));
    if (disk && Array.isArray(disk.candles) && disk.candles.length) return disk.candles;
  } catch {}
  return null;
}

async function indexKlines(symbol = 'sh000300', limit = 320) {
  const cacheKey = cache.key('indexKlines', symbol);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  // 磁盘缓存（Phase 1）
  const disk = await readKlineDisk('idx_' + symbol + '_' + limit);
  if (disk) { cache.set(cacheKey, disk); return disk; }
  const text = await requestText(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${limit},`);
  const payload = JSON.parse(text).data?.[symbol];
  const rows = payload?.qfqday || payload?.day || [];
  if (!rows.length) throw new Error('指数K线暂不可用');
  const result = rows.map(row => ({ date: row[0], open: number(row[1]), close: number(row[2]), high: number(row[3]), low: number(row[4]), volume: number(row[5]) }));
  cache.set(cacheKey, result);
  await writeKlineDisk('idx_' + symbol + '_' + limit, result);
  return result;
}

// --- 大盘指数 ---
async function getIndices() {
  const indices = [
    { code: '000001', name: '上证指数', market: 'sh' },
    { code: '399001', name: '深证成指', market: 'sz' },
    { code: '399006', name: '创业板指', market: 'sz' },
    { code: '000300', name: '沪深300', market: 'sh' },
  ];
  const cacheKey = cache.key('indices');
  const cached = cache.get(cacheKey);
  if (cached) return { indices: cached, cached: true };
  const results = await batchRun(indices, async idx => {
    try {
      const text = await requestText(`https://qt.gtimg.cn/q=${idx.market}${idx.code}`, 'gbk');
      const values = (text.match(/"([^"]*)"/) || [, ''])[1].split('~');
      return { code: idx.code, name: idx.name, price: number(values[3]), changePct: number(values[32]), change: number(values[31]), source: '腾讯' };
    } catch { return { code: idx.code, name: idx.name, available: false, source: 'error' }; }
  }, 4);
  const data = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  cache.set(cacheKey, data);
  return { indices: data, cached: false, partial: data.some(x => !x.available) };
}

// --- 体检历史追踪 ---
async function recordCheckHistory(result) {
  if (!result || !result.code) return;
  try {
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const file = join(CHECK_HISTORY_DIR, `${today}.json`);
    const { readJson, writeJson } = require('./store');
    await updateJson(file, {}, history => {
      history[result.code] = {
        name: result.name, health: result.health, light: result.light, band: result.band,
        close: result.last_close, updatedAt: new Date().toISOString(),
      };
      return history;
    }, true);
  } catch {}
}

/** 最近被体检的股票（"大家都在测"数据源） */
async function recentChecks(limit = 6) {
  const items = [];
  try {
    await mkdir(CHECK_HISTORY_DIR, { recursive: true });
    const files = (await readdir(CHECK_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort().slice(-7);
    for (const f of files) {
      try {
        const day = JSON.parse(await readFile(join(CHECK_HISTORY_DIR, f), 'utf8'));
        for (const [code, v] of Object.entries(day || {})) {
          if (v && v.name) items.push({ code, name: v.name, health: v.health, light: v.light, band: v.band, updatedAt: v.updatedAt || (f.replace('.json', '') + 'T00:00:00Z') });
        }
      } catch {}
    }
  } catch {}
  // 按时间降序，同代码保留最新
  items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const seen = new Set();
  const result = [];
  for (const it of items) {
    if (!seen.has(it.code)) { seen.add(it.code); result.push(it); }
    if (result.length >= limit) break;
  }
  return result;
}

async function checkHistory(code) {
  const normalized = String(code).replace(/\D/g, '').padStart(6, '0');
  const entries = [];
  try {
    await mkdir(CHECK_HISTORY_DIR, { recursive: true });
    const files = (await readdir(CHECK_HISTORY_DIR)).sort().slice(-60);
    for (const f of files) {
      try {
        const day = JSON.parse(await readFile(join(CHECK_HISTORY_DIR, f), 'utf8'));
        if (day[normalized]) entries.push({ date: f.replace('.json', ''), ...day[normalized] });
      } catch {}
    }
  } catch {}
  return entries;
}

module.exports = {
  cache, requestText, remoteSearch,
  quote, klines, indexKlines, getIndices,
  recordCheckHistory, checkHistory, recentChecks, klineFromDisk, indexKlinesFromDisk, klinesSafe,
};
