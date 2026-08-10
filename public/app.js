const app = document.querySelector('#app');
const api = (path, options = {}) => fetch(`/api${path}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options }).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || '请求失败'); return data; });
const escape = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' })[x]);
const number = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function notice(message, good = false) { const node = document.createElement('div'); node.className = `toast ${good ? 'good' : ''}`; node.textContent = message; document.body.append(node); setTimeout(() => node.remove(), 2600); }
function layout(title, content, intro = '') { document.title = `${title} · 牛股体检站`; app.innerHTML = `<section class="page"><h1>${title}</h1>${intro ? `<p class="intro">${intro}</p>` : ''}${content}</section>`; }
function card(title, body, cls='') { return `<article class="card ${cls}">${title ? `<h2>${title}</h2>` : ''}${body}</article>`; }
function loading() { app.innerHTML = '<section class="page"><div class="loading">正在读取市场数据…</div></section>'; }

// --- 形态标签 ---
function patternChips(patterns) {
  if (!patterns || !patterns.length) return '<span class="patchip neu">无明显形态</span>';
  return patterns.map(p => `<span class="patchip ${p.dir === 'bull' ? 'bull' : p.dir === 'bear' ? 'bear' : 'neu'}">${p.name}</span>`).join('');
}

// --- 四方会诊渲染 ---
function renderConsult(c) {
  if (!c) return '';
  const colors = { green: '#e9f6ef', red: '#fdeeea', yellow: '#fdf6e3', neutral: '#f7f9fd' };
  const borders = { green: '#cce8d8', red: '#f3cfc9', yellow: '#f0e2b4', neutral: '#e6ebf4' };
  const row = (ic, nm, L) => {
    const cls = L.includes('偏多') ? 'green' : L.includes('偏空') ? 'red' : 'neutral';
    const col = { green: '#247a52', red: '#bb4339', neutral: '#76819a' }[cls];
    return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12.5px"><span style="width:92px;color:#76819a">${ic} ${nm}</span><b style="color:${col}">${escape(L)}</b></div>`;
  };
  return `<div style="margin:10px 0 6px;padding:11px 13px;background:${colors[c.cls]};border:1px solid ${borders[c.cls]};border-radius:11px;font-size:13px;line-height:1.6">
    <b>🩺 四方会诊</b>（蜡烛短线 / 趋势结构 / 摆动动量 / 图表中线，四路独立判向）
    ${row('🕯️', '蜡烛形态', c.L1)}${row('📉', '趋势·破位', c.L2)}${row('📊', '摆动指标', c.L3)}${row('📐', '图表形态', c.L4)}
    <div style="margin-top:6px;padding-top:6px;border-top:1px dashed ${borders[c.cls]}"><b>综合：</b>${c.bulls} 方偏多 / ${c.bears} 方偏空 → ${c.verdict}</div>
  </div>`;
}

// --- 摆动指标组渲染 ---
function renderMurphy(m) {
  if (!m || !m.ok) return '';
  const rows = m.factors.map(f => {
    const cls = f.dir === 'bull' ? 'pos' : f.dir === 'bear' ? 'neg' : 'neu';
    const badge = f.pts > 0 ? '+' + f.pts : f.pts < 0 ? '' + f.pts : '·';
    return `<div class="dimrow2 ${cls}"><span class="fpts ${f.pts ? '' : 'idle'}">${badge}</span><span class="dn">${escape(f.name)}</span><span class="dwhy">${escape(f.plain)}</span></div>`;
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
    return `<div class="dimrow2 ${cls}"><span class="fpts ${p.pts ? '' : 'idle'}">${badge}</span><span class="dn">${escape(p.name)}</span><span class="dwhy">${conf}${escape(p.plain)}</span></div>`;
  }).join('');
  return `<div class="seclbl">经典图表形态<span style="font-weight:400;color:#9098a9;font-size:12px">（本组 ${cp.pts > 0 ? '+' + cp.pts : cp.pts} 分）</span></div><div class="dims">${rows}</div>`;
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
  try { j = (await fetchP).j || (await fetchP); } catch (e) { j = null; }
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
  layout('个股体检', `<div class="result-title"><div><h2>${escape(data.name)} <small>${data.code}</small></h2><p>数据更新时间：${escape(data.quote.updatedAt || data.last_date || '最近交易日')}</p></div><button id="back" class="outline">重新体检</button></div>
    <div class="overview"><div><span>最新价</span><b class="${data.quote.changePct >= 0 ? 'up' : 'down'}">${number(data.last_close || data.quote.price)}</b><em>${data.quote.changePct >= 0 ? '+' : ''}${number(data.quote.changePct)}%</em></div>
    <div><span>技术健康分</span><b class="score s${Math.floor(data.health/10)}">${data.health}</b><em>${data.band}</em></div>
    <div><span>量比</span><b>${number(data.vol_ratio || data.quote.volumeRatio)}</b><em>换手 ${number(data.quote.turnoverPct)}%</em></div>
    <div><span>市值</span><b>${number(data.quote.marketCapYi)} 亿</b><em>PE ${number(data.quote.pe)}</em></div></div>
    <div class="report-grid"><article class="card"><h2>趋势与价格</h2><div id="chart" class="chart"></div>
    <div class="legend" style="display:flex;gap:13px;flex-wrap:wrap;font-size:11px;color:#76819a;padding:2px 6px 8px"><i><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#d8584d;vertical-align:middle;margin-right:3px"></span>红=涨</i><i><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#3a9e6e;vertical-align:middle;margin-right:3px"></span>绿=跌</i><i><span style="display:inline-block;width:9px;height:2px;background:#4f6cae;vertical-align:middle;margin-right:3px"></span>蓝线=MA60</i><i><span style="display:inline-block;width:9px;height:2px;background:#c9922e;vertical-align:middle;margin-right:3px"></span>金线=均量5</i></div>
    <p class="summary">${escape(data.headline || data.summary)}</p></article>
    <article class="card"><h2>体检结论</h2>
    <p class="signal ${data.light === 'green' ? 'positive' : data.light === 'red' ? 'negative' : ''}">● ${data.band}</p>
    <dl><dt>MA20</dt><dd>${number(data.metrics?.ma20)}</dd><dt>MA60</dt><dd>${number(data.metrics?.ma60)}</dd><dt>MACD</dt><dd>${number(data.metrics?.macd)}</dd><dt>RSI</dt><dd>${number(data.metrics?.rsi)}</dd></dl>
    <button id="favorite" class="primary full">收藏到自选</button></article></div>
    ${card('蜡烛形态', `<p class="report-note">已扫描 ${data.pat_scanned} 种形态，命中 ${data.pat_hit} 种</p><div class="pats" style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 0">${patternChips(data.patterns)}</div>`, 'report-card')}
    ${card('摆动指标组', renderMurphy(data.murphy), 'report-card')}
    ${card('经典图表形态', renderClassicPatterns(data.patterns_classic), 'report-card')}
    ${card('四方会诊', renderConsult(data.consult), 'report-card')}
    ${card('全部校验', `<p class="report-note">每次体检会对趋势、均线、量价与动量指标执行同一套规则。</p>${data.scan_dims.map(d => `<div class="check"><i>${d.note.includes('跌破') || d.note.includes('偏弱') || d.note.includes('死叉') || d.note.includes('超买') ? '·' : '✓'}</i><b>${escape(d.name)}</b><span>${escape(d.note)}</span></div>`).join('')}`, 'report-card')}
    <div id="favorites"></div>`);
  document.querySelector('#back').onclick = checkPage;
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
    if (!data.favorites.length) { slot.innerHTML = '<section class="watch"><h2>我的自选</h2><div class="local-note">还没有自选股，体检结果页可以直接收藏。</div></section>'; return; }
    // 尝试获取行情摘要
    let quotes = {};
    try { const q = await api('/favorites/quotes'); (q.items||[]).forEach(it => { if (it.ok) quotes[it.code] = it; }); } catch {}
    slot.innerHTML = `<section class="watch"><h2>我的自选</h2><div class="favhead-actions" style="display:flex;gap:8px;margin-bottom:10px"><button class="testall" id="testAllBtn" style="background:linear-gradient(135deg,#5d7cc4,#4f6cae);color:#fff;border:none;border-radius:12px;padding:10px 18px;font-size:14px;font-weight:800;cursor:pointer">⚡ 一键全测</button></div>
    <div class="fav-list">${data.favorites.map(x => {
      const q = quotes[x.code];
      const sparkline = q && q.sparkline && q.sparkline.length >= 2 ? sparklineSVG(q.sparkline, q.change_pct) : '';
      const price = q ? number(q.last_close) : '—';
      const pct = q && q.change_pct != null ? `${q.change_pct >= 0 ? '+' : ''}${number(q.change_pct)}%` : '';
      return `<div class="favrow" data-code="${x.code}" style="background:#fff;border:1px solid #e4e8f1;border-radius:13px;margin:8px 0;padding:11px 13px;display:flex;align-items:center;gap:11px"><button class="onecheck mini" data-code="${x.code}" style="border:1px solid #d4ddef;background:#eef2fb;color:#3a548f;border-radius:9px;padding:6px 9px;font-size:12px;font-weight:800;cursor:pointer">体检</button><div style="flex:1"><div style="font-weight:700;font-size:14.5px">${escape(x.name)}</div><div style="color:#9098a9;font-size:11.5px">${x.code}</div></div>${sparkline}<div style="text-align:right"><div style="font-family:ui-monospace,monospace;font-weight:800">${price}</div><div style="font-size:12px;color:${q && q.change_pct >= 0 ? '#d8584d' : '#3a9e6e'}">${pct}</div></div><button class="rmfav mini danger" data-code="${x.code}" style="border:1px solid #f3cfc9;background:#fcefed;color:#bb4339;border-radius:9px;padding:6px 9px;font-size:12px;font-weight:800;cursor:pointer">删除</button></div>`;
    }).join('')}</div></section>`;
    // 绑定事件
    slot.querySelectorAll('.onecheck').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = '体检中…';
      try { const r = await api(`/stocks/${b.dataset.code}/report`); checkPage(); setTimeout(() => renderReport(r), 100); }
      catch (e) { notice(e.message); b.disabled = false; b.textContent = '体检'; }
    });
    slot.querySelectorAll('.rmfav').forEach(b => b.onclick = async () => {
      try { await fetch(`/api/favorites/${b.dataset.code}`, { method: 'DELETE' }); notice('已删除', true); renderFavorites(); }
      catch (e) { notice(e.message); }
    });
    const testAllBtn = slot.querySelector('#testAllBtn');
    if (testAllBtn) testAllBtn.onclick = () => testAll(data.favorites);
  } catch (e) { slot.innerHTML = ''; }
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
    const data = await api('/screen');
    layout('回春法选股', `<div class="how"><b>📋 这份名单怎么用</b><p>每天按趋势、MACD、均线与量价规则扫描可用样本；候选仅供技术研究，不构成投资建议。</p></div>
    <div class="filters"><input id="screen-filter" placeholder="🔍 输入代码/名称搜索"><button class="active">体检分</button></div>
    ${card('', `<p class="report-note">🩺 候选按体检分排序，数据更新时间：${date(data.updatedAt)}</p><div class="table-wrap"><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>现价</th><th>今日</th><th>体检分</th><th>量比</th><th>结论</th><th>灯</th></tr></thead><tbody id="screen-rows"></tbody></table></div>`)}`);
    const render = rows => document.querySelector('#screen-rows').innerHTML = rows.length ? rows.map((x, i) => `<tr data-code="${x.code}"><td>${i+1}</td><td>${x.code}</td><td><b>${escape(x.name)}</b></td><td>${number(x.price)}</td><td class="${x.changePct>=0?'up':'down'}">${x.changePct>=0?'+':''}${number(x.changePct)}%</td><td><strong class="score mini">${x.score}</strong></td><td>${number(x.volumeRatio)}</td><td>${x.status}</td><td>${x.light === 'green' ? '🟢' : x.light === 'yellow' ? '🟡' : '🔴'}</td></tr>`).join('') : '<tr><td colspan="9">当前没有符合筛选条件的候选。</td></tr>';
    render(data.candidates);
    document.querySelector('#screen-filter').oninput = e => render(data.candidates.filter(x => (x.code + x.name).includes(e.target.value.trim())));
    document.querySelector('#screen-rows').onclick = e => { const row = e.target.closest('tr[data-code]'); if (row) location.hash = `#/check/${row.dataset.code}`; };
  } catch (e) { checkPage(); notice(e.message); }
}

function rulesPage() {
  layout('方法说明 两步走', `<p class="intro">不是玄学。挑票用「回春法」，判断技术风险用蜡烛图、均线、MACD、成交量和动量指标的公开规则进行计算。</p>
    <div class="steps"><article><b>1</b><h2>挑票</h2><p>回春法选出候选</p></article><article><b>2</b><h2>判断</h2><p>个股体检能不能买</p></article></div>
    ${card('一、回春法：怎么挑出候选股', `<p>三项共同满足：前期存在明显涨幅、MACD 重新转强、价格站在上行的 60 日均线上。量比达到 1.5 以上时作为放量确认。</p><div class="rule-grid"><div><b>1</b><h3>前期涨幅</h3><p>识别近期强势区间。</p></div><div><b>2</b><h3>MACD 转强</h3><p>观察快慢线关系与 0 轴位置。</p></div><div><b>3</b><h3>趋势未坏</h3><p>价格与 MA60 同时确认。</p></div></div>`)}
    ${card('二、个股体检：健康分', `<p>基础分为 50，趋势、均线、MACD、量价、RSI 等信号分别加减分；若价格有效跌破近期关键支撑，风险分会被压低。分数仅描述技术状态，不预测收益或目标价。</p><table><tbody><tr><td>🟢 80–100</td><td>健康 / 趋势与动量偏强</td></tr><tr><td>🟡 45–79</td><td>中性 / 等待信号确认</td></tr><tr><td>🔴 0–44</td><td>偏弱 / 注意破位风险</td></tr></tbody></table>`)}`);
}

async function feedbackPage() {
  layout('意见反馈 / 留言板', `<p class="intro">用着哪里不顺、想要什么功能、发现 bug，直接在这儿说。反馈会保存在当前电脑本地。</p><textarea id="feedback-message" maxlength="500" placeholder="说说你的想法、建议或遇到的问题…（最多 500 字）"></textarea><div class="form-actions"><span>提交后仅保存在本机</span><button id="send-feedback" class="primary">提交反馈</button></div><div id="feedback-list"></div>`);
  const render = async () => { const data = await api('/feedback'); document.querySelector('#feedback-list').innerHTML = data.feedback.map(x => `<article class="feedback"><b>${escape(x.author)}</b><time>${date(x.createdAt)}</time><p>${escape(x.message)}</p></article>`).join('') || '<p class="empty">还没有留言，来说第一句吧。</p>'; };
  document.querySelector('#send-feedback').onclick = async () => { try { await api('/feedback', { method:'POST', body:JSON.stringify({message:document.querySelector('#feedback-message').value}) }); document.querySelector('#feedback-message').value = ''; notice('感谢反馈，已保存', true); render(); } catch (e) { notice(e.message); } };
  render();
}

function router() {
  const path = location.hash.slice(2) || 'check';
  if (path.startsWith('check/')) { const code = path.split('/')[1]; checkPage(); setTimeout(() => { document.querySelector('#stock-input').value = code; api(`/stocks/${code}/report`).then(r => { const scanSlot = document.querySelector('#scan-slot'); if (scanSlot) playScanAnim(scanSlot, Promise.resolve({j:r}), {title:'个股体检中'}).then(({j}) => j && renderReport(j)); }).catch(e => notice(e.message)); }, 100); return; }
  ({ check: checkPage, screen: screenPage, rules: rulesPage, feedback: feedbackPage }[path] || checkPage)();
}
router(); window.addEventListener('hashchange', router);
