/**
 * 智能选股引擎 — v0.0.5
 *
 * 三层架构（方法论参考 zvt TargetSelector / Sequoia-X 规则库 / ai-hedge-fund 信号聚合）：
 *   第一层 硬过滤：流动性 / ST / 次新 / 过热 —— 风险排除不参与打分，直接淘汰
 *   第二层 多策略信号：趋势、RPS 相对强度、20日突破、量价金叉、形态 —— 各自独立输出 [-1,1] 置信度
 *   第三层 聚合：加权投票 → 横截面 TopK；破位 / 深度回撤由风险否决层一票否决
 *
 * 每日名单落盘 data/screen-history/YYYY-MM-DD.json，
 * 作为前向收益回验（T+1/T+5/T+10 vs 沪深300）与后续 RankIC 因子体检的数据基础。
 */

const { join } = require('node:path');
const { mkdir, readdir } = require('node:fs/promises');
const { average, ema } = require('../helpers');
const { number, batchRun } = require('./utils');
const { loadConfig, readJson, writeJson, SCREEN_HISTORY_DIR } = require('./store');
const { klines, indexKlines, klineFromDisk } = require('./market');
const { reportFrom } = require('./report');
const { getUniverse } = require('./universe');

// 各策略信号权重（v1 手工设定，后续用 RankIC 体检数据校准）
const SCREEN_WEIGHTS = { trend: 0.30, rps: 0.25, breakout: 0.20, volcross: 0.15, pattern: 0.10 };
const SIGNAL_NAMES = { trend: '趋势动量', rps: 'RPS强度', breakout: '20日突破', volcross: '量价金叉', pattern: '形态共振' };
const FORWARD_HORIZONS = [1, 5, 10];
// Phase 3: Score 分桶（用于单调性检验）
const SCORE_BUCKETS = [
  { label: '50-55', min: 50, max: 55 },
  { label: '55-60', min: 55, max: 60 },
  { label: '60-65', min: 60, max: 65 },
  { label: '65-70', min: 65, max: 70 },
  { label: '70-75', min: 70, max: 75 },
  { label: '75-80', min: 75, max: 80 },
  { label: '80+', min: 80, max: 200 },
];

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- 第一层：硬过滤 ---

/** 上市日期 YYYYMMDD 距今天数 */
function daysSinceList(listDate, now = new Date()) {
  if (!/^\d{8}$/.test(String(listDate))) return Infinity;
  const s = String(listDate);
  const listed = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Math.floor((now - listed) / 86400000);
}

/**
 * 硬过滤：返回 { pass, reason }
 * 被拒原因用于漏斗统计，不进入任何打分。
 */
function hardFilter(stock, cfg, now = new Date()) {
  if (stock.price <= 0 || stock.amount <= 0) return { pass: false, reason: '停牌/无成交' };
  if (/ST|退/i.test(stock.name)) return { pass: false, reason: 'ST/退市风险' };
  if (stock.amount < cfg.screenMinAmount) return { pass: false, reason: '成交额不足' };
  const days = daysSinceList(stock.listDate, now);
  if (days < cfg.screenMinListDays) return { pass: false, reason: '次新股' };
  if (stock.chg60d > cfg.screenMaxChg60d) return { pass: false, reason: '60日涨幅过热' };
  return { pass: true, reason: null };
}

/**
 * 横截面百分位排名（RPS 口径）：返回 Map<code, 0-100>
 * 值 = 该股票在全市场中跑赢的比例（欧奈尔 RPS 定义）
 */
function rpsMap(stocks, key) {
  const valid = stocks.filter(s => Number.isFinite(s[key]));
  const sorted = [...valid].sort((a, b) => a[key] - b[key]);
  const map = new Map();
  const denom = Math.max(1, sorted.length - 1);
  sorted.forEach((s, i) => map.set(s.code, Math.round((i / denom) * 100)));
  return map;
}

// --- 第二层：多策略信号 ---

/**
 * 基于 K 线计算各策略置信度（均为 [-1, 1]）
 * @param candles 日K数组（>= 70 根）
 * @param cfg 策略配置
 * @param report reportFrom 输出（提供形态/墨菲分）
 */
function computeStrategySignals(candles, cfg, report) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const last = candles[candles.length - 1];
  const n = closes.length;

  const ma60 = average(closes, Math.min(cfg.ma60Period, n));
  const ma20 = average(closes, 20);
  const fast = ema(closes, cfg.macdFast), slow = ema(closes, cfg.macdSlow);
  const macd = fast.map((x, i) => x - slow[i]);
  const signal = ema(macd, cfg.macdSignal);
  const macdUp = macd[n - 1] >= signal[n - 1];

  // 1. 趋势动量：生命线 + 中期均线 + MACD 状态
  let trendConf = 0;
  const trendParts = [];
  trendConf += last.close >= ma60 ? 0.5 : -0.5; trendParts.push(last.close >= ma60 ? '站上MA60' : '跌破MA60');
  trendConf += last.close >= ma20 ? 0.25 : -0.25; trendParts.push(last.close >= ma20 ? '站上MA20' : '跌破MA20');
  trendConf += macdUp ? 0.25 : -0.25; trendParts.push(macdUp ? 'MACD多头' : 'MACD空头');

  // 2. 20日突破（海龟简化）：收盘创 20 日新高且收阳
  const prevHigh20 = Math.max(...highs.slice(-21, -1));
  const prevLow20 = Math.min(...lows.slice(-21, -1));
  let breakoutConf = 0, breakoutNote = '未突破';
  if (last.close > prevHigh20 && last.close > last.open) { breakoutConf = 1; breakoutNote = `放量收阳创20日新高（${prevHigh20.toFixed(2)}）`; }
  else if (last.close < prevLow20) { breakoutConf = -0.5; breakoutNote = '收盘跌破20日低点'; }

  // 3. 量价金叉：近 3 日内 MA5 上穿 MA20，且金叉当日放量（量 >= 前20日均量 x 1.5）
  let volcrossConf = 0, volcrossNote = '无';
  const ma5At = i => average(closes.slice(0, i + 1), 5);
  const ma20At = i => average(closes.slice(0, i + 1), 20);
  for (let i = Math.max(20, n - 3); i < n; i++) {
    if (ma5At(i) >= ma20At(i) && ma5At(i - 1) < ma20At(i - 1)) {
      const volBase = average(volumes.slice(0, i), 20);
      const volUp = volBase > 0 && volumes[i] >= volBase * 1.5;
      if (i === n - 1 && !volUp) { volcrossNote = '今日金叉但未放量'; }
      else { volcrossConf = 1; volcrossNote = `${candles[i].date} MA5上穿MA20${volUp ? ' + 放量确认' : ''}`; }
      break;
    }
  }

  // 4. 形态共振：蜡烛形态权重差 + 墨菲摆动分 + 经典图表分（与 reportFrom 同口径）
  const patBull = report.patterns.filter(p => p.dir === 'bull').reduce((s, p) => s + p.weight, 0);
  const patBear = report.patterns.filter(p => p.dir === 'bear').reduce((s, p) => s + p.weight, 0);
  const rawPts = Math.max(-12, Math.min(12, patBull - patBear)) + (report.murphy?.pts || 0) + (report.patterns_classic?.pts || 0);
  const patternConf = Math.max(-1, Math.min(1, rawPts / 15));
  const patternNote = rawPts > 0 ? `形态偏多（+${rawPts.toFixed(0)}分）` : rawPts < 0 ? `形态偏空（${rawPts.toFixed(0)}分）` : '无形态倾向';

  return {
    trend: { conf: Math.max(-1, Math.min(1, trendConf)), note: trendParts.join(' · ') },
    breakout: { conf: breakoutConf, note: breakoutNote },
    volcross: { conf: volcrossConf, note: volcrossNote },
    pattern: { conf: patternConf, note: patternNote },
  };
}

/**
 * 风险否决层（独立于打分，一票否决 — ai-hedge-fund 风控硬约束思想）
 */
function riskVetoes(candles, report) {
  const vetoes = [];
  if (report.is_powei) vetoes.push(report.powei_reason || '收盘破位');
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const high60 = Math.max(...candles.slice(-60).map(c => c.high));
  const drawdown = 1 - last / high60;
  if (drawdown > 0.30) vetoes.push(`距60日高点回撤 ${(drawdown * 100).toFixed(1)}%`);
  return vetoes;
}

/**
 * 单只候选精析：拉 K 线 → 体检引擎 → 策略信号
 * 返回 null 表示数据不足/失败（skipReason 说明）
 */
/** 核心精析：给定 K 线切片（可为历史截至某日）与行情近似值，输出体检+信号+风险 */
async function analyzeWithKlines(stockLike, k, cfg) {
  if (!k || k.length < 70) return { code: stockLike.code, name: stockLike.name, skip: 'K线不足70根' };
  const quoteLike = { code: stockLike.code, name: stockLike.name, price: stockLike.price, changePct: stockLike.changePct, volumeRatio: stockLike.volumeRatio };
  const report = reportFrom(quoteLike, k, cfg);
  const signals = computeStrategySignals(k, cfg, report);
  const vetoes = riskVetoes(k, report);

  const closes = k.map(c => c.close);
  const base = closes.length >= 121 ? closes[closes.length - 121] : closes[0];
  const ret120 = base > 0 ? (closes[closes.length - 1] / base - 1) * 100 : 0;

  return {
    code: stockLike.code, name: stockLike.name, price: stockLike.price, changePct: stockLike.changePct,
    amount: stockLike.amount, turnoverPct: stockLike.turnoverPct, volumeRatio: stockLike.volumeRatio,
    health: report.health, light: report.light, band: report.band,
    ret120, signals, vetoes, skip: null,
  };
}

async function analyzeCandidate(stock, cfg) {
  let k;
  try { k = await klines(stock.code); }
  catch { return { code: stock.code, name: stock.name, skip: 'K线获取失败' }; }
  return analyzeWithKlines(stock, k, cfg);
}

// --- 第三层：聚合 ---

/**
 * 加权聚合：confs = { trend, rps, breakout, volcross, pattern }（[-1,1]）
 * 归一化后映射到 0-100（50 为中性）
 */
function finalizeScore(confs, weights = SCREEN_WEIGHTS) {
  let sum = 0, wsum = 0;
  for (const [key, w] of Object.entries(weights)) {
    const c = confs[key];
    if (c == null || !Number.isFinite(c)) continue;
    sum += w * Math.max(-1, Math.min(1, c));
    wsum += w;
  }
  if (!wsum) return 50;
  return Math.max(0, Math.min(100, Math.round(50 + (sum / wsum) * 50)));
}

/**
 * 运行一次全市场智能选股
 */
async function runSmartScreen({ force = false, persist = true } = {}) {
  const cfg = await loadConfig();
  const today = localDateStr();
  const file = join(SCREEN_HISTORY_DIR, `${today}.json`);

  if (!force) {
    const existing = await readJson(file, null);
    if (existing) return { ...existing, cached: true };
  }

  // 第一层：全市场快照 + 硬过滤
  const uni = await getUniverse();
  const passed = [];
  const rejected = {};
  for (const s of uni.stocks) {
    const r = hardFilter(s, cfg);
    if (r.pass) passed.push(s);
    else rejected[r.reason] = (rejected[r.reason] || 0) + 1;
  }

  // RPS60 横截面（对全市场有效报价股排名，才是真实相对强度）
  const rps60 = rpsMap(uni.stocks, 'chg60d');
  const candidates = passed
    .filter(s => (rps60.get(s.code) || 0) >= cfg.screenRpsMin)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, cfg.screenMaxCandidates);

  // 第二层：K线精析
  const results = await batchRun(candidates, s => analyzeCandidate(s, cfg), 6);
  const analyzed = [], skipped = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && !r.value.skip) analyzed.push(r.value);
    else if (r.status === 'fulfilled' && r.value) skipped.push(r.value);
  }

  // RPS120 横截面（候选池内排名）
  const rps120 = rpsMap(analyzed, 'ret120');

  // 第三层：聚合评分
  const scored = analyzed.map(a => {
    const rpsConf = ((rps120.get(a.code) || 50) - 50) / 50;
    const confs = {
      trend: a.signals.trend.conf,
      rps: rpsConf,
      breakout: a.signals.breakout.conf,
      volcross: a.signals.volcross.conf,
      pattern: a.signals.pattern.conf,
    };
    const score = finalizeScore(confs);
    const signalList = Object.entries(confs).map(([key, conf]) => ({
      key, name: SIGNAL_NAMES[key], conf: Math.round(conf * 100) / 100,
      note: key === 'rps' ? `120日强度排名 ${rps120.get(a.code) ?? '—'}` : a.signals[key].note,
    }));
    return {
      code: a.code, name: a.name, price: a.price, changePct: a.changePct,
      amountYi: Math.round(a.amount / 1e8 * 100) / 100,
      turnoverPct: a.turnoverPct, volumeRatio: a.volumeRatio,
      rps60: rps60.get(a.code) ?? null, rps120: rps120.get(a.code) ?? null,
      ret120: Math.round(a.ret120 * 100) / 100,
      health: a.health, light: a.light, band: a.band,
      score, signals: signalList, vetoes: a.vetoes,
    };
  });

  // 风险否决：被否决的移出 TopK 候选，单独列示（透明度）
  const clean = scored.filter(x => x.vetoes.length === 0);
  const vetoed = scored.filter(x => x.vetoes.length > 0)
    .map(({ signals, ...rest }) => rest)
    .sort((a, b) => b.score - a.score);

  clean.sort((a, b) => b.score - a.score || (b.rps120 || 0) - (a.rps120 || 0));
  const top = clean.slice(0, cfg.screenTopK)
    .map((x, i) => ({ rank: i + 1, ...x }));

  const result = {
    ok: true,
    date: today,
    generatedAt: new Date().toISOString(),
    method: '三层智能选股：硬过滤 → RPS候选 → 多策略加权 TopK（风险一票否决）',
    funnel: {
      universe: uni.count,
      hardFilterPassed: passed.length,
      rpsCandidates: candidates.length,
      analyzed: analyzed.length,
      skipped: skipped.length,
      vetoed: vetoed.length,
    },
    rejected,
    weights: SCREEN_WEIGHTS,
    config: {
      minAmountYi: cfg.screenMinAmount / 1e8,
      rpsMin: cfg.screenRpsMin,
      maxCandidates: cfg.screenMaxCandidates,
      topK: cfg.screenTopK,
      minListDays: cfg.screenMinListDays,
      maxChg60d: cfg.screenMaxChg60d,
    },
    top,
    vetoed: vetoed.slice(0, 10),
    disclaimer: '历史规律不代表未来表现，仅技术面筛选，不构成投资建议。',
  };

  if (persist) {
    try {
      await mkdir(SCREEN_HISTORY_DIR, { recursive: true });
      await writeJson(file, result);
    } catch (e) { console.error('[smart-screen] 名单落盘失败：', e.message); }
  }
  return result;
}

// --- 历史名单 ---

async function loadScreenHistoryList() {
  try {
    await mkdir(SCREEN_HISTORY_DIR, { recursive: true });
    const files = (await readdir(SCREEN_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort();
    const list = [];
    for (const f of files.slice(-60)) {
      const data = await readJson(join(SCREEN_HISTORY_DIR, f), null);
      if (!data?.top) continue;
      list.push({
        date: f.replace('.json', ''),
        generatedAt: data.generatedAt,
        count: data.top.length,
        names: data.top.slice(0, 3).map(t => t.name),
      });
    }
    return list.reverse();
  } catch { return []; }
}

// --- 历史回填：对过去交易日按当日收盘后口径重跑选股（无前视） ---

/**
 * 对指定历史交易日 T 运行一次选股并落盘（与实盘同口径，仅用 <=T 的数据）
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {Object|null} 名单结果；T 非交易日或无数据返回 null
 */
async function runBackfillScreen(dateStr) {
  const cfg = await loadConfig();
  const file = join(SCREEN_HISTORY_DIR, dateStr + '.json');
  const existing = await readJson(file, null);
  if (existing && existing.top) return { ...existing, cached: true };

  const uni = await getUniverse();
  const target = new Date(dateStr + 'T12:00:00');
  const stocks = [];
  const rpsInput = []; // 全市场 chg60d 排名输入
  let traded = 0;

  // 并发直读磁盘 K 线（不触发网络，避免限流）
  const scanResults = await batchRun(uni.stocks, async s => {
    try {
      const k = await klineFromDisk(s.code);
      if (!k) return null;
      const idx = k.findIndex(c => c.date === dateStr);
      if (idx < 60) return null; // T 无数据或 K 线不足（含停牌）
      const c = k[idx];
      const close60 = k[idx - 60]?.close;
      const chg60d = close60 > 0 ? (c.close / close60 - 1) * 100 : null;
      const volBase = average(k.slice(Math.max(0, idx - 4), idx + 1).map(x => x.volume), 5);
      const volRatio = volBase > 0 ? c.volume / volBase : null;
      return {
        code: s.code, market: s.market, name: s.name,
        price: c.close, changePct: idx > 0 ? (c.close / k[idx - 1].close - 1) * 100 : 0,
        amount: c.volume * 100 * c.close, // K线 volume 单位为手（1手=100股）
        turnoverPct: null, volumeRatio: volRatio,
        totalCap: s.totalCap, floatCap: s.floatCap,
        chg60d, chgYtd: s.chgYtd, listDate: s.listDate,
        _k: k, _idx: idx,
      };
    } catch { return null; }
  }, 8);

  for (const r of scanResults) {
    if (r.status === 'fulfilled' && r.value) {
      stocks.push(r.value);
      traded++;
      if (Number.isFinite(r.value.chg60d)) rpsInput.push({ code: r.value.code, chg60d: r.value.chg60d });
    }
  }
  if (traded < 500) return { ok: false, date: dateStr, message: '非交易日或数据不足' };

  // 硬过滤（历史口径）
  const passed = [];
  const rejected = {};
  for (const s of stocks) {
    const r = hardFilter(s, cfg, target);
    if (r.pass) passed.push(s);
    else rejected[r.reason] = (rejected[r.reason] || 0) + 1;
  }

  // RPS60 全市场横截面（历史 chg60d）
  const rps60 = rpsMap(rpsInput, 'chg60d');
  const candidates = passed
    .filter(s => (rps60.get(s.code) || 0) >= cfg.screenRpsMin)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, cfg.screenMaxCandidates);

  // K线精析（仅候选，用截至 T 的切片）
  const results = await batchRun(candidates, s => analyzeWithKlines(s, s._k.slice(0, s._idx + 1), cfg), 6);
  const analyzed = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && !r.value.skip) analyzed.push(r.value);
  }

  // RPS120 候选池排名
  const rps120 = rpsMap(analyzed, 'ret120');

  // 聚合评分
  const scored = analyzed.map(a => {
    const rpsConf = ((rps120.get(a.code) || 50) - 50) / 50;
    const confs = {
      trend: a.signals.trend.conf, rps: rpsConf, breakout: a.signals.breakout.conf,
      volcross: a.signals.volcross.conf, pattern: a.signals.pattern.conf,
    };
    const score = finalizeScore(confs);
    const signalList = Object.entries(confs).map(([key, conf]) => ({
      key, name: SIGNAL_NAMES[key], conf: Math.round(conf * 100) / 100,
      note: key === 'rps' ? `120日强度排名 ${rps120.get(a.code) ?? '—'}` : a.signals[key].note,
    }));
    return {
      code: a.code, name: a.name, price: Math.round(a.price * 100) / 100, changePct: Math.round((a.changePct || 0) * 100) / 100,
      amountYi: Math.round((a.amount || 0) / 1e8 * 100) / 100,
      turnoverPct: a.turnoverPct, volumeRatio: a.volumeRatio == null ? null : Math.round(a.volumeRatio * 100) / 100,
      rps60: rps60.get(a.code) ?? null, rps120: rps120.get(a.code) ?? null,
      ret120: Math.round(a.ret120 * 100) / 100,
      health: a.health, light: a.light, band: a.band,
      score, signals: signalList, vetoes: a.vetoes,
    };
  });

  const clean = scored.filter(x => x.vetoes.length === 0);
  const vetoed = scored.filter(x => x.vetoes.length > 0).map(({ signals, ...rest }) => rest).sort((a, b) => b.score - a.score);
  clean.sort((a, b) => b.score - a.score || (b.rps120 || 0) - (a.rps120 || 0));
  const top = clean.slice(0, cfg.screenTopK).map((x, i) => ({ rank: i + 1, ...x }));

  const result = {
    ok: true, date: dateStr, generatedAt: new Date().toISOString(),
    method: '历史回填：三层智能选股（当日收盘后口径，无前视）',
    funnel: {
      universe: uni.count, hardFilterPassed: passed.length,
      rpsCandidates: candidates.length, analyzed: analyzed.length,
      skipped: traded - analyzed.length, vetoed: vetoed.length,
    },
    rejected, weights: SCREEN_WEIGHTS,
    config: {
      minAmountYi: cfg.screenMinAmount / 1e8, rpsMin: cfg.screenRpsMin,
      maxCandidates: cfg.screenMaxCandidates, topK: cfg.screenTopK,
      minListDays: cfg.screenMinListDays, maxChg60d: cfg.screenMaxChg60d,
    },
    top, vetoed: vetoed.slice(0, 10),
    disclaimer: '历史回填名单，仅用于前向回验研究，不构成投资建议。',
  };

  await mkdir(SCREEN_HISTORY_DIR, { recursive: true });
  await writeJson(file, result);
  return result;
}

/** 回填最近 N 个交易日（跳过已有/非交易日），返回处理列表 */
async function backfillRecentDays({ days = 20, onProgress } = {}) {
  const done = [], skipped = [];
  // 交易日来源：优先本地 K 线缓存日期（600519 等），网络失败兜底用最近文件日期
  let tradeDates = [];
  try {
    const k = await klineFromDisk('600519');
    if (k) tradeDates = k.map(c => c.date);
    if (!k) {
      const k2 = await klines('600519');
      tradeDates = k2.map(c => c.date);
    }
  } catch (e) {
    try {
      const idxK = await indexKlines('sh000001', 320);
      tradeDates = idxK.map(c => c.date);
    } catch { tradeDates = []; }
  }
  if (!tradeDates.length) return { done, skipped, error: '无法获取交易日历' };
  tradeDates = tradeDates.slice(-days - 1, -1); // 不含今天（今天可能盘中）
  for (const d of tradeDates) {
    try {
      const r = await runBackfillScreen(d);
      if (r && r.ok && r.top) { done.push(d); if (onProgress) onProgress(d, r.top.length); }
      else skipped.push(d);
    } catch (e) { skipped.push(d); console.error('[backfill]', d, e.message); }
  }
  return { done, skipped };
}

// --- 前向收益回验：T+1 收盘买入，持有 N 日 ---

/**
 * 对历史选股名单做事后收益统计
 * 买入口径：选股日 T 的次一交易日收盘价（T+1 可执行，无前视）
 * 基准：沪深300 同期收益
 */
async function validateScreenHistory() {
  await mkdir(SCREEN_HISTORY_DIR, { recursive: true });
  const files = (await readdir(SCREEN_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort();
  if (!files.length) {
    return { ok: true, message: '暂无历史选股记录，先运行一次智能选股', days: 0, horizons: [] };
  }

  let benchmark = [];
  try { benchmark = await indexKlines('sh000300', 320); } catch {}

  const buckets = FORWARD_HORIZONS.map(h => ({ h, rets: [], benchRets: [] }));
  // 信号 IC 收集器：每个信号 key 收集 (conf, 前向收益) 对（用 T+5 收益，数据不足时用 T+1）
  const icPairs = {};
  // Phase 3: 按日分组的 IC 序列（用于 IC mean/std/ICIR/正值率）
  const icByDay = {};
  // Phase 3: 各 horizon 的 (conf, ret) 对（用于 IC 衰减）
  const icByHorizon = {};
  // Phase 3: Score 分桶收集器 bucketed[h][bucketIdx] = { rets: [] }
  const bucketed = FORWARD_HORIZONS.map(h => SCORE_BUCKETS.map(() => ({ rets: [] })));
  let usedDays = 0;

  for (const f of files.slice(-60)) {
    const data = await readJson(join(SCREEN_HISTORY_DIR, f), null);
    const dateStr = f.replace('.json', '');
    if (!data?.top?.length) continue;

    // 基准窗口：idx 为选股日，idx+1 买入，idx+1+h 卖出
    let bIdx = -1;
    if (benchmark.length) bIdx = benchmark.findIndex(c => c.date === dateStr);

    let dayUsed = false;
    for (const t of data.top) {
      let k;
      try { k = await klines(t.code); } catch { continue; }
      const idx = k.findIndex(c => c.date === dateStr);
      if (idx < 0 || idx + 1 >= k.length) continue;
      const entry = k[idx + 1].close;
      if (!(entry > 0)) continue;
      // 信号 IC：T+5 收益（数据不足时退 T+1）
      const icExit5 = idx + 1 + 5;
      const icExit1 = idx + 1 + 1;
      let icRet = null;
      if (icExit5 < k.length) icRet = (k[icExit5].close / entry - 1) * 100;
      else if (icExit1 < k.length) icRet = (k[icExit1].close / entry - 1) * 100;
      if (icRet != null && Array.isArray(t.signals)) {
        for (const sig of t.signals) {
          if (sig && sig.key && Number.isFinite(sig.conf)) {
            if (!icPairs[sig.key]) icPairs[sig.key] = [];
            icPairs[sig.key].push({ conf: sig.conf, ret: icRet });
            // 按日分组
            if (!icByDay[sig.key]) icByDay[sig.key] = {};
            if (!icByDay[sig.key][dateStr]) icByDay[sig.key][dateStr] = [];
            icByDay[sig.key][dateStr].push({ conf: sig.conf, ret: icRet });
            // 各 horizon
            for (const h of FORWARD_HORIZONS) {
              const exitH = idx + 1 + h;
              if (exitH >= k.length) continue;
              if (!icByHorizon[sig.key]) icByHorizon[sig.key] = {};
              if (!icByHorizon[sig.key][h]) icByHorizon[sig.key][h] = [];
              icByHorizon[sig.key][h].push({ conf: sig.conf, ret: (k[exitH].close / entry - 1) * 100 });
            }
          }
        }
      }
      // Phase 3: Score 分桶
      for (let bi = 0; bi < SCORE_BUCKETS.length; bi++) {
        const bk = SCORE_BUCKETS[bi];
        if (t.score >= bk.min && t.score < bk.max) {
          for (let hi = 0; hi < FORWARD_HORIZONS.length; hi++) {
            const exitB = idx + 1 + FORWARD_HORIZONS[hi];
            if (exitB < k.length) bucketed[hi][bi].rets.push((k[exitB].close / entry - 1) * 100);
          }
          break;
        }
      }
      for (const b of buckets) {
        const exitIdx = idx + 1 + b.h;
        if (exitIdx >= k.length) continue;
        b.rets.push((k[exitIdx].close / entry - 1) * 100);
        dayUsed = true;
        if (bIdx >= 0) {
          const bExit = bIdx + 1 + b.h;
          if (bExit < benchmark.length && benchmark[bIdx + 1] && benchmark[bIdx + 1].close > 0) {
            b.benchRets.push((benchmark[bExit].close / benchmark[bIdx + 1].close - 1) * 100);
          }
        }
      }
    }
    if (dayUsed) usedDays++;
  }

  const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
  const horizons = buckets.map(b => {
    const mean = avg(b.rets), benchMean = avg(b.benchRets);
    return {
      h: b.h,
      samples: b.rets.length,
      avgReturn: mean == null ? null : Math.round(mean * 100) / 100,
      winRate: b.rets.length ? Math.round(b.rets.filter(x => x > 0).length / b.rets.length * 1000) / 10 : null,
      benchReturn: benchMean == null ? null : Math.round(benchMean * 100) / 100,
      excess: mean == null || benchMean == null ? null : Math.round((mean - benchMean) * 100) / 100,
    };
  });

  const totalSamples = buckets[0]?.rets.length || 0;

  // Spearman 秩相关（简化：秩均分后算 Pearson）
  function rankArray(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const rank = new Map();
    sorted.forEach((v, i) => { if (!rank.has(v)) rank.set(v, i + 1); });
    return arr.map(v => rank.get(v));
  }
  function spearman(a, b) {
    if (a.length < 5 || a.length !== b.length) return null;
    const ra = rankArray(a), rb = rankArray(b);
    const n = ra.length;
    const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
    if (!da || !db) return null;
    return num / Math.sqrt(da * db);
  }
  // 日度 IC 序列统计（Phase 3）
  function dailyICSeries(key) {
    const days = icByDay[key] || {};
    const ics = [];
    for (const [day, pairs] of Object.entries(days)) {
      if (pairs.length < 3) continue; // 单日至少 3 个信号才有意义
      const ic = spearman(pairs.map(p => p.conf), pairs.map(p => p.ret));
      if (ic != null) ics.push(ic);
    }
    return ics;
  }
  const signalICs = Object.entries(icPairs).map(([key, pairs]) => {
    const confs = pairs.map(p => p.conf), rets = pairs.map(p => p.ret);
    const ic = spearman(confs, rets);
    // 日度 IC 序列
    const dayICs = dailyICSeries(key);
    const icMean = dayICs.length ? dayICs.reduce((s, x) => s + x, 0) / dayICs.length : null;
    const icStd = dayICs.length > 1 ? Math.sqrt(dayICs.reduce((s, x) => s + Math.pow(x - icMean, 2), 0) / dayICs.length) : null;
    const icir = icMean != null && icStd ? icMean / icStd : null;
    const icPosRatio = dayICs.length ? dayICs.filter(x => x > 0).length / dayICs.length : null;
    // IC 衰减：各 horizon 的全局 IC
    const decay = FORWARD_HORIZONS.map(h => {
      const pairsH = (icByHorizon[key] || {})[h] || [];
      if (pairsH.length < 5) return { h, ic: null, samples: pairsH.length };
      const icH = spearman(pairsH.map(p => p.conf), pairsH.map(p => p.ret));
      return { h, ic: icH == null ? null : Math.round(icH * 1000) / 1000, samples: pairsH.length };
    });
    return {
      key,
      name: SIGNAL_NAMES[key] || key,
      samples: pairs.length,
      ic: ic == null ? null : Math.round(ic * 1000) / 1000,
      icMean: icMean == null ? null : Math.round(icMean * 1000) / 1000,
      icStd: icStd == null ? null : Math.round(icStd * 1000) / 1000,
      icir: icir == null ? null : Math.round(icir * 100) / 100,
      icPosRatio: icPosRatio == null ? null : Math.round(icPosRatio * 100) / 100,
      decay,
      note: ic == null ? '样本不足' : ic > 0.05 ? '信号与未来收益正相关（有效）' : ic < -0.05 ? '信号与未来收益负相关（需复核）' : '相关性弱',
    };
  }).sort((a, b) => (b.ic ?? -9) - (a.ic ?? -9));

  // Score 分桶单调性表（Phase 3）
  const scoreBuckets = FORWARD_HORIZONS.map((h, hi) => ({
    h,
    buckets: SCORE_BUCKETS.map((bk, bi) => {
      const rets = bucketed[hi][bi].rets;
      const mean = rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : null;
      return {
        label: bk.label,
        samples: rets.length,
        avgReturn: mean == null ? null : Math.round(mean * 100) / 100,
        winRate: rets.length ? Math.round(rets.filter(x => x > 0).length / rets.length * 1000) / 10 : null,
        worst: rets.length ? Math.round(Math.min(...rets) * 100) / 100 : null,
      };
    }),
  }));
  // 单调性检验：高分区平均收益是否 > 低分区（用 80+ vs 50-55 且样本充足时）
  const monotonic = [];
  for (const sb of scoreBuckets) {
    const b80 = sb.buckets.find(b => b.label === '80+');
    const b50 = sb.buckets.find(b => b.label === '50-55');
    if (b80 && b50 && b80.samples >= 5 && b50.samples >= 5 && b80.avgReturn != null && b50.avgReturn != null) {
      const diff = b80.avgReturn - b50.avgReturn;
      monotonic.push({ h: sb.h, diff: Math.round(diff * 100) / 100, verdict: diff > 0 ? '高分组收益更高（评分有效）' : diff < -0.2 ? '高分组反而更差（评分需复核）' : '差异不明显' });
    } else {
      monotonic.push({ h: sb.h, diff: null, verdict: '样本不足' });
    }
  }

  return {
    ok: true,
    days: files.length,
    usedDays,
    buyRule: '选股日次一交易日收盘价买入',
    benchmark: '沪深300',
    reliable: totalSamples >= 30,
    reliabilityNote: totalSamples >= 30
      ? `样本 ${totalSamples} 条，达到最低观察门槛，可作初步参考。`
      : `当前仅 ${totalSamples} 条样本，低于 30 条最低观察门槛，请继续积累每日选股数据。`,
    horizons,
    signalICs,
    scoreBuckets,
    monotonic,
    icNote: signalICs.length ? '信号 IC = 信号强度与未来收益的秩相关（Spearman），>0.05 表示信号有正向预测力。样本 <5 时无法计算。' : null,
    disclaimer: '历史有效性不代表未来表现，仅供参考。',
  };
}

// --- 每日自动调度 ---

/** 今天是否交易日：上证指数最新 K 线日期 == 今天 */
async function isTradingDay(dateStr) {
  try {
    const k = await indexKlines('sh000001', 10);
    return k.length > 0 && k[k.length - 1].date === dateStr;
  } catch { return false; }
}

/**
 * 到点自动跑一次选股（15:35 后、交易日、当日未跑过）
 * 服务启动时与定时器都会调用，幂等。
 */
async function maybeRunDailyScreen() {
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 15 * 60 + 35) return null;
  const today = localDateStr(now);
  const existing = await readJson(join(SCREEN_HISTORY_DIR, `${today}.json`), null);
  if (existing) return null;
  if (!(await isTradingDay(today))) return null;
  const result = await runSmartScreen({ force: true });
  console.log(`[smart-screen] ${today} 自动选股完成：Top${result.top.length}（候选 ${result.funnel.analyzed} 只）`);
  return result;
}

module.exports = {
  SCREEN_WEIGHTS, SIGNAL_NAMES, FORWARD_HORIZONS,
  daysSinceList, hardFilter, rpsMap,
  computeStrategySignals, riskVetoes, analyzeCandidate, finalizeScore,
  runSmartScreen, loadScreenHistoryList, validateScreenHistory,
  runBackfillScreen, backfillRecentDays, analyzeWithKlines,
  isTradingDay, maybeRunDailyScreen, localDateStr,
};
