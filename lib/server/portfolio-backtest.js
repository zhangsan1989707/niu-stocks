/**
 * Phase 5: 组合级回测 + 市场状态（Market Regime）
 *
 * 组合回测基于历史智能选股 TopK 名单（screen-history 落盘）：
 *   - 每个选股日 T：取 Top N 名单，等权
 *   - T+1 开盘价买入（开盘涨幅 >= 9.8% 视为涨停无法买入，跳过）
 *   - 持有 holdDays 个交易日后 T+1 开盘卖出（开盘跌幅 >= 9.8% 视为跌停无法卖出，顺延）
 *   - 计入佣金/印花税/滑点
 * 数据不足时提示，随每日落盘自动积累。
 *
 * Market Regime：沪深300 vs MA60 + MA60 斜率 + 近 5 日动量 → 牛/震荡/熊
 */

const { klines, indexKlines, indexKlinesFromDisk } = require('./market');
const { readJson, SCREEN_HISTORY_DIR } = require('./store');
const { readdir } = require('node:fs/promises');
const { join } = require('node:path');

const FEE_RATE = 0.001;      // 佣金（可配）
const STAMP_TAX = 0.0005;    // 印花税（卖出，可配）
const SLIPPAGE = 0.0005;     // 滑点（可配）
const LOT_SIZE = 100;        // A 股整手

function limitPct(code, name = '') {
  if (/ST/i.test(name)) return 4.8;
  if (/^(300|301|688)/.test(code)) return 19.8;
  if (/^[48]/.test(code)) return 29.8;
  return 9.8;
}

/**
 * 组合回测 v2（现金+持仓法，支持 A 股真实规则）
 * @param {Object} opts
 *   topN 每期买入只数 | holdDays 持有期数
 *   initialCapital 初始资金（默认 10 万）
 *   weightMode 'equal'等权 | 'score'按入选分加权
 *   commissionRate 佣金率 | minCommission 最低佣金(元) | stampTaxRate 印花税 | slippageRate 滑点
 *   useLimits 涨跌停限制开关 | benchmark 'sh000300'|'sh000001'
 */
async function runPortfolioBacktest({
  topN = 10, holdDays = 5, initialCapital = 100000,
  weightMode = 'equal', commissionRate = 0.001, minCommission = 5,
  stampTaxRate = 0.0005, slippageRate = 0.0005, useLimits = true,
  benchmark = 'sh000300',
} = {}) {
  await readJson(join(SCREEN_HISTORY_DIR, '.keep'), null).catch(() => {});
  let files = [];
  try { files = (await readdir(SCREEN_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort(); } catch {}

  if (!files.length) {
    return { ok: true, message: '暂无历史选股名单，先运行一次智能选股', trades: [], days: 0 };
  }

  const trades = [];
  const openPos = [];      // { code, name, entryDate, entryPrice, shares, pickIdx, weight }
  const dailyValues = [];  // 每日组合净值
  const drawdownCurve = [];
  let cash = initialCapital;

  // 基准曲线
  let benchmarkK = [];
  try {
    const { indexKlinesFromDisk, indexKlines } = require('./market');
    benchmarkK = (await indexKlinesFromDisk(benchmark, 320)) || (await indexKlines(benchmark, 320)) || [];
  } catch {}

  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const dateStr = f.replace('.json', '');
    const data = await readJson(join(SCREEN_HISTORY_DIR, f), null);
    if (!data?.top?.length) continue;

    const today = data.top.slice(0, topN);

    // 1. 卖出到期持仓（持有 holdDays 期后，T+1 开盘卖出）
    const stillOpen = [];
    for (const pos of openPos) {
      if (dateStr >= pos.exitDate) {
        try {
          const k = (await klines(pos.code));
          const idx = k.findIndex(c => c.date === pos.exitDate);
          if (idx >= 0) {
            const openP = k[idx].open;
            const prevClose = k[idx - 1]?.close;
            if (useLimits && prevClose > 0 && (openP - prevClose) / prevClose * 100 <= -limitPct(pos.code, pos.name)) {
              stillOpen.push(pos); continue; // 跌停无法卖出，顺延
            }
            const sellPrice = openP * (1 - slippageRate);
            const amount = sellPrice * pos.shares;
            const fee = Math.max(amount * commissionRate, minCommission);
            const tax = amount * stampTaxRate;
            const proceeds = amount - fee - tax;
            const ret = (sellPrice - pos.entryPrice) / pos.entryPrice * 100;
            cash += proceeds;
            trades.push({ code: pos.code, name: pos.name, entryDate: pos.entryDate, exitDate: k[idx].date, entryPrice: Math.round(pos.entryPrice * 100) / 100, exitPrice: Math.round(sellPrice * 100) / 100, shares: pos.shares, ret: Math.round(ret * 100) / 100 });
            continue;
          }
        } catch {}
        stillOpen.push(pos);
      } else stillOpen.push(pos);
    }
    openPos.length = 0;
    openPos.push(...stillOpen);

    // 2. 买入新名单（现金分配：等权 or 评分加权；整手 100 股）
    const newOnes = today.filter(t => !openPos.some(p => p.code === t.code));
    if (newOnes.length && cash > 0) {
      const totalScore = weightMode === 'score' ? newOnes.reduce((s, x) => s + (x.score || 50), 0) : newOnes.length;
      for (const t of newOnes) {
        try {
          const k = (await klines(t.code));
          const idx = k.findIndex(c => c.date === dateStr);
          if (idx < 0 || idx + 1 >= k.length) continue;
          const openP = k[idx + 1].open;
          const prevClose = k[idx].close;
          if (useLimits && prevClose > 0 && (openP - prevClose) / prevClose * 100 >= limitPct(t.code, t.name)) continue; // 涨停无法买入
          const exitIdx = idx + 1 + holdDays;
          if (exitIdx >= k.length) continue;
          const w = weightMode === 'score' ? (t.score || 50) / totalScore : 1 / totalScore;
          const budget = cash * w;
          const buyPrice = openP * (1 + slippageRate);
          const shares = Math.floor(budget / buyPrice / LOT_SIZE) * LOT_SIZE;
          if (shares <= 0) continue;
          const amount = buyPrice * shares;
          const fee = Math.max(amount * commissionRate, minCommission);
          const totalCost = amount + fee;
          if (totalCost > cash) continue;
          cash -= totalCost;
          openPos.push({ code: t.code, name: t.name, entryDate: k[idx + 1].date, exitDate: k[exitIdx].date, entryPrice: buyPrice, shares, totalCost });
        } catch {}
      }
    }

    // 3. 当日净值（持仓按收盘 mark-to-market）
    let nav = cash;
    for (const pos of openPos) {
      try {
        const k = (await klines(pos.code));
        const idx = k.findIndex(c => c.date === dateStr);
        if (pos.entryDate > dateStr) nav += pos.totalCost;
        else if (idx >= 0) nav += k[idx].close * pos.shares;
      } catch {}
    }
    dailyValues.push({ date: dateStr, nav: Math.round(nav * 100) / 100 });
  }

  // ---- 绩效指标 ----
  const n = dailyValues.length;
  const navs = dailyValues.map(d => d.nav);
  let totalReturn = null, cagr = null, sharpe = null, sortino = null, calmar = null, annVol = null, maxDD = 0;
  const drawdowns = [];
  if (n >= 2) {
    const first = navs[0], last = navs[n - 1];
    totalReturn = Math.round((last / first - 1) * 10000) / 100;
    const years = n / 252;
    if (years > 0 && last > 0 && first > 0) cagr = Math.round((Math.pow(last / first, 1 / years) - 1) * 10000) / 100;
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(navs[i] / navs[i - 1] - 1);
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / rets.length);
    const downside = rets.filter(x => x < 0);
    const downStd = downside.length ? Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / rets.length) : 0;
    annVol = std > 0 ? Math.round(std * Math.sqrt(252) * 10000) / 100 : null;
    if (std > 0) sharpe = Math.round((mean / std * Math.sqrt(252)) * 100) / 100;
    if (downStd > 0) sortino = Math.round((mean / downStd * Math.sqrt(252)) * 100) / 100;
    let peak = navs[0];
    for (const v of navs) {
      if (v > peak) peak = v;
      const dd = (v - peak) / peak * 100;
      drawdowns.push({ date: dailyValues[navs.indexOf(v)].date, dd: Math.round(dd * 100) / 100 });
      if (dd < maxDD) maxDD = dd;
    }
    maxDD = Math.round(maxDD * 100) / 100;
    if (cagr != null && maxDD < 0) calmar = Math.round((cagr / Math.abs(maxDD)) * 100) / 100;
  }

  const wins = trades.filter(t => t.ret > 0).length;
  const profits = trades.filter(t => t.ret > 0).map(t => t.ret);
  const losses = trades.filter(t => t.ret < 0).map(t => Math.abs(t.ret));
  const avgWin = profits.length ? profits.reduce((s, x) => s + x, 0) / profits.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : 0;

  // Alpha / Beta（对基准，日收益回归）
  let alpha = null, beta = null;
  if (benchmarkK.length && n >= 5) {
    const b0 = benchmarkK.findIndex(c => c.date === dailyValues[0].date);
    if (b0 >= 0) {
      const bRets = [], pRets = [];
      for (let i = 1; i < n; i++) {
        const bCur = benchmarkK.find(c => c.date === dailyValues[i].date);
        if (bCur && bCur.close > 0) {
          const bPrev = benchmarkK[b0 + i - 1] || bCur;
          bRets.push(bCur.close / bPrev.close - 1);
          pRets.push(navs[i] / navs[i - 1] - 1);
        }
      }
      if (pRets.length >= 5) {
        const pm = pRets.reduce((s, x) => s + x, 0) / pRets.length;
        const bm = bRets.reduce((s, x) => s + x, 0) / bRets.length;
        let cov = 0, bvar = 0;
        for (let i = 0; i < pRets.length; i++) { cov += (pRets[i] - pm) * (bRets[i] - bm); bvar += (bRets[i] - bm) ** 2; }
        if (bvar > 0) {
          beta = Math.round((cov / bvar) * 100) / 100;
          alpha = Math.round((pm - beta * bm) * 252 * 10000) / 100; // 年化 Alpha %
        }
      }
    }
  }

  const benchStart = benchmarkK.find(c => c.date === dailyValues[0]?.date);
  const benchEnd = benchmarkK.find(c => c.date === dailyValues[n - 1]?.date);
  const benchmarkReturn = benchStart && benchEnd ? Math.round((benchEnd.close / benchStart.close - 1) * 10000) / 100 : null;
  const excessReturn = benchmarkReturn == null || totalReturn == null ? null : Math.round((totalReturn - benchmarkReturn) * 100) / 100;

  return {
    ok: true,
    topN, holdDays, initialCapital, weightMode, useLimits, benchmark,
    days: files.length,
    trades: trades.slice(-50).reverse(),
    closedTrades: trades.length,
    winRate: trades.length ? Math.round(wins / trades.length * 1000) / 10 : null,
    profitFactor: avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : null,
    totalReturn, cagr, sharpe, sortino, calmar, annVol,
    maxDrawdown: maxDD, drawdownCurve: drawdowns,
    alpha, beta, benchmarkReturn, excessReturn,
    dailyValues,
    note: files.length < 10 ? `当前仅 ${files.length} 天选股名单，样本不足，结果仅供参考；每日自动积累后回测将自动完整。` : null,
    disclaimer: '组合回测基于历史选股名单，T+1 开盘执行，整手 100 股，计入佣金/印花税/滑点，涨停无法买入、跌停无法卖出。历史有效性不代表未来表现。',
  };
}

async function getMarketRegime() {
  try {
    let k = await indexKlinesFromDisk('sh000300', 120);
    if (!k || k.length < 70) k = await indexKlines('sh000300', 120);
    if (!k || k.length < 70) return { ok: true, regime: 'unknown', note: '数据不足' };
    const closes = k.map(c => c.close);
    const last = closes[closes.length - 1];
    const ma60 = closes.slice(-60).reduce((s, x) => s + x, 0) / 60;
    const ma60Prev = closes.slice(-65, -5).reduce((s, x) => s + x, 0) / 60;
    const ma20 = closes.slice(-20).reduce((s, x) => s + x, 0) / 20;
    // 近 5 日动量
    const mom5 = (last / closes[closes.length - 6] - 1) * 100;
    // 近 10 日上涨天数
    let upDays = 0;
    for (let i = closes.length - 10; i < closes.length; i++) if (closes[i] > closes[i - 1]) upDays++;

    const aboveMa60 = last >= ma60;
    const ma60Up = ma60 > ma60Prev * 1.001;
    let regime, note;
    if (aboveMa60 && ma60Up && mom5 > 0) {
      regime = 'bull'; note = `指数站上 MA60 且 MA60 上行（近5日动量 ${mom5.toFixed(1)}%，10日${upDays}天上涨）`;
    } else if (!aboveMa60 && !ma60Up && mom5 < 0) {
      regime = 'bear'; note = `指数跌破 MA60 且 MA60 下行（近5日动量 ${mom5.toFixed(1)}%，10日${upDays}天上涨）`;
    } else {
      regime = 'range'; note = `指数在 MA60 附近震荡（${aboveMa60 ? 'MA60 上方' : 'MA60 下方'}，MA60 ${ma60Up ? '上行' : '走平/下行'}，近5日动量 ${mom5.toFixed(1)}%）`;
    }
    return {
      ok: true, regime, note,
      indexClose: Math.round(last * 100) / 100,
      ma60: Math.round(ma60 * 100) / 100,
      ma20: Math.round(ma20 * 100) / 100,
      mom5: Math.round(mom5 * 100) / 100,
      upDays10: upDays,
      updatedAt: k[k.length - 1].date,
    };
  } catch (e) {
    return { ok: false, regime: 'unknown', error: e.message };
  }
}

module.exports = { runPortfolioBacktest, getMarketRegime, limitPct };
