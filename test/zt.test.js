const test = require('node:test');
const assert = require('node:assert/strict');
const { boardOf, fmtTime } = require('../lib/server/zt-pool');

test('P2-14: boardOf 板块标识正确', () => {
  assert.equal(boardOf('688981'), '科创板20cm');
  assert.equal(boardOf('300750'), '创业板20cm');
  assert.equal(boardOf('301602'), '创业板20cm');
  assert.equal(boardOf('920856'), '北交所30cm');
  assert.equal(boardOf('000001'), '深主板10cm');
  assert.equal(boardOf('002594'), '深主板10cm');
  assert.equal(boardOf('600519'), '沪主板10cm');
  assert.equal(boardOf('601138'), '沪主板10cm');
  assert.equal(boardOf('603197'), '沪主板10cm');
  assert.equal(boardOf('605000'), '沪主板10cm');
  assert.equal(boardOf('123456'), '其他');
});

test('P2-14: fmtTime 封板时间格式化', () => {
  assert.equal(fmtTime(92500), '09:25');
  assert.equal(fmtTime(145830), '14:58');
  assert.equal(fmtTime(0), '—');
  assert.equal(fmtTime(null), '—');
  assert.equal(fmtTime(''), '—');
});

test('P2-14: 涨停池数据完整（真实接口）', async () => {
  const { getZTPool } = require('../lib/server/zt-pool');
  const r = await getZTPool();
  assert.equal(r.ok, true);
  assert.ok(r.total > 0, '应有涨停股');
  assert.ok(r.pool.length > 0);
  const first = r.pool[0];
  ['code', 'name', 'board', 'lbc', 'zdp', 'price', 'firstTime'].forEach(k => {
    assert.ok(first[k] !== undefined && first[k] !== null, `字段 ${k} 应存在`);
  });
  assert.ok(r.summary.maxLbc >= 1, '最高连板 >= 1');
  // 排序：连板数降序
  for (let i = 1; i < Math.min(10, r.pool.length); i++) {
    assert.ok(r.pool[i - 1].lbc >= r.pool[i].lbc, '应按连板数降序');
  }
});
