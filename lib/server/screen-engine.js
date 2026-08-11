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
const { klines, indexKlines } = require('./market');
const { reportFrom } = require('./report');
const { getUniverse } = require('./universe');

// 各策略信号权重（v1 手工设定，后续用 RankIC 体检数据校准）
const SCREEN_WEIGHTS = { trend: 0.30, rps: 0.25, breakout: 0.20, volcross: 0.15, pattern: 0.10 };
const SIGNAL_NAMES = { trend: '趋势动量', rps: 'RPS强度', breakout: '20日突破', volcross: '量价金叉', pattern: '形态共振' };
const FORWARD_HORIZONS = [1, 5, 10];

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
async function analyzeCandidate(stock, cfg) {
  let k;
  try { k = await klines(stock.code); }
  catch { return { code: stock.code, name: stock.name, skip: 'K线获取失败' }; }
  if (!k || k.length < 70) return { code: stock.code, name: stock.name, skip: 'K线不足70根' };

  const quoteLike = { code: stock.code, name: stock.name, price: stock.price, changePct: stock.changePct, volumeRatio: stock.volumeRatio };
  const report = reportFrom(quoteLike, k, cfg);
  const signals = computeStrategySignals(k, cfg, report);
  const vetoes = riskVetoes(k, report);

  const closes = k.map(c => c.close);
  const base = closes.length >= 121 ? closes[closes.length - 121] : closes[0];
  const ret120 = base > 0 ? (closes[closes.length - 1] / base - 1) * 100 : 0;

  return {
    code: stock.code, name: stock.name, price: stock.price, changePct: stock.changePct,
    amount: stock.amount, turnoverPct: stock.turnoverPct, volumeRatio: stock.volumeRatio,
    health: report.health, light: report.light, band: report.band,
    ret120, signals, vetoes, skip: null,
  };
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
  isTradingDay, maybeRunDailyScreen, localDateStr,
};
