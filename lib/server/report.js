/**
 * 报告引擎层
 * 从 server.js 提取的 reportFrom / stockReport / 持仓计算 / 回测
 */

const { join } = require('node:path');
const { readFile } = require('node:fs/promises');
const { average, ema } = require('../helpers');
const { detectPatterns } = require('../patterns');
const { murphyIndicators } = require('../indicators');
const { detectClassicPatterns } = require('../classic-patterns');
const { number, DATA_DIR } = require('./utils');
const { loadConfig } = require('./store');
const { quote, klines, recordCheckHistory, checkHistory } = require('./market');
const { multiPeriodAnalysis } = require('./multi-period');

/**
 * 核心体检报告生成
 */
function reportFrom(quoteData, candles, config = {}) {
  const cfg = { macdFast: 6, macdSlow: 13, macdSignal: 5, volumeRatioThreshold: 1.5, healthScoreThreshold: 60, ma60Period: 60, ...config };
  const closes = candles.map(x => x.close), volumes = candles.map(x => x.volume), last = candles.at(-1);
  const ma20 = average(closes, 20), ma60 = average(closes, cfg.ma60Period), ma5 = average(closes, 5);

  const ma60Series = closes.map((_, i) => i >= cfg.ma60Period - 1 ? average(closes.slice(0, i + 1), cfg.ma60Period) : null);

  const fast = ema(closes, cfg.macdFast), slow = ema(closes, cfg.macdSlow), macd = fast.map((x, i) => x - slow[i]), signal = ema(macd, cfg.macdSignal);
  const diff = macd.at(-1), dea = signal.at(-1);
  const changes = closes.slice(-15).map((x, i, arr) => i ? x - arr[i - 1] : 0).slice(1);
  const gains = changes.map(x => Math.max(x, 0)), losses = changes.map(x => Math.max(-x, 0));
  const rsiVal = average(gains, 14) / (average(losses, 14) || .0001);
  const rsiValue = 100 - 100 / (1 + rsiVal);
  const recentHigh = Math.max(...candles.slice(-60).map(x => x.high));
  const support = Math.min(...candles.slice(-21, -1).map(x => x.low));
  const resistance = recentHigh;

  const patterns = detectPatterns(candles);
  const patternsClassic = detectClassicPatterns(candles);
  const murphy = murphyIndicators(candles);

  const bullish = last.close >= ma60, macdUp = diff >= dea, healthy = bullish && macdUp;
  let score = 50 + (bullish ? 15 : -15) + (last.close >= ma20 ? 8 : -8) + (macdUp ? 9 : -9) + (quoteData.volumeRatio >= cfg.volumeRatioThreshold ? 5 : 0) + (rsiValue > 70 ? -4 : rsiValue < 30 ? 2 : 0);

  let patternPts = 0;
  patterns.forEach(p => {
    if (p.dir === 'bull') patternPts += p.weight;
    else if (p.dir === 'bear') patternPts -= p.weight;
  });
  patternPts = Math.max(-12, Math.min(12, patternPts));
  score += patternPts;
  score += murphy.pts;
  score += patternsClassic.pts;

  let brokeType = null, brokeIdx = -1;
  if (last.close < support * 0.985) { brokeType = 'support'; brokeIdx = candles.length - 1; score = Math.min(score, 22); }
  else if (last.close < ma60 && candles.length >= 2 && candles[candles.length - 2].close >= ma60) { brokeType = 'ma60'; brokeIdx = candles.length - 1; }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const light = score >= 65 ? 'green' : score >= 45 ? 'yellow' : 'red';
  const band = score >= 80 ? '健康' : score >= 65 ? '偏好' : score >= 45 ? '中性' : score >= 25 ? '偏弱' : '危险';
  const trend = last.close >= ma60 ? (ma5 >= ma20 ? 'up' : 'range') : (last.close < ma20 ? 'down' : 'range');

  const scan_dims = [
    { key: 'trend', name: '趋势背景', note: bullish ? '上升趋势' : '趋势偏弱' },
    { key: 'ma60', name: '生命线 MA60', note: `${last.close >= ma60 ? '站上' : '跌破'} ${ma60.toFixed(2)}` },
    { key: 'support', name: '关键支撑', note: `${support.toFixed(2)} ${last.close >= support ? '暂未跌破' : '已跌破'}` },
    { key: 'ma5_ma20', name: 'MA5 / MA20', note: ma5 >= ma20 ? '短期均线偏多' : '短期均线偏空' },
    { key: 'volume', name: '成交量 / 量价', note: `量比 ${quoteData.volumeRatio.toFixed(2)}（≥${cfg.volumeRatioThreshold} 算放量）` },
    { key: 'macd', name: 'MACD 金死叉', note: macdUp ? '金叉 · 多头占优' : '死叉 · 需谨慎' },
    { key: 'rsi', name: 'RSI / MACD 背离', note: `${rsiValue.toFixed(1)} · ${rsiValue > 70 ? '超买提醒' : rsiValue < 30 ? '超卖关注' : '无明显背离'}` },
    { key: 'polarity', name: '极性转换', note: last.close >= ma20 ? '无' : '均线下方，观察反压' },
    { key: 'fake', name: '假摔 / 假突破', note: last.low < support && last.close >= support ? '疑似假摔，等待确认' : '未识别' },
    { key: 'murphy', name: '墨菲摆动指标组', note: `${murphy.lean}（${murphy.factors.length} 项）` },
    { key: 'patterns', name: '经典图表形态', note: patternsClassic.patterns.length ? `命中 ${patternsClassic.patterns.length} 种经典图表形态` : '未识别明显形态' },
    { key: 'drawdown', name: '60日高点回撤', note: `${((1 - last.close / recentHigh) * 100).toFixed(1)}%` },
  ];

  const factors = [];
  factors.push({ dim: 'trend', pts: bullish ? 15 : -15, text: `${bullish ? '站上' : '跌破'} MA60 ${ma60.toFixed(2)}` });
  factors.push({ dim: 'ma5_ma20', pts: last.close >= ma20 ? 8 : -8, text: `收盘价 ${last.close.toFixed(2)} ${last.close >= ma20 ? '≥' : '<'} MA20 ${ma20.toFixed(2)}` });
  factors.push({ dim: 'macd', pts: macdUp ? 9 : -9, text: macdUp ? 'MACD 金叉' : 'MACD 死叉' });
  if (quoteData.volumeRatio >= cfg.volumeRatioThreshold) factors.push({ dim: 'volume', pts: 5, text: `量比 ${quoteData.volumeRatio.toFixed(2)} 放量` });
  if (rsiValue > 70) factors.push({ dim: 'rsi', pts: -4, text: `RSI ${rsiValue.toFixed(1)} 超买` });
  else if (rsiValue < 30) factors.push({ dim: 'rsi', pts: 2, text: `RSI ${rsiValue.toFixed(1)} 超卖` });
  if (patternPts !== 0) factors.push({ dim: 'pattern', pts: patternPts, text: `蜡烛形态 ${patterns.length} 种命中` });
  if (murphy.pts !== 0) factors.push({ dim: 'murphy', pts: murphy.pts, text: `摆动指标组 ${murphy.lean}` });
  if (patternsClassic.pts !== 0) factors.push({ dim: 'classic_pattern', pts: patternsClassic.pts, text: `经典图表形态 ${patternsClassic.patterns.length} 种命中` });

  const patBullW = patterns.filter(p => p.dir === 'bull').reduce((s, p) => s + p.weight, 0);
  const patBearW = patterns.filter(p => p.dir === 'bear').reduce((s, p) => s + p.weight, 0);
  const L1 = patBullW > patBearW ? '偏多' : patBearW > patBullW ? '偏空' : '中性';
  const L2 = brokeType ? '偏空·已破位' : trend === 'up' ? '偏多' : trend === 'down' ? '偏空' : '中性·震荡';
  const L3 = murphy.lean;
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
    score, status: band,
    metrics: { ma20, ma60, ma5, macd: diff, signal: dea, rsi: rsiValue, support, recentHigh },
    checks: scan_dims.map(d => [d.name, d.note, !d.note.includes('跌破') && !d.note.includes('偏弱') && !d.note.includes('死叉') && !d.note.includes('超买') && !d.note.includes('已跌破') && !d.note.includes('偏空')]),
  };
}

async function stockReport(code) {
  const normalized = String(code).replace(/\D/g, '').padStart(6, '0');
  const [q, k] = await Promise.all([quote(normalized), klines(normalized)]);
  const cfg = await loadConfig();
  const report = reportFrom(q, k, cfg);
  report.multiPeriod = multiPeriodAnalysis(k);
  return report;
}

async function stockReportWithHistory(code) {
  const result = await stockReport(code);
  await recordCheckHistory(result);
  return result;
}

// --- 持仓计算 ---
function calcPosition(pos, price) {
  const cost = pos.shares * pos.costPrice;
  const marketValue = price != null ? pos.shares * price : cost;
  const pnl = price != null ? marketValue - cost : 0;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  return { cost, marketValue, pnl, pnlPct };
}

// --- 回测引擎（P2-1: 消除前视偏差）---
// 核心修正：信号在第 i 日收盘后生成，交易在第 i+1 日开盘价执行
// 这样信号生成时只使用已知数据，成交价是次日开盘（实际可执行价）
async function runBacktest(code, days) {
  const k = await klines(code);
  const slice = k.slice(-days);
  const cfg = await loadConfig();

  const feeRate = 0.001, slippageRate = 0.0005;
  let signalCount = 0, closedTrades = 0, wins = 0, equity = 1, maxDrawdown = 0;
  let peak = -Infinity, entryPrice = null, firstEntryPrice = null;
  const signalLog = [];

  for (let i = 30; i < slice.length - 1; i++) {
    // 只使用 [0, i] 的数据计算指标（不含未来数据）
    const closes = slice.slice(0, i + 1).map(c => c.close);
    const ma60 = average(closes, Math.min(cfg.ma60Period, closes.length));

    // 使用配置中的 MACD 参数
    const fast = ema(closes, cfg.macdFast);
    const slow = ema(closes, cfg.macdSlow);
    const macd = fast.map((x, j) => x - slow[j]);
    const signal = ema(macd, cfg.macdSignal);

    const isGolden = macd[i] >= signal[i];
    const prevGolden = macd[i - 1] < signal[i - 1];

    // 信号在 Day i 收盘后确认 → 次日开盘价执行
    const nextDay = slice[i + 1];

    // 金叉买入
    if (isGolden && prevGolden && closes[i] >= ma60 && !entryPrice) {
      signalCount++;
      entryPrice = nextDay.open * (1 + feeRate + slippageRate);
      if (firstEntryPrice == null) firstEntryPrice = entryPrice;
      peak = entryPrice;
      signalLog.push({ date: nextDay.date, action: 'buy', price: entryPrice });
    }

    // 死叉卖出
    if (!isGolden && !prevGolden && entryPrice) {
      const exitPrice = nextDay.open * (1 - feeRate - slippageRate);
      const ret = (exitPrice - entryPrice) / entryPrice;
      equity *= 1 + ret;
      closedTrades++;
      if (ret > 0) wins++;
      signalLog.push({ date: nextDay.date, action: 'sell', price: exitPrice, profit: ret * 100 });
      entryPrice = null;
    }

    // 最大回撤：只在持仓期间计算
    if (entryPrice) {
      const cur = nextDay.close;
      if (cur > peak) peak = cur;
      const dd = (cur - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
  }

  // 如果回测结束时仍有持仓，以最后一日收盘价平仓
  if (entryPrice) {
    const lastClose = slice[slice.length - 1].close * (1 - feeRate - slippageRate);
    const ret = (lastClose - entryPrice) / entryPrice;
    equity *= 1 + ret;
    closedTrades++;
    if (ret > 0) wins++;
    signalLog.push({ date: slice[slice.length - 1].date, action: 'sell', price: lastClose, profit: ret * 100 });
    const cur = lastClose;
    if (cur > peak) peak = cur;
    const dd = (cur - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  return {
    ok: true, code, days: slice.length,
    signals: signalLog,
    signalCount,
    closedTrades,
    wins,
    winRate: closedTrades > 0 ? Math.round(wins / closedTrades * 1000) / 10 : 0,
    totalReturn: Math.round((equity - 1) * 10000) / 100,
    benchmarkReturn: firstEntryPrice == null ? null : Math.round((((slice.at(-1).close * (1 - feeRate - slippageRate)) / firstEntryPrice) - 1) * 10000) / 100,
    feeRate: feeRate * 100,
    slippageRate: slippageRate * 100,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
    disclaimer: '回测信号在收盘后生成，次日开盘价执行，已计入每次成交 0.10% 费用和 0.05% 滑点。仍受幸存者偏差、停牌及数据质量影响，仅供参考。',
  };
}

module.exports = { reportFrom, stockReport, stockReportWithHistory, calcPosition, runBacktest, checkHistory };
