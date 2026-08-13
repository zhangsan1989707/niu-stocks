const test = require('node:test');
const assert = require('node:assert/strict');
const { validateScreenHistory } = require('../lib/server/screen-engine');

test('P3: validateScreenHistory 返回分桶单调性结构', async () => {
  const r = await validateScreenHistory();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.scoreBuckets), '应返回 scoreBuckets 数组');
  if (r.scoreBuckets.length) {
    const sb = r.scoreBuckets[0];
    assert.ok(sb.h >= 1, '含 horizon');
    assert.ok(Array.isArray(sb.buckets), '含 buckets');
    // 分桶标签应覆盖 50-55 到 80+
    const labels = sb.buckets.map(b => b.label);
    assert.ok(labels.includes('50-55') && labels.includes('80+'), '分桶应含 50-55 和 80+');
    sb.buckets.forEach(b => {
      assert.ok(typeof b.samples === 'number');
      assert.ok(b.avgReturn === null || typeof b.avgReturn === 'number');
      assert.ok(b.winRate === null || typeof b.winRate === 'number');
      assert.ok(b.worst === null || typeof b.worst === 'number');
    });
  }
  assert.ok(Array.isArray(r.monotonic), '应返回 monotonic 数组');
  r.monotonic.forEach(m => {
    assert.ok(m.h >= 1);
    assert.ok(m.verdict, '含判定');
  });
});

test('P3: 信号 IC 含 ICIR/正值率/衰减结构', async () => {
  const r = await validateScreenHistory();
  (r.signalICs || []).forEach(s => {
    assert.ok(s.key, '含 key');
    assert.ok(typeof s.samples === 'number');
    assert.ok(s.ic === null || typeof s.ic === 'number');
    if (s.icir != null) assert.ok(typeof s.icir === 'number');
    if (s.icPosRatio != null) assert.ok(s.icPosRatio >= 0 && s.icPosRatio <= 100);
    assert.ok(Array.isArray(s.decay), '含衰减数组');
    s.decay.forEach(d => {
      assert.ok(typeof d.h === 'number');
      assert.ok(d.ic === null || typeof d.ic === 'number');
    });
  });
});
