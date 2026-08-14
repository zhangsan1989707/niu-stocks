/**
 * 分数区间历史表现（score-lookback）
 * 基于 screen-history 选股名单（含 health 分），统计各分数区间 T+1/5/10 收益与胜率
 * 缓存至 data/score-lookback.json，体检页直接展示"该分数区间历史上表现如何"
 */
const { readdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { klinesSafe } = require('./market');
const { SCREEN_HISTORY_DIR } = require('./store');
const { DATA_DIR } = require('./utils');

const CACHE_FILE = join(DATA_DIR, 'score-lookback.json');
const BUCKETS = [[0, 50, '<50'], [50, 60, '50-60'], [60, 70, '60-70'], [70, 80, '70-80'], [80, 101, '80+']];

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

let cached = null;
async function computeScoreLookback(force = false) {
  const now = Date.now();
  if (!force && cached && now - cached.ts < 12 * 3600 * 1000) return cached;
  try {
    if (!force && now - JSON.parse(await readFile(CACHE_FILE, 'utf8')).ts < 12 * 3600 * 1000) {
      cached = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
      return cached;
    }
  } catch {}

  let files = [];
  try { files = (await readdir(SCREEN_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort(); } catch {}
  const samples = [];
  const seen = new Set();
  for (const f of files) {
    const dateStr = f.replace('.json', '');
    let data;
    try { data = JSON.parse(await readFile(join(SCREEN_HISTORY_DIR, f), 'utf8')); } catch { continue; }
    for (const t of (data.top || [])) {
      if (seen.has(t.code + dateStr) || t.health == null) continue;
      seen.add(t.code + dateStr);
      try {
        const k = await klinesSafe(t.code);
        const idx = k.findIndex(c => c.date === dateStr);
        if (idx < 0 || idx + 10 >= k.length) continue;
        const base = k[idx].close;
        const ret = d => (k[idx + d].close / base - 1) * 100;
        samples.push({ health: Number(t.health), ret1: ret(1), ret5: ret(5), ret10: ret(10) });
      } catch {}
    }
  }

  const buckets = BUCKETS.map(([lo, hi, label]) => {
    const group = samples.filter(s => s.health >= lo && s.health < hi);
    const stat = d => {
      if (!group.length) return null;
      const vals = group.map(s => s['ret' + d]);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const win = vals.filter(v => v > 0).length / vals.length * 100;
      return { avg: Math.round(avg * 100) / 100, win: Math.round(win * 100) / 100, n: group.length };
    };
    return { label, n: group.length, d1: stat(1), d5: stat(5), d10: stat(10) };
  }).filter(b => b.n > 0);

  const ic = {
    d1: spearman(samples.map(s => s.health), samples.map(s => s.ret1)),
    d5: spearman(samples.map(s => s.health), samples.map(s => s.ret5)),
    d10: spearman(samples.map(s => s.health), samples.map(s => s.ret10)),
  };

  const out = { ok: true, ts: now, generatedAt: new Date(now).toISOString(), samples: samples.length, buckets, ic };
  cached = out;
  try { await writeFile(CACHE_FILE, JSON.stringify(out)); } catch {}
  return out;
}

module.exports = { computeScoreLookback };
