/**
 * 涨停股池模块 — P2-14
 * 直接调用东方财富涨停池/昨日池/龙虎榜接口（akshare 同源），纯 Node 实现
 *
 * 数据来源：
 *   - 涨停板池：push2ex getTopicZTPool (sort=fbt:asc)
 *   - 昨日涨停池：同上 (date=昨日, sort=zbc:asc) → 昨日连板数
 *   - 龙虎榜：datacenter-web RPT_DAILYBILLBOARD_DETAILSNEW（失败则跳过）
 *   - 量比 / 60日新高：复用腾讯行情 + K线（有缓存）
 *
 * 每日名单落盘 data/zt-history/YYYYMMDD.json
 */

const { Cache } = require('../helpers');
const { number, batchRun, DATA_DIR } = require('./utils');
const { requestText, quote, klines } = require('./market');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');

const cache = new Cache();
const ZT_HISTORY_DIR = join(DATA_DIR, 'zt-history');
const ZT_API = 'https://push2ex.eastmoney.com/getTopicZTPool';
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const MAX_PAGES = 3; // 单页 170，涨停一般 <500

function dateStr(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function dateDash(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function yesterdayDate() {
  const d = new Date(Date.now() - 86400000);
  return dateStr(d);
}

/** 板块标识（A 股涨跌停幅度） */
function boardOf(code) {
  if (code.startsWith('688')) return '科创板20cm';
  if (code.startsWith('300') || code.startsWith('301')) return '创业板20cm';
  if (code.startsWith('920') || code.startsWith('83') || code.startsWith('87') || code.startsWith('43')) return '北交所30cm';
  if (code.startsWith('000') || code.startsWith('002') || code.startsWith('001')) return '深主板10cm';
  if (code.startsWith('600') || code.startsWith('601') || code.startsWith('603') || code.startsWith('605')) return '沪主板10cm';
  return '其他';
}

/** 封板时间数字 → 'HH:MM' */
function fmtTime(t) {
  if (t == null || t === '' || Number(t) <= 0) return '—';
  const s = String(t).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

/** 抓取涨停池（sort 参数区分池子） */
/** 抓取"最近交易日"的昨日池（基于目标日期回退，周末/节假日自动往前找，最多 10 天） */
async function fetchPrevPool(target) {
  const base = new Date(Number(target.slice(0, 4)), Number(target.slice(4, 6)) - 1, Number(target.slice(6, 8)));
  for (let i = 1; i <= 10; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const ds = dateStr(d);
    try {
      const rows = await fetchPool(ds, 'zbc:asc');
      if (rows.length) return { date: ds, rows };
    } catch {}
  }
  return { date: null, rows: [] };
}

async function fetchPool(date, sort) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${ZT_API}?ut=${UT}&dpt=wz.ztzt&Pageindex=${page}&pagesize=170&sort=${encodeURIComponent(sort)}&date=${date}`;
    const text = await requestText(url);
    const data = JSON.parse(text).data;
    if (!data || !data.pool || !data.pool.length) break;
    rows.push(...data.pool);
    if (rows.length >= data.tc) break;
  }
  return rows;
}

/** 龙虎榜当日股票代码集合（失败返回空 Set） */
async function fetchLhb(dateDashStr) {
  const codes = new Set();
  try {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=500&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&filter=(TRADE_DATE%3D%27${dateDashStr}%27)`;
    const text = await requestText(url);
    const data = JSON.parse(text).result;
    (data?.data || []).forEach(row => {
      const secu = String(row.SECUCODE || '');
      const code = secu.split('.')[0];
      if (/^\d{6}$/.test(code)) codes.add(code);
    });
  } catch {}
  return codes;
}

/**
 * 获取涨停股池（合并昨日池/龙虎榜/量比/60日新高）
 * @param {Object} opts { date: 'YYYYMMDD', force: bool }
 */
async function getZTPool({ date, force = false } = {}) {
  const target = date || dateStr();
  const cacheKey = cache.key('ztpool', target);
  if (!force) {
    const cached = cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
    try {
      const disk = JSON.parse(await readFile(join(ZT_HISTORY_DIR, `${target}.json`), 'utf8'));
      if (disk && disk.pool && disk.pool.length && disk.prevDate !== undefined) return { ...disk, cached: true };
    } catch {}
  }

  // 1. 当日涨停池 + 昨日池（拿昨日连板数）
  const [poolRows, prevRes] = await Promise.allSettled([
    fetchPool(target, 'fbt:asc'),
    fetchPrevPool(target),
  ]);
  const prevRows = prevRes.status === 'fulfilled' ? prevRes.value : { date: null, rows: [] };
  const prevDate = prevRows.date;
  if (poolRows.status !== 'fulfilled' || !poolRows.value.length) {
    return { ok: false, error: '当日涨停池数据暂不可用（可能非交易日或接口异常）', date: target };
  }
  const prevMap = {};
  if (prevRows.rows && prevRows.rows.length) {
    prevRows.rows.forEach(r => { prevMap[String(r.c)] = r.lbc; });
  }

  // 2. 龙虎榜（可选）
  const lhbCodes = await fetchLhb(dateDash(new Date(`${target.slice(0, 4)}-${target.slice(4, 6)}-${target.slice(6, 8)}T12:00:00`)));

  // 3. 批量行情（量比）+ K线（60日新高）
  const codes = [...new Set(poolRows.value.map(r => String(r.c)))];
  const quoteResults = await batchRun(codes, async code => {
    try { const q = await quote(code); return { code, volumeRatio: q.volumeRatio, price: q.price }; }
    catch { return { code, volumeRatio: null, price: null }; }
  }, 6);
  const quoteMap = {};
  quoteResults.forEach(r => { if (r.status === 'fulfilled' && r.value) quoteMap[r.value.code] = r.value; });

  const highResults = await batchRun(codes, async code => {
    try {
      const k = await klines(code);
      if (!k || k.length < 30) return { code, newHigh: null };
      const prev60 = k.slice(-61, -1).map(c => c.high);
      const last = k[k.length - 1];
      return { code, newHigh: prev60.length ? last.close >= Math.max(...prev60) : null };
    } catch { return { code, newHigh: null }; }
  }, 6);
  const highMap = {};
  highResults.forEach(r => { if (r.status === 'fulfilled' && r.value) highMap[r.value.code] = r.value.newHigh; });

  // 4. 合并
  const pool = poolRows.value.map(r => {
    const code = String(r.c);
    const amount = number(r.amount);
    const fund = number(r.fund);
    const ltsz = number(r.ltsz);
    return {
      code, name: String(r.n || ''), board: boardOf(code), industry: String(r.hybk || ''),
      lbc: number(r.lbc), prevLbc: prevMap[code] != null ? number(prevMap[code]) : null,
      zdp: Math.round(number(r.zdp) * 100) / 100, price: Math.round(number(r.p) * 100) / 100,
      amountYi: Math.round(amount / 1e8 * 100) / 100,
      ltszYi: Math.round(ltsz / 1e8 * 100) / 100,
      tshareYi: Math.round(number(r.tshare) / 1e8 * 100) / 100,
      hs: Math.round(number(r.hs) * 100) / 100,
      volumeRatio: quoteMap[code]?.volumeRatio != null ? Math.round(quoteMap[code].volumeRatio * 100) / 100 : null,
      fundYi: Math.round(fund / 1e8 * 100) / 100,
      fundRatio: amount > 0 ? Math.round(fund / amount * 100) / 100 : null,
      firstTime: fmtTime(r.fbt), lastTime: fmtTime(r.lbt), zbc: number(r.zbc),
      zttj: r.zttj ? `${r.zttj.ct}天/${r.zttj.days}日` : '',
      lhb: lhbCodes.has(code), newHigh: highMap[code],
    };
  });

  pool.sort((a, b) => (b.lbc - a.lbc) || (a.firstTime.localeCompare(b.firstTime)));

  const result = {
    ok: true, date: target, prevDate, updatedAt: new Date().toISOString(),
    total: pool.length,
    lhbTotal: lhbCodes.size,
    pool,
    summary: {
      maxLbc: pool.length ? Math.max(...pool.map(x => x.lbc)) : 0,
      lbc3: pool.filter(x => x.lbc >= 3).length,
      lbc5: pool.filter(x => x.lbc >= 5).length,
      lhbCount: pool.filter(x => x.lhb).length,
      newHighCount: pool.filter(x => x.newHigh === true).length,
      zbc0: pool.filter(x => x.zbc === 0).length,
      zbc3: pool.filter(x => x.zbc >= 3).length,
      boards: pool.reduce((acc, x) => { acc[x.board] = (acc[x.board] || 0) + 1; return acc; }, {}),
    },
    disclaimer: '涨停数据来自东方财富公开接口，仅供研究，不构成投资建议。',
  };

  // 落盘
  try {
    await mkdir(ZT_HISTORY_DIR, { recursive: true });
    await writeFile(join(ZT_HISTORY_DIR, `${target}.json`), JSON.stringify(result));
  } catch {}
  cache.set(cacheKey, result);
  return result;
}

/** 历史涨停名单列表 */
async function listZTHistory() {
  try {
    await mkdir(ZT_HISTORY_DIR, { recursive: true });
    const { readdir } = require('node:fs/promises');
    const files = (await readdir(ZT_HISTORY_DIR)).filter(f => /^\d{8}\.json$/.test(f)).sort().reverse();
    const list = [];
    for (const f of files.slice(0, 30)) {
      try {
        const data = JSON.parse(await readFile(join(ZT_HISTORY_DIR, f), 'utf8'));
        if (data && data.pool) {
          const top = [...data.pool].sort((a, b) => b.lbc - a.lbc).slice(0, 3);
          list.push({ date: f.replace('.json', ''), total: data.pool.length, maxLbc: data.summary?.maxLbc || 0, top: top.map(t => t.name) });
        }
      } catch {}
    }
    return list;
  } catch { return []; }
}

module.exports = { getZTPool, listZTHistory, boardOf, fmtTime };
