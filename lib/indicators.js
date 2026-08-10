/**
 * 墨菲摆动指标组（7 项）
 * 基于《金融市场技术分析》(John J. Murphy)
 */

const { average, ema } = require('./helpers');

/**
 * KDJ 随机指标
 * @param {number[]} highs - 最高价序列
 * @param {number[]} lows - 最低价序列
 * @param {number[]} closes - 收盘价序列
 * @param {number} period - 周期，默认 9
 * @returns {{k:number,d:number,j:number}}
 */
function kdj(highs, lows, closes, period = 9) {
  if (closes.length < period) return { k: 50, d: 50, j: 50 };
  const start = closes.length - period;
  const highestHigh = Math.max(...highs.slice(start));
  const lowestLow = Math.min(...lows.slice(start));
  const rsv = highestHigh === lowestLow
    ? 50
    : ((closes[closes.length - 1] - lowestLow) / (highestHigh - lowestLow)) * 100;

  // 用 EMA(3) 平滑 K 和 D
  // 简化：取最近 3 个 RSV 的加权平均
  const rsvs = [];
  for (let i = Math.max(0, closes.length - period - 2); i < closes.length; i++) {
    const s = Math.max(0, i - period + 1);
    const hh = Math.max(...highs.slice(s, i + 1));
    const ll = Math.min(...lows.slice(s, i + 1));
    rsvs.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const k = rsvs.length >= 3
    ? (rsvs[rsvs.length - 1] * 2 + rsvs[rsvs.length - 2] * 1 + rsvs[rsvs.length - 3]) / 3
    : rsvs[rsvs.length - 1] || rsv;
  // D = SMA(K, 3) 简化
  const ks = [];
  for (let i = 0; i < rsvs.length; i++) {
    const sub = rsvs.slice(Math.max(0, i - 2), i + 1);
    ks.push(sub.reduce((a, b) => a + b, 0) / sub.length);
  }
  const d = ks[ks.length - 1] || 50;
  const j = 3 * k - 2 * d;
  return { k, d, j };
}

/**
 * RSI 相对强弱指标
 * @param {number[]} closes - 收盘价序列
 * @param {number} period - 周期
 * @returns {number}
 */
function rsi(closes, period) {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(-period - 1).map((x, i, arr) => i ? x - arr[i - 1] : 0).slice(1);
  const gains = changes.map(x => Math.max(x, 0));
  const losses = changes.map(x => Math.max(-x, 0));
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * WR 威廉指标
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period - 默认 14
 * @returns {number}
 */
function wr(highs, lows, closes, period = 14) {
  if (closes.length < period) return -50;
  const start = closes.length - period;
  const highestHigh = Math.max(...highs.slice(start));
  const lowestLow = Math.min(...lows.slice(start));
  if (highestHigh === lowestLow) return -50;
  return ((highestHigh - closes[closes.length - 1]) / (highestHigh - lowestLow)) * -100;
}

/**
 * CCI 商品通道指标
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period - 默认 14
 * @returns {number}
 */
function cci(highs, lows, closes, period = 14) {
  if (closes.length < period) return 0;
  const tps = [];
  for (let i = Math.max(0, closes.length - period); i < closes.length; i++) {
    tps.push((highs[i] + lows[i] + closes[i]) / 3);
  }
  const sma = tps.reduce((a, b) => a + b, 0) / tps.length;
  const meanDev = tps.reduce((a, b) => a + Math.abs(b - sma), 0) / tps.length;
  if (meanDev === 0) return 0;
  const tp = tps[tps.length - 1];
  return (tp - sma) / (0.015 * meanDev);
}

/**
 * 计算墨菲摆动指标组（7 项）
 * @param {Array<{open,close,high,low,volume}>} candles
 * @returns {{ok:boolean, factors:Array, lean:string, pts:number}}
 */
function murphyIndicators(candles) {
  if (!candles || candles.length < 14) {
    return { ok: false, factors: [], lean: '中性', pts: 0 };
  }

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const rsi6 = rsi(closes, 6);
  const rsi12 = rsi(closes, 12);
  const { k, d, j } = kdj(highs, lows, closes, 9);
  const wrVal = wr(highs, lows, closes, 14);
  const cciVal = cci(highs, lows, closes, 14);

  const factors = [];
  let pts = 0;

  // KDJ-K
  let kDir = 'neutral', kState = '中性';
  if (k > 80) { kDir = 'bear'; kState = '超买区域'; pts -= 1; }
  else if (k < 20) { kDir = 'bull'; kState = '超卖区域'; pts += 1; }
  else if (k > 50) { kDir = 'bull'; kState = '偏多'; pts += 0.5; }
  else { kDir = 'bear'; kState = '偏空'; pts -= 0.5; }
  factors.push({ name: 'KDJ-K', dir: kDir, pts: Math.round(kDir === 'neutral' ? 0 : (k > 80 ? -1 : k < 20 ? 1 : k > 50 ? 1 : -1)), state: `${k.toFixed(1)} ${kState}`, plain: `K=${k.toFixed(1)}，${kState}` });

  // KDJ-D
  let dDir = 'neutral', dState = '中性';
  if (d > 80) { dDir = 'bear'; dState = '超买'; }
  else if (d < 20) { dDir = 'bull'; dState = '超卖'; }
  else if (d > 50) { dDir = 'bull'; dState = '偏多'; }
  else { dDir = 'bear'; dState = '偏空'; }
  factors.push({ name: 'KDJ-D', dir: dDir, pts: 0, state: `${d.toFixed(1)} ${dState}`, plain: `D=${d.toFixed(1)}，${dState}` });

  // KDJ-J
  let jDir = 'neutral', jState = '中性';
  if (j > 100) { jDir = 'bear'; jState = '超买 extremes'; }
  else if (j < 0) { jDir = 'bull'; jState = '超卖 extremes'; }
  else if (j > 50) { jDir = 'bull'; jState = '偏多'; }
  else if (j < 50) { jDir = 'bear'; jState = '偏空'; }
  factors.push({ name: 'KDJ-J', dir: jDir, pts: 0, state: `${j.toFixed(1)} ${jState}`, plain: `J=${j.toFixed(1)}，${jState}` });

  // RSI-6
  let r6Dir = 'neutral', r6State = '中性';
  if (rsi6 > 80) { r6Dir = 'bear'; r6State = '超买'; pts -= 1; }
  else if (rsi6 < 20) { r6Dir = 'bull'; r6State = '超卖'; pts += 1; }
  else if (rsi6 > 50) { r6Dir = 'bull'; r6State = '偏多'; pts += 0.5; }
  else { r6Dir = 'bear'; r6State = '偏空'; pts -= 0.5; }
  factors.push({ name: 'RSI-6', dir: r6Dir, pts: Math.round(rsi6 > 80 ? -1 : rsi6 < 20 ? 1 : rsi6 > 50 ? 1 : -1), state: `${rsi6.toFixed(1)} ${r6State}`, plain: `RSI6=${rsi6.toFixed(1)}，${r6State}` });

  // RSI-12
  let r12Dir = 'neutral', r12State = '中性';
  if (rsi12 > 70) { r12Dir = 'bear'; r12State = '超买'; }
  else if (rsi12 < 30) { r12Dir = 'bull'; r12State = '超卖'; }
  else if (rsi12 > 50) { r12Dir = 'bull'; r12State = '偏多'; }
  else { r12Dir = 'bear'; r12State = '偏空'; }
  factors.push({ name: 'RSI-12', dir: r12Dir, pts: 0, state: `${rsi12.toFixed(1)} ${r12State}`, plain: `RSI12=${rsi12.toFixed(1)}，${r12State}` });

  // WR
  let wrDir = 'neutral', wrState = '中性';
  if (wrVal < -80) { wrDir = 'bull'; wrState = '超卖'; pts += 1; }
  else if (wrVal > -20) { wrDir = 'bear'; wrState = '超买'; pts -= 1; }
  else if (wrVal > -50) { wrDir = 'bear'; wrState = '偏空'; }
  else { wrDir = 'bull'; wrState = '偏多'; }
  factors.push({ name: 'WR', dir: wrDir, pts: Math.round(wrVal < -80 ? 1 : wrVal > -20 ? -1 : 0), state: `${wrVal.toFixed(1)} ${wrState}`, plain: `WR=${wrVal.toFixed(1)}，${wrState}` });

  // CCI
  let cciDir = 'neutral', cciState = '中性';
  if (cciVal > 100) { cciDir = 'bull'; cciState = '强势'; pts += 1; }
  else if (cciVal < -100) { cciDir = 'bear'; cciState = '弱势'; pts -= 1; }
  else if (cciVal > 0) { cciDir = 'bull'; cciState = '偏多'; }
  else { cciDir = 'bear'; cciState = '偏空'; }
  factors.push({ name: 'CCI', dir: cciDir, pts: Math.round(cciVal > 100 ? 1 : cciVal < -100 ? -1 : 0), state: `${cciVal.toFixed(1)} ${cciState}`, plain: `CCI=${cciVal.toFixed(1)}，${cciState}` });

  // 组内封顶 ±10
  pts = Math.max(-10, Math.min(10, Math.round(pts)));

  // lean 判断：只看非超买超卖的偏多/偏空方向
  const leanBulls = factors.filter(f => f.dir === 'bull' && !f.state.includes('超买') && !f.state.includes('超卖')).length;
  const leanBears = factors.filter(f => f.dir === 'bear' && !f.state.includes('超买') && !f.state.includes('超卖')).length;
  const lean = leanBulls > leanBears + 1 ? '偏多' : leanBears > leanBulls + 1 ? '偏空' : '中性';

  return { ok: true, factors, lean, pts };
}

module.exports = { murphyIndicators, kdj, rsi, wr, cci };
