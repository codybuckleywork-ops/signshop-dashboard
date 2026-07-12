/* The Cutline — app logic.
   Pipeline: Design → Print → Laminate → Cut → Mask → Install → Complete.
   Every render guards against missing data: nothing prints "undefined". */
'use strict';

// ---------- constants ----------

const STAGES = ['design', 'print', 'laminate', 'cut', 'mask', 'install', 'complete'];
const STAGE_LABEL = {
  design: 'Design', print: 'Print', laminate: 'Laminate',
  cut: 'Cut', mask: 'Mask', install: 'Install', complete: 'Complete',
};
const STAGE_VAR = {
  design: 'st-design', print: 'st-print', laminate: 'st-laminate',
  cut: 'st-cut', mask: 'st-mask', install: 'st-install', complete: 'st-complete',
};
const SUBSTRATE_LABEL = {
  acm: 'ACM', coroplast: 'Coroplast', aluminum: 'Aluminum', pvc: 'PVC',
  acrylic: 'Acrylic', banner: 'Banner', vinyl: 'Vinyl', magnetic: 'Magnetic',
  mdo: 'MDO', other: 'Other',
};
const FILE_KIND_LABEL = {
  photo: '📷 Site photo', proof: '🖼️ Proof', artwork: '✏️ Artwork',
  document: '📄 Document', other: '📎 File',
};
const EVENT_ICON = {
  created: '✚', stage: '➜', hold: '⏸', file: '📎', material: '📦',
};
const STALE_DAYS = 5;
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
const SNOW_CODES = [71, 73, 75, 77, 85, 86];
const STORM_CODES = [95, 96, 99];

// ---------- state ----------

const state = {
  jobs: [],
  tasks: [],
  equipment: [],
  materials: [],
  usage: [],             // recent material usage rows (joined with job info)
  history: [],           // completed jobs, verbose
  customers: [],         // customer profiles with job stats
  quotes: [],            // quotes with line items
  customerSearch: '',
  modalCustomerName: null,
  kpiDrill: null,        // which KPI card is expanded on the dashboard
  notes: [],
  forecast: {},          // date -> {code, hi, lo, precip, wind, inclement, reason}
  hourly: [],            // [{label, code, temp, precip}]
  current: null,         // {temp, feels, humidity, wind, code}
  settings: null,
  page: 'dashboard',
  activeStage: 'all',
  activeSubstrate: 'all',
  batchMode: false,
  search: '',
  historySearch: '',
  view: localStorage.getItem('cutline-view') || 'list',
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  modalJobId: null,
  modalDetail: null,     // {job, events, files, materials, checklist, total_sqft}
  modalTab: 'details',
  geoCache: {},          // location string -> {lat, lon, label} | null
};

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function txt(v, fallback = '') {
  return (v === null || v === undefined) ? fallback : String(v);
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function woNum(id) { return 'WO-' + String(num(id)).padStart(4, '0'); }

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return txt(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtBytes(n) {
  n = num(n);
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function initials(name) {
  const parts = txt(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function weatherIcon(code) {
  const c = num(code, -1);
  if (c === 0) return '☀️';
  if (c === 1 || c === 2) return '⛅';
  if (c === 3) return '☁️';
  if (c === 45 || c === 48) return '🌫️';
  if (STORM_CODES.includes(c)) return '⛈️';
  if (SNOW_CODES.includes(c)) return '❄️';
  if (RAIN_CODES.includes(c)) return '🌧️';
  return '☁️';
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 204) return null;
  if (!res.ok) {
    let msg = `Request failed: ${res.status}`;
    try { const body = await res.json(); if (body && body.error) msg = body.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// Dialogs: clicking the dimmed backdrop closes them.
function backdropClose(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// ---------- router ----------

const PAGE_TITLES = {
  dashboard: 'Dashboard', jobs: 'Jobs', quotes: 'Quotes', customers: 'Customers',
  history: 'Job history', materials: 'Materials', equipment: 'Equipment',
};

function route() {
  let hash = (location.hash || '#dashboard').slice(1);
  if (hash === 'calendar') {
    hash = 'jobs';
    state.view = 'calendar';
    localStorage.setItem('cutline-view', 'calendar');
  }
  if (!PAGE_TITLES[hash]) hash = 'dashboard';
  state.page = hash;

  document.querySelectorAll('.page').forEach(p => { p.hidden = true; });
  const section = $('page-' + hash);
  if (section) section.hidden = false;

  // Highlight the current page; the Calendar nav item lights up when the
  // calendar view is active on the jobs page.
  document.querySelectorAll('.nav-item').forEach(a => {
    if (a.dataset.page === 'calendar') {
      a.classList.toggle('active', hash === 'jobs' && state.view === 'calendar');
    } else if (a.dataset.page === 'jobs') {
      a.classList.toggle('active', hash === 'jobs' && state.view !== 'calendar');
    } else {
      a.classList.toggle('active', a.dataset.page === hash);
    }
  });

  $('page-title').textContent = PAGE_TITLES[hash];
  if (hash === 'jobs') renderJobs();
  if (hash === 'dashboard') renderDashboard();
  if (hash === 'history') loadHistory();
  if (hash === 'materials') loadUsage();
  if (hash === 'customers') loadCustomers();
  if (hash === 'quotes') loadQuotes();
}

window.addEventListener('hashchange', route);

// ---------- dashboard ----------

function renderDashboard() {
  renderKpis();
  renderPipeline();
  renderDailyChart();
  renderAttention();
  renderWeekPanel();
  renderToday();
}

// Jobs that need eyes: overdue, on hold, stalled in a stage, weather risk.
function renderAttention() {
  const list = $('attention-list');
  if (!list) return;
  const empty = $('attention-empty');
  const sub = $('attention-sub');
  const today = isoToday();

  const items = [];
  for (const j of state.jobs) {
    if (j.stage === 'complete') continue;
    const age = daysInStage(j);
    if (j.due_date && j.due_date < today) {
      const late = Math.max(1, Math.round((new Date(today) - new Date(j.due_date)) / 86400000));
      items.push({ job: j, sev: 0, cls: 'danger', badge: `${late}d overdue` });
    } else if (j.on_hold) {
      items.push({ job: j, sev: 1, cls: 'warning', badge: '⏸ on hold' });
    } else if (age !== null && age >= STALE_DAYS) {
      items.push({ job: j, sev: 2, cls: 'warning', badge: `${age}d in ${STAGE_LABEL[j.stage] || j.stage}` });
    } else {
      const flag = installWeatherFlag(j);
      if (flag) items.push({ job: j, sev: 3, cls: 'info', badge: flag });
    }
  }
  items.sort((a, b) => a.sev - b.sev);

  list.innerHTML = '';
  empty.hidden = items.length > 0;
  sub.textContent = items.length ? `${items.length} job${items.length === 1 ? '' : 's'}` : '';

  for (const it of items.slice(0, 10)) {
    const li = document.createElement('li');
    li.className = 'attn-item';
    li.innerHTML = `
      <span class="attn-dot ${it.cls}"></span>
      <span class="attn-main"><span class="mono">${woNum(it.job.id)}</span><strong>${esc(txt(it.job.customer))}</strong> — ${esc(txt(it.job.job_name))}</span>
      <span class="attn-badge ${it.cls}">${esc(it.badge)}</span>
    `;
    li.addEventListener('click', () => openJobModal(it.job.id));
    list.appendChild(li);
  }
  if (items.length > 10) {
    const li = document.createElement('li');
    li.className = 'attn-more muted';
    li.textContent = `+${items.length - 10} more — see the Jobs page`;
    list.appendChild(li);
  }
}

// Compact 7-day agenda in the dashboard sidebar.
function renderWeekPanel() {
  const list = $('week-panel-list');
  if (!list) return;
  const empty = $('week-panel-empty');
  const jobs = state.jobs.filter(j => j.stage !== 'complete');
  list.innerHTML = '';
  let any = false;

  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dues = jobs.filter(j => j.due_date === iso).length;
    const installs = jobs.filter(j => j.install_date === iso).length;
    if (!dues && !installs) continue;
    any = true;
    const w = state.forecast[iso];
    const li = document.createElement('li');
    li.className = 'wkp-row';
    li.innerHTML = `
      <span class="wkp-day">${i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}</span>
      <span class="wkp-badges">
        ${dues ? `<span class="wkp-b due">${dues} due</span>` : ''}
        ${installs ? `<span class="wkp-b install">${installs} install${installs === 1 ? '' : 's'}</span>` : ''}
      </span>
      ${w && w.inclement ? `<span class="wkp-warn" title="${esc(w.reason)}">⚠</span>` : ''}
    `;
    li.addEventListener('click', gotoWeekView);
    list.appendChild(li);
  }
  empty.hidden = any;
}

function gotoWeekView() {
  state.view = 'week';
  localStorage.setItem('cutline-view', 'week');
  localStorage.setItem('cutline-jobview', 'week');
  if (location.hash !== '#jobs') location.hash = '#jobs';
  renderJobs();
  route();
}

// Bar chart: jobs created / completed / due per day over the last 14 days.
function renderDailyChart() {
  const wrap = $('daily-chart');
  if (!wrap) return;
  const today = isoToday();

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({
      iso,
      label: d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
      created: state.jobs.filter(j => txt(j.created_at).slice(0, 10) === iso).length,
      completed: state.jobs.filter(j => txt(j.completed_at).slice(0, 10) === iso).length,
      due: state.jobs.filter(j => j.stage !== 'complete' && j.due_date === iso).length,
    });
  }

  const max = Math.max(1, ...days.map(d => Math.max(d.created, d.completed, d.due)));
  const bar = (count, cls) => {
    const h = Math.max(3, Math.round((count / max) * 100));
    return `<div class="bc-bar ${cls}${count ? '' : ' zero'}" style="height:${count ? h : 3}%">${count ? `<span class="bc-val">${count}</span>` : ''}</div>`;
  };

  wrap.innerHTML = days.map(d => `
    <div class="bc-col${d.iso === today ? ' today' : ''}" title="${d.label}: ${d.created} created · ${d.completed} completed · ${d.due} due">
      <div class="bc-bars">
        ${bar(d.created, 'created')}
        ${bar(d.completed, 'completed')}
        ${bar(d.due, 'due')}
      </div>
      <div class="bc-label">${d.label}</div>
    </div>
  `).join('');
}

// Everything each KPI is counting, so cards can drill down into the detail.
function kpiData() {
  const today = isoToday();
  const open = state.jobs.filter(j => j.stage !== 'complete');

  const weekOut = new Date();
  weekOut.setDate(weekOut.getDate() + 7);
  const weekStr = weekOut.toISOString().slice(0, 10);

  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);

  return {
    open: [...open],
    overdue: open.filter(j => j.due_date && j.due_date < today)
      .sort((a, b) => txt(a.due_date).localeCompare(txt(b.due_date))),
    hold: open.filter(j => j.on_hold),
    installs: open.filter(j => j.install_date && j.install_date >= today && j.install_date <= weekStr)
      .sort((a, b) => txt(a.install_date).localeCompare(txt(b.install_date))),
    completed: state.jobs.filter(j => j.completed_at && new Date(j.completed_at) >= monthAgo)
      .sort((a, b) => txt(b.completed_at).localeCompare(txt(a.completed_at))),
    sqftRows: state.usage.filter(u => u.created_at && new Date(u.created_at) >= monthAgo),
    lowStock: state.materials.filter(materialLow),
    equipDue: state.equipment.filter(equipmentDueSoon),
  };
}

function renderKpis() {
  const d = kpiData();
  const sqft30 = d.sqftRows.reduce((s, u) => s + num(u.sqft), 0);

  const kpis = [
    { key: 'open', icon: '🗂️', bg: 'var(--primary-soft)', num: d.open.length, label: 'Open jobs' },
    { key: 'overdue', icon: '⏰', bg: 'var(--danger-soft)', num: d.overdue.length, label: 'Overdue', alert: d.overdue.length > 0 },
    { key: 'hold', icon: '📌', bg: 'var(--warning-soft)', num: d.hold.length, label: 'On hold' },
    { key: 'installs', icon: '🚚', bg: 'var(--pink-soft)', num: d.installs.length, label: 'Installs this week' },
    { key: 'completed', icon: '✅', bg: 'var(--success-soft)', num: d.completed.length, label: 'Completed (30d)' },
    { key: 'sqft', icon: '📐', bg: 'var(--info-soft)', num: Math.round(sqft30).toLocaleString(), label: 'Sq ft used (30d)' },
    { key: 'lowstock', icon: '📦', bg: 'var(--warning-soft)', num: d.lowStock.length, label: 'Low stock', alert: d.lowStock.length > 0 },
    { key: 'equip', icon: '🔧', bg: 'var(--purple-soft)', num: d.equipDue.length, label: 'Equipment due', alert: d.equipDue.length > 0 },
  ];

  $('kpi-grid').innerHTML = kpis.map(k => `
    <button type="button" class="kpi${k.alert ? ' alert' : ''}${state.kpiDrill === k.key ? ' active' : ''}" data-kpi="${k.key}" title="Click to see the list">
      <div class="kpi-icon" style="background:${k.bg}">${k.icon}</div>
      <div><div class="kpi-num">${k.num}</div><div class="kpi-label">${k.label}</div></div>
      <span class="kpi-caret">▾</span>
    </button>
  `).join('');

  $('kpi-grid').querySelectorAll('[data-kpi]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.kpiDrill = state.kpiDrill === btn.dataset.kpi ? null : btn.dataset.kpi;
      renderKpis();
    });
  });

  renderKpiDrill(d);
}

function kdStagePill(job) {
  const v = STAGE_VAR[job.stage] || 'st-design';
  return `<span class="kd-stage" style="background:var(--${v}-soft);color:var(--${v})">${STAGE_LABEL[job.stage] || esc(txt(job.stage))}</span>`;
}

function kdJobRow(job, side) {
  return `
    <li class="kd-row" data-job="${job.id}">
      ${kdStagePill(job)}
      <span class="kd-main"><span class="mono">${woNum(job.id)}</span><strong>${esc(txt(job.customer))}</strong> <small>— ${esc(txt(job.job_name))}</small></span>
      <span class="kd-side">${side || ''}</span>
    </li>
  `;
}

function renderKpiDrill(d) {
  const panel = $('kpi-drill');
  if (!panel) return;
  const key = state.kpiDrill;
  if (!key) { panel.hidden = true; panel.innerHTML = ''; return; }
  const today = isoToday();
  const daysLate = (date) => Math.max(1, Math.round((new Date(today) - new Date(date)) / 86400000));

  let title = '', sub = '', rowsHtml = '', footHtml = '', emptyText = 'Nothing here. Nice.';

  if (key === 'open') {
    title = '🗂️ Open jobs'; sub = `${d.open.length} in the pipeline`;
    rowsHtml = d.open.map(j => kdJobRow(j,
      (j.substrate ? `<span class="sub-pill sub-${esc(j.substrate)}">${esc(SUBSTRATE_LABEL[j.substrate] || j.substrate)}</span>` : '')
      + (j.due_date ? `<span class="badge${j.due_date < today ? ' overdue' : ''}">due ${esc(j.due_date)}</span>` : '<span class="muted mono" style="font-size:10.5px">no due date</span>')
    )).join('');
    footHtml = '<a href="#jobs" class="linklike">open the Jobs page →</a>';
    emptyText = 'The board is empty. Go win some work.';
  } else if (key === 'overdue') {
    title = '⏰ Overdue jobs'; sub = 'oldest first — these need a phone call or a push';
    rowsHtml = d.overdue.map(j => kdJobRow(j,
      `<span class="badge overdue">${daysLate(j.due_date)}d late</span>`
      + (j.on_hold ? '<span class="badge hold">⏸ held</span>' : '')
    )).join('');
    emptyText = 'Nothing overdue. You are officially on top of it. 🎉';
  } else if (key === 'hold') {
    title = '📌 On hold'; sub = 'waiting on material or a decision';
    rowsHtml = d.hold.map(j => {
      const age = daysInStage(j);
      return kdJobRow(j,
        (age !== null ? `<span class="badge">${age}d in ${esc(STAGE_LABEL[j.stage] || j.stage)}</span>` : '')
        + (j.due_date ? `<span class="badge${j.due_date < today ? ' overdue' : ''}">due ${esc(j.due_date)}</span>` : '')
      );
    }).join('');
    emptyText = 'Nothing on hold — everything is moving.';
  } else if (key === 'installs') {
    title = '🚚 Installs this week'; sub = 'next 7 days, soonest first';
    rowsHtml = d.installs.map(j => {
      const flag = installWeatherFlag(j);
      return kdJobRow(j,
        `<span class="badge">${j.install_date === today ? 'TODAY' : esc(j.install_date)}</span>`
        + (j.install_location ? `<span class="badge loc">📍 ${esc(j.install_location)}</span>` : '')
        + (flag ? `<span class="badge weather">${esc(flag)}</span>` : '')
      );
    }).join('');
    emptyText = 'No installs scheduled this week.';
  } else if (key === 'completed') {
    title = '✅ Completed — last 30 days'; sub = 'most recent first';
    rowsHtml = d.completed.map(j => {
      let turnaround = '';
      if (j.created_at && j.completed_at) {
        const t = Math.max(0, Math.round((new Date(j.completed_at) - new Date(j.created_at)) / 86400000));
        turnaround = `<span class="badge">⏱ ${t}d</span>`;
      }
      return kdJobRow(j, `<span class="badge check done">✔ ${esc(txt(j.completed_at).slice(0, 10))}</span>${turnaround}`);
    }).join('');
    footHtml = '<a href="#history" class="linklike">full job history →</a>';
    emptyText = 'Nothing finished in the last 30 days yet.';
  } else if (key === 'sqft') {
    const total = d.sqftRows.reduce((s, u) => s + num(u.sqft), 0);
    title = '📐 Material posted — last 30 days'; sub = `${Math.round(total).toLocaleString()} sq ft across ${d.sqftRows.length} entr${d.sqftRows.length === 1 ? 'y' : 'ies'}`;
    rowsHtml = d.sqftRows.map(u => `
      <li class="kd-row" ${u.job_id ? `data-job="${u.job_id}"` : ''}>
        <span class="kd-stage" style="background:var(--info-soft);color:var(--info)">${esc(txt(u.created_at).slice(5, 10))}</span>
        <span class="kd-main"><strong>${esc(txt(u.material_name))}</strong> <small>— ${num(u.qty)} ${esc(txt(u.unit, ''))}${u.job_name ? ` on ${esc(u.job_name)}` : ''}</small></span>
        <span class="kd-side">${num(u.sqft) ? `<span class="badge">${num(u.sqft)} sqft</span>` : ''}</span>
      </li>
    `).join('');
    footHtml = '<a href="#materials" class="linklike">materials & usage log →</a>';
    emptyText = 'No material posted yet — log usage from a job\'s Materials tab.';
  } else if (key === 'lowstock') {
    title = '📦 Low stock'; sub = 'at or below the reorder point';
    rowsHtml = d.lowStock.map(m => `
      <li class="kd-row" data-nav="#materials">
        <span class="kd-stage" style="background:var(--warning-soft);color:var(--warning)">reorder</span>
        <span class="kd-main"><strong>${esc(txt(m.name))}</strong></span>
        <span class="kd-side"><span class="badge">${num(m.on_hand)} ${esc(txt(m.unit, ''))} left</span><span class="badge overdue">reorder at ${num(m.reorder_at)}</span></span>
      </li>
    `).join('');
    footHtml = '<a href="#materials" class="linklike">manage inventory →</a>';
    emptyText = 'Stock levels are healthy. 📦👍';
  } else if (key === 'equip') {
    title = '🔧 Equipment due for service'; sub = 'within 7 days or overdue';
    rowsHtml = d.equipDue.map(eq => {
      const next = new Date(eq.last_service);
      next.setDate(next.getDate() + num(eq.interval_days, 90));
      const left = Math.round((next - new Date()) / 86400000);
      return `
        <li class="kd-row" data-nav="#equipment">
          <span class="kd-stage" style="background:var(--purple-soft);color:var(--purple)">service</span>
          <span class="kd-main"><strong>${esc(txt(eq.name))}</strong></span>
          <span class="kd-side">${left < 0 ? `<span class="badge overdue">${Math.abs(left)}d overdue</span>` : `<span class="badge">due in ${left}d</span>`}</span>
        </li>
      `;
    }).join('');
    footHtml = '<a href="#equipment" class="linklike">equipment page →</a>';
    emptyText = 'All machines happy. Keep the blades sharp.';
  }

  panel.hidden = false;
  panel.innerHTML = `
    <div class="kd-head">
      <h3>${title}</h3>
      <span class="muted">${sub}</span>
      <button type="button" class="icon-btn kd-close" aria-label="Close">×</button>
    </div>
    ${rowsHtml ? `<ul class="kd-list">${rowsHtml}</ul>` : `<p class="kd-empty">${emptyText}</p>`}
    ${footHtml ? `<div class="kd-foot">${footHtml}</div>` : ''}
  `;

  panel.querySelector('.kd-close').addEventListener('click', () => {
    state.kpiDrill = null;
    renderKpis();
  });
  panel.querySelectorAll('[data-job]').forEach(row => {
    row.addEventListener('click', () => openJobModal(num(row.dataset.job)));
  });
  panel.querySelectorAll('[data-nav]').forEach(row => {
    row.addEventListener('click', () => { location.hash = row.dataset.nav; });
  });
}

function renderPipeline() {
  const bar = $('pipeline-bar');
  const legend = $('pipeline-legend');
  const open = state.jobs.filter(j => j.stage !== 'complete');
  const counts = STAGES.slice(0, 6).map(s => ({ stage: s, count: open.filter(j => j.stage === s).length }));
  const total = counts.reduce((s, c) => s + c.count, 0);

  if (!total) {
    bar.innerHTML = '';
    legend.innerHTML = '<span class="muted">No open jobs — pipeline is clear.</span>';
    const d = $('pipeline-detail');
    if (d) d.innerHTML = '';
    return;
  }
  bar.innerHTML = counts.filter(c => c.count > 0).map(c =>
    `<div class="pipeline-seg" style="width:${(c.count / total) * 100}%;background:var(--${STAGE_VAR[c.stage]})" title="${STAGE_LABEL[c.stage]}: ${c.count}"></div>`
  ).join('');
  legend.innerHTML = counts.map(c =>
    `<span><span class="pl-dot" style="background:var(--${STAGE_VAR[c.stage]})"></span>${STAGE_LABEL[c.stage]} <span class="mono">${c.count}</span></span>`
  ).join('');

  // Detail: one row per active stage with the actual jobs in it, so the
  // dashboard answers "what exactly is sitting in Print right now?"
  const detail = $('pipeline-detail');
  if (!detail) return;
  const today = isoToday();
  detail.innerHTML = counts.filter(c => c.count > 0).map(c => {
    const sv = STAGE_VAR[c.stage];
    const inStage = open.filter(j => j.stage === c.stage);
    const chips = inStage.slice(0, 8).map(j => {
      const late = j.due_date && j.due_date < today;
      const age = daysInStage(j);
      return `<button type="button" class="pd-chip${late ? ' late' : ''}${j.on_hold ? ' held' : ''}" data-job="${j.id}"
        title="${esc(txt(j.job_name))}${j.due_date ? ' · due ' + esc(j.due_date) : ''}${age >= 1 ? ` · ${age}d in stage` : ''}${j.on_hold ? ' · ON HOLD' : ''}">
        ${esc(txt(j.customer, 'Customer'))}${late ? ' ⚠' : ''}${j.on_hold ? ' ⏸' : ''}</button>`;
    }).join('');
    const more = inStage.length > 8 ? `<span class="pd-more muted">+${inStage.length - 8} more</span>` : '';
    return `
      <div class="pd-row">
        <span class="pd-stage" style="background:var(--${sv}-soft);color:var(--${sv})">${STAGE_LABEL[c.stage]} <b>${c.count}</b></span>
        <span class="pd-jobs">${chips}${more}</span>
      </div>`;
  }).join('');
  detail.querySelectorAll('[data-job]').forEach(b =>
    b.addEventListener('click', () => openJobModal(num(b.dataset.job))));
}

// The big "what happens today" board at the top of the dashboard.
// Customer is the headline; the job name is the supporting line.
function renderToday() {
  const grid = $('th-grid');
  const empty = $('th-empty');
  const count = $('th-count');
  if (!grid) return;
  const today = isoToday();
  const lateDays = (d) => Math.max(1, Math.round((new Date(today) - new Date(d)) / 86400000));

  const items = [];
  for (const j of state.jobs) {
    if (j.stage === 'complete') continue;
    const installToday = j.install_date && j.install_date <= today;
    const dueToday = j.due_date && j.due_date <= today;
    if (!installToday && !dueToday) continue;
    const relevant = installToday ? j.install_date : j.due_date;
    items.push({
      jobId: j.id,
      customer: txt(j.customer, 'Customer'),
      name: txt(j.job_name, 'Job'),
      stage: STAGE_LABEL[j.stage] || txt(j.stage),
      stageVar: STAGE_VAR[j.stage] || 'st-design',
      kind: installToday ? 'install' : 'due',
      overdue: relevant < today,
      late: relevant < today ? lateDays(relevant) : 0,
      flag: j.on_hold ? '⏸ waiting on material' : installWeatherFlag(j),
      sort: txt(relevant),
    });
  }
  for (const t of state.tasks) {
    if (t.job_id || t.completed || !t.due_date || t.due_date > today) continue;
    items.push({
      customer: txt(t.title, 'Task'),
      name: 'shop task',
      stage: null,
      stageVar: null,
      kind: 'task',
      overdue: t.due_date < today,
      late: t.due_date < today ? lateDays(t.due_date) : 0,
      flag: null,
      sort: txt(t.due_date),
    });
  }
  items.sort((a, b) => ((b.overdue ? 1 : 0) - (a.overdue ? 1 : 0)) || a.sort.localeCompare(b.sort));

  grid.innerHTML = '';
  empty.hidden = items.length > 0;
  count.textContent = items.length
    ? `${items.length} item${items.length === 1 ? '' : 's'} today`
    : '';

  for (const it of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'th-card' + (it.overdue ? ' overdue' : '') + (it.kind === 'install' ? ' install' : '');
    card.innerHTML = `
      <div class="th-tags">
        <span class="th-tag ${it.overdue ? 'late' : it.kind}">${it.overdue ? `${it.late}d overdue` : it.kind === 'install' ? 'install today' : 'due today'}</span>
        ${it.stageVar ? `<span class="th-stage" style="background:var(--${it.stageVar}-soft);color:var(--${it.stageVar})">${esc(it.stage)}</span>` : ''}
      </div>
      <div class="th-customer">${esc(it.customer)}</div>
      <div class="th-job">${esc(it.name)}</div>
      ${it.flag ? `<div class="th-flag">${esc(it.flag)}</div>` : ''}
    `;
    if (it.jobId) card.addEventListener('click', () => openJobModal(it.jobId));
    grid.appendChild(card);
  }
}

// ---------- weather ----------

function installWeatherFlag(job) {
  if (!job.install_date || job.stage === 'complete') return null;
  const day = state.forecast[job.install_date];
  if (day && day.inclement) return `⚠ ${day.reason} on install day`;
  return null;
}

async function loadWeather() {
  if (!state.settings) return;
  const lat = num(state.settings.lat, 34.9265);
  const lon = num(state.settings.lon, -86.5847);
  $('wc-loc').textContent = txt(state.settings.location_name);
  $('weather-loc-label').textContent = txt(state.settings.location_name);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`
      + `&hourly=temperature_2m,precipitation_probability,weather_code&forecast_hours=12`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    const data = await res.json();

    const cur = data.current || {};
    state.current = {
      temp: Math.round(num(cur.temperature_2m)),
      feels: Math.round(num(cur.apparent_temperature)),
      humidity: Math.round(num(cur.relative_humidity_2m)),
      wind: Math.round(num(cur.wind_speed_10m)),
      code: num(cur.weather_code),
    };

    state.hourly = [];
    const h = data.hourly || {};
    (h.time || []).forEach((t, i) => {
      const dt = new Date(t);
      state.hourly.push({
        label: dt.toLocaleTimeString(undefined, { hour: 'numeric' }),
        temp: Math.round(num((h.temperature_2m || [])[i])),
        precip: Math.round(num((h.precipitation_probability || [])[i])),
        code: num((h.weather_code || [])[i]),
      });
    });

    state.forecast = {};
    const d = data.daily || {};
    (d.time || []).forEach((date, i) => {
      const code = num((d.weather_code || [])[i]);
      const precip = Math.round(num((d.precipitation_probability_max || [])[i]));
      const wind = Math.round(num((d.wind_speed_10m_max || [])[i]));
      let reason = null;
      if (STORM_CODES.includes(code)) reason = `storms (${precip}% precip)`;
      else if (SNOW_CODES.includes(code)) reason = `snow (${precip}% precip)`;
      else if (precip >= 50) reason = `rain likely (${precip}%)`;
      else if (wind >= 20) reason = `high wind (${wind} mph)`;
      state.forecast[date] = {
        code,
        hi: Math.round(num((d.temperature_2m_max || [])[i])),
        lo: Math.round(num((d.temperature_2m_min || [])[i])),
        precip,
        wind,
        inclement: !!reason,
        reason: reason || '',
      };
    });

    renderWeather();
    renderJobs();
    renderToday();
  } catch (err) {
    $('weather-now').innerHTML = '<span class="muted">Weather unavailable right now.</span>';
  }
}

function renderWeather() {
  const c = state.current;
  if (c) {
    $('wc-icon').textContent = weatherIcon(c.code);
    $('wc-temp').textContent = `${c.temp}°F`;
    $('weather-now').innerHTML = `
      <span class="wn-icon">${weatherIcon(c.code)}</span>
      <span class="wn-temp">${c.temp}°F</span>
      <div class="wn-details">
        <span>Feels like <strong>${c.feels}°</strong></span>
        <span>Wind <strong>${c.wind} mph</strong></span>
        <span>Humidity <strong>${c.humidity}%</strong></span>
      </div>
    `;
    showAdvisory(c);
  }

  $('hourly-strip').innerHTML = state.hourly.map(h => `
    <div class="hour-cell">
      <div class="hour-label">${esc(h.label)}</div>
      <div class="hour-icon">${weatherIcon(h.code)}</div>
      <div class="hour-temp">${h.temp}°</div>
      <div class="hour-precip">${h.precip > 0 ? h.precip + '%' : '&nbsp;'}</div>
    </div>
  `).join('');

  const dates = Object.keys(state.forecast).sort();
  $('forecast-row').innerHTML = dates.map(date => {
    const day = state.forecast[date];
    const label = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    const installs = state.jobs.filter(j => j.stage !== 'complete' && j.install_date === date);
    const installChips = installs.map(j =>
      `<button type="button" class="day-install-chip" data-job="${j.id}" title="Install: ${esc(j.customer)} — ${esc(j.job_name)}${j.install_location ? ' @ ' + esc(j.install_location) : ''}">🚚 ${esc(txt(j.customer, 'Customer'))}</button>`
    ).join('');
    return `
      <div class="day-card${day.inclement ? ' inclement' : ''}">
        <div class="day-name">${esc(label)}</div>
        <div class="day-icon">${weatherIcon(day.code)}</div>
        <div class="day-temps">${day.hi}° <span class="lo">${day.lo}°</span></div>
        <div class="day-meta">💧${day.precip}% · ${day.wind}mph</div>
        ${day.inclement ? `<div class="day-flag">⚠ ${esc(day.reason)}</div>` : ''}
        ${installChips ? `<div class="day-installs">${installChips}</div>` : ''}
      </div>
    `;
  }).join('');

  $('forecast-row').querySelectorAll('[data-job]').forEach(btn => {
    btn.addEventListener('click', () => openJobModal(num(btn.dataset.job)));
  });
}

function showAdvisory(c) {
  const el = $('weather-advisory');
  let msg = null;
  if (STORM_CODES.includes(c.code)) msg = 'Storms nearby — outdoor installs are a bad idea today.';
  else if (SNOW_CODES.includes(c.code)) msg = 'Snow or ice — reschedule outdoor install work if you can.';
  else if (RAIN_CODES.includes(c.code)) msg = 'Wet conditions — exterior installs and wraps will fight you today.';
  else if (c.wind >= 20) msg = `Wind around ${c.wind} mph — banner and yard sign installs won't be fun.`;
  else if (c.temp < 50) msg = `${c.temp}°F — vinyl adhesion gets iffy below 50°F; consider pushing exterior installs.`;
  else if (c.temp > 95) msg = `${c.temp}°F — watch for curling prints and laminate silvering in this heat.`;
  el.textContent = msg || '';
  el.hidden = !msg;
}

// Live radar — Windy embed on the dashboard. Loads automatically once
// settings (shop coordinates) arrive; the button just hides/shows it.
// The iframe is kept alive when hidden so it never has to reload.
function initRadar() {
  const wrap = $('radar-wrap');
  if (!wrap || wrap.dataset.loaded) return;
  const lat = num(state.settings && state.settings.lat, 34.9265);
  const lon = num(state.settings && state.settings.lon, -86.5847);
  wrap.innerHTML = `<iframe
    src="https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}&zoom=8&level=surface&overlay=radar&product=radar&menu=&message=&marker=true&calendar=now&pressure=&type=map&location=coordinates&metricWind=mph&metricTemp=%C2%B0F&radarRange=-1"
    frameborder="0" loading="lazy" title="Live weather radar"></iframe>`;
  wrap.dataset.loaded = '1';
  wrap.hidden = false;
  $('radar-toggle').textContent = '🛰 Hide radar';
}

$('radar-toggle').addEventListener('click', () => {
  const wrap = $('radar-wrap');
  if (!wrap.dataset.loaded) { initRadar(); return; }
  wrap.hidden = !wrap.hidden;
  $('radar-toggle').textContent = wrap.hidden ? '🛰 Show live radar' : '🛰 Hide radar';
});

// Geocode an install location (city or address) via Open-Meteo's free
// geocoding API. Results are cached for the session.
async function geocode(place) {
  const key = txt(place).trim().toLowerCase();
  if (!key) return null;
  if (key in state.geoCache) return state.geoCache[key];
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(key)}&count=1&language=en&format=json`);
    const data = await res.json();
    const hit = (data.results || [])[0];
    state.geoCache[key] = hit
      ? { lat: hit.latitude, lon: hit.longitude, label: [hit.name, hit.admin1].filter(Boolean).join(', ') }
      : null;
  } catch {
    state.geoCache[key] = null;
  }
  return state.geoCache[key];
}

// Forecast for a job's install day at its install location (falls back to
// the shop's forecast when no location is set or geocoding finds nothing).
async function installDayWeather(job) {
  if (!job.install_date) return null;
  const daysOut = Math.round((new Date(job.install_date + 'T00:00:00') - new Date(isoToday() + 'T00:00:00')) / 86400000);
  if (daysOut < 0) return { past: true };
  if (daysOut > 15) return { tooFar: true };

  let loc = null;
  if (job.install_location) loc = await geocode(job.install_location);

  if (!loc) {
    const day = state.forecast[job.install_date];
    return day ? { ...day, label: txt(state.settings && state.settings.location_name, 'shop location'), fallback: !!job.install_location } : null;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=16`;
    const res = await fetch(url);
    const data = await res.json();
    const d = data.daily || {};
    const idx = (d.time || []).indexOf(job.install_date);
    if (idx === -1) return { tooFar: true };
    const code = num((d.weather_code || [])[idx]);
    const precip = Math.round(num((d.precipitation_probability_max || [])[idx]));
    const wind = Math.round(num((d.wind_speed_10m_max || [])[idx]));
    let reason = null;
    if (STORM_CODES.includes(code)) reason = `storms (${precip}% precip)`;
    else if (SNOW_CODES.includes(code)) reason = `snow (${precip}% precip)`;
    else if (precip >= 50) reason = `rain likely (${precip}%)`;
    else if (wind >= 20) reason = `high wind (${wind} mph)`;
    return {
      code,
      hi: Math.round(num((d.temperature_2m_max || [])[idx])),
      lo: Math.round(num((d.temperature_2m_min || [])[idx])),
      precip, wind,
      inclement: !!reason,
      reason: reason || '',
      label: loc.label,
    };
  } catch {
    return null;
  }
}

// ---------- jobs ----------

function matchesSearch(job) {
  if (!state.search) return true;
  const q = state.search;
  return txt(job.job_name).toLowerCase().includes(q)
    || txt(job.customer).toLowerCase().includes(q)
    || txt(job.assigned_to).toLowerCase().includes(q)
    || txt(job.install_location).toLowerCase().includes(q)
    || woNum(job.id).toLowerCase().includes(q);
}

async function loadJobs() {
  state.jobs = await api('/api/jobs');
  renderJobs();
  renderDashboard();
  renderWeather();
  updateDatalists();
}

function daysInStage(job) {
  const since = job.stage_changed_at || job.created_at;
  if (!since) return null;
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

function jobChecklist(jobId) {
  return state.tasks.filter(t => t.job_id === jobId);
}

function renderJobs() {
  const list = $('job-list');
  const kanban = $('kanban');
  const calendar = $('calendar');
  const empty = $('jobs-empty');
  if (!list) return;

  const weekView = $('week-view');
  const isKanban = state.view === 'kanban';
  const isCal = state.view === 'calendar';
  const isWeek = state.view === 'week';
  list.hidden = isKanban || isCal || isWeek;
  kanban.hidden = !isKanban;
  calendar.hidden = !isCal;
  if (weekView) weekView.hidden = !isWeek;

  document.querySelectorAll('.view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === state.view));

  renderStageChips();
  renderSubstrateChips();

  if (isCal) { renderCalendar(); empty.hidden = true; return; }
  if (isKanban) { renderKanban(); empty.hidden = true; return; }
  if (isWeek) { renderWeek(); empty.hidden = true; return; }

  let filtered = state.activeStage === 'all'
    ? state.jobs
    : state.jobs.filter(j => j.stage === state.activeStage);
  if (state.activeSubstrate !== 'all') {
    filtered = filtered.filter(j => txt(j.substrate) === state.activeSubstrate);
  }
  filtered = filtered.filter(matchesSearch);

  list.innerHTML = '';
  empty.hidden = filtered.length > 0;

  if (state.batchMode) {
    const groups = new Map();
    for (const job of filtered) {
      const key = txt(job.substrate);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const key of keys) {
      const header = document.createElement('li');
      header.className = 'batch-header';
      header.innerHTML = `<span>${esc(key ? (SUBSTRATE_LABEL[key] || key) : 'No substrate set')}</span><span class="batch-count">${groups.get(key).length}</span>`;
      list.appendChild(header);
      groups.get(key).forEach(j => list.appendChild(jobCard(j)));
    }
  } else {
    filtered.forEach(j => list.appendChild(jobCard(j)));
  }
}

function renderStageChips() {
  const wrap = $('stage-chips');
  const chips = [{ key: 'all', label: 'All' }, ...STAGES.map(s => ({ key: s, label: STAGE_LABEL[s] }))];
  wrap.innerHTML = chips.map(c => {
    const count = c.key === 'all' ? 0 : state.jobs.filter(j => j.stage === c.key).length;
    const show = c.key !== 'all' && c.key !== 'complete' && count > 0;
    return `<button type="button" class="chip${state.activeStage === c.key ? ' active' : ''}" data-stage="${c.key}">${c.label}${show ? ` <span class="cnt">${count}</span>` : ''}</button>`;
  }).join('');
  wrap.querySelectorAll('[data-stage]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeStage = btn.dataset.stage;
      if (['calendar', 'kanban', 'week'].includes(state.view)) {
        state.view = 'list';
        localStorage.setItem('cutline-view', 'list');
        localStorage.setItem('cutline-jobview', 'list');
      }
      renderJobs();
    });
  });
}

function renderSubstrateChips() {
  const wrap = $('substrate-chips');
  const present = [...new Set(state.jobs.filter(j => j.stage !== 'complete' && j.substrate).map(j => j.substrate))];
  if (state.activeSubstrate !== 'all' && !present.includes(state.activeSubstrate)) {
    state.activeSubstrate = 'all';
  }
  if (!present.length) { wrap.innerHTML = ''; return; }

  const chips = present.sort().map(sub => {
    const count = state.jobs.filter(j => j.stage !== 'complete' && j.substrate === sub).length;
    return `<button type="button" class="chip${state.activeSubstrate === sub ? ' active' : ''}" data-sub="${sub}">${SUBSTRATE_LABEL[sub] || sub} <span class="cnt">${count}</span></button>`;
  }).join('');

  wrap.innerHTML = `<span class="row-label">Material</span>`
    + `<button type="button" class="chip${state.activeSubstrate === 'all' ? ' active' : ''}" data-sub="all">All</button>`
    + chips
    + `<button type="button" class="chip batch${state.batchMode ? ' active' : ''}" id="batch-toggle">Batch by material</button>`;

  wrap.querySelectorAll('[data-sub]').forEach(btn => {
    btn.addEventListener('click', () => { state.activeSubstrate = btn.dataset.sub; renderJobs(); });
  });
  const bt = $('batch-toggle');
  if (bt) bt.addEventListener('click', () => { state.batchMode = !state.batchMode; renderJobs(); });
}

function badgeRow(job, compact = false) {
  const today = isoToday();
  const overdue = job.stage !== 'complete' && job.due_date && job.due_date < today;
  const age = daysInStage(job);
  const flag = installWeatherFlag(job);
  const items = jobChecklist(job.id);
  const done = items.filter(t => t.completed).length;

  const parts = [];
  if (job.substrate) parts.push(`<span class="sub-pill sub-${esc(job.substrate)}">${esc(SUBSTRATE_LABEL[job.substrate] || job.substrate)}</span>`);
  if (job.on_hold && job.stage !== 'complete') parts.push(`<span class="badge hold">⏸ waiting on material</span>`);
  if (job.due_date) parts.push(`<span class="badge${overdue ? ' overdue' : ''}">${overdue ? '⚠ overdue — ' : ''}due ${esc(job.due_date)}</span>`);
  if (job.install_date && !compact) parts.push(`<span class="badge">install ${esc(job.install_date)}</span>`);
  if (job.install_location && !compact) parts.push(`<span class="badge loc">📍 ${esc(job.install_location)}</span>`);
  if (job.priority === 'high') parts.push(`<span class="badge prio">high</span>`);
  if (age !== null && age >= 1 && job.stage !== 'complete') {
    parts.push(`<span class="badge${age >= STALE_DAYS ? ' stale' : ''}">${age}d in ${esc(STAGE_LABEL[job.stage] || job.stage)}</span>`);
  }
  if (items.length) parts.push(`<span class="badge check${done === items.length ? ' done' : ''}">☑ ${done}/${items.length}</span>`);
  if (num(job.pending_proofs) > 0 && job.stage !== 'complete') parts.push(`<span class="badge proof">🖼 proof out</span>`);
  if (flag) parts.push(`<span class="badge weather">${esc(flag)}</span>`);
  if (job.assigned_to) parts.push(`<span class="avatar"><i>${esc(initials(job.assigned_to))}</i>${esc(job.assigned_to)}</span>`);
  return parts.join('');
}

function jobCard(job) {
  const li = document.createElement('li');
  li.className = 'job-card'
    + (job.stage === 'complete' ? ' complete' : '')
    + (job.on_hold && job.stage !== 'complete' ? ' on-hold' : '');

  const top = document.createElement('div');
  top.className = 'job-top';

  const left = document.createElement('div');
  left.className = 'job-left';
  left.title = 'Open job details';
  left.innerHTML = `
    <div class="job-wo">${woNum(job.id)}</div>
    <p class="job-name">${esc(txt(job.customer))}</p>
    <p class="job-cust">${esc(txt(job.job_name))}</p>
  `;
  left.addEventListener('click', () => openJobModal(job.id));

  const btns = document.createElement('div');
  btns.className = 'job-btns';

  const hold = document.createElement('button');
  hold.type = 'button';
  hold.className = 'hold-btn' + (job.on_hold ? ' held' : '');
  hold.title = job.on_hold ? 'Release hold' : 'Put on hold — waiting on material';
  hold.textContent = '⏸';
  hold.addEventListener('click', async () => {
    await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ on_hold: job.on_hold ? 0 : 1 }) });
    loadJobs();
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'x-btn';
  del.title = 'Delete job';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete ${woNum(job.id)} — ${txt(job.job_name)}? This also removes its files and history.`)) return;
    await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
    loadJobs();
  });

  btns.appendChild(hold);
  btns.appendChild(del);
  top.appendChild(left);
  top.appendChild(btns);

  const badges = document.createElement('div');
  badges.className = 'badge-row';
  badges.innerHTML = badgeRow(job);

  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  const currentIdx = STAGES.indexOf(job.stage);
  STAGES.forEach((stage, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step' + (i < currentIdx ? ' done' : '') + (i === currentIdx ? ' current' : '');
    btn.title = `Move to ${STAGE_LABEL[stage]}`;
    btn.innerHTML = `<span class="step-dot"></span><span class="step-label">${STAGE_LABEL[stage]}</span>`;
    btn.addEventListener('click', async () => {
      await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ stage }) });
      loadJobs();
    });
    stepper.appendChild(btn);
  });

  li.appendChild(top);
  li.appendChild(badges);
  li.appendChild(stepper);
  return li;
}

// ---------- kanban ----------

function renderKanban() {
  const kanban = $('kanban');
  kanban.innerHTML = '';
  let jobs = state.jobs.filter(matchesSearch);
  if (state.activeSubstrate !== 'all') {
    jobs = jobs.filter(j => txt(j.substrate) === state.activeSubstrate);
  }

  for (const stage of STAGES) {
    const col = document.createElement('div');
    col.className = 'kanban-col' + (stage === 'complete' ? ' col-complete' : '');
    const inStage = jobs.filter(j => j.stage === stage);
    col.innerHTML = `
      <div class="kanban-col-head" style="color:var(--${STAGE_VAR[stage]})">
        <span>${STAGE_LABEL[stage]}</span><span class="kcount">${inStage.length}</span>
      </div>
      <div class="kanban-col-body"></div>
    `;
    const body = col.querySelector('.kanban-col-body');
    inStage.forEach(j => body.appendChild(kanbanCard(j)));

    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const job = state.jobs.find(j => j.id === parseInt(id, 10));
      if (!job || job.stage === stage) return;
      await api(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ stage }) });
      loadJobs();
    });

    kanban.appendChild(col);
  }
}

function kanbanCard(job) {
  const card = document.createElement('div');
  card.className = 'kanban-card'
    + (job.on_hold && job.stage !== 'complete' ? ' on-hold' : '')
    + (job.priority === 'high' ? ' prio-high' : '');
  card.draggable = true;
  card.innerHTML = `
    <div class="job-wo">${woNum(job.id)}</div>
    <p class="job-name">${esc(txt(job.customer))}</p>
    <p class="job-cust">${esc(txt(job.job_name))}</p>
    <div class="badge-row">${badgeRow(job, true)}</div>
  `;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(job.id));
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => openJobModal(job.id));
  return card;
}

// ---------- week view (7-day scheduling board) ----------

function wkChip(job, kind, unscheduled = false) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `wk-chip ${unscheduled ? 'unsched' : kind}`
    + (job.priority === 'high' ? ' hi' : '')
    + (job.on_hold ? ' held' : '');
  el.draggable = true;
  const icon = unscheduled ? '📋' : (kind === 'install' ? '🚚' : '⏱');
  const sv = STAGE_VAR[job.stage] || 'st-design';
  el.innerHTML = `
    <span class="wk-kind">${icon}</span>
    <span class="wk-txt"><strong>${esc(txt(job.customer, 'Customer'))}</strong><small>${esc(txt(job.job_name))}${job.install_location && kind === 'install' ? ' · 📍' + esc(job.install_location) : ''}</small>
    <small class="wk-stage" style="color:var(--${sv})"><span class="cc-dot" style="background:var(--${sv})"></span>${STAGE_LABEL[job.stage] || esc(txt(job.stage))}</small></span>
  `;
  el.title = `${woNum(job.id)} — ${txt(job.job_name)} (${unscheduled ? 'unscheduled' : kind === 'install' ? 'install' : 'due'})`
    + (job.on_hold ? ' — ON HOLD' : '') + ` · ${STAGE_LABEL[job.stage] || job.stage}`;
  el.addEventListener('click', () => openJobModal(job.id));
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', `${job.id}:${kind}`);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

function wkColumn({ title, sub, warn, cls, iso, droppable }) {
  const col = document.createElement('div');
  col.className = 'wk-col' + (cls ? ` ${cls}` : '');
  col.innerHTML = `
    <div class="wk-head">
      <div class="wk-day">${esc(title)}</div>
      <div class="wk-date mono">${sub || ''}</div>
      ${warn ? `<div class="wk-warn">⚠ ${esc(warn)}</div>` : ''}
    </div>
    <div class="wk-body"></div>
  `;
  if (droppable) {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const [idStr, kind] = (e.dataTransfer.getData('text/plain') || '').split(':');
      const id = parseInt(idStr, 10);
      if (!id || !kind) return;
      const field = kind === 'install' ? 'install_date' : 'due_date';
      await api(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ [field]: iso }) });
      loadJobs();
    });
  }
  return col;
}

function renderWeek() {
  const summary = $('wk-summary');
  const board = $('week-board');
  if (!board) return;
  board.innerHTML = '';

  let jobs = state.jobs.filter(j => j.stage !== 'complete' && matchesSearch(j));
  if (state.activeSubstrate !== 'all') {
    jobs = jobs.filter(j => txt(j.substrate) === state.activeSubstrate);
  }

  const today = isoToday();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({
      iso,
      name: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short' }),
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      weather: state.forecast[iso] || null,
      installs: jobs.filter(j => j.install_date === iso),
      dues: jobs.filter(j => j.due_date === iso && j.install_date !== iso),
    });
  }
  const overdue = jobs.filter(j => j.due_date && j.due_date < today);
  const unscheduled = jobs.filter(j => !j.due_date && !j.install_date);

  const weekDue = days.reduce((s, d) => s + d.dues.length, 0);
  const weekInst = days.reduce((s, d) => s + d.installs.length, 0);
  const riskDays = days.filter(d => d.weather && d.weather.inclement).length;
  summary.innerHTML = `
    <span class="wk-stat"><strong>${days[0].dues.length + days[0].installs.length}</strong> today</span>
    <span class="wk-stat"><strong>${weekDue}</strong> due this week</span>
    <span class="wk-stat"><strong>${weekInst}</strong> install${weekInst === 1 ? '' : 's'} this week</span>
    ${overdue.length ? `<span class="wk-stat bad"><strong>${overdue.length}</strong> overdue</span>` : ''}
    ${riskDays ? `<span class="wk-stat warn">⚠ <strong>${riskDays}</strong> weather-risk day${riskDays === 1 ? '' : 's'}</span>` : ''}
    <span class="wk-hint muted">drag a chip onto a day to reschedule it</span>
  `;

  if (overdue.length) {
    const col = wkColumn({ title: 'Overdue', sub: `${overdue.length} job${overdue.length === 1 ? '' : 's'}`, cls: 'overdue-col', droppable: false });
    const body = col.querySelector('.wk-body');
    overdue.forEach(j => body.appendChild(wkChip(j, 'due')));
    board.appendChild(col);
  }

  for (const d of days) {
    const w = d.weather;
    const col = wkColumn({
      title: d.name,
      sub: `${d.date}${w ? ` ${weatherIcon(w.code)} ${w.hi}°` : ''}`,
      warn: w && w.inclement ? w.reason : null,
      cls: d.iso === today ? 'today-col' : '',
      iso: d.iso,
      droppable: true,
    });
    const body = col.querySelector('.wk-body');
    d.installs.forEach(j => body.appendChild(wkChip(j, 'install')));
    d.dues.forEach(j => body.appendChild(wkChip(j, 'due')));
    if (!d.installs.length && !d.dues.length) {
      body.innerHTML = '<div class="wk-empty">—</div>';
    }
    board.appendChild(col);
  }

  const uCol = wkColumn({ title: 'Unscheduled', sub: 'no dates set', cls: 'unsched-col', iso: null, droppable: true });
  const uBody = uCol.querySelector('.wk-body');
  unscheduled.forEach(j => uBody.appendChild(wkChip(j, 'due', true)));
  if (!unscheduled.length) uBody.innerHTML = '<div class="wk-empty">everything is scheduled</div>';
  board.appendChild(uCol);
}

const weekJumpBtn = $('week-jump');
if (weekJumpBtn) weekJumpBtn.addEventListener('click', gotoWeekView);

// ---------- calendar ----------

function renderCalendar() {
  const title = $('cal-title');
  const grid = $('cal-grid');
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  title.textContent = state.calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  grid.innerHTML = '';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(wd => {
    const el = document.createElement('div');
    el.className = 'cal-weekday';
    el.textContent = wd;
    grid.appendChild(el);
  });

  const first = new Date(y, m, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  const today = isoToday();
  const active = state.jobs.filter(j => j.stage !== 'complete' && matchesSearch(j));

  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cal-cell'
      + (d.getMonth() === m ? '' : ' cal-outside')
      + (iso === today ? ' cal-today-cell' : '');

    const weather = state.forecast[iso];
    cell.innerHTML = `<div class="cal-daynum">${d.getDate()}${weather && weather.inclement ? ` <span class="cal-warn" title="${esc(weather.reason)}">⚠</span>` : ''}</div>`;

    active.filter(j => j.due_date === iso).forEach(j => cell.appendChild(calChip(j, 'due')));
    active.filter(j => j.install_date === iso).forEach(j => cell.appendChild(calChip(j, 'install')));
    grid.appendChild(cell);
  }
}

function calChip(job, kind) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `cal-chip ${kind}`;
  const sv = STAGE_VAR[job.stage] || 'st-design';
  chip.title = `${txt(job.customer)} — ${txt(job.job_name)} (${kind}) · stage: ${STAGE_LABEL[job.stage] || txt(job.stage)}${job.install_location ? ' @ ' + txt(job.install_location) : ''}`;
  chip.innerHTML = `<span class="cc-dot" style="background:var(--${sv})" title="${STAGE_LABEL[job.stage] || ''}"></span>${esc(txt(job.customer, 'Customer'))}`;
  chip.addEventListener('click', () => openJobModal(job.id));
  return chip;
}

$('cal-prev').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('cal-next').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('cal-today').addEventListener('click', () => {
  state.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  renderCalendar();
});

// ---------- view switch / search / add job / CSV import ----------

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view || 'list';
    localStorage.setItem('cutline-view', state.view);
    // Remember the last non-calendar view so the Jobs nav item can return
    // to it — Calendar has its own nav entry.
    if (state.view !== 'calendar') localStorage.setItem('cutline-jobview', state.view);
    if (location.hash !== '#jobs') location.hash = '#jobs';
    renderJobs();
    route();
  });
});

// Clicking "Jobs" in the sidebar must never land on the calendar — that is
// what the Calendar nav item is for. Restore the last list/board/week view.
document.querySelectorAll('.nav-item[data-page="jobs"]').forEach(a => {
  a.addEventListener('click', () => {
    if (state.view === 'calendar') {
      state.view = localStorage.getItem('cutline-jobview') || 'list';
      localStorage.setItem('cutline-view', state.view);
    }
    // If the hash is already #jobs no hashchange fires, so render here;
    // otherwise the upcoming hashchange -> route() handles it.
    if ((location.hash || '') === '#jobs') {
      renderJobs();
      route();
    }
  });
});

$('job-search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderJobs();
});

$('job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customer = $('job-customer').value.trim();
  const jobName = $('job-name').value.trim();
  if (!customer || !jobName) return;
  await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      customer,
      job_name: jobName,
      substrate: $('job-substrate').value || '',
      due_date: $('job-due').value || null,
      install_date: $('job-install').value || null,
      install_location: $('job-location').value.trim(),
      priority: $('job-priority').value || 'medium',
      assigned_to: $('job-assigned').value.trim(),
    }),
  });
  $('job-form').reset();
  $('job-priority').value = 'medium';
  loadJobs();
});

// Jobs import — CSV or ICS calendar files. CSV rows with a matching id
// update; ICS events match by customer + job name; everything else creates.
$('jobs-import-btn').addEventListener('click', () => $('jobs-import-file').click());
$('jobs-import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/import/jobs', { method: 'POST', body: fd });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Import failed');
    let msg = `Import complete: ${result.created} created, ${result.updated} updated`;
    if (result.skipped) msg += `, ${result.skipped} skipped`;
    if (result.errors && result.errors.length) msg += `\n\nNotes:\n${result.errors.join('\n')}`;
    alert(msg);
    await loadJobs();
    renderDashboard();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
});

function updateDatalists() {
  const customers = new Set();
  const assignees = new Set();
  state.jobs.forEach(j => { if (j.customer) customers.add(j.customer); if (j.assigned_to) assignees.add(j.assigned_to); });
  $('customer-list').innerHTML = [...customers].sort().map(n => `<option value="${esc(n)}"></option>`).join('');
  $('assignee-list').innerHTML = [...assignees].sort().map(n => `<option value="${esc(n)}"></option>`).join('');
  $('material-name-list').innerHTML = state.materials.map(m => `<option value="${esc(m.name)}"></option>`).join('');
  const vendors = new Set(['Grimco']);
  state.materials.forEach(m => { if (m.vendor) vendors.add(m.vendor); });
  const vl = $('vendor-list');
  if (vl) vl.innerHTML = [...vendors].sort().map(v => `<option value="${esc(v)}"></option>`).join('');
}

// ---------- job modal ----------

const jobModal = $('job-modal');
backdropClose(jobModal);

function setModalTab(tab) {
  state.modalTab = tab;
  document.querySelectorAll('#jm-tabs .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  ['details', 'files', 'materials', 'activity'].forEach(t => {
    $(`jm-pane-${t}`).hidden = t !== tab;
  });
}

document.querySelectorAll('#jm-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => setModalTab(btn.dataset.tab));
});

function openJobModal(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  state.modalJobId = jobId;
  state.modalDetail = null;

  $('jm-wo').textContent = `${woNum(job.id)} — ${STAGE_LABEL[job.stage] || txt(job.stage)}`;
  // Customer is the headline; the job name rides underneath.
  $('jm-title').textContent = txt(job.customer, 'Customer');
  $('jm-customer').textContent = txt(job.job_name);
  $('jm-customer-input').value = txt(job.customer);
  $('jm-jobname-input').value = txt(job.job_name);
  $('jm-assigned').value = txt(job.assigned_to);
  $('jm-substrate').value = txt(job.substrate);
  $('jm-priority').value = txt(job.priority, 'medium');
  $('jm-due').value = txt(job.due_date);
  $('jm-install').value = txt(job.install_date);
  $('jm-location').value = txt(job.install_location);
  $('jm-notes').value = txt(job.notes);

  setModalTab('details');
  renderModalChecklist();
  renderInstallWeather(job);
  refreshModalDetail();
  renderModalMaterialSelect();
  jobModal.showModal();
}

async function refreshModalDetail() {
  if (!state.modalJobId) return;
  try {
    state.modalDetail = await api(`/api/jobs/${state.modalJobId}/detail`);
  } catch {
    state.modalDetail = null;
  }
  renderModalFiles();
  renderModalMaterials();
  renderModalTimeline();
}

async function renderInstallWeather(job) {
  const box = $('jm-weather');
  if (!job.install_date || job.stage === 'complete') { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'install-weather';
  box.innerHTML = '<span class="muted">Checking install-day weather…</span>';

  const w = await installDayWeather(job);
  if (state.modalJobId !== job.id) return; // modal moved on
  if (!w) { box.hidden = true; return; }
  if (w.past) { box.hidden = true; return; }
  if (w.tooFar) {
    box.innerHTML = `<span class="muted">Install ${esc(job.install_date)} is too far out for a forecast (16-day max).</span>`;
    return;
  }
  if (w.inclement) box.classList.add('bad');
  box.innerHTML = `
    <span class="iw-icon">${weatherIcon(w.code)}</span>
    <span><strong>Install day — ${esc(job.install_date)}</strong> at ${esc(w.label)}${w.fallback ? ' <span class="muted">(location not found; showing shop forecast)</span>' : ''}<br>
    ${w.hi}° / ${w.lo}° · 💧${w.precip}% · wind ${w.wind} mph${w.inclement ? ` · <strong class="iw-warn">⚠ ${esc(w.reason)}</strong>` : ' · looks workable'}</span>
  `;
}

function renderModalChecklist() {
  const list = $('jm-checklist');
  const progress = $('jm-progress');
  const items = jobChecklist(state.modalJobId);
  list.innerHTML = '';
  const done = items.filter(t => t.completed).length;
  progress.textContent = items.length ? `${done}/${items.length} done` : 'nothing yet';

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'check-item' + (item.completed ? ' completed' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.completed;
    cb.addEventListener('change', async () => {
      await api(`/api/tasks/${item.id}`, { method: 'PATCH', body: JSON.stringify({ completed: cb.checked ? 1 : 0 }) });
      await loadTasks();
      renderModalChecklist();
    });

    const span = document.createElement('span');
    span.className = 'c-title';
    span.textContent = txt(item.title);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'x-btn';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await api(`/api/tasks/${item.id}`, { method: 'DELETE' });
      await loadTasks();
      renderModalChecklist();
    });

    li.appendChild(cb);
    li.appendChild(span);
    li.appendChild(del);
    list.appendChild(li);
  }
}

$('jm-check-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('jm-check-input');
  const title = input.value.trim();
  if (!title || !state.modalJobId) return;
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, job_id: state.modalJobId }) });
  input.value = '';
  await loadTasks();
  renderModalChecklist();
});

// --- files tab ---

function isImageFile(f) {
  const ext = txt(f.orig_name).split('.').pop().toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

function renderModalFiles() {
  const grid = $('jm-file-grid');
  const empty = $('jm-files-empty');
  const cnt = $('jm-files-cnt');
  const files = state.modalDetail ? state.modalDetail.files : [];
  grid.innerHTML = '';
  empty.hidden = files.length > 0;
  cnt.hidden = files.length === 0;
  cnt.textContent = files.length;

  for (const f of files) {
    const card = document.createElement('div');
    card.className = 'file-card';
    const url = `/files/${encodeURIComponent(f.stored_name)}`;
    const thumb = isImageFile(f)
      ? `<a href="${url}" target="_blank" rel="noopener"><img class="file-thumb" src="${url}" alt="${esc(f.orig_name)}" loading="lazy"></a>`
      : `<a href="${url}" target="_blank" rel="noopener" class="file-thumb file-thumb-generic">${(FILE_KIND_LABEL[f.kind] || '📎').split(' ')[0]}</a>`;
    card.innerHTML = `
      ${thumb}
      <div class="file-info">
        <span class="file-kind">${esc(FILE_KIND_LABEL[f.kind] || f.kind)}</span>
        <a class="file-name" href="${url}" target="_blank" rel="noopener" title="${esc(f.orig_name)}">${esc(f.label || f.orig_name)}</a>
        <span class="file-meta mono">${fmtBytes(f.size)} · ${esc(txt(f.uploaded_at).slice(0, 10))}</span>
      </div>
    `;
    // Proofs carry an approval state — track customer sign-off per file.
    if (f.kind === 'proof') {
      const row = document.createElement('div');
      row.className = 'proof-row';
      row.innerHTML = `<span class="proof-pill ${f.approved ? 'ok' : 'wait'}">${f.approved ? '✔ approved' : '⏳ awaiting approval'}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'proof-btn';
      btn.textContent = f.approved ? 'Undo' : 'Approve';
      btn.addEventListener('click', async () => {
        await api(`/api/files/${f.id}`, { method: 'PATCH', body: JSON.stringify({ approved: f.approved ? 0 : 1 }) });
        await loadJobs();
        refreshModalDetail();
      });
      row.appendChild(btn);
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'proof-btn';
      send.textContent = '✉ Send to customer';
      send.addEventListener('click', async () => {
        const job = state.jobs.find(j => j.id === state.modalJobId);
        const cust = state.customers.find(c => job && txt(c.name).toLowerCase() === txt(job.customer).toLowerCase());
        const to = prompt('Send proof to (customer email):', (cust && cust.email) || '');
        if (!to) return;
        try {
          const res = await api(`/api/files/${f.id}/send-proof`, { method: 'POST', body: JSON.stringify({ to }) });
          alert(res.message + '\n\nThey get the proof attached plus an approve/request-changes link.');
        } catch (err) {
          alert('Could not send: ' + err.message);
        }
        refreshModalDetail();
      });
      row.appendChild(send);
      card.appendChild(row);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'x-btn file-del';
    del.title = 'Delete file';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete file "${txt(f.label || f.orig_name)}"?`)) return;
      await api(`/api/files/${f.id}`, { method: 'DELETE' });
      refreshModalDetail();
    });
    card.appendChild(del);
    grid.appendChild(card);
  }
}

$('jm-file-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.modalJobId) return;
  const input = $('jm-file-input');
  const file = input.files[0];
  if (!file) return;
  const btn = $('jm-file-upload');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', $('jm-file-kind').value);
    fd.append('label', $('jm-file-label').value.trim());
    const res = await fetch(`/api/jobs/${state.modalJobId}/files`, { method: 'POST', body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Upload failed');
    input.value = '';
    $('jm-file-label').value = '';
    refreshModalDetail();
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload';
  }
});

// --- materials tab ---

function renderModalMaterialSelect() {
  const sel = $('jm-mat-select');
  sel.innerHTML = '<option value="">— pick from inventory (auto-deducts) —</option>'
    + state.materials.map(m =>
      `<option value="${m.id}">${esc(m.name)} (${num(m.on_hand)} ${esc(txt(m.unit, 'pcs'))} on hand)</option>`
    ).join('');
}

$('jm-mat-select').addEventListener('change', () => {
  const id = num($('jm-mat-select').value);
  const mat = state.materials.find(m => m.id === id);
  if (mat) {
    $('jm-mat-name').value = '';
    $('jm-mat-unit').value = ['sqft', 'sheets', 'rolls', 'ft', 'pcs'].includes(mat.unit) ? mat.unit : 'pcs';
  }
});

function renderModalMaterials() {
  const list = $('jm-mat-list');
  const empty = $('jm-mats-empty');
  const total = $('jm-mat-total');
  const cnt = $('jm-mats-cnt');
  const mats = state.modalDetail ? state.modalDetail.materials : [];
  list.innerHTML = '';
  empty.hidden = mats.length > 0;
  cnt.hidden = mats.length === 0;
  cnt.textContent = mats.length;

  const totalSqft = mats.reduce((s, m) => s + num(m.sqft), 0);
  total.hidden = totalSqft <= 0;
  total.textContent = `Total: ${totalSqft.toLocaleString()} sq ft`;

  for (const m of mats) {
    const li = document.createElement('li');
    li.className = 'usage-item';
    li.innerHTML = `
      <div class="usage-main">
        <span class="usage-name">${esc(m.material_name)}</span>
        <span class="usage-qty mono">${num(m.qty)} ${esc(txt(m.unit, ''))}${num(m.sqft) ? ` · ${num(m.sqft)} sqft` : ''}</span>
        ${m.notes ? `<span class="usage-notes muted">${esc(m.notes)}</span>` : ''}
        <span class="usage-date mono muted">${esc(txt(m.created_at).slice(0, 10))}${m.material_id ? ' · from inventory' : ''}</span>
      </div>
    `;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'x-btn';
    del.title = m.material_id ? 'Remove entry (restores stock)' : 'Remove entry';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove usage entry for ${txt(m.material_name)}?${m.material_id ? ' The quantity goes back into inventory.' : ''}`)) return;
      await api(`/api/job-materials/${m.id}`, { method: 'DELETE' });
      await loadMaterials();
      renderModalMaterialSelect();
      refreshModalDetail();
    });
    li.appendChild(del);
    list.appendChild(li);
  }
}

$('jm-mat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.modalJobId) return;
  const materialId = num($('jm-mat-select').value) || null;
  const name = $('jm-mat-name').value.trim();
  const qty = num($('jm-mat-qty').value);
  const sqft = num($('jm-mat-sqft').value);
  if (!materialId && !name) { alert('Pick a material from inventory or type a name.'); return; }
  if (qty <= 0 && sqft <= 0) { alert('Enter a quantity or square footage.'); return; }
  try {
    await api(`/api/jobs/${state.modalJobId}/materials`, {
      method: 'POST',
      body: JSON.stringify({
        material_id: materialId,
        material_name: name,
        qty,
        unit: $('jm-mat-unit').value,
        sqft,
        notes: $('jm-mat-notes').value.trim(),
      }),
    });
    $('jm-mat-form').reset();
    $('jm-mat-unit').value = 'sqft';
    await loadMaterials();
    renderModalMaterialSelect();
    refreshModalDetail();
  } catch (err) {
    alert('Could not post usage: ' + err.message);
  }
});

// --- activity tab ---

function renderModalTimeline() {
  const list = $('jm-timeline');
  const empty = $('jm-timeline-empty');
  const events = state.modalDetail ? state.modalDetail.events : [];
  list.innerHTML = '';
  empty.hidden = events.length > 0;

  for (const ev of [...events].reverse()) {
    const li = document.createElement('li');
    li.className = 'timeline-item';
    li.innerHTML = `
      <span class="tl-icon">${EVENT_ICON[ev.event] || '•'}</span>
      <div class="tl-body">
        <span class="tl-detail">${esc(ev.detail || ev.event)}</span>
        <span class="tl-date mono muted">${esc(fmtDateTime(ev.created_at))}</span>
      </div>
    `;
    list.appendChild(li);
  }
}

// --- modal actions ---

$('jm-save').addEventListener('click', async () => {
  if (!state.modalJobId) return;
  const customer = $('jm-customer-input').value.trim();
  const jobName = $('jm-jobname-input').value.trim();
  if (!customer || !jobName) { alert('Customer and job name can\'t be empty.'); return; }
  await api(`/api/jobs/${state.modalJobId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      customer,
      job_name: jobName,
      assigned_to: $('jm-assigned').value.trim(),
      substrate: $('jm-substrate').value || '',
      priority: $('jm-priority').value || 'medium',
      due_date: $('jm-due').value || null,
      install_date: $('jm-install').value || null,
      install_location: $('jm-location').value.trim(),
      notes: $('jm-notes').value,
    }),
  });
  jobModal.close();
  loadJobs();
});

$('jm-delete').addEventListener('click', async () => {
  if (!state.modalJobId) return;
  const job = state.jobs.find(j => j.id === state.modalJobId);
  if (!confirm(`Delete ${woNum(state.modalJobId)} — ${job ? txt(job.job_name) : 'this job'}? This also removes its files and history.`)) return;
  await api(`/api/jobs/${state.modalJobId}`, { method: 'DELETE' });
  jobModal.close();
  loadJobs();
});

$('jm-close').addEventListener('click', () => jobModal.close());
$('jm-cancel').addEventListener('click', () => jobModal.close());

// --- verbose work order printing ---

function workOrderHtml(job, detail) {
  const shop = state.settings ? txt(state.settings.shop_name, 'Sign Shop') : 'Sign Shop';
  const items = jobChecklist(job.id);
  const mats = detail ? detail.materials : [];
  const files = detail ? detail.files : [];
  const events = detail ? detail.events : [];
  const totalSqft = mats.reduce((s, m) => s + num(m.sqft), 0);
  const age = daysInStage(job);

  const checklistHtml = items.length
    ? `<h3>Checklist</h3><ul class="print-checklist">${items.map(t => `<li>${t.completed ? '☑' : '☐'} ${esc(txt(t.title))}</li>`).join('')}</ul>`
    : '';

  const matsHtml = mats.length
    ? `<h3>Materials used</h3>
       <table class="print-table">
         <thead><tr><th>Material</th><th>Qty</th><th>Sq ft</th><th>Notes</th><th>Logged</th></tr></thead>
         <tbody>${mats.map(m => `
           <tr>
             <td>${esc(m.material_name)}</td>
             <td>${num(m.qty)} ${esc(txt(m.unit, ''))}</td>
             <td>${num(m.sqft) || ''}</td>
             <td>${esc(txt(m.notes))}</td>
             <td>${esc(txt(m.created_at).slice(0, 10))}</td>
           </tr>`).join('')}
         </tbody>
       </table>
       ${totalSqft ? `<p><strong>Total square footage: ${totalSqft.toLocaleString()} sq ft</strong></p>` : ''}`
    : '';

  const filesHtml = files.length
    ? `<h3>Attached files</h3><ul class="print-checklist">${files.map(f =>
        `<li>${esc((FILE_KIND_LABEL[f.kind] || 'File').replace(/^\S+\s/, ''))}: ${esc(f.label || f.orig_name)} <span style="color:#666">(${esc(f.orig_name)}, ${fmtBytes(f.size)})</span></li>`).join('')}</ul>`
    : '';

  const eventsHtml = events.length
    ? `<h3>Job history</h3><ul class="print-checklist">${events.map(ev =>
        `<li>${esc(fmtDateTime(ev.created_at))} — ${esc(ev.detail || ev.event)}</li>`).join('')}</ul>`
    : '';

  const qrImg = `<img class="print-qr" src="https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(location.origin + '/#wo-' + job.id)}" alt="">`;

  return `
    <div class="print-doc">
      <div class="print-head"><h1>${esc(shop)}</h1><div class="print-head-right">${qrImg}<div><strong class="print-wo">${woNum(job.id)}</strong><br><span style="font-size:10pt">WORK ORDER</span></div></div></div>
      <h2>${esc(txt(job.job_name))}</h2>
      <table class="print-table print-kv">
        <tr><th>Customer</th><td>${esc(txt(job.customer))}</td></tr>
        <tr><th>Stage</th><td>${esc(STAGE_LABEL[job.stage] || txt(job.stage))}${age !== null && job.stage !== 'complete' ? ` (${age}d in stage)` : ''}</td></tr>
        ${job.substrate ? `<tr><th>Substrate</th><td>${esc(SUBSTRATE_LABEL[job.substrate] || job.substrate)}</td></tr>` : ''}
        ${job.assigned_to ? `<tr><th>Assigned to</th><td>${esc(job.assigned_to)}</td></tr>` : ''}
        <tr><th>Priority</th><td>${esc(txt(job.priority, 'medium'))}${job.on_hold ? ' — ⏸ ON HOLD (waiting on material)' : ''}</td></tr>
        ${job.due_date ? `<tr><th>Due</th><td>${esc(job.due_date)}</td></tr>` : ''}
        ${job.install_date ? `<tr><th>Install date</th><td>${esc(job.install_date)}</td></tr>` : ''}
        ${job.install_location ? `<tr><th>Install location</th><td>${esc(job.install_location)}</td></tr>` : ''}
        <tr><th>Created</th><td>${esc(fmtDateTime(job.created_at))}</td></tr>
        ${job.completed_at ? `<tr><th>Completed</th><td>${esc(fmtDateTime(job.completed_at))}</td></tr>` : ''}
      </table>
      ${job.notes ? `<h3>Notes</h3><p class="print-notes">${esc(job.notes)}</p>` : ''}
      ${checklistHtml}
      ${matsHtml}
      ${filesHtml}
      ${eventsHtml}
      <p class="print-foot">Printed ${new Date().toLocaleString()}</p>
    </div>
  `;
}

$('jm-print').addEventListener('click', () => {
  const job = state.jobs.find(j => j.id === state.modalJobId);
  if (!job) return;
  printHtml(workOrderHtml(job, state.modalDetail));
});

// ---------- customers (CRM-lite) ----------

const customerModal = $('customer-modal');
backdropClose(customerModal);

async function loadCustomers() {
  try {
    state.customers = await api('/api/customers');
  } catch {
    state.customers = [];
  }
  renderCustomers();
}

function customerMatches(c) {
  if (!state.customerSearch) return true;
  const q = state.customerSearch;
  return txt(c.name).toLowerCase().includes(q)
    || txt(c.contact).toLowerCase().includes(q)
    || txt(c.phone).toLowerCase().includes(q)
    || txt(c.email).toLowerCase().includes(q)
    || txt(c.notes).toLowerCase().includes(q);
}

function renderCustomers() {
  const grid = $('customer-grid');
  if (!grid) return;
  const empty = $('customer-empty');
  const note = $('customers-note');
  const filtered = state.customers.filter(customerMatches);
  grid.innerHTML = '';
  empty.hidden = filtered.length > 0;

  const openTotal = state.customers.reduce((s, c) => s + num(c.open_jobs), 0);
  note.textContent = state.customers.length
    ? `${state.customers.length} customer${state.customers.length === 1 ? '' : 's'} · ${openTotal} open job${openTotal === 1 ? '' : 's'}`
    : '';

  for (const c of filtered) {
    const card = document.createElement('div');
    card.className = 'm-card cust-card' + (c.overdue_jobs ? ' low' : '');
    card.innerHTML = `
      <div class="m-top">
        <span class="m-name">${esc(txt(c.name))}</span>
        ${c.open_jobs ? `<span class="badge">${c.open_jobs} open</span>` : '<span class="muted mono" style="font-size:10.5px">no open jobs</span>'}
      </div>
      <div class="cust-contact">
        ${c.contact ? `<span>👤 ${esc(c.contact)}</span>` : ''}
        ${c.phone ? `<a href="tel:${esc(c.phone)}">📞 ${esc(c.phone)}</a>` : ''}
        ${c.email ? `<a href="mailto:${esc(c.email)}">✉️ ${esc(c.email)}</a>` : ''}
        ${!c.contact && !c.phone && !c.email ? '<span class="muted">no contact info yet</span>' : ''}
      </div>
      <div class="cust-stats mono">
        ${c.total_jobs} job${c.total_jobs === 1 ? '' : 's'} · ${c.completed_jobs} done
        ${num(c.total_sqft) ? ` · ${Math.round(c.total_sqft).toLocaleString()} sqft` : ''}
        ${c.overdue_jobs ? ` · <span class="cust-overdue">${c.overdue_jobs} overdue</span>` : ''}
      </div>
      ${(c.open_names || []).length ? `<div class="cust-open muted">${c.open_names.map(n => esc(n)).join(' · ')}</div>` : ''}
      ${c.notes ? `<div class="cust-notes">${esc(c.notes)}</div>` : ''}
      <div class="m-actions"></div>
    `;
    const actions = card.querySelector('.m-actions');

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = c.id || c.contact || c.phone || c.email || c.notes ? 'Edit info' : 'Add contact info';
    edit.addEventListener('click', () => openCustomerModal(c));
    actions.appendChild(edit);

    if (c.total_jobs) {
      const jobsBtn = document.createElement('button');
      jobsBtn.type = 'button';
      jobsBtn.textContent = 'View jobs';
      jobsBtn.addEventListener('click', () => {
        state.search = txt(c.name).toLowerCase();
        state.view = 'list';
        localStorage.setItem('cutline-view', 'list');
        state.activeStage = 'all';
        location.hash = '#jobs';
        const box = $('job-search');
        if (box) box.value = c.name;
        renderJobs();
        route();
      });
      actions.appendChild(jobsBtn);
    }
    grid.appendChild(card);
  }
}

function openCustomerModal(c) {
  state.modalCustomerName = txt(c.name);
  $('cm-name').textContent = txt(c.name);
  $('cm-contact').value = txt(c.contact);
  $('cm-phone').value = txt(c.phone);
  $('cm-email').value = txt(c.email);
  $('cm-notes').value = txt(c.notes);
  customerModal.showModal();
}

$('customer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.modalCustomerName) return;
  await api('/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: state.modalCustomerName,
      contact: $('cm-contact').value.trim(),
      phone: $('cm-phone').value.trim(),
      email: $('cm-email').value.trim(),
      notes: $('cm-notes').value.trim(),
    }),
  });
  customerModal.close();
  loadCustomers();
});
$('cm-close').addEventListener('click', () => customerModal.close());
$('cm-cancel').addEventListener('click', () => customerModal.close());

$('customer-search').addEventListener('input', (e) => {
  state.customerSearch = e.target.value.trim().toLowerCase();
  renderCustomers();
});

// ---------- history ----------

async function loadHistory() {
  try {
    state.history = await api('/api/history');
  } catch {
    state.history = [];
  }
  renderHistory();
}

function historyMatches(j) {
  if (!state.historySearch) return true;
  const q = state.historySearch;
  return txt(j.job_name).toLowerCase().includes(q)
    || txt(j.customer).toLowerCase().includes(q)
    || txt(j.install_location).toLowerCase().includes(q)
    || txt(j.assigned_to).toLowerCase().includes(q)
    || woNum(j.id).toLowerCase().includes(q)
    || (j.materials || []).some(m => txt(m.material_name).toLowerCase().includes(q));
}

function renderHistory() {
  const list = $('history-list');
  const empty = $('history-empty');
  const note = $('history-note');
  if (!list) return;

  const filtered = state.history.filter(historyMatches);
  list.innerHTML = '';
  empty.hidden = filtered.length > 0;

  const totalSqft = state.history.reduce((s, j) => s + num(j.total_sqft), 0);
  note.textContent = state.history.length
    ? `${state.history.length} completed · ${Math.round(totalSqft).toLocaleString()} sq ft total`
    : '';

  for (const j of filtered) {
    list.appendChild(historyCard(j));
  }
}

function historyCard(j) {
  const li = document.createElement('li');
  li.className = 'job-card history-card';

  const matsSummary = (j.materials || [])
    .map(m => `${num(m.qty)} ${txt(m.unit, '')} ${txt(m.material_name)}`).join(' · ');

  li.innerHTML = `
    <div class="job-top">
      <div class="job-left">
        <div class="job-wo">${woNum(j.id)} · completed ${esc(txt(j.completed_at).slice(0, 10))}</div>
        <p class="job-name">${esc(txt(j.customer))}</p>
        <p class="job-cust">${esc(txt(j.job_name))}</p>
      </div>
      <div class="job-btns">
        <button type="button" class="btn btn-ghost btn-sm hc-expand">Details ▾</button>
        <button type="button" class="btn btn-ghost btn-sm hc-reopen" title="Send back to the Install stage">↩ Reopen</button>
      </div>
    </div>
    <div class="badge-row">
      ${j.substrate ? `<span class="sub-pill sub-${esc(j.substrate)}">${esc(SUBSTRATE_LABEL[j.substrate] || j.substrate)}</span>` : ''}
      ${j.turnaround_days !== null && j.turnaround_days !== undefined ? `<span class="badge">⏱ ${j.turnaround_days}d turnaround</span>` : ''}
      ${num(j.total_sqft) ? `<span class="badge">📐 ${num(j.total_sqft).toLocaleString()} sqft</span>` : ''}
      ${j.install_location ? `<span class="badge loc">📍 ${esc(j.install_location)}</span>` : ''}
      ${(j.files || []).length ? `<span class="badge">📎 ${j.files.length} file${j.files.length === 1 ? '' : 's'}</span>` : ''}
      ${j.checklist_total ? `<span class="badge check${j.checklist_done === j.checklist_total ? ' done' : ''}">☑ ${j.checklist_done}/${j.checklist_total}</span>` : ''}
      ${j.assigned_to ? `<span class="avatar"><i>${esc(initials(j.assigned_to))}</i>${esc(j.assigned_to)}</span>` : ''}
    </div>
    <div class="history-detail" hidden>
      <div class="hd-grid">
        <div>
          <h4>Timeline</h4>
          <ul class="timeline small">
            ${(j.events || []).map(ev => `
              <li class="timeline-item">
                <span class="tl-icon">${EVENT_ICON[ev.event] || '•'}</span>
                <div class="tl-body">
                  <span class="tl-detail">${esc(ev.detail || ev.event)}</span>
                  <span class="tl-date mono muted">${esc(fmtDateTime(ev.created_at))}</span>
                </div>
              </li>`).join('') || '<li class="muted">No events recorded.</li>'}
          </ul>
        </div>
        <div>
          ${matsSummary ? `<h4>Materials</h4><p class="hd-mats">${esc(matsSummary)}</p>` : ''}
          ${(j.files || []).length ? `<h4>Files</h4><ul class="hd-files">${j.files.map(f =>
            `<li><a href="/files/${encodeURIComponent(f.stored_name)}" target="_blank" rel="noopener">${esc(f.label || f.orig_name)}</a> <span class="muted mono">${esc(txt(f.kind))}</span></li>`).join('')}</ul>` : ''}
          ${j.notes ? `<h4>Notes</h4><p class="hd-notes">${esc(j.notes)}</p>` : ''}
          <p class="muted mono hd-dates">Created ${esc(fmtDateTime(j.created_at))}<br>Completed ${esc(fmtDateTime(j.completed_at))}</p>
        </div>
      </div>
    </div>
  `;

  const detail = li.querySelector('.history-detail');
  const expand = li.querySelector('.hc-expand');
  expand.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    expand.textContent = detail.hidden ? 'Details ▾' : 'Details ▴';
  });
  li.querySelector('.hc-reopen').addEventListener('click', async () => {
    if (!confirm(`Reopen ${woNum(j.id)} — ${txt(j.job_name)}? It goes back to the Install stage.`)) return;
    await api(`/api/jobs/${j.id}`, { method: 'PATCH', body: JSON.stringify({ stage: 'install' }) });
    await loadJobs();
    loadHistory();
  });
  return li;
}

$('history-search').addEventListener('input', (e) => {
  state.historySearch = e.target.value.trim().toLowerCase();
  renderHistory();
});

// ---------- printing ----------

function printHtml(html) {
  const area = $('print-area');
  area.innerHTML = html;
  area.hidden = false;
  document.body.classList.add('printing');
  window.print();
  document.body.classList.remove('printing');
  area.hidden = true;
}

// ---------- shop tasks ----------

async function loadTasks() {
  state.tasks = await api('/api/tasks');
  renderTasks();
  renderToday();
  renderJobs();
}

function renderTasks() {
  const list = $('task-list');
  const empty = $('task-empty');
  const visible = state.tasks.filter(t => !t.job_id);
  list.innerHTML = '';
  empty.hidden = visible.length > 0;

  for (const task of visible) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.completed ? ' completed' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!task.completed;
    cb.addEventListener('change', async () => {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completed: cb.checked ? 1 : 0 }) });
      loadTasks();
    });

    const body = document.createElement('div');
    body.className = 'task-body';
    const overdue = !task.completed && task.due_date && task.due_date < isoToday();
    body.innerHTML = `
      <p class="t-title">${esc(txt(task.title))}</p>
      ${(task.due_date || task.priority === 'high') ? `
        <div class="t-meta">
          ${task.due_date ? `<span class="${overdue ? 'overdue' : ''}">${overdue ? 'overdue — ' : 'due '}${esc(task.due_date)}</span>` : ''}
          ${task.priority === 'high' ? '<span class="high">high</span>' : ''}
        </div>` : ''}
    `;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'x-btn';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
      loadTasks();
    });

    li.appendChild(cb);
    li.appendChild(body);
    li.appendChild(del);
    list.appendChild(li);
  }
}

$('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('task-title').value.trim();
  if (!title) return;
  await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title,
      due_date: $('task-due').value || null,
      priority: $('task-priority').value || 'medium',
    }),
  });
  $('task-form').reset();
  $('task-priority').value = 'medium';
  loadTasks();
});

// ---------- quick notes ----------

async function loadNotes() {
  state.notes = await api('/api/notes');
  renderNotes();
}

function renderNotes() {
  const list = $('note-list');
  const empty = $('note-empty');
  const gList = $('graveyard-list');
  const gToggle = $('graveyard-toggle');
  const gCount = $('graveyard-count');

  const pinned = state.notes.filter(n => !n.resolved);
  const resolved = state.notes.filter(n => n.resolved);

  list.innerHTML = '';
  empty.hidden = pinned.length > 0;
  pinned.forEach(n => list.appendChild(noteChip(n)));

  gList.innerHTML = '';
  resolved.forEach(n => gList.appendChild(noteChip(n)));

  if (resolved.length) {
    gToggle.hidden = false;
    gCount.textContent = `${resolved.length} cleared`;
  } else {
    gToggle.hidden = true;
    gList.hidden = true;
  }
}

function noteChip(note) {
  const li = document.createElement('li');
  li.className = 'note-chip';

  const text = document.createElement('span');
  text.textContent = txt(note.content);

  const actions = document.createElement('span');
  actions.className = 'note-actions';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = note.resolved ? '↺' : '✓';
  toggle.title = note.resolved ? 'Restore' : 'Mark done';
  toggle.addEventListener('click', async () => {
    await api(`/api/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: note.resolved ? 0 : 1 }) });
    loadNotes();
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Delete';
  del.addEventListener('click', async () => {
    await api(`/api/notes/${note.id}`, { method: 'DELETE' });
    loadNotes();
  });

  actions.appendChild(toggle);
  actions.appendChild(del);
  li.appendChild(text);
  li.appendChild(actions);
  return li;
}

$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('note-input');
  const content = input.value.trim();
  if (!content) return;
  await api('/api/notes', { method: 'POST', body: JSON.stringify({ content }) });
  input.value = '';
  loadNotes();
});

$('graveyard-toggle').addEventListener('click', () => {
  const gList = $('graveyard-list');
  gList.hidden = !gList.hidden;
});

// ---------- materials ----------

function materialLow(mat) {
  return num(mat.reorder_at) > 0 && num(mat.on_hand) <= num(mat.reorder_at);
}

async function loadMaterials() {
  state.materials = await api('/api/materials');
  renderMaterials();
  renderKpis();
  updateDatalists();
}

async function loadUsage() {
  try {
    state.usage = await api('/api/material-usage');
  } catch {
    state.usage = [];
  }
  renderUsage();
  renderKpis();
}

function renderMaterials() {
  const grid = $('material-list');
  const empty = $('material-empty');
  const note = $('materials-note');
  grid.innerHTML = '';
  empty.hidden = state.materials.length > 0;

  const lowCount = state.materials.filter(materialLow).length;
  if (note) {
    note.textContent = state.materials.length
      ? `${state.materials.length} tracked${lowCount ? ` · ${lowCount} low` : ''}`
      : '';
  }

  for (const mat of state.materials) {
    const low = materialLow(mat);
    const onHand = num(mat.on_hand);
    const reorder = num(mat.reorder_at);
    const pct = reorder > 0 ? Math.min(100, Math.round((onHand / (reorder * 2)) * 100)) : 100;
    const cost = num(mat.cost);

    const infoBits = [];
    if (mat.sku) infoBits.push(`<span class="m-sku mono" title="Product code">#${esc(mat.sku)}</span>`);
    if (mat.vendor) infoBits.push(`<span class="m-vendor">${esc(mat.vendor)}</span>`);
    if (cost > 0) infoBits.push(`<span class="m-cost mono">$${cost.toFixed(2)}/${esc(txt(mat.unit, 'pc')).replace(/s$/, '')}</span>`);
    if (mat.location) infoBits.push(`<span class="m-loc">📍 ${esc(mat.location)}</span>`);
    if (mat.product_url) infoBits.push(`<a class="m-link" href="${esc(mat.product_url)}" target="_blank" rel="noopener" title="Open product page">order ↗</a>`);

    const card = document.createElement('div');
    card.className = 'm-card' + (low ? ' low' : '');
    card.innerHTML = `
      <div class="m-top">
        <span class="m-name">${esc(txt(mat.name))}</span>
        <span class="m-qty${low ? ' low' : ''}">${onHand} ${esc(txt(mat.unit, 'pcs'))}</span>
      </div>
      ${infoBits.length ? `<div class="m-info">${infoBits.join('')}</div>` : ''}
      <div class="m-meta">${low ? '⚠ reorder now — ' : ''}${reorder > 0 ? `reorder at ${reorder}` : 'no reorder point'}${low && cost > 0 && reorder > 0 ? ` · ~$${(Math.max(0, reorder * 2 - onHand) * cost).toFixed(0)} to restock` : ''}</div>
      <div class="m-bar"><div class="m-bar-fill" style="width:${pct}%;background:${low ? 'var(--warning)' : 'var(--success)'}"></div></div>
      <div class="m-actions"></div>
    `;

    const actions = card.querySelector('.m-actions');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.title = 'Edit name, product code, vendor, cost…';
    edit.addEventListener('click', () => openMaterialModal(mat));
    actions.appendChild(edit);
    const step = (txt(mat.unit) === 'ft' || txt(mat.unit) === 'sqft') ? 10 : 1;
    [[`−${step}`, -step, 'Used some'], [`+${step}`, step, 'Received stock']].forEach(([label, delta, title]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', async () => {
        await api(`/api/materials/${mat.id}`, { method: 'PATCH', body: JSON.stringify({ on_hand: Math.max(0, onHand + delta) }) });
        loadMaterials();
      });
      actions.appendChild(b);
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      if (!confirm(`Remove "${txt(mat.name)}" from inventory?`)) return;
      await api(`/api/materials/${mat.id}`, { method: 'DELETE' });
      loadMaterials();
    });
    actions.appendChild(rm);
    grid.appendChild(card);
  }
}

function renderUsage() {
  const tbody = $('usage-tbody');
  const empty = $('usage-empty');
  if (!tbody) return;
  tbody.innerHTML = '';
  empty.hidden = state.usage.length > 0;

  for (const u of state.usage) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${esc(txt(u.created_at).slice(0, 10))}</td>
      <td>${u.job_id ? `${woNum(u.job_id)} — ${esc(txt(u.job_name, ''))}` : '<span class="muted">—</span>'}</td>
      <td>${esc(txt(u.material_name))}</td>
      <td class="num">${num(u.qty)} ${esc(txt(u.unit, ''))}</td>
      <td class="num">${num(u.sqft) || ''}</td>
      <td class="muted">${esc(txt(u.notes))}</td>
    `;
    const td = document.createElement('td');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'x-btn';
    del.title = u.material_id ? 'Remove entry (restores stock)' : 'Remove entry';
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove usage entry for ${txt(u.material_name)}?${u.material_id ? ' The quantity goes back into inventory.' : ''}`)) return;
      await api(`/api/job-materials/${u.id}`, { method: 'DELETE' });
      await loadMaterials();
      loadUsage();
    });
    td.appendChild(del);
    tr.appendChild(td);
    // Clicking a row (not the delete button) opens the job.
    if (u.job_id) {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => openJobModal(num(u.job_id)));
    }
    tbody.appendChild(tr);
  }
}

$('material-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // If a URL lookup is still in flight (pasted then hit Add immediately),
  // wait for it so the autofilled fields make it into the save.
  if (urlLookupPending['mat-url']) { try { await urlLookupPending['mat-url']; } catch { } }
  const name = $('mat-name').value.trim();
  if (!name) { alert('Give the material a name (or paste a product link and wait a moment).'); return; }
  await api('/api/materials', {
    method: 'POST',
    body: JSON.stringify({
      name,
      sku: $('mat-sku').value.trim(),
      vendor: $('mat-vendor').value.trim(),
      on_hand: num($('mat-onhand').value),
      unit: $('mat-unit').value || 'sheets',
      reorder_at: num($('mat-reorder').value),
      cost: num($('mat-cost').value),
      product_url: $('mat-url').value.trim(),
    }),
  });
  $('material-form').reset();
  loadMaterials();
});

// Paste a product URL → autofill name / SKU / vendor / cost from the page
// (or from the URL itself for JS-heavy storefronts like grimco.com).
// Only fills fields you haven't typed in — never overwrites your input.
async function lookupMaterialUrl(url, f) {
  if (!/^https?:\/\//i.test(url)) return;
  const oldPh = f.name.placeholder;
  f.name.placeholder = 'Looking up product…';
  try {
    const info = await api(`/api/materials/lookup?url=${encodeURIComponent(url)}`);
    if (info.name && !f.name.value.trim()) f.name.value = info.name;
    if (info.sku && !f.sku.value.trim()) f.sku.value = info.sku;
    if (info.vendor && !f.vendor.value.trim()) f.vendor.value = info.vendor;
    if (info.cost > 0 && f.cost && !num(f.cost.value)) f.cost.value = info.cost;
  } catch { /* autofill is best-effort */
  } finally {
    f.name.placeholder = oldPh;
  }
}

// Fires while typing/pasting (debounced) — no need to click away first.
// The pending promise is tracked so form submits can wait for it.
const urlLookupPending = {};
function wireUrlAutofill(urlId, fields) {
  const el = $(urlId);
  let timer = null;
  const run = () => { urlLookupPending[urlId] = lookupMaterialUrl(el.value.trim(), fields); };
  el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  });
  el.addEventListener('change', run);
  el.addEventListener('paste', () => setTimeout(run, 60));
}
wireUrlAutofill('mat-url', { name: $('mat-name'), sku: $('mat-sku'), vendor: $('mat-vendor'), cost: $('mat-cost') });
wireUrlAutofill('mm-url', { name: $('mm-name'), sku: $('mm-sku'), vendor: $('mm-vendor'), cost: $('mm-cost') });

// --- material edit modal ---

const materialModal = $('material-modal');
backdropClose(materialModal);
let editMaterialId = null;

function openMaterialModal(mat) {
  editMaterialId = mat.id;
  $('mm-title').textContent = txt(mat.name, 'Edit material');
  $('mm-name').value = txt(mat.name);
  $('mm-sku').value = txt(mat.sku);
  $('mm-vendor').value = txt(mat.vendor);
  $('mm-onhand').value = num(mat.on_hand);
  $('mm-unit').value = ['sheets', 'rolls', 'sqft', 'ft', 'pcs'].includes(mat.unit) ? mat.unit : 'pcs';
  $('mm-reorder').value = num(mat.reorder_at);
  $('mm-cost').value = num(mat.cost) || '';
  $('mm-category').value = txt(mat.category);
  $('mm-location').value = txt(mat.location);
  $('mm-url').value = txt(mat.product_url);
  $('mm-notes').value = txt(mat.notes);
  materialModal.showModal();
}

$('mm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editMaterialId) return;
  await api(`/api/materials/${editMaterialId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: $('mm-name').value.trim(),
      sku: $('mm-sku').value.trim(),
      vendor: $('mm-vendor').value.trim(),
      on_hand: num($('mm-onhand').value),
      unit: $('mm-unit').value,
      reorder_at: num($('mm-reorder').value),
      cost: num($('mm-cost').value),
      category: $('mm-category').value.trim(),
      location: $('mm-location').value.trim(),
      product_url: $('mm-url').value.trim(),
      notes: $('mm-notes').value.trim(),
    }),
  });
  materialModal.close();
  loadMaterials();
});
$('mm-close').addEventListener('click', () => materialModal.close());
$('mm-cancel').addEventListener('click', () => materialModal.close());

$('reorder-email-btn').addEventListener('click', async () => {
  const btn = $('reorder-email-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api('/api/reorder/email', { method: 'POST' });
    alert(res.message || 'Reorder list sent.');
  } catch (err) {
    alert(err.message.includes('reorder point')
      ? 'Nothing is low — no reorder email needed.'
      : 'Could not send: ' + err.message + '\n\nSet up your Gmail app password in Settings first.');
  } finally {
    btn.disabled = false;
    btn.textContent = '✉ Email reorder list';
  }
});

// CSV import — materials (upsert by name).
$('materials-import-btn').addEventListener('click', () => $('materials-import-file').click());
$('materials-import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/import/materials.csv', { method: 'POST', body: fd });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Import failed');
    alert(`Import complete: ${result.created} added, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ''}`);
    loadMaterials();
  } catch (err) {
    alert('CSV import failed: ' + err.message);
  }
});

// ---------- equipment ----------

function equipmentDueSoon(eq) {
  if (!eq.last_service) return false;
  const next = new Date(eq.last_service);
  next.setDate(next.getDate() + num(eq.interval_days, 90));
  return Math.round((next - new Date()) / 86400000) <= 7;
}

async function loadEquipment() {
  state.equipment = await api('/api/equipment');
  renderEquipment();
  renderKpis();
}

function renderEquipment() {
  const grid = $('equipment-list');
  const empty = $('equipment-empty');
  grid.innerHTML = '';
  empty.hidden = state.equipment.length > 0;

  for (const eq of state.equipment) {
    let meta = 'No service logged yet';
    let pct = 0;
    let color = 'var(--success)';
    let due = false;

    if (eq.last_service) {
      const interval = num(eq.interval_days, 90);
      const next = new Date(eq.last_service);
      next.setDate(next.getDate() + interval);
      const daysLeft = Math.round((next - new Date()) / 86400000);
      due = daysLeft <= 7;
      meta = daysLeft < 0
        ? `service overdue by ${Math.abs(daysLeft)}d`
        : `next service in ${daysLeft}d (${next.toISOString().slice(0, 10)})`;
      pct = Math.min(100, Math.max(0, Math.round(((interval - daysLeft) / interval) * 100)));
      color = daysLeft < 0 ? 'var(--danger)' : due ? 'var(--warning)' : 'var(--success)';
    }

    const card = document.createElement('div');
    card.className = 'm-card' + (due ? ' low' : '');
    card.innerHTML = `
      <div class="m-top"><span class="m-name">${esc(txt(eq.name))}</span></div>
      <div class="m-meta">${esc(meta)}</div>
      <div class="m-bar"><div class="m-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="m-actions"></div>
    `;
    const actions = card.querySelector('.m-actions');
    const serviced = document.createElement('button');
    serviced.type = 'button';
    serviced.textContent = 'Mark serviced today';
    serviced.addEventListener('click', async () => {
      await api(`/api/equipment/${eq.id}`, { method: 'PATCH', body: JSON.stringify({ last_service: isoToday() }) });
      loadEquipment();
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      if (!confirm(`Remove "${txt(eq.name)}"?`)) return;
      await api(`/api/equipment/${eq.id}`, { method: 'DELETE' });
      loadEquipment();
    });
    actions.appendChild(serviced);
    actions.appendChild(rm);
    grid.appendChild(card);
  }
}

$('equipment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('eq-name').value.trim();
  if (!name) return;
  await api('/api/equipment', {
    method: 'POST',
    body: JSON.stringify({
      name,
      interval_days: parseInt($('eq-interval').value, 10) || 90,
      last_service: isoToday(),
    }),
  });
  $('equipment-form').reset();
  $('eq-interval').value = 90;
  loadEquipment();
});

// ---------- settings ----------

const settingsModal = $('settings-modal');
backdropClose(settingsModal);

async function loadSettings() {
  state.settings = await api('/api/settings');
  $('shop-name').textContent = txt(state.settings.shop_name, 'The Cutline');
  loadWeather();
  initRadar(); // radar goes live as soon as we know the shop coordinates
}

$('settings-btn').addEventListener('click', () => {
  if (!state.settings) return;
  $('set-shop-name').value = txt(state.settings.shop_name);
  $('set-location-name').value = txt(state.settings.location_name);
  $('set-lat').value = num(state.settings.lat);
  $('set-lon').value = num(state.settings.lon);
  $('set-digest-enabled').checked = !!state.settings.digest_enabled;
  $('set-digest-hour').value = num(state.settings.digest_hour, 7);
  $('set-digest-to').value = txt(state.settings.digest_to);
  $('set-smtp-user').value = txt(state.settings.smtp_user);
  $('set-smtp-pass').value = txt(state.settings.smtp_app_password);
  loadBackups();
  settingsModal.showModal();
});

$('digest-test').addEventListener('click', async () => {
  const btn = $('digest-test');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api('/api/digest/test', { method: 'POST' });
    alert(res.message || 'Sent.');
  } catch (err) {
    alert('Could not send: ' + err.message + '\n\nSave your Gmail address and app password first, then try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send test';
  }
});

// --- backups (rollback safety net) ---

async function loadBackups() {
  let backups = [];
  try {
    backups = await api('/api/backups');
  } catch { /* list stays empty */ }
  const list = $('backup-list');
  const empty = $('backup-empty');
  if (!list) return;
  list.innerHTML = '';
  empty.hidden = backups.length > 0;

  for (const b of backups.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = 'backup-item';
    const label = txt(b.name).replace(/^backup-/, '').replace(/\.zip$/, '');
    li.innerHTML = `
      <span class="backup-name mono">${esc(label)}</span>
      <span class="backup-size muted mono">${fmtBytes(b.size)}</span>
      <span class="backup-actions"></span>
    `;
    const actions = li.querySelector('.backup-actions');

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn btn-ghost btn-sm';
    restore.textContent = '↩ Restore';
    restore.addEventListener('click', async () => {
      if (!confirm(`Roll everything back to ${label}?\n\nThis restores the database, uploads, config, AND app code from that moment. A snapshot of the current state is saved first, so this is reversible.`)) return;
      try {
        const res = await api(`/api/backups/${encodeURIComponent(b.name)}/restore`, { method: 'POST' });
        alert(res.message || 'Backup restored.');
        location.reload();
      } catch (err) {
        alert('Restore failed: ' + err.message);
      }
    });

    const dl = document.createElement('a');
    dl.className = 'btn btn-ghost btn-sm';
    dl.textContent = '⤓';
    dl.title = 'Download this backup';
    dl.href = `/api/backups/${encodeURIComponent(b.name)}/download`;

    actions.appendChild(restore);
    actions.appendChild(dl);
    list.appendChild(li);
  }
}

$('backup-create').addEventListener('click', async () => {
  const btn = $('backup-create');
  btn.disabled = true;
  btn.textContent = 'Backing up…';
  try {
    await api('/api/backups', { method: 'POST', body: JSON.stringify({ label: 'manual' }) });
    loadBackups();
  } catch (err) {
    alert('Backup failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '＋ Back up now';
  }
});
$('settings-cancel').addEventListener('click', () => settingsModal.close());
$('settings-close').addEventListener('click', () => settingsModal.close());

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      shop_name: $('set-shop-name').value,
      location_name: $('set-location-name').value,
      lat: num($('set-lat').value),
      lon: num($('set-lon').value),
      digest_enabled: $('set-digest-enabled').checked,
      digest_hour: Math.min(23, Math.max(0, num($('set-digest-hour').value, 7))),
      digest_to: $('set-digest-to').value.trim(),
      smtp_user: $('set-smtp-user').value.trim(),
      smtp_app_password: $('set-smtp-pass').value.trim(),
    }),
  });
  $('shop-name').textContent = txt(state.settings.shop_name, 'The Cutline');
  settingsModal.close();
  loadWeather();
});

// ---------- quotes ----------

const QUOTE_STATUS_META = {
  draft: ['Draft', 'var(--ink-3)', 'var(--surface-2)'],
  sent: ['Sent', 'var(--info)', 'var(--info-soft)'],
  accepted: ['Accepted', 'var(--success)', 'var(--success-soft)'],
  declined: ['Declined', 'var(--danger)', 'var(--danger-soft)'],
};

function quoteItems(q) {
  try { return JSON.parse(q.items || '[]'); } catch { return []; }
}
function quoteTotal(q) {
  const sub = quoteItems(q).reduce((s, i) => s + num(i.qty, 1) * num(i.price), 0);
  return sub * (1 + num(q.tax_rate) / 100);
}

async function loadQuotes() {
  try { state.quotes = await api('/api/quotes'); } catch { state.quotes = []; }
  renderQuotes();
}

function renderQuotes() {
  const grid = $('quote-list');
  if (!grid) return;
  const empty = $('quote-empty');
  const note = $('quotes-note');
  grid.innerHTML = '';
  empty.hidden = state.quotes.length > 0;
  const openVal = state.quotes.filter(q => q.status !== 'declined')
    .reduce((s, q) => s + quoteTotal(q), 0);
  note.textContent = state.quotes.length
    ? `${state.quotes.length} quote${state.quotes.length === 1 ? '' : 's'} · $${openVal.toFixed(2)} open value`
    : '';

  for (const q of state.quotes) {
    const [label, color, bg] = QUOTE_STATUS_META[q.status] || QUOTE_STATUS_META.draft;
    const items = quoteItems(q);
    const card = document.createElement('div');
    card.className = 'm-card quote-card';
    card.innerHTML = `
      <div class="m-top">
        <span class="m-name">${esc(txt(q.customer))}</span>
        <span class="q-status" style="color:${color};background:${bg}">${label}</span>
      </div>
      <div class="m-meta">${esc(txt(q.title))}</div>
      <ul class="q-lines">${items.map(i =>
        `<li><span>${num(i.qty, 1)}× ${esc(txt(i.desc))}</span><span class="mono">$${(num(i.qty, 1) * num(i.price)).toFixed(2)}</span></li>`).join('')}
      </ul>
      <div class="q-sum mono">Total: $${quoteTotal(q).toFixed(2)}${num(q.tax_rate) ? ` <small>(incl. ${num(q.tax_rate)}% tax)</small>` : ''}</div>
      <div class="m-actions"></div>
    `;
    const actions = card.querySelector('.m-actions');

    const sel = document.createElement('select');
    sel.innerHTML = Object.keys(QUOTE_STATUS_META).map(s =>
      `<option value="${s}"${q.status === s ? ' selected' : ''}>${QUOTE_STATUS_META[s][0]}</option>`).join('');
    sel.addEventListener('change', async () => {
      await api(`/api/quotes/${q.id}`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) });
      loadQuotes();
    });
    actions.appendChild(sel);

    if (!q.job_id) {
      const conv = document.createElement('button');
      conv.type = 'button';
      conv.textContent = '→ Job';
      conv.title = 'Accept this quote and create a job from it';
      conv.addEventListener('click', async () => {
        if (!confirm(`Create a job from "${txt(q.title)}" for ${txt(q.customer)}?`)) return;
        const res = await api(`/api/quotes/${q.id}/convert`, { method: 'POST' });
        await loadJobs();
        loadQuotes();
        if (res && res.job_id) openJobModal(res.job_id);
      });
      actions.appendChild(conv);
    }

    const print = document.createElement('button');
    print.type = 'button';
    print.textContent = 'Print';
    print.addEventListener('click', () => printHtml(quoteHtml(q)));
    actions.appendChild(print);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rm';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete quote "${txt(q.title)}"?`)) return;
      await api(`/api/quotes/${q.id}`, { method: 'DELETE' });
      loadQuotes();
    });
    actions.appendChild(del);
    grid.appendChild(card);
  }
}

function quoteHtml(q) {
  const shop = state.settings ? txt(state.settings.shop_name, 'Sign Shop') : 'Sign Shop';
  const items = quoteItems(q);
  const sub = items.reduce((s, i) => s + num(i.qty, 1) * num(i.price), 0);
  const tax = sub * num(q.tax_rate) / 100;
  return `
    <div class="print-doc">
      <div class="print-head"><h1>${esc(shop)}</h1><div><strong class="print-wo">QUOTE #${q.id}</strong><br><span style="font-size:10pt">${esc(txt(q.created_at).slice(0, 10))}</span></div></div>
      <h2>${esc(txt(q.title))}</h2>
      <p><strong>Prepared for:</strong> ${esc(txt(q.customer))}</p>
      <table class="print-table">
        <thead><tr><th>Item</th><th>Qty</th><th>Each</th><th>Amount</th></tr></thead>
        <tbody>${items.map(i => `
          <tr><td>${esc(txt(i.desc))}</td><td>${num(i.qty, 1)}</td>
          <td>$${num(i.price).toFixed(2)}</td><td>$${(num(i.qty, 1) * num(i.price)).toFixed(2)}</td></tr>`).join('')}
        </tbody>
      </table>
      <p style="text-align:right">Subtotal: $${sub.toFixed(2)}${tax ? `<br>Tax (${num(q.tax_rate)}%): $${tax.toFixed(2)}` : ''}<br><strong style="font-size:14pt">Total: $${(sub + tax).toFixed(2)}</strong></p>
      ${q.notes ? `<h3>Notes</h3><p class="print-notes">${esc(q.notes)}</p>` : ''}
      <p class="print-foot">Quote valid for 30 days · Printed ${new Date().toLocaleString()}</p>
    </div>
  `;
}

function addQuoteItemRow(desc = '', qty = 1, price = '') {
  const wrap = $('q-items');
  const row = document.createElement('div');
  row.className = 'q-item-row';
  row.innerHTML = `
    <input type="text" class="qi-desc" placeholder="Description — e.g. 4x8 ACM sign" value="${esc(desc)}">
    <input type="number" class="qi-qty" min="0.25" step="0.25" value="${qty}" title="Qty">
    <input type="number" class="qi-price" min="0" step="0.01" placeholder="$ each" value="${price}">
    <button type="button" class="x-btn" title="Remove line">×</button>
  `;
  row.querySelector('.x-btn').addEventListener('click', () => { row.remove(); updateQuoteTotal(); });
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', updateQuoteTotal));
  wrap.appendChild(row);
}

function readQuoteItems() {
  return [...document.querySelectorAll('#q-items .q-item-row')].map(r => ({
    desc: r.querySelector('.qi-desc').value.trim(),
    qty: num(r.querySelector('.qi-qty').value, 1),
    price: num(r.querySelector('.qi-price').value),
  })).filter(i => i.desc);
}

function updateQuoteTotal() {
  const sub = readQuoteItems().reduce((s, i) => s + i.qty * i.price, 0);
  const total = sub * (1 + num($('q-tax').value) / 100);
  $('q-total').textContent = `Total: $${total.toFixed(2)}`;
}

$('q-add-item').addEventListener('click', () => addQuoteItemRow());
$('q-tax').addEventListener('input', updateQuoteTotal);
addQuoteItemRow(); // start with one empty line

$('quote-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customer = $('q-customer').value.trim();
  const title = $('q-title').value.trim();
  const items = readQuoteItems();
  if (!customer || !title) return;
  if (!items.length) { alert('Add at least one line item with a description.'); return; }
  await api('/api/quotes', {
    method: 'POST',
    body: JSON.stringify({ customer, title, items, tax_rate: num($('q-tax').value) }),
  });
  $('quote-form').reset();
  $('q-items').innerHTML = '';
  addQuoteItemRow();
  updateQuoteTotal();
  loadQuotes();
});

// ---------- stage-time analytics ----------

async function loadStageTimes() {
  const box = $('stage-times');
  if (!box) return;
  let rows = [];
  try { rows = await api('/api/analytics/stages'); } catch { return; }
  const withData = rows.filter(r => r.avg_days !== null);
  if (!withData.length) { box.innerHTML = ''; return; }
  const max = Math.max(...withData.map(r => r.avg_days), 0.1);
  box.innerHTML = `<div class="st-head muted">Average days in each stage <span class="mono">(from ${withData.reduce((s, r) => s + r.samples, 0)} stage changes)</span></div>`
    + rows.map(r => {
      const sv = STAGE_VAR[r.stage] || 'st-design';
      const w = r.avg_days === null ? 0 : Math.max(4, Math.round((r.avg_days / max) * 100));
      return `
        <div class="st-row" title="${r.samples} sample${r.samples === 1 ? '' : 's'}">
          <span class="st-label">${STAGE_LABEL[r.stage] || r.stage}</span>
          <span class="st-bar"><span class="st-fill" style="width:${w}%;background:var(--${sv})"></span></span>
          <span class="st-val mono">${r.avg_days === null ? '—' : r.avg_days + 'd'}</span>
        </div>`;
    }).join('');
}

// ---------- industry news ----------

async function loadNews() {
  const list = $('news-list');
  if (!list) return;
  let items = [];
  try {
    const res = await api('/api/news');
    items = (res && res.items) || [];
  } catch { /* fall through to empty state */ }

  if (!items.length) {
    list.innerHTML = '<li class="muted">No headlines right now — use the links below.</li>';
    return;
  }
  // Interleave sources so one feed doesn't drown out the other.
  const bySource = new Map();
  items.forEach(it => {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  });
  const mixed = [];
  let added = true;
  while (added && mixed.length < 8) {
    added = false;
    for (const arr of bySource.values()) {
      if (arr.length && mixed.length < 8) { mixed.push(arr.shift()); added = true; }
    }
  }
  list.innerHTML = mixed.map(it => `
    <li class="news-item">
      <a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
      <span class="news-src muted">${esc(it.source)}</span>
    </li>
  `).join('');
}

// ---------- theme ----------

function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('cutline-theme', theme);
}

$('theme-toggle').addEventListener('click', () => {
  const current = localStorage.getItem('cutline-theme') || 'light';
  applyTheme(current === 'light' ? 'dark' : 'light');
});

// ---------- init ----------

$('page-date').textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
});

(async function init() {
  applyTheme(localStorage.getItem('cutline-theme') || 'light');
  await loadSettings();
  await loadJobs();
  await loadTasks();
  await loadEquipment();
  await loadMaterials();
  await loadUsage();
  await loadNotes();
  route();
  loadNews();
  loadStageTimes();
  const wo = location.hash.match(/^#wo-(\d+)$/);
  if (wo) {
    location.hash = '#jobs';
    openJobModal(parseInt(wo[1], 10));
  }
})();
