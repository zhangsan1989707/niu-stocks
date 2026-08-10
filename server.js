const http = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { join, extname } = require('node:path');

const { average, ema, Cache } = require('./lib/helpers');
const { detectPatterns } = require('./lib/patterns');
const { murphyIndicators } = require('./lib/indicators');
const { detectClassicPatterns } = require('./lib/classic-patterns');

const PORT = Number(process.env.PORT || 4317);
const ROOT = __dirname;
const DATA_DIR = join(ROOT, 'data');
const DB_FILE = join(DATA_DIR, 'local.json');
const STATIC = join(ROOT, 'public');
const STOCKS = [
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
const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// --- 数据缓存 ---
const cache = new Cache();

// --- 日志（P2-5 增强）---
function log(method, path, status, ms) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${method} ${path} → ${status} (${ms}ms)`);
}
function logFallback(code, from, to, reason) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] [降级] ${code} ${from} → ${to}（${reason}）`);
}

// --- DB ---
let _dbCache = null, _dbCacheTime = 0;
async function loadDb() {
  // 1 秒内复用缓存，避免高频请求重复读文件
  if (_dbCache && Date.now() - _dbCacheTime < 1000) return _dbCache;
  await mkdir(DATA_DIR, { recursive: true });
  try { _dbCache = JSON.parse(await readFile(DB_FILE, 'utf8')); }
  catch { _dbCache = { feedback: [], favorites: [] }; }
  _dbCacheTime = Date.now();
  return _dbCache;
}
async function saveDb(db) { _dbCache = db; _dbCacheTime = Date.now(); await writeFile(DB_FILE, JSON.stringify(db, null, 2)); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求格式不正确')); } }); req.on('error', reject); }); }
function market(code) { return code.startsWith('6') || code.startsWith('9') ? 'sh' : code.startsWith('8') ? 'bj' : 'sz'; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

// --- 行情数据 ---
async function requestText(url, encoding = 'utf-8') { const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 StockHealthStation/1.0' }, signal: AbortSignal.timeout(8000) }); if (!response.ok) throw new Error(`行情服务返回 ${response.status}`); return new TextDecoder(encoding).decode(await response.arrayBuffer()); }

// --- 远程搜索（东方财富）---
async function remoteSearch(q) {
  try {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`;
    const text = await requestText(url);
    const data = JSON.parse(text);
    if (!data.QuotationCodeTable?.Data) return [];
    return data.QuotationCodeTable.Data
      .filter(x => x.Code && x.Name && /^[036]\d{5}$/.test(x.Code))
      .map(x => ({ code: x.Code, name: x.Name }));
  } catch { return []; }
}
async function tencentQuote(code) {
  const text = await requestText(`https://qt.gtimg.cn/q=${market(code)}${code}`, 'gbk');
  const values = (text.match(/"([^"]*)"/) || [, ''])[1].split('~');
  if (values.length < 50 || !values[1]) throw new Error('未找到该股票');
  return { code, name: values[1], price: number(values[3]), previousClose: number(values[4]), open: number(values[5]), volume: number(values[6]), high: number(values[33]), low: number(values[34]), change: number(values[31]), changePct: number(values[32]), amountWan: number(values[37]), turnoverPct: number(values[38]), pe: number(values[39]), marketCapYi: number(values[44]), pb: number(values[46]), volumeRatio: number(values[49]), updatedAt: values[30] || '', source: '腾讯财经' };
}
async function eastmoneyQuote(code) {
  const secid = `${market(code) === 'sh' ? 1 : 0}.${code}`;
  const text = await requestText(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=f57,f58,f43,f44,f45,f46,f47,f48,f50,f51,f52,f60,f116,f162,f167,f168,f170`);
  const data = JSON.parse(text).data;
  if (!data?.f58) throw new Error('备用行情源未找到该股票');
  return { code, name: data.f58, price: number(data.f43), previousClose: number(data.f60), open: number(data.f46), volume: number(data.f47), high: number(data.f44), low: number(data.f45), change: number(data.f51), changePct: number(data.f170), amountWan: number(data.f48) / 10000, turnoverPct: number(data.f168), pe: number(data.f162), marketCapYi: number(data.f116) / 1e8, pb: number(data.f167), volumeRatio: number(data.f50), updatedAt: new Date().toISOString(), source: '东方财富' };
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
  return rows.map(row => { const x = row.split(','); return { date:x[0], open:number(x[1]), close:number(x[2]), high:number(x[3]), low:number(x[4]), volume:number(x[5]) }; });
}
async function klines(code) {
  const cacheKey = cache.key('klines', code);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  let result;
  try { result = await tencentKlines(code); }
  catch (e) { logFallback(code, '腾讯K线', '东方财富K线', e.message); result = await eastmoneyKlines(code); }
  cache.set(cacheKey, result);
  return result;
}

// --- 报告引擎 ---
function reportFrom(quoteData, candles) {
  const closes = candles.map(x => x.close), volumes = candles.map(x => x.volume), last = candles.at(-1);
  const ma20 = average(closes, 20), ma60 = average(closes, 60), ma5 = average(closes, 5);

  // MA60 序列（用于图表叠加）
  const ma60Series = closes.map((_, i) => i >= 59 ? average(closes.slice(0, i + 1), 60) : null);

  const fast = ema(closes, 6), slow = ema(closes, 13), macd = fast.map((x, i) => x - slow[i]), signal = ema(macd, 5);
  const diff = macd.at(-1), dea = signal.at(-1);
  const changes = closes.slice(-15).map((x, i, arr) => i ? x - arr[i - 1] : 0).slice(1);
  const gains = changes.map(x => Math.max(x, 0)), losses = changes.map(x => Math.max(-x, 0));
  const rsiVal = average(gains, 14) / (average(losses, 14) || .0001);
  const rsiValue = 100 - 100 / (1 + rsiVal);
  const recentHigh = Math.max(...candles.slice(-60).map(x => x.high));
  const support = Math.min(...candles.slice(-21, -1).map(x => x.low));
  const resistance = recentHigh;

  // --- 蜡烛形态识别 ---
  const patterns = detectPatterns(candles);

  // --- 经典图表形态（P2-1）---
  const patternsClassic = detectClassicPatterns(candles);

  // --- 墨菲摆动指标组 ---
  const murphy = murphyIndicators(candles);

  const bullish = last.close >= ma60, macdUp = diff >= dea, healthy = bullish && macdUp;
  let score = 50 + (bullish ? 15 : -15) + (last.close >= ma20 ? 8 : -8) + (macdUp ? 9 : -9) + (quoteData.volumeRatio >= 1.5 ? 5 : 0) + (rsiValue > 70 ? -4 : rsiValue < 30 ? 2 : 0);

  // 形态加分
  let patternPts = 0;
  patterns.forEach(p => {
    if (p.dir === 'bull') patternPts += p.weight;
    else if (p.dir === 'bear') patternPts -= p.weight;
  });
  patternPts = Math.max(-12, Math.min(12, patternPts));
  score += patternPts;

  // 摆动指标组加分
  score += murphy.pts;

  // 经典图表形态加分（P2-1）
  score += patternsClassic.pts;

  // 破位检测：支撑破位优先于 MA60
  let brokeType = null, brokeIdx = -1;
  if (last.close < support * 0.985) { brokeType = 'support'; brokeIdx = candles.length - 1; score = Math.min(score, 22); }
  else if (last.close < ma60 && candles.length >= 2 && candles[candles.length - 2].close >= ma60) { brokeType = 'ma60'; brokeIdx = candles.length - 1; }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const light = score >= 65 ? 'green' : score >= 45 ? 'yellow' : 'red';
  const band = score >= 80 ? '健康' : score >= 65 ? '偏好' : score >= 45 ? '中性' : score >= 25 ? '偏弱' : '危险';
  const trend = last.close >= ma60 ? (ma5 >= ma20 ? 'up' : 'range') : (last.close < ma20 ? 'down' : 'range');

  // --- 体检维度 ---
  const scan_dims = [
    { key: 'trend', name: '趋势背景', note: bullish ? '上升趋势' : '趋势偏弱' },
    { key: 'ma60', name: '生命线 MA60', note: `${last.close >= ma60 ? '站上' : '跌破'} ${ma60.toFixed(2)}` },
    { key: 'support', name: '关键支撑', note: `${support.toFixed(2)} ${last.close >= support ? '暂未跌破' : '已跌破'}` },
    { key: 'ma5_ma20', name: 'MA5 / MA20', note: ma5 >= ma20 ? '短期均线偏多' : '短期均线偏空' },
    { key: 'volume', name: '成交量 / 量价', note: `量比 ${quoteData.volumeRatio.toFixed(2)}（≥1.5 算放量）` },
    { key: 'macd', name: 'MACD 金死叉', note: macdUp ? '金叉 · 多头占优' : '死叉 · 需谨慎' },
    { key: 'rsi', name: 'RSI / MACD 背离', note: `${rsiValue.toFixed(1)} · ${rsiValue > 70 ? '超买提醒' : rsiValue < 30 ? '超卖关注' : '无明显背离'}` },
    { key: 'polarity', name: '极性转换', note: last.close >= ma20 ? '无' : '均线下方，观察反压' },
    { key: 'fake', name: '假摔 / 假突破', note: last.low < support && last.close >= support ? '疑似假摔，等待确认' : '未识别' },
    { key: 'murphy', name: '墨菲摆动指标组', note: `${murphy.lean}（${murphy.factors.length} 项）` },
    { key: 'patterns', name: '经典图表形态', note: patterns.length ? `命中 ${patterns.length} 种蜡烛形态` : '未识别明显形态' },
    { key: 'drawdown', name: '60日高点回撤', note: `${((1 - last.close / recentHigh) * 100).toFixed(1)}%` },
  ];

  // --- 评分明细 ---
  const factors = [];
  factors.push({ dim: 'trend', pts: bullish ? 15 : -15, text: `${bullish ? '站上' : '跌破'} MA60 ${ma60.toFixed(2)}` });
  factors.push({ dim: 'ma5_ma20', pts: last.close >= ma20 ? 8 : -8, text: `收盘价 ${last.close.toFixed(2)} ${last.close >= ma20 ? '≥' : '<'} MA20 ${ma20.toFixed(2)}` });
  factors.push({ dim: 'macd', pts: macdUp ? 9 : -9, text: macdUp ? 'MACD 金叉' : 'MACD 死叉' });
  if (quoteData.volumeRatio >= 1.5) factors.push({ dim: 'volume', pts: 5, text: `量比 ${quoteData.volumeRatio.toFixed(2)} 放量` });
  if (rsiValue > 70) factors.push({ dim: 'rsi', pts: -4, text: `RSI ${rsiValue.toFixed(1)} 超买` });
  else if (rsiValue < 30) factors.push({ dim: 'rsi', pts: 2, text: `RSI ${rsiValue.toFixed(1)} 超卖` });
  if (patternPts !== 0) factors.push({ dim: 'pattern', pts: patternPts, text: `蜡烛形态 ${patterns.length} 种命中` });
  if (murphy.pts !== 0) factors.push({ dim: 'murphy', pts: murphy.pts, text: `摆动指标组 ${murphy.lean}` });
  if (patternsClassic.pts !== 0) factors.push({ dim: 'classic_pattern', pts: patternsClassic.pts, text: `经典图表形态 ${patternsClassic.patterns.length} 种命中` });

  // --- 四方会诊 ---
  const patBullW = patterns.filter(p => p.dir === 'bull').reduce((s, p) => s + p.weight, 0);
  const patBearW = patterns.filter(p => p.dir === 'bear').reduce((s, p) => s + p.weight, 0);
  const L1 = patBullW > patBearW ? '偏多' : patBearW > patBullW ? '偏空' : '中性';
  const L2 = brokeType ? '偏空·已破位' : trend === 'up' ? '偏多' : trend === 'down' ? '偏空' : '中性·震荡';
  const L3 = murphy.lean;
  // 四方会诊中 L4 使用经典图表形态
  const classicBullW = patternsClassic.patterns.filter(p => p.dir === 'bull').reduce((s, p) => s + Math.abs(p.pts), 0);
  const classicBearW = patternsClassic.patterns.filter(p => p.dir === 'bear').reduce((s, p) => s + Math.abs(p.pts), 0);
  const L4 = patternsClassic.patterns.length ? (classicBullW > classicBearW ? '偏多' : classicBearW > classicBullW ? '偏空' : '中性') : (patterns.length ? (patBullW > patBearW ? '偏多' : patBearW > patBullW ? '偏空' : '中性') : '无形态');
  const sides = [L1, L2, L3, L4];
  const bulls = sides.filter(x => x === '偏多').length;
  const bears = sides.filter(x => x.includes('偏空')).length;
  let consultVerdict, consultCls;
  if (bulls >= 2 && bears === 0) { consultVerdict = '四方共振偏多——多项一致向好，可信度较高。'; consultCls = 'green'; }
  else if (bears >= 2 && bulls === 0) { consultVerdict = '四方共振偏空——多项一致走弱，风险叠加。'; consultCls = 'red'; }
  else if (bulls > 0 && bears > 0) { consultVerdict = '⚠️ 存在背离——有看多也有看空一方，常见于反弹诱多 / 超跌反抽，等方向明朗再动手。'; consultCls = 'yellow'; }
  else { consultVerdict = '以中性为主，暂无明显合力。'; consultCls = 'neutral'; }

  // --- 图表数据 ---
  const chartBars = candles.slice(-70).map(c => ({ d: c.date, o: c.open, c: c.close, h: c.high, l: c.low, v: c.volume }));
  const chartMa60 = ma60Series.slice(-70);

  return {
    ok: true,
    code: quoteData.code,
    name: quoteData.name,
    quote: quoteData,
    candles,
    chart: { bars: chartBars, ma60: chartMa60, support, resistance },
    health: score,
    band,
    light,
    trend,
    last_close: last.close,
    last_date: last.date,
    support,
    resistance,
    vol_ratio: quoteData.volumeRatio,
    is_powei: !!brokeType,
    powei_reason: brokeType ? `收盘跌破${brokeType === 'support' ? '关键支撑' : '生命线 MA60'}` : null,
    broke: brokeIdx,
    broke_type: brokeType,
    patterns,
    pat_scanned: 29,
    pat_hit: patterns.length,
    patterns_classic: patternsClassic,
    scan_dims,
    factors,
    murphy,
    consult: { L1, L2, L3, L4, verdict: consultVerdict, cls: consultCls, bulls, bears },
    headline: healthy ? '趋势与动量保持偏强，暂未出现明显破位信号。' : '当前技术面存在分歧，建议结合下一交易日量价变化确认。',
    summary: healthy ? '趋势与动量保持偏强，暂未出现明显破位信号。' : '当前技术面存在分歧，建议结合下一交易日量价变化确认。',
    disclaimer: '仅技术形态分析，不构成投资建议。',
    // 兼容旧字段
    score, status: band,
    metrics: { ma20, ma60, ma5, macd: diff, signal: dea, rsi: rsiValue, support, recentHigh },
    checks: scan_dims.map(d => [d.name, d.note, !d.note.includes('跌破') && !d.note.includes('偏弱') && !d.note.includes('死叉') && !d.note.includes('超买') && !d.note.includes('已跌破') && !d.note.includes('偏空')]),
  };
}
async function stockReport(code) { const normalized = String(code).replace(/\D/g, '').padStart(6, '0'); const [q, k] = await Promise.all([quote(normalized), klines(normalized)]); return reportFrom(q, k); }
function route(path) { return path === '/' ? '/index.html' : path; }

// --- 限流并发 ---
async function batchRun(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
      catch (e) { results[i] = { status: 'rejected', reason: e }; }
    }
  });
  await Promise.all(workers);
  return results;
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`); const db = await loadDb();
  try {
    if (req.method === 'GET' && url.pathname === '/api/stocks/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const matches = STOCKS.filter(x => x[0].includes(q) || x[1].includes(q)).slice(0, 8).map(([code, name]) => ({ code, name }));
      if (/^\d{6}$/.test(q) && !matches.some(x => x.code === q)) {
        try { const current = await quote(q); matches.unshift({ code: q, name: current.name }); } catch {}
      }
      // 预置列表没匹配时，走远程搜索
      if (matches.length < 3 && !/^\d{6}$/.test(q)) {
        const remote = await remoteSearch(q);
        for (const r of remote) {
          if (!matches.some(x => x.code === r.code)) matches.push(r);
          if (matches.length >= 8) break;
        }
      }
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { stocks: matches });
    }

    if (req.method === 'GET' && /^\/api\/stocks\/\d{6}\/report$/.test(url.pathname)) {
      const code = url.pathname.split('/')[3];
      const result = await stockReport(code);
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/screen') {
      const reports = await batchRun(STOCKS, ([code]) => stockReport(code), 3);
      const candidates = reports.filter(x => x.status === 'fulfilled').map(x => x.value)
        .filter(x => x.health >= 60).sort((a, b) => b.health - a.health)
        .map(x => ({ code: x.code, name: x.name, price: x.quote.price, changePct: x.quote.changePct, score: x.health, volumeRatio: x.quote.volumeRatio, status: x.band, light: x.light }));
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { updatedAt: new Date().toISOString(), candidates });
    }

    // 自定义代码列表扫描
    if (req.method === 'GET' && url.pathname === '/api/screen/custom') {
      const codesParam = url.searchParams.get('codes') || '';
      const codes = [...new Set(codesParam.split(',').map(c => c.trim()).filter(c => /^\d{6}$/.test(c)))].slice(0, 20);
      if (!codes.length) { log('GET', url.pathname, 400, Date.now() - start); return json(res, 400, { error: '请提供有效的股票代码列表' }); }
      const reports = await batchRun(codes, code => stockReport(code), 3);
      const candidates = reports.filter(x => x.status === 'fulfilled').map(x => x.value)
        .sort((a, b) => b.health - a.health)
        .map(x => ({ code: x.code, name: x.name, price: x.quote.price, changePct: x.quote.changePct, score: x.health, volumeRatio: x.quote.volumeRatio, status: x.band, light: x.light, patterns: x.patterns }));
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { updatedAt: new Date().toISOString(), count: candidates.length, candidates });
    }

    // 批量获取自选行情摘要
    if (req.method === 'GET' && url.pathname === '/api/favreport') {
      const favCodes = db.favorites.map(f => f.code);
      if (!favCodes.length) { log('GET', url.pathname, 200, Date.now() - start); return json(res, 200, { ok: true, date: new Date().toISOString().slice(0, 10), items: [], changes: [] }); }
      const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
      const historyDir = join(DATA_DIR, 'fav-history');
      const historyFile = join(historyDir, `${today}.json`);
      let todayData = null;
      try { todayData = JSON.parse(await readFile(historyFile, 'utf8')); } catch {}
      if (!todayData) {
        // 首次：生成今日快照
        const results = await batchRun(favCodes, code => stockReport(code).then(r => ({ code: r.code, name: r.name, light: r.light, health: r.health })), 3);
        todayData = { date: today, items: results.filter(r => r.status === 'fulfilled').map(r => r.value) };
        try { await mkdir(historyDir, { recursive: true }); await writeFile(historyFile, JSON.stringify(todayData, null, 2)); } catch {}
      }
      // 读昨日数据对比（用本地日期避免 UTC 跨日问题）
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      const yDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      const yesterdayFile = join(historyDir, `${yDate}.json`);
      let prevData = null;
      try { prevData = JSON.parse(await readFile(yesterdayFile, 'utf8')); } catch {}
      let changes = [];
      if (prevData) {
        const prevMap = {};
        prevData.items.forEach(item => { prevMap[item.code] = item; });
        changes = todayData.items.filter(item => {
          const prev = prevMap[item.code];
          return prev && prev.light !== item.light;
        }).map(item => {
          const prev = prevMap[item.code];
          return { code: item.code, name: item.name, prev_light: prev.light, prev_score: prev.health, light: item.light, score: item.health };
        });
      }
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { ok: true, date: today, prev_date: prevData ? prevData.date : null, items: todayData.items, changes });
    }

    if (req.method === 'GET' && url.pathname === '/api/favorites/quotes') {
      const favCodes = db.favorites.map(f => f.code);
      if (!favCodes.length) { log('GET', url.pathname, 200, Date.now() - start); return json(res, 200, { ok: true, items: [] }); }
      const results = await batchRun(favCodes, async code => {
        try { const q = await quote(code); const k = await klines(code); const closes = k.map(c => c.close).slice(-24); return { ok: true, code, name: q.name, last_close: q.price, change_pct: q.changePct, sparkline: closes, source: q.source }; }
        catch (e) { return { ok: false, code, error: e.message }; }
      }, 3);
      const items = results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, code: '', error: r.reason?.message });
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { ok: true, items });
    }

    if (url.pathname === '/api/favorites') {
      if (req.method === 'GET') { log('GET', url.pathname, 200, Date.now() - start); return json(res, 200, { favorites: db.favorites }); }
      const { code, name } = await body(req);
      if (!/^\d{6}$/.test(code || '')) return json(res, 400, { error: '股票代码不正确' });
      if (!db.favorites.some(x => x.code === code)) { db.favorites.push({ id: randomUUID(), code, name, createdAt: new Date().toISOString() }); await saveDb(db); }
      log('POST', url.pathname, 201, Date.now() - start);
      return json(res, 201, { ok: true, favorites: db.favorites });
    }
    if (req.method === 'DELETE' && /^\/api\/favorites\/\d{6}$/.test(url.pathname)) { db.favorites = db.favorites.filter(x => x.code !== url.pathname.split('/').at(-1)); await saveDb(db); log('DELETE', url.pathname, 200, Date.now() - start); return json(res, 200, { ok: true, favorites: db.favorites }); }

    if (url.pathname === '/api/feedback') {
      if (req.method === 'GET') { log('GET', url.pathname, 200, Date.now() - start); return json(res, 200, { feedback: db.feedback.slice(-30).reverse() }); }
      const { message } = await body(req);
      if (!String(message || '').trim() || message.length > 500) return json(res, 400, { error: '反馈内容需为 1–500 字' });
      db.feedback.push({ id: randomUUID(), message: message.trim(), author: '本机用户', createdAt: new Date().toISOString() });
      await saveDb(db);
      log('POST', url.pathname, 201, Date.now() - start);
      return json(res, 201, { ok: true });
    }

    if (req.method === 'GET') {
      const file = join(STATIC, route(url.pathname));
      if (!file.startsWith(STATIC)) return json(res, 403, { error: 'Forbidden' });
      try {
        const content = await readFile(file);
        res.writeHead(200, { 'content-type': type[extname(file)] || 'application/octet-stream' });
        return res.end(content);
      } catch {
        const html = await readFile(join(STATIC, 'index.html'));
        res.writeHead(200, { 'content-type': type['.html'] });
        return res.end(html);
      }
    }
    log(req.method, url.pathname, 404, Date.now() - start);
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    const ms = Date.now() - start;
    const status = error.message?.includes('timeout') || error.name === 'TimeoutError' ? 504
      : error.message?.includes('未找到') ? 404
      : error.message?.includes('请求格式') ? 400
      : 502;
    log(req.method, url.pathname, status, ms);
    const errMsg = status === 504 ? '行情服务响应超时，请稍后重试'
      : status === 404 ? error.message
      : status === 400 ? error.message
      : error.message || '服务暂不可用，请稍后重试';
    json(res, status, { error: errMsg, source: 'error' });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`牛股体检站运行于 http://localhost:${PORT}`));

module.exports = { reportFrom, market, detectPatterns, murphyIndicators, detectClassicPatterns };
