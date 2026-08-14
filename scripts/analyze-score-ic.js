/**
 * 体检评分合理性分析：对历史选股名单重算体检子项分，检验各因子 vs T+5 收益的预测力
 * 运行：node scripts/analyze-score-ic.js
 */
const { readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { klinesSafe } = require('../lib/server/market');
const { reportFrom } = require('../lib/server/report');
const { readJson, SCREEN_HISTORY_DIR } = require('../lib/server/store');

function spearman(a, b) {
  if (a.length < 10 || a.length !== b.length) return null;
  const rank = arr => {
    const sorted = [...arr].sort((x, y) => x - y);
    const m = new Map(); sorted.forEach((v, i) => { if (!m.has(v)) m.set(v, i + 1); });
    return arr.map(v => m.get(v));
  };
  const ra = rank(a), rb = rank(b);
  const n = ra.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}

async function main() {
  let files = [];
  try { files = (await readdir(SCREEN_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort(); } catch {}
  console.log(`分析 ${files.length} 天选股名单…`);

  const samples = []; // { date, code, name, score, health, factorPts: {}, ret5 }
  const seen = new Set();

  for (const f of files) {
    const dateStr = f.replace('.json', '');
    const data = await readJson(join(SCREEN_HISTORY_DIR, f), null);
    if (!data?.top?.length) continue;
    for (const t of data.top) {
      if (seen.has(t.code + dateStr)) continue;
      seen.add(t.code + dateStr);
      try {
        const k = await klinesSafe(t.code);
        const idx = k.findIndex(c => c.date === dateStr);
        if (idx < 60 || idx + 6 >= k.length) continue;
        const slice = k.slice(0, idx + 1);
        const quoteLike = { code: t.code, name: t.name, price: slice[idx].close, changePct: 0, volumeRatio: slice[idx].volume / (slice.slice(-6, -1).reduce((s, c) => s + c.volume, 0) / 5 || 1) };
        const r = reportFrom(quoteLike, slice, {});
        const factorPts = {};
        (r.factors || []).forEach(fc => { factorPts[fc.dim] = (factorPts[fc.dim] || 0) + fc.pts; });
        const ret5 = (k[idx + 5].close / slice[idx].close - 1) * 100;
        samples.push({ date: dateStr, code: t.code, name: t.name, score: r.health, health: r.health, factorPts, ret5 });
      } catch {}
    }
  }

  console.log(`有效样本: ${samples.length}`);
  if (samples.length < 30) { console.log('样本不足'); return; }

  // 各因子 IC
  const dims = ['trend', 'ma5_ma20', 'macd', 'volume', 'rsi', 'pattern', 'murphy', 'classic_pattern'];
  console.log('\n=== 因子 vs T+5 收益 (Spearman IC) ===');
  console.log('因子         样本  IC     解读');
  for (const d of dims) {
    const pairs = samples.filter(s => s.factorPts[d] !== undefined && s.factorPts[d] !== 0);
    if (pairs.length < 10) { console.log(`${d.padEnd(12)} ${pairs.length}    —     样本不足`); continue; }
    const ic = spearman(pairs.map(p => p.factorPts[d]), pairs.map(p => p.ret5));
    if (ic == null) { console.log(`${d.padEnd(12)} ${pairs.length}    —     样本不足`); continue; }
    const verdict = ic > 0.05 ? '有正向预测力' : ic < -0.05 ? '负向(需复核)' : '预测力弱';
    console.log(`${d.padEnd(12)} ${String(pairs.length).padEnd(5)} ${(ic > 0 ? '+' : '') + ic.toFixed(3)}  ${verdict}`);
  }

  // 总分 IC
  const icAll = spearman(samples.map(s => s.health), samples.map(s => s.ret5));
  console.log(`\n=== 总分(health) vs T+5 收益 ===`);
  console.log(`样本 ${samples.length} | IC ${(icAll > 0 ? '+' : '') + icAll.toFixed(3)} | ${icAll > 0.05 ? '评分有预测力' : icAll < -0.05 ? '评分与收益负相关(需重构)' : '评分预测力弱'}`);

  // 分桶
  console.log('\n=== 分数分桶 vs T+5 收益 ===');
  const buckets = [[50, 60, '50-60'], [60, 70, '60-70'], [70, 80, '70-80'], [80, 101, '80+']];
  for (const [lo, hi, label] of buckets) {
    const group = samples.filter(s => s.health >= lo && s.health < hi);
    if (!group.length) { console.log(`${label}: 无样本`); continue; }
    const avg = group.reduce((s, x) => s + x.ret5, 0) / group.length;
    const win = group.filter(x => x.ret5 > 0).length / group.length * 100;
    console.log(`${label.padEnd(6)} 样本 ${String(group.length).padEnd(5)} 平均 ${avg.toFixed(2)}%  胜率 ${win.toFixed(0)}%`);
  }

  // 各因子出现率
  console.log('\n=== 因子出现率（有多少样本该因子非零）===');
  for (const d of dims) {
    const cnt = samples.filter(s => s.factorPts[d] !== undefined && s.factorPts[d] !== 0).length;
    console.log(`${d.padEnd(14)} ${cnt}/${samples.length}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
