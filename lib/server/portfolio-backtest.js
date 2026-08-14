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

const FEE_RATE = 0.001;      // 佣金
const STAMP_TAX = 0.0005;    // 印花税（卖出）
const SLIPPAGE = 0.0005;     // 滑点
const LIMIT_PCT = 9.8;       // 涨停/跌停判定阈值（%）

/**
 * 组合回测
 * @param {Object} opts { topN: 10, holdDays: 5 }
 */
async function runPortfolioBacktest({ topN = 10, holdDays = 5 } = {}) {
  await readJson(join(SCREEN_HISTORY_DIR, '.keep'), null).catch(() => {});
  let files = [];
  try { files = (await readdir(SCREEN_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort(); } catch {}

  if (!files.length) {
    return { ok: true, message: '暂无历史选股名单，先运行一次智能选股', trades: [], days: 0 };
  }

  const trades = [];      // 已平仓交易
  const openPos = [];     // 持仓 { code, name, entryDate, entryPrice, shares, value }
  const dailyValues = []; // 每日组合净值
  let cash = 0;           // 简化：全仓等权，用净值法
  const totalDays = files.length;

  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const dateStr = f.replace('.json', '');
    const data = await readJson(join(SCREEN_HISTORY_DIR, f), null);
    if (!data?.top?.length) continue;

    const today = data.top.slice(0, topN);

    // 1. 卖出到期持仓（持有 holdDays 个选股日后卖出）
    const stillOpen = [];
    for (const pos of openPos) {
      const holdDaysCount = fi - pos.pickIdx;
      if (holdDaysCount >= holdDays) {
        // T+1 开盘卖出：pos 在 pickIdx 的名单，pickIdx+1 开盘买入，这里用今天（fi）作为卖出参考日
        // 简化口径：以"下一个交易日"开盘价卖出——用该股 K 线对齐
        try {
          const k = await klines(pos.code);
          const idx = k.findIndex(c => c.date === dateStr);
          if (idx >= 0 && idx + 1 < k.length) {
            const openP = k[idx + 1].open;
            const prevClose = k[idx].close;
            // 跌停无法卖出：开盘跌幅 >= 9.8%
            if (prevClose > 0 && (openP - prevClose) / prevClose * 100 <= -LIMIT_PCT) {
              stillOpen.push(pos); // 顺延
              continue;
            }
            const exitPrice = openP * (1 - FEE_RATE - STAMP_TAX - SLIPPAGE);
            const ret = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
            trades.push({ code: pos.code, name: pos.name, entryDate: pos.entryDate, exitDate: k[idx + 1].date, entryPrice: Math.round(pos.entryPrice * 100) / 100, exitPrice: Math.round(exitPrice * 100) / 100, ret: Math.round(ret * 100) / 100 });
            continue;
          }
        } catch {}
        stillOpen.push(pos);
      } else {
        stillOpen.push(pos);
      }
    }
    openPos.length = 0;
    openPos.push(...stillOpen);

    // 2. 买入新名单（等权：每只 = 组合价值 / topN）
    for (const t of today) {
      if (openPos.some(p => p.code === t.code)) continue;
      try {
        const k = await klines(t.code);
        const idx = k.findIndex(c => c.date === dateStr);
        if (idx < 0 || idx + 1 >= k.length) continue;
        const openP = k[idx + 1].open;
        const prevClose = k[idx].close;
        // 涨停无法买入
        if (prevClose > 0 && (openP - prevClose) / prevClose * 100 >= LIMIT_PCT) continue;
        const entryPrice = openP * (1 + FEE_RATE + SLIPPAGE);
        openPos.push({ code: t.code, name: t.name, entryDate: k[idx + 1].date, entryPrice, pickIdx: fi });
      } catch {}
    }

    // 3. 当日组合净值（持仓按当日收盘 mark-to-market，nav 初始 1.0）
    const ratios = [];
    for (const pos of openPos) {
      try {
        const k = await klines(pos.code);
        const idx = k.findIndex(c => c.date === dateStr);
        if (idx >= 0 && pos.entryPrice > 0) ratios.push(k[idx].close / pos.entryPrice);
      } catch {}
    }
    if (ratios.length) {
      dailyValues.push({ date: dateStr, nav: Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length * 10000) / 10000 });
    }
  }

  // 净值序列
  const n = dailyValues.length;
  let totalReturn = null, cagr = null, sharpe = null, maxDD = 0;
  if (n >= 2) {
    const first = dailyValues[0].nav, last = dailyValues[n - 1].nav;
    totalReturn = Math.round((last / first - 1) * 10000) / 100;
    const years = n / 252;
    if (years > 0 && last > 0) cagr = Math.round((Math.pow(last / first, 1 / years) - 1) * 10000) / 100;
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(dailyValues[i].nav / dailyValues[i - 1].nav - 1);
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / rets.length);
    if (std > 0) sharpe = Math.round((mean / std * Math.sqrt(252)) * 100) / 100;
    let peak = dailyValues[0].nav;
    for (const d of dailyValues) {
      if (d.nav > peak) peak = d.nav;
      const dd = (d.nav - peak) / peak * 100;
      if (dd < maxDD) maxDD = dd;
    }
  }

  const wins = trades.filter(t => t.ret > 0).length;
  const profits = trades.filter(t => t.ret > 0).map(t => t.ret);
  const losses = trades.filter(t => t.ret < 0).map(t => Math.abs(t.ret));
  const avgWin = profits.length ? profits.reduce((s, x) => s + x, 0) / profits.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : 0;

  return {
    ok: true,
    topN, holdDays,
    days: files.length,
    trades: trades.slice(-50).reverse(),
    closedTrades: trades.length,
    winRate: trades.length ? Math.round(wins / trades.length * 1000) / 10 : null,
    profitFactor: avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : null,
    totalReturn,
    cagr,
    sharpe,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    dailyValues,
    note: files.length < 10 ? `当前仅 ${files.length} 天选股名单，样本不足，结果仅供参考；每日自动积累后回测将自动完整。` : null,
    disclaimer: '组合回测基于历史选股名单，T+1 开盘执行，计入佣金/印花税/滑点，涨停无法买入、跌停无法卖出。历史有效性不代表未来表现。',
  };
}

/**
 * Market Regime：牛/震荡/熊
 * 依据：沪深300 vs MA60 + MA60 斜率 + 近 5 日动量
 */
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

module.exports = { runPortfolioBacktest, getMarketRegime };
