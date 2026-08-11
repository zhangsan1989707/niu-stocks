const app = document.querySelector('#app');
const api = (path, options = {}) => fetch(`/api${path}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options }).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || '请求失败'); return data; });
const escape = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' })[x]);
const number = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function notice(message, good = false) { const node = document.createElement('div'); node.className = `toast ${good ? 'good' : ''}`; node.textContent = message; document.body.append(node); setTimeout(() => { node.classList.add('fadeout'); setTimeout(() => node.remove(), 280); }, 2300); }
function layout(title, content, intro = '') { document.title = `${title} · 牛股体检站`; app.innerHTML = `<section class="page"><h1>${title}</h1>${intro ? `<p class="intro">${intro}</p>` : ''}${content}</section>`; }
function card(title, body, cls='') { return `<article class="card ${cls}">${title ? `<h2>${title}</h2>` : ''}${body}</article>`; }
function loading() { app.innerHTML = '<section class="page"><div class="loading">正在读取市场数据…</div></section>'; }

// --- 形态标签 ---
function patternChips(patterns) {
  if (!patterns || !patterns.length) return '<span class="patchip neu">无明显形态</span>';
  return patterns.map(p => {
    const desc = PATTERN_DESC[p.name];
    const tt = desc ? `data-tooltip="${desc.meaning}" data-tooltip-signal="${desc.signal}"` : '';
    return `<span class="patchip has-tip ${p.dir === 'bull' ? 'bull' : p.dir === 'bear' ? 'bear' : 'neu'}" ${tt}>${p.name}</span>`;
  }).join('');
}

// --- 四方会诊渲染 ---
function renderConsult(c) {
  if (!c) return '';
  const row = (ic, nm, L) => {
    const cls = L.includes('偏多') ? 'green' : L.includes('偏空') ? 'red' : 'neutral';
    return `<div class="consult-row ${cls}"><span class="consult-ic">${ic} ${nm}</span><b>${escape(L)}</b></div>`;
  };
  return `<div class="consult-box ${c.cls}">
    <b>🩺 四方会诊</b>（蜡烛短线 / 趋势结构 / 摆动动量 / 图表中线，四路独立判向）
    ${row('🕯️', '蜡烛形态', c.L1)}${row('📉', '趋势·破位', c.L2)}${row('📊', '摆动指标', c.L3)}${row('📐', '图表形态', c.L4)}
    <div class="consult-sum"><b>综合：</b>${c.bulls} 方偏多 / ${c.bears} 方偏空 → ${c.verdict}</div>
  </div>`;
}

// --- 摆动指标组渲染 ---
function renderMurphy(m) {
  if (!m || !m.ok) return '';
  const rows = m.factors.map(f => {
    const cls = f.dir === 'bull' ? 'pos' : f.dir === 'bear' ? 'neg' : 'neu';
    const badge = f.pts > 0 ? '+' + f.pts : f.pts < 0 ? '' + f.pts : '·';
    const desc = INDICATOR_DESC[f.name];
    const tt = desc ? `data-tooltip="${desc.meaning}" data-tooltip-signal="${desc.hint}"` : '';
    return `<div class="dimrow2 ${cls} has-tip" ${tt}><span class="fpts ${f.pts ? '' : 'idle'}">${badge}</span><span class="dn">${escape(f.name)}</span><span class="dwhy">${escape(f.plain)}</span></div>`;
  }).join('');
  return `<div class="seclbl">摆动指标组 · 墨菲《金融市场技术分析》<span style="font-weight:400;color:#9098a9;font-size:12px">（${m.factors.length} 项，本组 ${m.pts > 0 ? '+' + m.pts : m.pts} 分）</span></div><div class="dims">${rows}</div>`;
}

// --- 经典图表形态渲染（P2-1）---
function renderClassicPatterns(cp) {
  if (!cp || !cp.ok) return '';
  if (!cp.patterns.length) return `<div class="seclbl">经典图表形态<span style="font-weight:400;color:#9098a9;font-size:12px">（本次未识别形态，计 0 分）</span></div><div class="dims"><div class="dimrow2 neu"><span class="fpts idle">·</span><span class="dn">形态扫描</span><span class="dwhy">未识别明显经典图表形态（头肩 / 双顶双底 / 三重 / 三角形 / 箱体）</span></div></div>`;
  const rows = cp.patterns.map(p => {
    const cls = p.dir === 'bull' ? 'pos' : p.dir === 'bear' ? 'neg' : 'neu';
    const badge = p.pts > 0 ? '+' + p.pts : p.pts < 0 ? '' + p.pts : '·';
    const conf = p.confirmed ? '<b style="color:#bb4339">●已确认</b> ' : '<span style="color:#9098a9">○成型中</span> ';
    const desc = CLASSIC_PATTERN_DESC[p.name];
    const tt = desc ? `data-tooltip="${desc.meaning}" data-tooltip-signal="${desc.hint}"` : '';
    return `<div class="dimrow2 ${cls} has-tip" ${tt}><span class="fpts ${p.pts ? '' : 'idle'}">${badge}</span><span class="dn">${escape(p.name)}</span><span class="dwhy">${conf}${escape(p.plain)}</span></div>`;
  }).join('');
  return `<div class="seclbl">经典图表形态<span style="font-weight:400;color:#9098a9;font-size:12px">（本组 ${cp.pts > 0 ? '+' + cp.pts : cp.pts} 分）</span></div><div class="dims">${rows}</div>`;
}

// --- 多周期分析渲染 ---
function renderMultiPeriod(mp) {
  if (!mp || !mp.sufficient) return '';
  const periodRows = (mp.periods || []).map(p => {
    if (!p.sufficient) return `<div class="dimrow2 neu"><span class="fpts idle">·</span><span class="dn">${p.label}</span><span class="dwhy">${escape(p.note || '数据不足')}</span></div>`;
    const trendCls = p.trend === '偏多' ? 'pos' : p.trend === '偏空' ? 'neg' : 'neu';
    const macdLabel = p.macdUp ? '多头' : '空头';
    return `<div class="dimrow2 ${trendCls}"><span class="fpts ${p.trend === '中性' ? 'idle' : ''}">${p.trend}</span><span class="dn">${p.label}</span><span class="dwhy">收盘 ${p.close} / MA5 ${p.ma5} / MA20 ${p.ma20} / MACD ${macdLabel} / ${p.maAlign} / RSI ${p.rsi}</span></div>`;
  }).join('');
  return `<div class="consult-box ${mp.cls}"><b>多周期共振</b>（日线 / 周线 / 月线 三个级别）${periodRows}<div class="consult-sum"><b>综合：${mp.alignment}</b>（${mp.bulls} 偏多 / ${mp.bears} 偏空 / ${mp.neutrals} 中性）${escape(mp.verdict)}</div></div>`;
}

// --- 增强 K 线图 ---
function drawChart(chart) {
  if (!chart || !chart.bars || chart.bars.length < 2) return '<div class="empty">暂无足够K线</div>';
  const bars = chart.bars, ma60 = chart.ma60 || [], support = chart.support, resistance = chart.resistance;
  const W = 760, padL = 6, padR = 46, show = bars.length;
  const priceT = 10, priceB = 196, volT = 212, volB = 270, dateY = 285, H = 298;
  const ma60v = ma60.filter(m => m != null);
  let mn = Math.min(...bars.map(b => b.l), support || Infinity, ...(ma60v.length ? ma60v : [Infinity]));
  let mx = Math.max(...bars.map(b => b.h), resistance || -Infinity, ...(ma60v.length ? ma60v : [-Infinity]));
  const pad = (mx - mn) * 0.06; mn -= pad; mx += pad;
  const plotW = W - padL - padR, step = plotW / show;
  const x = i => padL + (i + 0.5) / show * plotW;
  const y = p => priceT + (mx - p) / (mx - mn) * (priceB - priceT);
  const cw = Math.max(3, step * 0.62);
  const vmax = Math.max(1, ...bars.map(b => b.v || 0));
  const vy = v => volB - (v || 0) / vmax * (volB - volT);

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="日K线图">`;

  // 支撑线
  if (support) { const yy = y(support); s += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#d8584d" stroke-width="1.2" stroke-dasharray="5 4" opacity=".7"/><text x="${W-5}" y="${yy-4}" text-anchor="end" font-size="10" fill="#bb4339">支撑 ${support.toFixed(2)}</text>`; }
  // 压力线
  if (resistance && resistance > bars[bars.length-1].c) { const yy = y(resistance); s += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#9aa6bd" stroke-width="1" stroke-dasharray="3 4" opacity=".55"/><text x="${W-5}" y="${yy-4}" text-anchor="end" font-size="10" fill="#9aa6bd">压力 ${resistance.toFixed(2)}</text>`; }
  // MA60 生命线
  let mp = ''; ma60.forEach((m, i) => { if (m != null) mp += (mp ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(m).toFixed(1) + ' '; });
  if (mp) s += `<path d="${mp}" fill="none" stroke="#4f6cae" stroke-width="1.6" opacity=".9"/>`;

  // K 线
  bars.forEach((b, i) => {
    const up = b.c >= b.o, col = up ? '#d8584d' : '#3a9e6e', xc = x(i);
    s += `<line x1="${xc}" y1="${y(b.h)}" x2="${xc}" y2="${y(b.l)}" stroke="${col}" stroke-width="1"/>`;
    const yo = y(b.o), yc = y(b.c);
    s += `<rect x="${xc-cw/2}" y="${Math.min(yo,yc)}" width="${cw}" height="${Math.max(1.5,Math.abs(yo-yc))}" fill="${col}"/>`;
  });

  // 成交量副图
  s += `<line x1="${padL}" y1="${volT-7}" x2="${W-padR}" y2="${volT-7}" stroke="#e7e9ef" stroke-width="1"/><text x="${padL}" y="${volT+2}" font-size="9.5" fill="#9aa6bd">成交量</text>`;
  bars.forEach((b, i) => {
    const up = b.c >= b.o, col = up ? '#d8584d' : '#3a9e6e', xc = x(i);
    const vh = volB - vy(b.v);
    s += `<rect x="${(xc-cw/2).toFixed(1)}" y="${vy(b.v).toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(0.6,vh).toFixed(1)}" fill="${col}" opacity=".82"/>`;
  });
  // 5日均量线
  let vmp = '';
  bars.forEach((b, i) => {
    const lo = Math.max(0, i - 4); let sum = 0, cnt = 0;
    for (let k = lo; k <= i; k++) { sum += bars[k].v || 0; cnt++; }
    vmp += (vmp ? 'L' : 'M') + x(i).toFixed(1) + ' ' + vy(sum / cnt).toFixed(1) + ' ';
  });
  if (vmp) s += `<path d="${vmp}" fill="none" stroke="#c9922e" stroke-width="1.3" opacity=".9"/>`;

  // 日期标签
  const dix = [...new Set([0, Math.floor(show/3), Math.floor(2*show/3), show-1])];
  dix.forEach(i => { const dd = (bars[i].d || '').slice(5); if (dd) s += `<text x="${x(i).toFixed(1)}" y="${dateY}" font-size="9" fill="#9aa6bd" text-anchor="middle">${dd}</text>`; });

  // 悬停热区
  bars.forEach((b, i) => {
    const xc = x(i);
    s += `<rect x="${(xc-step/2).toFixed(1)}" y="${priceT}" width="${step.toFixed(1)}" height="${(volB-priceT).toFixed(1)}" fill="transparent" style="cursor:pointer" data-d="${b.d||''}" data-o="${b.o}" data-h="${b.h}" data-l="${b.l}" data-c="${b.c}" data-v="${b.v||0}" data-up="${b.c>=b.o?1:0}" onmousemove="barTip(event,this)" onmouseleave="hideTip()" ontouchstart="barTip(event,this)" onclick="barTip(event,this)"/>`;
  });

  return s + '</svg>';
}

function fmtVol(v) { v = +v || 0; return v >= 1e8 ? (v/1e8).toFixed(2) + '亿' : (v >= 1e4 ? Math.round(v/1e4) + '万' : '' + Math.round(v)); }
function barTip(e, el) {
  let t = document.getElementById('chartTip');
  if (!t) { t = document.createElement('div'); t.id = 'chartTip'; document.body.appendChild(t); }
  const d = el.dataset, up = d.up === '1';
  const tp = (e.touches && e.touches[0]) ? e.touches[0] : e;
  t.innerHTML = `<div style="font-weight:500;margin-bottom:3px">${d.d||''}</div><div>开 ${(+d.o).toFixed(2)}　收 <b style="color:${up?'#ff7a6e':'#5ad19a'}">${(+d.c).toFixed(2)}</b></div><div>高 ${(+d.h).toFixed(2)}　低 ${(+d.l).toFixed(2)}</div><div>量 ${fmtVol(d.v)}</div>`;
  t.style.cssText = 'position:fixed;z-index:9999;background:rgba(28,34,48,.95);color:#fff;font-size:12px;line-height:1.55;padding:7px 11px;border-radius:8px;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.22);white-space:nowrap';
  let lx = tp.clientX + 14; if (lx + 128 > window.innerWidth) lx = tp.clientX - 138;
  t.style.left = Math.max(6, lx) + 'px'; t.style.top = (tp.clientY + 14) + 'px'; t.style.display = 'block';
  if (e.touches) { clearTimeout(window._tipTO); window._tipTO = setTimeout(hideTip, 2800); }
}
function hideTip() { const t = document.getElementById('chartTip'); if (t) t.style.display = 'none'; }

// --- 体检动画 ---
const PATLIB = [['看跌吞没','空'],['看涨吞没','多'],['乌云盖顶','空'],['刺透形态','多'],['看跌反击线','空'],['看涨反击线','多'],['锤子线','多'],['上吊线','空'],['倒锤子','多'],['流星线','空'],['墓碑十字','空'],['蜻蜓十字','多'],['顶部十字星','空'],['底部十字星','多'],['十字星','中'],['高位小实体','中'],['看跌孕线','空'],['看涨孕线','多'],['十字孕线','空'],['黄昏星','空'],['启明星','多'],['三只乌鸦','空'],['白色三兵','多'],['上升三法','多'],['下降三法','空'],['平头顶','空'],['平头底','多'],['向上跳空缺口','多'],['向下跳空缺口','空']];

// 形态含义说明
const PATTERN_DESC = {
  '看跌吞没': { meaning: '大阴线完全吞没前一日小阳线，空方压倒性优势', signal: '顶部反转信号，提示上涨动能衰竭' },
  '看涨吞没': { meaning: '大阳线完全吞没前一日小阴线，多方压倒性优势', signal: '底部反转信号，提示下跌动能衰竭' },
  '乌云盖顶': { meaning: '开盘创新高后大幅回落，收盘深入前日阳线实体一半以下', signal: '顶部反转信号，高位抛压明显' },
  '刺透形态': { meaning: '开盘创新低后大幅回升，收盘深入前日阴线实体一半以上', signal: '底部反转信号，低位承接有力' },
  '看跌反击线': { meaning: '两日收盘价几乎相同，但当前阴线开盘远高于前日阳线收盘', signal: '上升受阻信号，上行动能不足' },
  '看涨反击线': { meaning: '两日收盘价几乎相同，但当前阳线开盘远低于前日阴线收盘', signal: '下跌遇支撑信号，下行动能减弱' },
  '锤子线': { meaning: '小实体在上、长下影线（≥2倍实体），下跌后出现', signal: '底部反转信号，空方打压后多方收复' },
  '上吊线': { meaning: '小实体在上、长下影线（≥2倍实体），上涨后出现', signal: '顶部警示信号，多方推高后空方反扑' },
  '倒锤子': { meaning: '小实体在下、长上影线（≥2倍实体）', signal: '底部试探信号，多方尝试推高但被压制' },
  '流星线': { meaning: '小实体在下、长上影线（≥2倍实体），上涨后出现', signal: '顶部反转信号，冲高回落说明抛压重' },
  '墓碑十字': { meaning: '开收于最低点附近，长上影线', signal: '顶部反转信号，涨停/冲高全被砸回' },
  '蜻蜓十字': { meaning: '开收于最高点附近，长下影线', signal: '底部反转信号，大跌全被拉回' },
  '顶部十字星': { meaning: '上升趋势后出现十字星（开≈收）', signal: '趋势犹豫信号，多空平衡，可能变盘' },
  '底部十字星': { meaning: '下降趋势后出现十字星（开≈收）', signal: '趋势犹豫信号，空方力竭，可能企稳' },
  '十字星': { meaning: '开盘收盘几乎相同，实体极小', signal: '犹豫/平衡信号，等待下一根K线确认方向' },
  '高位小实体': { meaning: '一段上涨后出现实体很小的K线', signal: '上行动能衰减信号，谨慎观察' },
  '看跌孕线': { meaning: '大阳线后跟一根小阴线，被完全包含在前日实体中', signal: '趋势减弱信号，多方力量消退' },
  '看涨孕线': { meaning: '大阴线后跟一根小阳线，被完全包含在前日实体中', signal: '趋势减弱信号，空方力量消退' },
  '十字孕线': { meaning: '大K线后跟一根十字星，被包含在前日实体中', signal: '强烈反转预警，趋势可能结束' },
  '黄昏星': { meaning: '阳线→小实体（跳空）→阴线深入第一根中部以下', signal: '经典顶部三K反转，上涨趋势终结信号' },
  '启明星': { meaning: '阴线→小实体（跳空）→阳线深入第一根中部以上', signal: '经典底部三K反转，下跌趋势终结信号' },
  '三只乌鸦': { meaning: '连续三根阴线，收盘价逐日递减', signal: '强烈看空信号，持续抛售' },
  '白色三兵': { meaning: '连续三根阳线，收盘价逐日递增', signal: '强烈看多信号，持续买入' },
  '上升三法': { meaning: '阳+三根小阴+阳，小阴线在第一根范围内', signal: '上涨中继信号，短暂回调后继续上攻' },
  '下降三法': { meaning: '阴+三根小阳+阴，小阳线在第一根范围内', signal: '下跌中继信号，短暂反弹后继续下跌' },
  '平头顶': { meaning: '连续两根K线最高价几乎相同', signal: '顶部受阻信号，上方有压力' },
  '平头底': { meaning: '连续两根K线最低价几乎相同', signal: '底部支撑信号，下方有承接' },
  '向上跳空缺口': { meaning: '今日最低价高于昨日最高价', signal: '强势突破信号，买方踊跃追涨' },
  '向下跳空缺口': { meaning: '今日最高价低于昨日最低价', signal: '恐慌出逃信号，卖方压倒性优势' },
};

// 指标含义说明
const INDICATOR_DESC = {
  'KDJ-K': { meaning: '随机指标快线，9日RSV的加权平均', hint: '>80超买区域有回调风险；<20超卖区域有反弹可能' },
  'KDJ-D': { meaning: '随机指标慢线，K线的3日移动平均', hint: 'K线下穿D线为死叉卖出信号；K线上穿D线为金叉买入信号' },
  'KDJ-J': { meaning: 'KDJ的J线，K和D的差值放大', hint: 'J>100极端超买；J<0极端超卖；对转折更敏感' },
  'RSI-6': { meaning: '6日相对强弱指标，短期动量', hint: '>80短期超买（追涨过热）；<20短期超卖（杀跌过度）' },
  'RSI-12': { meaning: '12日相对强弱指标，中期动量', hint: '>70中期超买；<30中期超卖；50以上偏多' },
  'WR': { meaning: '威廉指标，衡量收盘价在区间内的位置', hint: '> -20为超买（多头力竭）；< -80为超卖（空头力竭）' },
  'CCI': { meaning: '商品通道指标，衡量价格偏离均值的程度', hint: '>100趋势偏强；<-100趋势偏弱；0附近无方向' },
};

// 经典图表形态含义说明
const CLASSIC_PATTERN_DESC = {
  '头肩顶': { meaning: '三个峰：肩-头（最高）-肩，头部高于两肩', hint: '经典顶部反转结构，跌破颈线（两谷连线）确认' },
  '头肩底': { meaning: '三个谷：肩-头（最低）-肩，头部低于两肩', hint: '经典底部反转结构，突破颈线（两峰连线）确认' },
  '双顶': { meaning: '两个相近高度的峰，中间一个谷', hint: '顶部受阻形态，M头，跌破中间谷底确认看空' },
  '双底': { meaning: '两个相近高度的谷，中间一个峰', hint: '底部支撑形态，W底，突破中间峰顶确认看多' },
  '三重顶': { meaning: '三个相近高度的峰', hint: '强阻力位，多次冲关失败后可能大跌' },
  '三重底': { meaning: '三个相近高度的谷', hint: '强支撑位，多次探底不破后可能大涨' },
  '上升三角形': { meaning: '上沿平齐、下沿逐步抬高的收敛形态', hint: '偏多形态，买方力量积蓄，向上突破概率大' },
  '下降三角形': { meaning: '下沿平齐、上沿逐步降低的收敛形态', hint: '偏空形态，卖方力量积蓄，向下突破概率大' },
  '对称三角形': { meaning: '上下沿同时收敛的整理形态', hint: '整理形态，突破方向决定后续趋势' },
  '矩形/箱体': { meaning: '价格在水平区间内反复震荡', hint: '震荡整理，突破上沿看多、跌破下沿看空' },
};

const PAT_COUNT = PATLIB.length, DIM_COUNT = 12, TOTAL_CHECKS = PAT_COUNT + DIM_COUNT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function playScanAnim(host, fetchP, opts = {}) {
  opts = opts || {};
  const alive = opts.alive || (() => true);
  host.className = 'scan show' + (opts.inrow ? ' inrow' : '');
  host.innerHTML = `<div class="scanhd">🔬 ${escape(opts.title||'个股体检中')} · 比对 <b>${PAT_COUNT}</b> 种蜡烛形态 ＋ <b>${DIM_COUNT}</b> 类技术维度<span class="cnt">0/${TOTAL_CHECKS}</span></div><div class="patgrid-wrap"><div class="patgrid">${PATLIB.map(p => `<div class="pchip"><span class="ck"></span>${p[0]}</div>`).join('')}</div></div><div class="swait"></div><div class="patsum"></div><div class="dimscan"></div><div class="sfin"></div>`;
  const scnt = host.querySelector('.cnt');
  const chips = Array.from(host.querySelector('.patgrid').children);

  for (let i = 0; i < chips.length; i++) {
    chips[i].classList.add('scan'); chips[i].querySelector('.ck').textContent = '✓';
    scnt.textContent = (i + 1) + '/' + TOTAL_CHECKS;
    await sleep(42);
    if (!alive()) return { aborted: true };
  }

  const wait = host.querySelector('.swait');
  if (wait) {
    wait.className = 'swait show';
    wait.innerHTML = '<span class="wbar"><i></i></span><span class="wtx">正在拉取实时行情与日线数据…</span>';
  }

  let j = null;
  try { const result = await fetchP; j = result.j || result; } catch (e) { j = null; }
  if (wait) wait.className = 'swait';
  if (!alive()) return { aborted: true };
  if (!j || !j.ok) return { j };

  const hitNames = (j.patterns || []).map(p => p.name || '');
  chips.forEach((c, i) => {
    const nm = PATLIB[i][0];
    if (hitNames.some(hn => hn && (hn.indexOf(nm) >= 0 || nm.indexOf(hn) >= 0))) {
      c.classList.add('hit'); c.querySelector('.ck').textContent = '●';
    }
  });
  await sleep(520);
  if (!alive()) return { aborted: true };

  const psum = host.querySelector('.patsum');
  if (psum) {
    psum.className = 'patsum show';
    psum.innerHTML = hitNames.length
      ? `✓ 已比对 <b>${PAT_COUNT}</b> 种蜡烛形态 · <span class="hit">命中 ${hitNames.length} 种：${hitNames.slice(0, 3).map(escape).join('、')}${hitNames.length > 3 ? '…' : ''}</span>`
      : `✓ 已比对 <b>${PAT_COUNT}</b> 种蜡烛形态 · 未现明显反转形态`;
  }
  const pw = host.querySelector('.patgrid-wrap');
  if (pw) pw.classList.add('collapsed');
  await sleep(340);
  if (!alive()) return { aborted: true };

  const dims = j.scan_dims || [];
  const ptsByDim = {};
  (j.factors || []).forEach(f => { if (f.dim) ptsByDim[f.dim] = (ptsByDim[f.dim] || 0) + f.pts; });
  const dsc = host.querySelector('.dimscan');
  if (dsc) dsc.innerHTML = dims.map(d => `<div class="d"><span class="ic"></span><span class="nm">${escape(d.name)}</span><span class="rs">检测中…</span></div>`).join('');
  const drows = dsc ? Array.from(dsc.children) : [];

  for (let i = 0; i < drows.length; i++) {
    drows[i].classList.add('on');
    await sleep(300);
    if (!alive()) return { aborted: true };
    const pts = ptsByDim[dims[i].key] || 0;
    const cls = pts > 0 ? 'pos' : pts < 0 ? 'neg' : 'neu';
    const icon = pts > 0 ? '✓' : pts < 0 ? '✗' : '·';
    drows[i].classList.remove('on'); drows[i].classList.add('ok', cls);
    drows[i].querySelector('.ic').textContent = icon;
    drows[i].querySelector('.rs').textContent = dims[i].note || '已核验';
    if (scnt) scnt.textContent = (PAT_COUNT + i + 1) + '/' + TOTAL_CHECKS;
    await sleep(55);
    if (!alive()) return { aborted: true };
  }

  const sfin = host.querySelector('.sfin');
  if (sfin) sfin.innerHTML = '<div class="scanfin">信号汇聚 · 综合评分中<span class="dots"><span>·</span><span>·</span><span>·</span></span></div>';
  await sleep(750);
  if (!alive()) return { aborted: true };
  host.className = 'scan';
  return { j };
}

// --- 页面 ---

// 体检维度含义
const SCAN_DIM_DESC = {
  'trend': { meaning: '基于收盘价与MA60的关系判断当前趋势方向', hint: '站上MA60=上升趋势（偏多）；跌破MA60=趋势转弱' },
  'ma60': { meaning: '60日均线，被称为"生命线"，是大资金的重要参考', hint: '价格站在MA60上方时中长期趋势健康' },
  'support': { meaning: '近期20日最低点，是下方的"地板"支撑位', hint: '跌到附近常有资金接盘托一下；一旦跌破则支撑变压力' },
  'ma5_ma20': { meaning: '短期均线（5日）与中期均线（20日）的排列关系', hint: 'MA5>MA20偏多，短线上攻；反之偏空，短线走弱' },
  'volume': { meaning: '量比=今日成交量/过去5日平均成交量', hint: '≥1.5算放量，说明有真金白银进场；<1缩量观望' },
  'macd': { meaning: 'MACD指标的快慢线交叉关系', hint: '金叉=DIF上穿DEA，短线多头信号；死叉=空头信号' },
  'rsi': { meaning: '14日相对强弱指标，衡量近期涨跌幅的对比', hint: '>70偏强但可能超买（不宜追涨）；<30偏弱但可能超卖' },
  'polarity': { meaning: '原先的支撑位跌破后变成阻力位（或反之）', hint: '均线下方时常遇反压；突破后回踩站稳才是有效突破' },
  'fake': { meaning: '盘中跌破支撑但收盘收回（假摔）或短暂突破后回落（假突破）', hint: '假摔说明支撑有效，买方接盘有力；假突破说明压力有效' },
  'murphy': { meaning: '基于墨菲《金融市场技术分析》的摆动指标综合评估', hint: '含KDJ/RSI/WR/CCI共7项，综合判断超买超卖状态' },
  'patterns': { meaning: '日本蜡烛图技术中29种经典K线形态的扫描结果', hint: '命中形态会在上方"蜡烛形态"卡片中详细展示' },
  'drawdown': { meaning: '从过去60日最高点回落的幅度', hint: '回撤越大说明之前的"坑"越深，反弹压力越大' },
};

function checkPage() {
  layout('个股体检', `<div class="search-row"><div class="stock-search"><span>⌕</span><input id="stock-input" autocomplete="off" placeholder="输入公司名或代码，如 比亚迪 / 002594"><div id="suggestions" class="suggestions"></div></div><button id="report-btn" class="primary">体检</button></div>
    <a class="hot-banner" href="#/screen">🔥 不知道测哪只？看「回春法」今日精选的强势候选 →</a>
    <div class="quota"><span>本机体检额度 <b>不限次数</b></span><span>数据与自选股仅保存在当前电脑</span></div>
    <div class="popular">🔥 大家在测：${[['600392','盛和资源'],['601138','工业富联'],['000021','深科技'],['002594','比亚迪'],['600519','贵州茅台']].map(([c,n]) => `<button data-code="${c}">${n}</button>`).join('')}</div>
    <div id="scan-slot"></div><div id="report-slot"></div><div id="favorites"></div>`);
  const input = document.querySelector('#stock-input'); let selectedCode = '';
  const run = async code => {
    const target = selectedCode || String(code).replace(/\D/g, '');
    if (!target) return notice('请从下拉菜单选择股票，或输入 6 位代码');
    const scanSlot = document.querySelector('#scan-slot');
    const reportSlot = document.querySelector('#report-slot');
    reportSlot.innerHTML = '';
    const _tk = Date.now();
    const fetchP = api(`/stocks/${target}/report`).then(j => ({ j }));
    const { j, aborted } = await playScanAnim(scanSlot, fetchP, { title: '个股体检中', alive: () => true });
    if (aborted) return;
    if (!j) { notice('体检失败，请稍后重试'); return; }
    renderReport(j);
  };
  const selectStock = stock => { selectedCode = stock.code; input.value = `${stock.name} · ${stock.code}`; document.querySelector('#suggestions').replaceChildren(); input.focus(); };
  document.querySelector('#report-btn').onclick = () => run(input.value.trim());
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); const first = document.querySelector('#suggestions button'); if (first && !selectedCode) return first.click(); run(input.value.trim()); }
    if (e.key === 'Escape') document.querySelector('#suggestions').replaceChildren();
  };
  document.querySelectorAll('.popular button').forEach(button => button.onclick = () => run(button.dataset.code));
  let timer;
  input.oninput = () => { selectedCode = ''; clearTimeout(timer); timer = setTimeout(async () => {
    const q = input.value.trim(); const box = document.querySelector('#suggestions');
    if (!q) return box.replaceChildren();
    try { const data = await api(`/stocks/search?q=${encodeURIComponent(q)}`); box.innerHTML = data.stocks.map(stock => `<button data-code="${stock.code}"><b>${stock.name}</b><span>${stock.code}</span></button>`).join(''); box.querySelectorAll('button').forEach(button => button.onclick = () => selectStock({ code: button.dataset.code, name: button.querySelector('b').textContent })); } catch { box.replaceChildren(); }
  }, 180); };
  renderFavorites();
}

function renderReport(data) {
  // 均线排列状态
  const maAlign = d => {
    const { ma5, ma20, ma60 } = d.metrics || {};
    if (!ma5 || !ma20 || !ma60) return '—';
    if (ma5 > ma20 && ma20 > ma60) return '多头排列';
    if (ma5 < ma20 && ma20 < ma60) return '空头排列';
    if (ma5 > ma60 && ma20 < ma60) return '纠缠偏多';
    if (ma5 < ma60 && ma20 > ma60) return '纠缠偏空';
    return '均线纠缠';
  };
  // 结论卡三色映射
  const lightMeta = { red: { em: '🔴', w: '技术风险高' }, yellow: { em: '🟡', w: '信号不明' }, green: { em: '🟢', w: '技术较稳' } }[data.light] || { em: '⚪', w: '—' };
  const trendTxt = { up: '上升趋势', down: '下降趋势', range: '横盘震荡' }[data.trend] || '—';
  // 计分公式：基准 50 + 各项分数
  const sumPts = (data.factors || []).reduce((s, f) => s + f.pts, 0);
  const rawScore = 50 + sumPts;
  let calcNote = `🧮 基准 50 分 ＋ 体检各项 ${sumPts >= 0 ? '+' : ''}${sumPts} ＝ ${rawScore} 分`;
  if (data.is_powei && data.health <= 22) calcNote += `；⚠️ 破位封顶（破位时最高只给 22 分）→ <b>${data.health} 分</b>`;
  else if (rawScore > 100) calcNote += `（不高于 100）→ <b>${data.health} 分</b>`;
  else if (rawScore < 0) calcNote += `（不低于 0）→ <b>${data.health} 分</b>`;
  // 形态计分
  const patternPts = (data.factors || []).filter(f => f.dim === 'pattern').reduce((s, f) => s + f.pts, 0);
  const patScoreHtml = patternPts !== 0 ? `<span style="font-weight:800;font-family:ui-monospace,monospace;color:${patternPts > 0 ? 'var(--good)' : 'var(--red)'}">（计 ${patternPts > 0 ? '+' + patternPts : patternPts} 分）</span>` : '';

  layout('个股体检', `
    <div class="result-title"><div><h2>${escape(data.name)} <small>${data.code}</small></h2><p>数据更新时间：${escape(data.quote.updatedAt || data.last_date || '最近交易日')}</p></div><button id="back" class="outline">重新体检</button></div>
    <div class="verdict ${data.light}"><div class="em">${lightMeta.em}</div><div><div class="vt">${data.band} · ${lightMeta.w}</div><div class="vs">${escape(data.headline || data.summary)}${data.is_powei && data.powei_reason ? '<br><b>说人话：</b>' + escape(data.powei_reason) + '，破位用<b>收盘价</b>判定，是真跌不是盘中假摔。' : ''}</div></div></div>
    <div class="health ${data.light}"><div class="hnum">${data.health}<small>/100</small></div><div class="hmid"><div class="hband">技术健康分 · ${data.band}</div><div class="hbar"><span class="mk" style="left:${data.health}%"></span></div><div class="hticks"><span>0 危险</span><span>45</span><span>65</span><span>健康 100</span></div></div></div>
    <div class="calcnote">${calcNote}</div>
    <div class="checkdone">✓ 已逐项核验 ${data.pat_scanned || 29} 种蜡烛形态 ＋ 12 类技术维度</div>
    <div class="report-grid"><article class="card"><h2>趋势与价格</h2><div id="chart" class="chart"></div>
    <div class="legend"><i><span style="background:#d8584d"></span>红=涨</i><i><span style="background:#3a9e6e"></span>绿=跌</i><i><span class="line" style="background:#4f6cae"></span>蓝线=MA60</i><i><span class="line" style="background:#c9922e"></span>金线=均量5</i><i><span style="background:#d8584d"></span>红虚线=支撑</i><i><span style="background:#9aa6bd"></span>灰虚线=压力</i></div>
    <div class="metrics">
      <div class="metric"><div class="ml">最新收盘</div><div class="mv">${number(data.last_close || data.quote.price)}</div><div class="ms">${data.quote.changePct >= 0 ? '+' : ''}${number(data.quote.changePct)}%</div></div>
      <div class="metric"><div class="ml">当前趋势</div><div class="mv" style="font-size:14px">${trendTxt}</div><div class="ms">${data.metrics?.ma5 >= data.metrics?.ma20 ? '短期偏多' : '短期偏空'}</div></div>
      <div class="metric"><div class="ml">均线排列</div><div class="mv" style="font-size:13px">${maAlign(data)}</div><div class="ms">MA5/20/60</div></div>
      <div class="metric"><div class="ml">支撑位·地板</div><div class="mv" style="color:var(--red)">${data.support ? data.support.toFixed(2) : '—'}</div><div class="ms">距现价 ${data.support && data.last_close ? (Math.abs(1 - data.support / data.last_close) * 100).toFixed(1) + '%' : '—'}</div></div>
      <div class="metric"><div class="ml">压力位·天花板</div><div class="mv" style="color:#8a93a8">${data.resistance ? data.resistance.toFixed(2) : '—'}</div><div class="ms">距现价 ${data.resistance && data.last_close ? (Math.abs(1 - data.resistance / data.last_close) * 100).toFixed(1) + '%' : '—'}</div></div>
      <div class="metric"><div class="ml">量比</div><div class="mv">${data.vol_ratio != null ? number(data.vol_ratio) : '—'}</div><div class="ms">${(data.vol_ratio || 0) >= 1.5 ? '放量' : '常态'}</div></div>
    </div>
    <p class="summary">📍 <b>支撑位</b>＝下方「地板」（前期低点，跌到附近常有资金接盘托一下，是值得关注的<b>观察位</b>）；<b>压力位</b>＝上方「天花板」（前期高点，涨到附近常遇套牢盘抛压、容易回落，是需要留意的<b>风险位</b>）。仅为技术位置提示，不构成买卖建议。</p></article>
    <article class="card"><h2>体检结论</h2>
    <div class="conclusion-row">
    <p class="signal ${data.light === 'green' ? 'positive' : data.light === 'red' ? 'negative' : ''}">● ${data.band}</p>
    <dl class="conclusion-metrics"><dt>MA20</dt><dd>${number(data.metrics?.ma20)}</dd><dt>MA60</dt><dd>${number(data.metrics?.ma60)}</dd><dt>MACD</dt><dd>${number(data.metrics?.macd)}</dd><dt>RSI</dt><dd>${number(data.metrics?.rsi)}</dd></dl>
    <button id="favorite" class="primary">收藏到自选</button></div></article></div>
    <div class="scanhdr">🔬 体检共 <b>${(data.pat_scanned || 29) + 10 + 7 + 5}</b> 项 = <b>①${data.pat_scanned || 29} 种蜡烛形态</b>（下方「命中形态」列出命中的，没命中=没出现）＋ <b>②技术维度展开 ${10 + 7 + 5} 项</b>（10 类核心 + 墨菲摆动指标 7 项 + 经典图表形态 5 类，下方逐项全列）。带分数=这次影响了评分，带「·」=查过、正常。</div>
    ${card('', `<div class="seclbl">① 蜡烛形态 · 已扫 ${data.pat_scanned || 29} 种，命中 ${data.pat_hit || 0} 种 ${patScoreHtml}</div><div class="pats" style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 0 14px">${patternChips(data.patterns)}</div><div class="seclbl">② 技术维度 · 12 类（全部都扫了）</div>${data.scan_dims.map(d => {
    const desc = SCAN_DIM_DESC[d.key];
    const tt = desc ? `data-tooltip="${desc.meaning}" data-tooltip-signal="${desc.hint}"` : '';
    const f = (data.factors || []).find(x => x.dim === d.key);
    const pts = f ? f.pts : 0;
    const cls = pts > 0 ? 'pos' : pts < 0 ? 'neg' : 'neu';
    const badge = pts > 0 ? '+' + pts : pts < 0 ? '' + pts : '·';
    return `<div class="dimrow2 ${cls} has-tip" ${tt}><span class="fpts ${pts ? '' : 'idle'}">${badge}</span><span class="dn">${escape(d.name)}</span><span class="dwhy">${escape(d.note)}</span></div>`;
  }).join('')}`, 'report-card')}
    ${card('摆动指标组', renderMurphy(data.murphy), 'report-card')}
    ${card('经典图表形态', renderClassicPatterns(data.patterns_classic), 'report-card')}
    ${card('四方会诊', renderConsult(data.consult), 'report-card')}
    ${data.multiPeriod && data.multiPeriod.sufficient ? card('多周期分析', renderMultiPeriod(data.multiPeriod), 'report-card') : ''}
    <div id="favorites"></div>`);
  document.querySelector('#back').onclick = () => { location.hash = '#/check'; checkPage(); };
  const chartEl = document.querySelector('#chart');
  if (chartEl) chartEl.innerHTML = drawChart(data.chart);
  document.querySelector('#favorite')?.addEventListener('click', async () => { try { await api('/favorites', { method:'POST', body:JSON.stringify({code:data.code,name:data.name}) }); notice('已加入自选', true); } catch (e) { notice(e.message); } });
  renderFavorites();
}

async function renderFavorites() {
  const slot = document.querySelector('#favorites');
  if (!slot) return;
  try {
    const data = await api('/favorites');
    const favs = data.favorites || [];
    const groups = data.groups || ['默认'];
    if (!favs.length) { slot.innerHTML = '<section class="watch"><h2>我的自选</h2><div class="local-note">还没有自选股，体检结果页可以直接收藏。</div></section>'; return; }
    // 分组 Tab
    const groupTabs = `<div class="fav-groups">${groups.map((g, i) => `<button class="fav-group-tab ${i === 0 ? 'active' : ''}" data-group="${escape(g)}">${escape(g)} <small>${favs.filter(f => (f.group || '默认') === g).length}</small></button>`).join('')}</div>`;
    // 尝试获取行情摘要
    let quotes = {};
    try { const q = await api('/favorites/quotes'); (q.items||[]).forEach(it => { if (it.ok) quotes[it.code] = it; }); } catch {}
    const renderGroup = group => {
      const list = favs.filter(f => (f.group || '默认') === group);
      const rows = list.map(x => {
        const q = quotes[x.code];
        const sparkline = q && q.sparkline && q.sparkline.length >= 2 ? sparklineSVG(q.sparkline, q.change_pct) : '';
        const price = q ? number(q.last_close) : '—';
        const pct = q && q.change_pct != null ? `${q.change_pct >= 0 ? '+' : ''}${number(q.change_pct)}%` : '';
        return `<div class="favrow" data-code="${x.code}" style="background:#fff;border:1px solid #e4e8f1;border-radius:13px;margin:8px 0;padding:11px 13px;display:flex;align-items:center;gap:11px;flex-wrap:wrap">
          <button class="onecheck mini" data-code="${x.code}">体检</button>
          <div style="flex:1;min-width:120px"><div style="font-weight:700;font-size:14.5px">${escape(x.name)}</div><div style="color:#9098a9;font-size:11.5px">${x.code}</div></div>
          ${sparkline}
          <div style="text-align:right"><div style="font-family:ui-monospace,monospace;font-weight:800">${price}</div><div style="font-size:12px;color:${q && q.change_pct >= 0 ? '#d8584d' : '#3a9e6e'}">${pct}</div></div>
          <select class="fav-group-move" data-code="${x.code}" title="移动到分组">
            ${groups.map(g => `<option value="${escape(g)}" ${(x.group || '默认') === g ? 'selected' : ''}>${escape(g)}</option>`).join('')}
          </select>
          <button class="rmfav mini danger" data-code="${x.code}">删除</button>
        </div>`;
      }).join('');
      return `<div class="fav-list">${rows || '<div class="local-note">该分组暂无股票</div>'}</div>`;
    };
    slot.innerHTML = `<section class="watch"><h2>我的自选</h2>
      <div class="favhead-actions" style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap"><button class="testall" id="testAllBtn" style="background:linear-gradient(135deg,#5d7cc4,#4f6cae);color:#fff;border:none;border-radius:12px;padding:10px 18px;font-size:14px;font-weight:800;cursor:pointer">⚡ 一键全测</button><button class="quote-refresh" id="refreshFavQuotes" style="border:1px solid var(--line);background:#fff;border-radius:10px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer">↻ 刷新行情</button></div>
      ${groupTabs}
      <div id="fav-group-content">${renderGroup('默认')}</div>
    </section>`;
    // 分组 Tab 切换
    const tabs = slot.querySelectorAll('.fav-group-tab');
    tabs.forEach(t => t.onclick = () => {
      tabs.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelector('#fav-group-content').innerHTML = renderGroup(t.dataset.group);
      bindFavEvents(slot);
    });
    // 移动分组
    slot.querySelectorAll('.fav-group-move').forEach(sel => sel.onchange = async () => {
      try { await api(`/favorites/${sel.dataset.code}`, { method: 'PUT', body: JSON.stringify({ group: sel.value }) }); notice(`已移动到「${sel.value}」`, true); renderFavorites(); }
      catch (e) { notice(e.message); }
    });
    bindFavEvents(slot);
    const testAllBtn = slot.querySelector('#testAllBtn');
    if (testAllBtn) testAllBtn.onclick = () => testAll(favs);
    const refreshBtn = slot.querySelector('#refreshFavQuotes');
    if (refreshBtn) refreshBtn.onclick = () => { refreshBtn.textContent = '刷新中…'; renderFavorites(); };
  } catch (e) { slot.innerHTML = ''; }
}

function bindFavEvents(slot) {
  slot.querySelectorAll('.onecheck').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = '体检中…';
    try { const r = await api(`/stocks/${b.dataset.code}/report`); checkPage(); setTimeout(() => renderReport(r), 100); }
    catch (e) { notice(e.message); b.disabled = false; b.textContent = '体检'; }
  });
  slot.querySelectorAll('.rmfav').forEach(b => b.onclick = async () => {
    try { await api(`/favorites/${b.dataset.code}`, { method: 'DELETE' }); notice('已删除', true); renderFavorites(); }
    catch (e) { notice(e.message); }
  });
}

function sparklineSVG(vals, pct) {
  vals = (vals || []).map(Number).filter(Number.isFinite).slice(-24);
  if (vals.length < 2) return '';
  const w = 86, h = 26, min = Math.min(...vals), max = Math.max(...vals), span = Math.max(max - min, 0.0001);
  const pts = vals.map((v, i) => `${(i/(vals.length-1)*w).toFixed(1)},${(h-(v-min)/span*(h-4)-2).toFixed(1)}`).join(' ');
  const col = (Number(pct) || 0) >= 0 ? '#d8584d' : '#3a9e6e';
  return `<svg style="width:86px;height:26px" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

let _testAllRunning = false;
async function testAll(favorites) {
  if (_testAllRunning || !favorites.length) return;
  _testAllRunning = true;
  const btn = document.querySelector('#testAllBtn');
  if (btn) { btn.disabled = true; btn.textContent = '体检中…'; }
  const results = [];
  for (let i = 0; i < favorites.length; i++) {
    const f = favorites[i];
    if (btn) btn.textContent = `体检中… ${i+1}/${favorites.length}`;
    try { const r = await api(`/stocks/${f.code}/report`); results.push({ code: f.code, name: r.name || f.name, health: r.health, light: r.light, band: r.band }); }
    catch { results.push({ code: f.code, name: f.name, health: 0, light: 'red', band: '失败' }); }
  }
  // 按风险排序
  const order = { red: 0, yellow: 1, green: 2 };
  results.sort((a, b) => (order[a.light] || 9) - (order[b.light] || 9));
  const cnt = { red: 0, yellow: 0, green: 0 };
  results.forEach(r => { if (cnt[r.light] != null) cnt[r.light]++; });
  if (btn) { btn.disabled = false; btn.textContent = '⚡ 一键全测'; }
  // 显示汇总
  const slot = document.querySelector('#favorites');
  const existing = slot?.querySelector('.fav-list');
  if (existing) {
    const summary = document.createElement('div');
    summary.style.cssText = 'display:flex;gap:8px;margin:10px 0';
    summary.innerHTML = `<div style="flex:1;text-align:center;border-radius:12px;padding:10px 6px;border:1px solid #f3cfc9;background:#fcefed"><div style="font-size:22px;font-weight:800;color:#bb4339">${cnt.red}</div><div style="font-size:11.5px;color:#76819a">🔴 危险</div></div><div style="flex:1;text-align:center;border-radius:12px;padding:10px 6px;border:1px solid #f3e3b9;background:#fbf4e6"><div style="font-size:22px;font-weight:800;color:#a87519">${cnt.yellow}</div><div style="font-size:11.5px;color:#76819a">🟡 观望</div></div><div style="flex:1;text-align:center;border-radius:12px;padding:10px 6px;border:1px solid #cce8d8;background:#eaf6ef"><div style="font-size:22px;font-weight:800;color:#247a52">${cnt.green}</div><div style="font-size:11.5px;color:#76819a">🟢 健康</div></div>`;
    existing.insertBefore(summary, existing.firstChild);
  }
  notice(`一键全测完成：${cnt.red} 红 / ${cnt.yellow} 黄 / ${cnt.green} 绿`, true);
  _testAllRunning = false;
}

async function screenPage() {
  loading();
  try {
    const [data, sectorData] = await Promise.all([
      api('/screen'),
      api('/sectors').catch(() => ({ sectors: [] })),
    ]);
    const sectors = (sectorData && sectorData.sectors) || [];
    const sectorHtml = sectors.length
      ? `<div class="sector-heat" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px">${sectors.map(s => {
          const col = s.avgPct >= 0 ? '#d8584d' : '#3a9e6e';
          return `<div title="${escape(s.sector)}：${s.count} 只" style="flex:1;min-width:90px;text-align:center;border:1px solid var(--line);border-radius:10px;padding:8px 6px;background:#fff"><div style="font-size:12.5px;font-weight:700">${escape(s.sector)}</div><div style="font-family:ui-monospace,monospace;font-weight:800;color:${col};margin-top:2px">${s.avgPct >= 0 ? '+' : ''}${s.avgPct}%</div><div style="font-size:11px;color:var(--muted)">${s.count} 只</div></div>`;
        }).join('')}</div>`
      : '';
    layout('回春法选股', `${sectorHtml ? '<div class="how"><b>🔥 板块热度</b></div>' + sectorHtml + '<div style="height:12px"></div>' : ''}<div class="how"><b>📋 这份名单怎么用</b><p>每天按趋势、MACD、均线与量价规则扫描预置股票池（覆盖白酒/新能源/半导体/消费电子/金融/医药/汽车/稀土/通信/军工/家电等板块龙头，约 40 只）；候选仅供技术研究，不构成投资建议。</p></div>
    <div class="custom-scan"><input id="scan-custom-codes" placeholder="📝 自定义扫描：输入 6 位代码，逗号分隔，如 600519,002594,300750"><button id="scan-custom-btn" class="outline" style="white-space:nowrap">⚡ 扫描自定义列表</button><span id="custom-status" style="display:none;font-size:12px;color:var(--blue)"></span></div>
    ${card('', `<div class="filters"><input id="screen-filter" placeholder="🔍 输入代码/名称搜索"><button class="active">体检分</button></div><p class="report-note">🩺 候选按体检分排序，数据更新时间：${date(data.updatedAt)}</p><div class="table-wrap"><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>现价</th><th>今日</th><th>体检分</th><th>量比</th><th>结论</th><th>灯</th></tr></thead><tbody id="screen-rows"></tbody></table></div>`)}`);
    let candidates = data.candidates;
    const render = rows => document.querySelector('#screen-rows').innerHTML = rows.length ? rows.map((x, i) => `<tr data-code="${x.code}"><td>${i+1}</td><td>${x.code}</td><td><b>${escape(x.name)}</b></td><td>${number(x.price)}</td><td class="${x.changePct>=0?'up':'down'}">${x.changePct>=0?'+':''}${number(x.changePct)}%</td><td><strong class="score mini">${x.score}</strong></td><td>${number(x.volumeRatio)}</td><td>${x.status}</td><td>${x.light === 'green' ? '🟢' : x.light === 'yellow' ? '🟡' : '🔴'}</td></tr>`).join('') : '<tr><td colspan="9">当前没有符合筛选条件的候选。</td></tr>';
    render(candidates);
    document.querySelector('#screen-filter').oninput = e => render(candidates.filter(x => (x.code + x.name).includes(e.target.value.trim())));
    document.querySelector('#screen-rows').onclick = e => { const row = e.target.closest('tr[data-code]'); if (row) location.hash = `#/check/${row.dataset.code}`; };
    // 自定义扫描
    const scanBtn = document.querySelector('#scan-custom-btn');
    const scanInput = document.querySelector('#scan-custom-codes');
    const scanStatus = document.querySelector('#custom-status');
    scanBtn.onclick = async () => {
      const codesStr = scanInput.value.trim();
      if (!codesStr) return notice('请输入股票代码，用逗号分隔');
      if (!/^[\d,]+$/.test(codesStr)) return notice('请输入纯数字代码，逗号分隔');
      scanBtn.disabled = true; scanStatus.style.display = 'inline'; scanStatus.textContent = '扫描中…';
      try {
        const r = await api(`/screen/custom?codes=${encodeURIComponent(codesStr)}`);
        if (!r.candidates.length) { notice('没有符合条件的候选'); scanBtn.disabled = false; scanStatus.style.display = 'none'; return; }
        candidates = r.candidates;
        render(candidates);
        scanStatus.textContent = `✓ 扫描 ${r.count} 只，符合条件 ${candidates.length} 只`;
        notice(`扫描完成：${candidates.length} 只符合回春法初筛`, true);
      } catch (e) { notice(e.message); scanStatus.style.display = 'none'; }
      finally { scanBtn.disabled = false; }
    };
    scanInput.onkeydown = e => { if (e.key === 'Enter') scanBtn.click(); };
  } catch (e) { checkPage(); notice(e.message); }
}

function rulesPage() {
  layout('方法说明', `<p class="intro">不是玄学。挑票用「回春法」，判断技术风险用《日本蜡烛图技术》(尼森) ＋ 《金融市场技术分析》(墨菲) 双书驱动的个股体检，纯规则计算、标准全公开。</p>
    <div class="steps"><article><b>1</b><h2>挑票</h2><p>回春法选出候选</p></article><article><b>2</b><h2>判断</h2><p>个股体检能不能买</p></article></div>

    ${card('为什么用这两本书', `<div class="book-grid"><div class="book-card"><h3>📗 日本蜡烛图技术 · 尼森</h3><p>个股体检以这本《日本蜡烛图技术》（史蒂夫·尼森著，丁圣元译）的<b>蜡烛图原则</b>为核心，再结合均线（MA60）、MACD、成交量等<b>工程化规则</b>综合判断，标准全公开。</p><ul class="clean"><li>K线（蜡烛图）的"开山经典"——尼森是第一个把蜡烛图系统介绍给全世界的人，被称作"K线图之父"</li><li>每个信号都有明确定义："看跌吞没""破位""假摔"都有精确的开高低收规则——能写成纯代码、可复现、不掺主观</li></ul></div><div class="book-card"><h3>📘 金融市场技术分析 · 墨菲</h3><p>西方技术分析公认的"圣经"级全景百科。尼森专攻 1～3 根 K 线的短线情绪，墨菲补上蜡烛图天生看不见的两块：<b>摆动指标</b>（动量温度）和<b>多周级别经典图表形态</b>（中线结构）。</p><ul class="clean"><li>摆动指标组（第 9/10 章）：KDJ、RSI、WR、CCI 等 7 项，衡量动量与超买超卖</li><li>经典图表形态（第 5/6 章）：头肩顶/底、双顶双底、三重顶底、矩形箱体、三角形——必须<b>收盘价决定性突破颈线/边界</b>才算确认</li></ul></div></div><p>两本书由同一位译者（丁圣元）译成中文，不是二选一，而是「专科 + 全科」互补会诊。</p>`)}

    ${card('体检引擎：四方会诊', `<p>个股体检不是只看一根 K 线。引擎把信号拆成四层，独立判向、看共振与背离：</p>
    <div class="rule-grid" style="grid-template-columns:repeat(4,1fr)"><div><b>🕯️</b><h3>蜡烛形态</h3><p>尼森 29 种形态看短线情绪</p></div><div><b>📉</b><h3>趋势·破位</h3><p>趋势方向与破位风险</p></div><div><b>📊</b><h3>摆动指标</h3><p>墨菲 7 项看动量位置</p></div><div><b>📐</b><h3>图表形态</h3><p>多周级别中线结构</p></div></div>
    <p style="margin-top:12px"><b>墨菲两组计分规则：</b></p>
    <ul class="clean"><li>摆动指标组：按组汇总、封顶 ±10。KDJ 低位金叉 +5 / 高位死叉 −5、双均线金叉死叉 ±4、布林中轨上下 ±2、ROC 动量 ±2；RSI、%R、CCI 与触布林轨只提示超买/超卖位置风险、不计方向分——强趋势中超买可以持续，这是墨菲原书的纪律。</li>
    <li>经典图表形态：收盘价决定性突破颈线/边界的「已确认」形态 ±10、成型中反转形态 ±3、三角形偏向 ±2，按组封顶 ±12，避免把"成型中"误当成"已确认"。</li>
    <li>优先级：破位一票否决（健康分硬压 ≤22）永远排第一，墨菲加分救不回已破位的股票。</li></ul>`)}

    ${card('一、回春法：怎么挑出候选股', `<p>一句话：退潮期挖「前期妖股反抽」。大盘没主线、赚钱效应差时，资金喜欢回头炒那些以前被爆炒过、有辨识度的老妖股（有"资金肌肉记忆"，拉起来更容易）。回春法用 MACD 把"跌透了、刚要重新转强"的老妖股挑出来。</p>
    <div class="rule-grid"><div><b>1</b><h3>前期是「妖股」</h3><p>上一轮 MACD 从金叉到死叉，区间涨幅很大（越大越好）。</p></div><div><b>2</b><h3>回调到 0 轴附近金叉</h3><p>死叉后第一个金叉、且在「0 轴」附近，是跌透重新转强的起点。</p></div><div><b>3</b><h3>趋势没坏</h3><p>股价站上 60 日均线，且 60 日线方向向上。</p></div></div>
    <p style="margin-top:10px"><b>买点：</b>MACD 即将金叉（差一步）时买入 + 当天明显放量（早盘 30/60 分钟量能比前几天明显放大）。<br><b>加分：</b>个股正处热门板块时上涨概率更高。</p>`)}

    ${card('二、个股体检：怎么判断技术风险', `<p>⚙️ 说明：个股体检用的 MACD 是更灵敏的 <b>6/13/5</b>（更早捕捉短线强弱），与「回春法选股」用的 <b>10/20/9</b> 不同——选股要稳、体检要快，参数本就该不一样。</p>
    <div class="concept-grid"><div class="concept"><b>支撑 = 地板</b><p>有一条价位，股价之前一直踩着没掉下去。</p></div><div class="concept"><b>破位 = 踩穿地板</b><p>今天<b>收盘价</b>跌穿了这条线，下面没东西接，容易接着往下掉。</p></div><div class="concept"><b>假摔 = 踩了一脚没穿</b><p>盘中跌破又被买回、收盘还在线上 → 吓唬人的，反而偏好。</p></div></div>
    <p><b>关键：</b>只看收盘价，不看盘中砸的那一下——这是真破位和假摔的分水岭。</p>
    <div class="steps" style="margin-top:14px"><article><b>1</b><h2>看趋势</h2><p>上涨/下跌/横盘</p></article><article><b>2</b><h2>认形态</h2><p>吞没/锤子…</p></article><article><b>3</b><h2>判破位</h2><p>收盘破没破</p></article><article><b>4</b><h2>查衰竭</h2><p>背离/假信号</p></article><article><b>5</b><h2>打分</h2><p>红黄绿灯</p></article></div>`)}

    ${card('结论：0–100 技术健康分', `<p>基准 <b>50</b> 分，每满足一项利好加分、利空减分，满足越多分越高；破位时直接压到 20 分以下。</p>
    <table><tbody>
    <tr><td>🟢 80–100 健康 / 65–79 偏好</td><td>上升趋势 + 看涨信号、没破位，相对安全（仍需结合基本面）</td></tr>
    <tr><td>🟡 45–64 中性</td><td>信号不明朗 / 横盘 / 等明天确认</td></tr>
    <tr><td>🔴 25–44 偏弱 / 0–24 危险</td><td>已破位 / 假突破 / 空头集中。新手最大的亏损来自"破位后觉得便宜去接刀子"，所以一票否决</td></tr>
    </tbody></table>
    <p>⚠️ 提醒：这里的红/绿是"红绿灯"含义（红=停、绿=行），<b>不是</b>股票里"红涨绿跌"的意思。K 线图里的蜡烛才按 A 股习惯红涨绿跌。</p>`)}

    ${card('常见问题 FAQ', `<div class="faq"><div class="faq-item"><b>Q：体检分数会预测涨跌吗？</b><p>A：不会。分数只描述技术状态（趋势/动量/破位风险），不预测涨跌幅、不给目标价。尼森铁律：蜡烛图只给方向不给目标。</p></div><div class="faq-item"><b>Q：为什么同一天体检结果会变？</b><p>A：盘中行情实时变化，指标随最新价更新；另外缓存 30 秒内复用数据。收盘后体检最稳定（按收盘价判定）。</p></div><div class="faq-item"><b>Q：为什么有的股票查不到？</b><p>A：可能停牌或数据源暂时不可用，稍后重试；新股上市不足 60 天时 MA60 等长周期指标会用可用数据近似计算。</p></div></div>`)}

    ${card('全部校验标准', `<p>每查一只股票，引擎会一次性跑完 51 项规则：29 种蜡烛形态 + 10 类核心维度 + 墨菲摆动指标 7 项 + 经典图表形态 5 类。鼠标悬停在报告里的每项上可以看到精确含义。</p>
    <p style="color:var(--muted);font-size:12.5px;margin-top:10px">本工具只看技术图形，判断"是否破位/能不能买"，不预测涨跌幅、不给目标价，不构成投资建议。<br>方法论来源：回春战法 + 史蒂夫·尼森《日本蜡烛图技术》+ 约翰·墨菲《金融市场技术分析》(均为丁圣元译)。</p>`)}

    <div id="config-panel"></div>
    <div id="stocks-panel"></div>`);
  loadConfig();
  loadStocksPanel();
}

// --- 股票池管理面板 ---
async function loadStocksPanel() {
  const panel = document.querySelector('#stocks-panel');
  if (!panel) return;
  try {
    const data = await api('/stocks');
    const stocks = data.stocks || [];
    panel.innerHTML = `
      <article class="card">
        <h2>股票池管理</h2>
        <p class="muted">选股扫描范围。共 ${stocks.length} 只。添加/删除后立即生效。</p>
        <div class="bt-form" style="margin-bottom:14px">
          <div class="bt-field">
            <label class="cfg-label" for="stk-code">代码</label>
            <input class="cfg-input" id="stk-code" type="text" placeholder="6位代码" maxlength="6">
          </div>
          <div class="bt-field">
            <label class="cfg-label" for="stk-name">名称</label>
            <input class="cfg-input" id="stk-name" type="text" placeholder="股票名称">
          </div>
          <button class="bt-run" id="stk-add">添加</button>
        </div>
        <div class="table-wrap">
          <table class="bt-table">
            <thead><tr><th>代码</th><th>名称</th><th>板块</th><th>操作</th></tr></thead>
            <tbody>${stocks.map(s => `<tr><td class="tnum">${s.code}</td><td>${escape(s.name)}</td><td>${escape(s.sector || '其他')}</td><td><button class="mini danger" data-del="${s.code}">移除</button></td></tr>`).join('')}</tbody>
          </table>
        </div>
      </article>`;
    panel.querySelector('#stk-add').onclick = async () => {
      const code = panel.querySelector('#stk-code').value.trim();
      const name = panel.querySelector('#stk-name').value.trim();
      if (!/^\d{6}$/.test(code)) return notice('请输入 6 位股票代码');
      try {
        await api('/stocks', { method: 'POST', body: JSON.stringify({ code, name }) });
        notice('已添加', true); loadStocksPanel();
      } catch (e) { notice(e.message); }
    };
    panel.querySelectorAll('button[data-del]').forEach(b => b.onclick = async () => {
      try {
        await api(`/stocks?code=${b.dataset.del}`, { method: 'DELETE' });
        notice('已移除', true); loadStocksPanel();
      } catch (e) { notice(e.message); }
    });
  } catch { panel.innerHTML = ''; }
}
async function loadConfig() {
  const panel = document.querySelector('#config-panel');
  if (!panel) return;
  try {
    const { config } = await api('/config');
    const fields = [
      { key: 'macdFast', label: 'MACD 快线', hint: '默认 6，越小越灵敏' },
      { key: 'macdSlow', label: 'MACD 慢线', hint: '默认 13' },
      { key: 'macdSignal', label: 'MACD 信号线', hint: '默认 5' },
      { key: 'volumeRatioThreshold', label: '放量量比阈值', hint: '默认 1.5' },
      { key: 'healthScoreThreshold', label: '健康分门槛', hint: '默认 60，选股筛选用' },
      { key: 'ma60Period', label: '生命线周期', hint: '默认 60' },
    ];
    panel.innerHTML = card('策略参数配置', `<p class="summary">修改体检引擎的技术参数。改完后新体检会立即生效，已出的体检结果不会变。</p>
    <div class="config-grid">${fields.map(f => `<label class="cfg-item"><span class="cfg-label">${f.label}</span><input type="number" step="any" data-key="${f.key}" value="${config[f.key] ?? ''}" class="cfg-input"><span class="cfg-hint">${f.hint}</span></label>`).join('')}</div>
    <div class="form-actions"><span id="cfg-status"></span><button class="primary" id="cfg-save">保存配置</button></div>`);
    document.querySelector('#cfg-save').onclick = async () => {
      const data = {};
      panel.querySelectorAll('.cfg-input').forEach(inp => { const v = Number(inp.value); if (Number.isFinite(v)) data[inp.dataset.key] = v; });
      try {
        const { config: saved } = await api('/config', { method: 'PUT', body: JSON.stringify(data) });
        panel.querySelectorAll('.cfg-input').forEach(inp => inp.value = saved[inp.dataset.key]);
        notice('配置已保存，新体检将使用新参数', true);
      } catch (e) { notice(e.message); }
    };
  } catch { panel.innerHTML = ''; }
}

// --- 回测页面 ---
async function backtestPage() {
  const main = document.querySelector('main');
  main.innerHTML = `
    <section class="card">
      <h2>策略回测</h2>
      <p class="muted">基于 MACD 金叉/死叉信号模拟历史交易回测，评估策略在特定股票上的表现。结果仅供参考，不构成投资建议。</p>
      <div class="bt-form">
        <div class="bt-field">
          <label class="cfg-label" for="bt-code">股票代码</label>
          <input class="cfg-input" id="bt-code" type="text" placeholder="如 600519" maxlength="6" value="">
        </div>
        <div class="bt-field">
          <label class="cfg-label" for="bt-days">回测天数</label>
          <select class="cfg-input" id="bt-days">
            <option value="60">60 天</option>
            <option value="120" selected>120 天</option>
            <option value="180">180 天</option>
            <option value="250">250 天（约一年）</option>
          </select>
        </div>
        <button class="bt-run" id="bt-run">开始回测</button>
      </div>
    </section>
    <div id="bt-result"></div>
  `;

  // 尝试填充当前选中股票
  const cur = document.querySelector('#stockSelect');
  if (cur && cur.value) {
    const inp = document.querySelector('#bt-code');
    if (inp) inp.value = cur.value;
  }

  const runBtn = document.querySelector('#bt-run');
  const resultDiv = document.querySelector('#bt-result');

  runBtn.onclick = async () => {
    const code = document.querySelector('#bt-code').value.trim();
    const days = document.querySelector('#bt-days').value;
    if (!/^\d{6}$/.test(code)) { notice('请输入 6 位股票代码'); return; }

    runBtn.disabled = true;
    runBtn.textContent = '回测中…';
    resultDiv.innerHTML = '<div class="card"><p class="muted center">正在计算回测数据…</p></div>';

    try {
      const res = await api(`/backtest?code=${code}&days=${days}`);
      renderBacktestResult(res, code, days);
    } catch (e) {
      resultDiv.innerHTML = `<div class="card"><p class="error">回测失败：${e.message}</p></div>`;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '开始回测';
    }
  };
}

function renderBacktestResult(res, code, days) {
  const div = document.querySelector('#bt-result');
  if (!res.ok || !res.signals || res.signals.length === 0) {
    div.innerHTML = `<div class="card"><p class="muted center">未产生任何交易信号，可能数据不足或该时间段内无金叉/死叉。</p></div>`;
    return;
  }

  const winRateColor = res.winRate >= 50 ? 'var(--red, #c0392b)' : 'var(--green, #27ae60)';
  const totalReturnColor = res.totalReturn >= 0 ? 'var(--red, #c0392b)' : 'var(--green, #27ae60)';

  // 信号列表（最近 20 条）
  const recentSignals = res.signals.slice(-20).reverse();
  const signalRows = recentSignals.map(s => {
    const isWin = s.profit !== undefined && s.profit > 0;
    const actionColor = s.action === 'buy' ? 'var(--red, #c0392b)' : 'var(--green, #27ae60)';
    return `
      <tr>
        <td>${s.date}</td>
        <td style="color:${actionColor};font-weight:600">${s.action === 'buy' ? '买入' : '卖出'}</td>
        <td class="tnum">${Number(s.price).toFixed(2)}</td>
        ${s.profit !== undefined ? `<td class="tnum" style="color:${isWin ? 'var(--red,#c0392b)' : 'var(--green,#27ae60)'}">${s.profit > 0 ? '+' : ''}${s.profit.toFixed(2)}%</td>` : '<td class="muted">—</td>'}
      </tr>`;
  }).join('');

  div.innerHTML = `
    <section class="card">
      <h2>回测结果 · ${code}</h2>
      <p class="muted">回测周期 ${days} 天 · 共 ${res.signalCount || res.signals.length} 个信号</p>
      <div class="bt-stats">
        <div class="bt-stat">
          <span class="bt-stat-label">胜率</span>
          <span class="bt-stat-val tnum" style="color:${winRateColor}">${res.winRate.toFixed(1)}%</span>
        </div>
        <div class="bt-stat">
          <span class="bt-stat-label">总收益</span>
          <span class="bt-stat-val tnum" style="color:${totalReturnColor}">${res.totalReturn >= 0 ? '+' : ''}${res.totalReturn.toFixed(2)}%</span>
        </div>
        <div class="bt-stat">
          <span class="bt-stat-label">最大回撤</span>
          <span class="bt-stat-val tnum" style="color:var(--green,#27ae60)">${res.maxDrawdown.toFixed(2)}%</span>
        </div>
        <div class="bt-stat">
          <span class="bt-stat-label">盈利次数</span>
          <span class="bt-stat-val tnum">${res.wins} / ${res.signals.filter(s => s.action === 'sell').length}</span>
        </div>
      </div>
    </section>
    <section class="card">
      <h3>交易信号明细（最近 20 条）</h3>
      <div class="table-wrap">
        <table class="bt-table">
          <thead><tr><th>日期</th><th>操作</th><th>价格</th><th>收益</th></tr></thead>
          <tbody>${signalRows}</tbody>
        </table>
      </div>
    </section>
    ${res.disclaimer ? `<p class="muted small center bt-disclaimer">${res.disclaimer}</p>` : ''}
  `;
}

// --- 体检分有效性验证页面 ---
async function validatePage() {
  const main = document.querySelector('main');
  main.innerHTML = `
    <section class="card">
      <h2>体检分有效性验证</h2>
      <p class="muted">将历史体检评分与后续实际涨跌对比，验证体检分的预测能力。按绿灯 / 黄灯 / 红灯分组统计平均涨跌和胜率。</p>
      <div class="bt-form">
        <div class="bt-field">
          <label class="cfg-label" for="val-days">预测周期</label>
          <select class="cfg-input" id="val-days">
            <option value="3">3 天</option>
            <option value="5" selected>5 天</option>
            <option value="10">10 天</option>
            <option value="20">20 天</option>
          </select>
        </div>
        <button class="bt-run" id="val-run">开始验证</button>
      </div>
    </section>
    <div id="val-result"></div>
  `;

  const runBtn = document.querySelector('#val-run');
  const resultDiv = document.querySelector('#val-result');

  runBtn.onclick = async () => {
    const days = document.querySelector('#val-days').value;
    runBtn.disabled = true;
    runBtn.textContent = '验证中…';
    resultDiv.innerHTML = '<div class="card"><p class="muted center">正在分析历史体检数据…</p></div>';

    try {
      const res = await api(`/validate?days=${days}`);
      renderValidateResult(res);
    } catch (e) {
      resultDiv.innerHTML = `<div class="card"><p class="error">验证失败：${e.message}</p></div>`;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '开始验证';
    }
  };
}

function renderValidateResult(res) {
  const div = document.querySelector('#val-result');

  if (!res.samples || res.samples === 0) {
    div.innerHTML = `<div class="card"><p class="muted center">${res.message || '历史体检记录不足，无法验证。请多使用体检功能积累数据后再试。'}</p></div>`;
    return;
  }

  const lightColors = { green: 'var(--red,#c0392b)', yellow: 'var(--blue,#3d5a96)', red: 'var(--green,#27ae60)' };
  const groupCards = Object.entries(res.groups).map(([key, g]) => {
    const retColor = g.avgReturn >= 0 ? 'var(--red,#c0392b)' : 'var(--green,#27ae60)';
    const winColor = g.winRate >= 50 ? 'var(--red,#c0392b)' : 'var(--green,#27ae60)';
    return `
      <div class="bt-stat">
        <span class="bt-stat-label">${g.name}（${g.count} 样本）</span>
        <span class="bt-stat-val tnum" style="color:${retColor}">${g.avgReturn >= 0 ? '+' : ''}${g.avgReturn}%</span>
        <span class="bt-stat-sub tnum" style="color:${winColor}">胜率 ${g.winRate}%</span>
      </div>`;
  }).join('');

  const detailRows = (res.detail || []).map(d => {
    const retColor = d.forwardReturn >= 0 ? 'var(--red,#c0392b)' : 'var(--green,#27ae60)';
    const lightBadge = d.light === 'green' ? '绿灯' : d.light === 'yellow' ? '黄灯' : '红灯';
    const badgeColor = lightColors[d.light] || 'var(--text-mid,#666)';
    return `
      <tr>
        <td class="tnum">${d.code}</td>
        <td>${d.name || '—'}</td>
        <td class="tnum">${d.date}</td>
        <td class="tnum" style="color:${badgeColor};font-weight:600">${d.health}（${lightBadge}）</td>
        <td class="tnum" style="color:${retColor}">${d.forwardReturn >= 0 ? '+' : ''}${d.forwardReturn}%</td>
      </tr>`;
  }).join('');

  div.innerHTML = `
    <section class="card">
      <h2>验证结果 · ${res.forwardDays} 天预测周期</h2>
      <p class="muted">总样本 ${res.samples} 条 · 整体上涨概率 <strong class="tnum">${res.totalWinRate}%</strong></p>
      <div class="bt-stats">${groupCards}</div>
    </section>
    ${res.detail && res.detail.length > 0 ? `
    <section class="card">
      <h3>样本明细（最近 ${res.detail.length} 条）</h3>
      <div class="table-wrap">
        <table class="bt-table">
          <thead><tr><th>代码</th><th>名称</th><th>体检日期</th><th>体检分</th><th>${res.forwardDays}日涨跌</th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </section>` : ''}
    ${res.disclaimer ? `<p class="muted small center bt-disclaimer">${res.disclaimer}</p>` : ''}
  `;
}

// --- 通用 Tooltip ---
let _tipTimer = null;
function showTooltip(e, el) {
  hideTooltip();
  const tip = document.createElement('div');
  tip.className = 'ct-tooltip';
  tip.id = 'ctTooltip';
  const meaning = el.dataset.tooltip || '';
  const signal = el.dataset.tooltipSignal || '';
  tip.innerHTML = `<div class="ct-tt-mean">${meaning}</div>${signal ? `<div class="ct-tt-signal">📌 ${signal}</div>` : ''}`;
  document.body.appendChild(tip);
  const rect = el.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left + rect.width / 2;
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
  tip.style.transform = 'translateX(-50%)';
  // Ensure within viewport
  const tr = tip.getBoundingClientRect();
  if (tr.right > window.innerWidth - 8) tip.style.left = (window.innerWidth - tr.width - 8) + 'px';
  if (tr.left < 8) tip.style.left = '8px';
  if (tr.bottom > window.innerHeight - 8) tip.style.top = (rect.top - tr.height - 6) + 'px';
}
function hideTooltip() {
  const t = document.getElementById('ctTooltip');
  if (t) t.remove();
  clearTimeout(_tipTimer);
}
// Delegated event listeners for all has-tip elements
document.addEventListener('mouseover', e => {
  const el = e.target.closest('.has-tip');
  if (!el || !el.dataset.tooltip) return;
  _tipTimer = setTimeout(() => showTooltip(e, el), 300);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest('.has-tip');
  if (!el) return;
  clearTimeout(_tipTimer);
  hideTooltip();
});
document.addEventListener('touchstart', e => {
  const el = e.target.closest('.has-tip');
  if (!el || !el.dataset.tooltip) return;
  e.preventDefault();
  showTooltip(e, el);
  _tipTimer = setTimeout(hideTooltip, 2800);
});


// --- 工作台：持仓管理（P0）---
async function portfolioPage() {
  loading();
  try {
    const data = await api('/portfolio');
    const { positions, summary } = data;
    const fmt = (v, digits = 2) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const pnlCls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
    const pnlTxt = v => (v > 0 ? '+' : '') + fmt(v);

    // 汇总卡
    const summaryCards = `
      <div class="port-summary">
        <div class="ps-card"><div class="ps-label">总市值</div><div class="ps-value">¥${fmt(summary.totalValue)}</div></div>
        <div class="ps-card"><div class="ps-label">总成本</div><div class="ps-value" style="color:var(--muted)">¥${fmt(summary.totalCost)}</div></div>
        <div class="ps-card ${summary.totalPnl >= 0 ? '' : ''}"><div class="ps-label">浮动盈亏</div><div class="ps-value ${pnlCls(summary.totalPnl)}">${pnlTxt(summary.totalPnl)}</div><div class="ps-sub ${pnlCls(summary.totalPnl)}">${pnlTxt(summary.totalPnlPct)}%</div></div>
        <div class="ps-card"><div class="ps-label">今日盈亏</div><div class="ps-value ${pnlCls(summary.todayPnl)}">${pnlTxt(summary.todayPnl)}</div><div class="ps-sub">按今日涨跌幅估算</div></div>
        <div class="ps-card"><div class="ps-label">持仓数</div><div class="ps-value">${summary.count} 只</div></div>
      </div>`;

    // 持仓表格
    const rows = positions.length ? positions.map(p => `
      <tr data-id="${p.id}">
        <td><b>${escape(p.name)}</b><br><small>${p.code}</small></td>
        <td>${p.shares}</td>
        <td>¥${fmt(p.costPrice)}</td>
        <td>¥${fmt(p.price)}</td>
        <td class="${pnlCls(p.pnl)}"><b>${pnlTxt(p.pnl)}</b></td>
        <td class="${pnlCls(p.pnlPct)}">${pnlTxt(p.pnlPct)}%</td>
        <td>${p.cost > 0 ? fmt((p.cost / (summary.totalCost || 1)) * 100, 1) + '%' : '—'}</td>
        <td>${p.price ? (p.price >= p.costPrice ? '<span class="lightdot green">🟢 盈利</span>' : '<span class="lightdot red">🔴 亏损</span>') : '<span class="lightdot idle">—</span>'}</td>
        <td><button class="mini" data-act="check" data-code="${p.code}">体检</button> <button class="mini" data-act="edit" data-id="${p.id}">编辑</button></td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty">还没有持仓，点击右上角「添加持仓」开始记录</td></tr>';

    layout('工作台 · 我的持仓', `
      <div class="port-toolbar">
        <button class="primary" id="addPosBtn">＋ 添加持仓</button>
        <button class="outline" id="checkAllPos">⚡ 体检全部持仓</button>
        <button class="outline" id="refreshPos">↻ 刷新行情</button>
      </div>
      ${summaryCards}
      <div id="port-check-slot"></div>
      ${card('持仓明细', `<div class="table-wrap"><table><thead><tr><th>股票</th><th>持仓数</th><th>成本价</th><th>现价</th><th>浮动盈亏</th><th>收益率</th><th>仓位</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`, 'report-card')}
      ${card('交易流水', '<div id="trade-list"><p class="empty">加载中…</p></div>')}
      <div id="addPosModal" class="modal" style="display:none">
        <div class="modal-box">
          <h3>添加持仓</h3>
          <label>股票代码 <input id="pos-code" placeholder="6位代码，如 600519" maxlength="6"></label>
          <label>股票名称（可选，留空自动获取） <input id="pos-name" placeholder="如 贵州茅台"></label>
          <label>持仓数量 <input id="pos-shares" type="number" placeholder="100" min="1"></label>
          <label>成本价 <input id="pos-cost" type="number" placeholder="1450.50" min="0.01" step="0.01"></label>
          <label>备注（买入理由） <input id="pos-note" placeholder="可选"></label>
          <div class="modal-actions"><button class="outline" id="pos-cancel">取消</button><button class="primary" id="pos-save">保存</button></div>
        </div>
      </div>
      <div id="editPosModal" class="modal" style="display:none">
        <div class="modal-box">
          <h3>编辑持仓</h3>
          <label>持仓数量 <input id="edit-shares" type="number" min="0" step="1"></label>
          <p style="font-size:12px;color:var(--muted)">改为 0 表示清仓（记一笔卖出流水）</p>
          <label>成本价 <input id="edit-cost" type="number" min="0.01" step="0.01"></label>
          <label>备注 <input id="edit-note"></label>
          <div class="modal-actions"><button class="outline danger" id="edit-del" style="color:var(--red)">删除持仓</button><span style="flex:1"></span><button class="outline" id="edit-cancel">取消</button><button class="primary" id="edit-save">保存</button></div>
        </div>
      </div>`);
    document.title = '工作台 · 牛股体检站';

    // 事件绑定
    let _editId = null;
    const openAdd = () => { document.querySelector('#addPosModal').style.display = 'flex'; };
    const closeAdd = () => { document.querySelector('#addPosModal').style.display = 'none'; };
    const openEdit = (id) => {
      const pos = positions.find(p => p.id === id);
      if (!pos) return;
      _editId = id;
      document.querySelector('#edit-shares').value = pos.shares;
      document.querySelector('#edit-cost').value = pos.costPrice;
      document.querySelector('#edit-note').value = pos.note || '';
      document.querySelector('#editPosModal').style.display = 'flex';
    };
    const closeEdit = () => { document.querySelector('#editPosModal').style.display = 'none'; };

    document.querySelector('#addPosBtn').onclick = openAdd;
    document.querySelector('#pos-cancel').onclick = closeAdd;
    document.querySelector('#edit-cancel').onclick = closeEdit;
    document.querySelector('#edit-del').onclick = async () => {
      if (!_editId) return;
      if (!confirm('确认删除该持仓？')) return;
      await api(`/portfolio/${_editId}`, { method: 'DELETE' });
      closeEdit(); notice('已删除', true); portfolioPage();
    };
    document.querySelector('#pos-save').onclick = async () => {
      const code = document.querySelector('#pos-code').value.trim();
      const shares = document.querySelector('#pos-shares').value;
      const costPrice = document.querySelector('#pos-cost').value;
      if (!/^\d{6}$/.test(code)) return notice('请输入6位股票代码');
      if (!shares || Number(shares) <= 0) return notice('请输入正确的持仓数量');
      if (!costPrice || Number(costPrice) <= 0) return notice('请输入正确的成本价');
      try {
        await api('/portfolio', { method: 'POST', body: JSON.stringify({
          code, name: document.querySelector('#pos-name').value.trim(), shares: Number(shares), costPrice: Number(costPrice), note: document.querySelector('#pos-note').value.trim() }) });
        closeAdd(); notice('已添加持仓', true); portfolioPage();
      } catch (e) { notice(e.message); }
    };
    document.querySelector('#edit-save').onclick = async () => {
      if (!_editId) return;
      const shares = document.querySelector('#edit-shares').value;
      const costPrice = document.querySelector('#edit-cost').value;
      try {
        await api(`/portfolio/${_editId}`, { method: 'PUT', body: JSON.stringify({ shares: Number(shares), costPrice: Number(costPrice), note: document.querySelector('#edit-note').value.trim() }) });
        closeEdit(); notice('已保存', true); portfolioPage();
      } catch (e) { notice(e.message); }
    };
    document.querySelector('#refreshPos').onclick = () => portfolioPage();
    document.querySelector('#checkAllPos').onclick = async () => {
      const btn = document.querySelector('#checkAllPos');
      btn.disabled = true; btn.textContent = '体检中…';
      const slot = document.querySelector('#port-check-slot');
      const results = [];
      for (let i = 0; i < positions.length; i++) {
        btn.textContent = `体检中… ${i+1}/${positions.length}`;
        try { const r = await api(`/stocks/${positions[i].code}/report`); results.push(r); }
        catch { results.push(null); }
      }
      btn.disabled = false; btn.textContent = '⚡ 体检全部持仓';
      const ok = results.filter(Boolean);
      const cnt = { red: 0, yellow: 0, green: 0 };
      ok.forEach(r => { if (cnt[r.light] != null) cnt[r.light]++; });
      slot.innerHTML = `<div class="checkdone">✓ 已完成 ${ok.length}/${positions.length} 只体检：🔴 ${cnt.red} / 🟡 ${cnt.yellow} / 🟢 ${cnt.green}</div>
        <div style="display:flex;flex-direction:column;gap:8px">${ok.map(r => `<div class="port-result" data-code="${r.code}" style="display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;cursor:pointer"><span class="lightdot ${r.light}">${r.light === 'green' ? '🟢' : r.light === 'yellow' ? '🟡' : '🔴'} ${r.band} ${r.health}分</span><b>${escape(r.name)}</b><small>${r.code}</small><span style="margin-left:auto;color:var(--muted);font-size:12px">点击查看详情 →</span></div>`).join('')}</div>`;
      slot.querySelectorAll('.port-result').forEach(el => el.onclick = () => { location.hash = `#/check/${el.dataset.code}`; });
    };
    // 表格操作按钮
    document.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.querySelectorAll('button[data-act="edit"]').forEach(b => b.onclick = e => { e.stopPropagation(); openEdit(b.dataset.id); });
      tr.querySelectorAll('button[data-act="check"]').forEach(b => b.onclick = e => { e.stopPropagation(); location.hash = `#/check/${b.dataset.code}`; });
      tr.onclick = () => { const code = tr.dataset.code; if (code) location.hash = `#/check/${code}`; };
    });
    // 交易流水
    try {
      const t = await api('/portfolio/trades');
      const list = document.querySelector('#trade-list');
      list.innerHTML = t.trades.length ? t.trades.map(x => `
        <div class="trade-item"><span class="tdir ${x.direction}">${x.direction === 'buy' ? '买入' : '卖出'}</span><b>${escape(x.name)}</b><small>${x.code}</small><span>${x.shares}股 × ¥${fmt(x.price)}</span><span class="tamt">¥${fmt(x.amount)}</span><span class="tdate">${date(x.createdAt)}</span>${x.reason ? `<span class="treason">📝 ${escape(x.reason)}</span>` : ''}</div>`).join('')
        : '<p class="empty">还没有交易记录</p>';
    } catch { document.querySelector('#trade-list').innerHTML = '<p class="empty">加载失败</p>'; }
  } catch (e) { checkPage(); notice(e.message); }
}

// --- 提醒系统（P1）---
async function alertsPage() {
  loading();
  let rules = [], pending = [], unreadCount = 0;
  try {
    const data = await api('/alerts');
    rules = data.rules || []; pending = data.pending || []; unreadCount = data.unreadCount || 0;
  } catch { /* 首次访问时文件未创建，正常 */ }
  layout('价格提醒', `
    <p class="intro">为关注的股票设置价格/涨跌幅提醒，触发后会在「待读提醒」中显示（5 分钟内同条规则不重复触发）。数据保存在本机。</p>
    <div class="port-toolbar">
      <button class="primary" id="addAlertBtn">＋ 新建提醒</button>
      <button class="outline" id="refreshAlerts">↻ 刷新</button>
      <button class="outline" id="readAllAlerts">✓ 全部标为已读${unreadCount ? `（${unreadCount}）` : ''}</button>
    </div>
    <div id="pending-slot"></div>
    <div id="rules-slot"></div>
    <div id="alertModal" class="modal" style="display:none">
      <div class="modal-box">
        <h3>新建提醒</h3>
        <label>股票代码 <input id="alert-code" placeholder="6位代码，如 600519" maxlength="6"></label>
        <label>股票名称（可选） <input id="alert-name" placeholder="如 贵州茅台"></label>
        <label>提醒类型
          <select id="alert-type">
            <option value="price">价格</option>
            <option value="pct">涨跌幅(%)</option>
          </select>
        </label>
        <label>触发条件
          <select id="alert-condition">
            <option value=">=">≥ 上穿</option>
            <option value="<=">≤ 下穿</option>
          </select>
        </label>
        <label>阈值 <input id="alert-value" type="number" step="0.01" placeholder="如 1500 或 -3"></label>
        <div class="modal-actions"><button class="outline" id="alert-cancel">取消</button><button class="primary" id="alert-save">保存</button></div>
      </div>
    </div>`);

  const renderPending = () => {
    const slot = document.querySelector('#pending-slot');
    if (!slot) return;
    const unread = pending.filter(p => !p.read);
    const recent = pending.slice(0, 20);
    slot.innerHTML = recent.length
      ? `<article class="card"><h2>待读提醒${unread.length ? ` <span class="lightdot red">${unread.length}</span>` : ''}</h2><div class="alert-list">${recent.map(p => `<div class="alert-item ${p.read ? 'read' : 'unread'}"><span class="alert-msg">${escape(p.message)}</span><time>${date(p.time)}</time></div>`).join('')}</div></article>`
      : '<article class="card"><h2>待读提醒</h2><p class="empty">暂无触发的提醒</p></article>';
  };
  const renderRules = () => {
    const slot = document.querySelector('#rules-slot');
    if (!slot) return;
    slot.innerHTML = rules.length
      ? `<article class="card"><h2>提醒规则</h2><div class="table-wrap"><table><thead><tr><th>股票</th><th>类型</th><th>条件</th><th>阈值</th><th>状态</th><th>操作</th></tr></thead><tbody>${rules.map(r => `<tr data-id="${r.id}"><td><b>${escape(r.name || r.code)}</b><br><small>${r.code}</small></td><td>${r.type === 'price' ? '价格' : '涨跌幅'}</td><td>${r.condition}</td><td>${r.type === 'price' ? number(r.value) : r.value + '%'}</td><td>${r.enabled ? '<span class="lightdot green">启用</span>' : '<span class="lightdot idle">停用</span>'}</td><td><button class="mini danger" data-del="${r.id}">删除</button></td></tr>`).join('')}</tbody></table></div></article>`
      : '<article class="card"><h2>提醒规则</h2><p class="empty">还没有提醒规则，点上方「新建提醒」创建一个。</p></article>';
    slot.querySelectorAll('button[data-del]').forEach(b => b.onclick = async () => {
      try { await api(`/alerts/${b.dataset.del}`, { method: 'DELETE' }); notice('已删除', true); alertsPage(); }
      catch (e) { notice(e.message); }
    });
  };
  renderPending(); renderRules();

  document.querySelector('#addAlertBtn').onclick = () => { document.querySelector('#alertModal').style.display = 'flex'; };
  document.querySelector('#alert-cancel').onclick = () => { document.querySelector('#alertModal').style.display = 'none'; };
  document.querySelector('#alert-save').onclick = async () => {
    const code = document.querySelector('#alert-code').value.trim();
    if (!/^\d{6}$/.test(code)) return notice('请输入6位股票代码');
    const value = Number(document.querySelector('#alert-value').value);
    if (!Number.isFinite(value)) return notice('请输入有效的阈值');
    try {
      await api('/alerts', { method: 'POST', body: JSON.stringify({
        code,
        name: document.querySelector('#alert-name').value.trim(),
        type: document.querySelector('#alert-type').value,
        condition: document.querySelector('#alert-condition').value,
        value,
      }) });
      document.querySelector('#alertModal').style.display = 'none';
      notice('提醒已创建', true); alertsPage();
    } catch (e) { notice(e.message); }
  };
  document.querySelector('#refreshAlerts').onclick = async () => {
    try { const data = await api('/alerts/pending'); pending = data.pending || []; renderPending(); notice('已刷新', true); }
    catch (e) { notice(e.message); }
  };
  document.querySelector('#readAllAlerts').onclick = async () => {
    try { await api('/alerts/readall', { method: 'PUT' }); pending = pending.map(p => ({ ...p, read: true })); renderPending(); AlertNotifier._updateBadge(0); notice('已全部标为已读', true); }
    catch (e) { notice(e.message); }
  };
  // Notification toggle
  const notifySwitch = document.querySelector('#notifySwitch');
  if (notifySwitch) {
    notifySwitch.checked = AlertNotifier.isEnabled;
    notifySwitch.onchange = () => {
      if (notifySwitch.checked) AlertNotifier.enable();
      else AlertNotifier.disable();
    };
  }
}

// --- 决策笔记（P2）---
async function notesPage() {
  loading();
  let notes = [];
  try { const data = await api('/notes'); notes = data.notes || []; } catch {}
  layout('决策笔记', `
    <p class="intro">记录每次买卖决策的理由、结果和教训，复盘才能进步。数据保存在本机。</p>
    <div class="port-toolbar"><button class="primary" id="addNoteBtn">＋ 新建笔记</button></div>
    <div id="notes-list"></div>
    <div id="noteModal" class="modal" style="display:none">
      <div class="modal-box">
        <h3>新建笔记</h3>
        <label>股票代码 <input id="note-code" placeholder="6位代码，如 600519" maxlength="6"></label>
        <label>股票名称（可选） <input id="note-name" placeholder="如 贵州茅台"></label>
        <label>方向
          <select id="note-direction">
            <option value="buy">买入</option>
            <option value="sell">卖出</option>
            <option value="watch">观望</option>
          </select>
        </label>
        <label>理由 <textarea id="note-reason" rows="2" placeholder="为什么这么操作？"></textarea></label>
        <label>结果 <input id="note-result" placeholder="对/错（事后填写）"></label>
        <label>教训 <textarea id="note-lesson" rows="2" placeholder="下次该怎么改进？"></textarea></label>
        <div class="modal-actions"><button class="outline" id="note-cancel">取消</button><button class="primary" id="note-save">保存</button></div>
      </div>
    </div>`);
  const dirMeta = { buy: { txt: '买入', cls: 'up' }, sell: { txt: '卖出', cls: 'down' }, watch: { txt: '观望', cls: '' } };
  const render = () => {
    const slot = document.querySelector('#notes-list');
    slot.innerHTML = notes.length
      ? notes.map(n => {
          const m = dirMeta[n.direction] || { txt: n.direction, cls: '' };
          return `<article class="card note-item"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span class="tdir ${n.direction}" style="padding:2px 8px;border-radius:6px;font-size:12px;font-weight:700;background:${n.direction === 'buy' ? 'var(--red-soft)' : n.direction === 'sell' ? 'var(--good-soft)' : 'var(--line-soft)'};color:${n.direction === 'buy' ? 'var(--red)' : n.direction === 'sell' ? 'var(--good)' : 'var(--muted)'}">${m.txt}</span><b>${escape(n.name || n.code)}</b><small>${n.code}</small><time style="margin-left:auto;color:var(--muted);font-size:12px">${date(n.createdAt)}</time><button class="mini danger" data-del="${n.id}">删除</button></div>${n.reason ? `<p><b>理由：</b>${escape(n.reason)}</p>` : ''}${n.result ? `<p><b>结果：</b>${escape(n.result)}</p>` : ''}${n.lesson ? `<p><b>教训：</b>${escape(n.lesson)}</p>` : ''}</article>`;
        }).join('')
      : '<p class="empty">还没有笔记，点上方「新建笔记」记录第一笔决策。</p>';
    slot.querySelectorAll('button[data-del]').forEach(b => b.onclick = async () => {
      try { await api(`/notes/${b.dataset.del}`, { method: 'DELETE' }); notice('已删除', true); notesPage(); }
      catch (e) { notice(e.message); }
    });
  };
  render();
  document.querySelector('#addNoteBtn').onclick = () => { document.querySelector('#noteModal').style.display = 'flex'; };
  document.querySelector('#note-cancel').onclick = () => { document.querySelector('#noteModal').style.display = 'none'; };
  document.querySelector('#note-save').onclick = async () => {
    const code = document.querySelector('#note-code').value.trim();
    const direction = document.querySelector('#note-direction').value;
    if (!/^\d{6}$/.test(code)) return notice('请输入6位股票代码');
    try {
      await api('/notes', { method: 'POST', body: JSON.stringify({
        code,
        name: document.querySelector('#note-name').value.trim(),
        direction,
        reason: document.querySelector('#note-reason').value.trim(),
        result: document.querySelector('#note-result').value.trim(),
        lesson: document.querySelector('#note-lesson').value.trim(),
      }) });
      document.querySelector('#noteModal').style.display = 'none';
      notice('笔记已保存', true); notesPage();
    } catch (e) { notice(e.message); }
  };
}

// --- 大盘指数栏 ---
async function loadIndices() {
  const bar = document.querySelector('#indices-bar');
  if (!bar) return;
  try {
    const { indices } = await api('/indices');
    if (!indices || !indices.length) { bar.style.display = 'none'; return; }
    bar.innerHTML = indices.map(idx => {
      const cls = idx.changePct > 0 ? 'up' : idx.changePct < 0 ? 'down' : '';
      const arrow = idx.changePct > 0 ? '▲' : idx.changePct < 0 ? '▼' : '—';
      return `<div class="idx-card ${cls}">
        <span class="idx-name">${escape(idx.name)}</span>
        <span class="idx-price">${number(idx.price)}</span>
        <span class="idx-chg">${arrow} ${Math.abs(idx.changePct).toFixed(2)}%</span>
      </div>`;
    }).join('');
  } catch { bar.style.display = 'none'; }
}

function router() {
  const path = location.hash.slice(2) || 'check';
  if (path.startsWith('check/')) { const code = path.split('/')[1]; checkPage(); setTimeout(() => { document.querySelector('#stock-input').value = code; api(`/stocks/${code}/report`).then(r => { const scanSlot = document.querySelector('#scan-slot'); if (scanSlot) playScanAnim(scanSlot, Promise.resolve({j:r}), {title:'个股体检中'}).then(({j}) => j && renderReport(j)); }).catch(e => notice(e.message)); }, 100); return; }
  ({ check: checkPage, screen: screenPage, backtest: backtestPage, validate: validatePage, rules: rulesPage, portfolio: portfolioPage, alerts: alertsPage, notes: notesPage }[path] || checkPage)();
}
loadIndices();
setInterval(loadIndices, 60000);
router(); window.addEventListener('hashchange', router);

// 导航栏点击：当 hash 相同时强制刷新页面（解决"已在体检页点导航回不去"问题）
document.querySelectorAll('header nav a, header .brand').forEach(a => {
  a.addEventListener('click', () => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#/') && location.hash === href) {
      router(); // hash 没变，手动触发路由
    }
  });
});

// --- 提醒推送化 (P2-4) ---
const AlertNotifier = {
  _timer: null,
  _lastNotifyIds: new Set(),
  _enabled: false,

  init() {
    // Check localStorage for notification preference
    this._enabled = localStorage.getItem('alert_notify') === 'true';
    if (this._enabled && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        this.start();
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => {
          if (p === 'granted') this.start();
          else { this._enabled = false; localStorage.setItem('alert_notify', 'false'); }
        });
      }
    }
  },

  enable() {
    if (!('Notification' in window)) { notice('当前浏览器不支持通知'); return false; }
    if (Notification.permission === 'granted') {
      this._enabled = true; localStorage.setItem('alert_notify', 'true'); this.start();
      return true;
    }
    if (Notification.permission === 'denied') {
      notice('通知权限已被拒绝，请在浏览器设置中手动开启');
      return false;
    }
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        this._enabled = true; localStorage.setItem('alert_notify', 'true'); this.start();
        notice('通知推送已开启', true);
      } else {
        notice('通知权限未授权');
      }
    });
    return true;
  },

  disable() {
    this._enabled = false; localStorage.setItem('alert_notify', 'false');
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    notice('通知推送已关闭');
  },

  get isEnabled() { return this._enabled; },

  start() {
    if (this._timer) return;
    // Poll every 60 seconds
    this._check();
    this._timer = setInterval(() => this._check(), 60000);
  },

  async _check() {
    if (!this._enabled) return;
    try {
      const data = await fetch('/api/alerts/pending').then(r => r.json());
      if (!data.ok) return;
      // Update nav badge
      this._updateBadge(data.unreadCount || 0);
      // Push browser notifications for new triggers
      if (data.pending && Notification.permission === 'granted') {
        for (const p of data.pending) {
          if (!p.read && !this._lastNotifyIds.has(p.id)) {
            this._lastNotifyIds.add(p.id);
            new Notification('\u26a0\ufe0f \u63d0\u9192\u89e6\u53d1', {
              body: p.message,
              icon: '/favicon.ico',
              tag: p.id,
            });
          }
        }
        // Keep only recent 50 ids
        if (this._lastNotifyIds.size > 50) {
          const arr = [...this._lastNotifyIds];
          this._lastNotifyIds = new Set(arr.slice(-50));
        }
      }
    } catch {}
  },

  _updateBadge(count) {
    let badge = document.querySelector('#alert-badge');
    const navLink = document.querySelector('header nav a[href="#/alerts"]');
    if (!navLink) return;
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'alert-badge';
        badge.className = 'nav-badge';
        navLink.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : count;
    } else if (badge) {
      badge.remove();
    }
  },
};

AlertNotifier.init();
