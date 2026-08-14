/**
 * 预取全市场 K 线到磁盘缓存（供历史回填/回测使用）
 * 运行：node scripts/prefetch-kline.js [并发数]
 */
const { getUniverse } = require('../lib/server/universe');
const { klines } = require('../lib/server/market');
const { batchRun } = require('../lib/server/utils');

const CONCURRENCY = Number(process.argv[2] || 8);

async function main() {
  console.log('加载全市场快照…');
  const uni = await getUniverse();
  const stocks = uni.stocks;
  console.log(`共 ${stocks.length} 只，并发 ${CONCURRENCY} 预取 K 线…`);

  let done = 0, failed = 0, cached = 0, t0 = Date.now();
  // 分批处理避免内存峰值
  const BATCH = 200;
  for (let b = 0; b < stocks.length; b += BATCH) {
    const batch = stocks.slice(b, b + BATCH);
    const results = await batchRun(batch, async s => {
      try {
        const k = await klines(s.code);
        if (!k || k.length < 70) return { status: 'short', code: s.code };
        return { status: 'ok', code: s.code, len: k.length };
      } catch (e) { return { status: 'fail', code: s.code, err: e.message }; }
    }, CONCURRENCY);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const v = r.value;
        if (v.status === 'ok') done++;
        else if (v.status === 'short') { done++; cached++; }
        else failed++;
      } else failed++;
    }
    const pct = ((b + batch.length) / stocks.length * 100).toFixed(0);
    const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1);
    console.log(`进度 ${pct}% (${b + batch.length}/${stocks.length}) | 成功 ${done} | 失败 ${failed} | ${rate} 只/s`);
    // 控制节奏，避免限流
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`完成：成功 ${done} / 失败 ${failed}（K线<70根计为成功 ${cached}） | 总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
}

main().catch(e => { console.error(e); process.exit(1); });
