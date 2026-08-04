/* AP ECET 2026 Allotment Results Portal
   Data loading + search logic for all three panels. */

let DATA = [];
let COLLEGES = [];
let BRANCHES = [];
let SEATS = {}; // { inst_code: { name, total, left, entry_date, district, college_type, branches: [{bcode,bname,total,left}] } }
let SORTED_COLLEGES = []; // [ [code, name], ... ] sorted by name, built once after load

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-IN');
}

function fmtDate(d) {
  // Input format: DD/MM/YYYY
  const parts = String(d || '').split('/');
  if (parts.length !== 3) return d || '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = parseInt(parts[0], 10);
  const month = months[parseInt(parts[1], 10) - 1] || '';
  return `${day} ${month} ${parts[2]}`;
}

/* ---------- Load data ---------- */
async function loadData() {
  const [dataRes, collegesRes, branchesRes, seatsRes] = await Promise.all([
    fetch('data.json'),
    fetch('colleges.json'),
    fetch('branches.json'),
    fetch('seats.json'),
  ]);
  DATA = await dataRes.json();
  COLLEGES = await collegesRes.json(); // [ [code, name], ... ]
  BRANCHES = await branchesRes.json();
  SEATS = await seatsRes.json();
  SORTED_COLLEGES = [...COLLEGES].sort((a, b) => a[1].localeCompare(b[1]));
}

/* Shared college search used by the main College panel and every inline
   cutoff widget — matches by name or code, ranked by best match. */
function matchColleges(query) {
  const q = query.trim().toLowerCase();
  if (!q) return SORTED_COLLEGES.slice(0, 30);
  const scored = [];
  for (const [code, name] of SORTED_COLLEGES) {
    const nameLc = name.toLowerCase();
    const codeLc = code.toLowerCase();
    let score = -1;
    if (codeLc === q) score = 0;
    else if (codeLc.startsWith(q)) score = 1;
    else if (nameLc.startsWith(q)) score = 2;
    else if (codeLc.includes(q)) score = 3;
    else if (nameLc.includes(q)) score = 4;
    if (score >= 0) scored.push({ code, name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, 30).map(s => [s.code, s.name]);
}

/* Number of candidates actually allotted a given branch at a given college,
   derived from the real allotment records (DATA). */
function allottedCountFor(ccode, bcode) {
  let n = 0;
  for (const r of DATA) {
    if (r.ccode === ccode && r.bcode === bcode) n++;
  }
  return n;
}

/* Combines the official sanctioned seat matrix (SEATS) with actual allotment
   counts (DATA) for one college: total sanctioned seats, seats left as per
   the official matrix, and seats actually allotted — both as a college-wide
   total and broken down per branch. Falls back gracefully if a college has
   no entry in the seat matrix. If branchFilter is given, every figure is
   scoped to that single branch only (so selecting a branch shows only that
   branch's seats, not the whole college's). */
function seatComparisonForCollege(ccode, branchFilter) {
  const seatInfo = SEATS[ccode];
  const allottedTotalAll = DATA.filter(r => r.ccode === ccode).length;

  if (!seatInfo) {
    const counts = new Map();
    for (const r of DATA) {
      if (r.ccode !== ccode) continue;
      if (branchFilter && r.bcode !== branchFilter) continue;
      if (!counts.has(r.bcode)) counts.set(r.bcode, { bname: r.bname, allotted: 0 });
      counts.get(r.bcode).allotted++;
    }
    const branches = [...counts.entries()]
      .map(([bcode, v]) => ({ bcode, bname: v.bname, total: null, left: null, allotted: v.allotted }))
      .sort((a, b) => b.allotted - a.allotted || a.bname.localeCompare(b.bname));
    const allottedTotal = branchFilter
      ? branches.reduce((s, b) => s + b.allotted, 0)
      : allottedTotalAll;
    return { hasSeatMatrix: false, total: null, left: null, allottedTotal, entryDate: null, branches };
  }

  let branches = seatInfo.branches.map(b => {
    const allotted = allottedCountFor(ccode, b.bcode);
    return {
      bcode: b.bcode,
      bname: b.bname,
      total: b.total,
      allotted,
      left: Math.max(0, b.total - allotted), // seats still open = sanctioned - allotted
    };
  }).sort((a, b) => b.total - a.total || a.bname.localeCompare(b.bname));

  if (branchFilter) {
    branches = branches.filter(b => b.bcode === branchFilter);
  }

  const total = branches.reduce((s, b) => s + b.total, 0);
  const allottedTotal = branches.reduce((s, b) => s + b.allotted, 0);

  return {
    hasSeatMatrix: true,
    total,
    allottedTotal,
    left: Math.max(0, total - allottedTotal),
    entryDate: seatInfo.entry_date,
    branches,
  };
}

/* ---------- Cutoff (last-rank-allotted) computation ---------- */

/* AP EAPCET category strings are highly granular (region + reservation type
   + gender all folded into one code, e.g. "bc_a_ncc_girls_svu"). We collapse
   each down to its base caste/community category plus gender, since that is
   what a cutoff table conventionally shows. */
const CATEGORY_PREFIXES = [
  ['bc_a_', 'BC-A'], ['bc_b_', 'BC-B'], ['bc_c_', 'BC-C'],
  ['bc_d_', 'BC-D'], ['bc_e_', 'BC-E'],
  ['sc_iii_', 'SC'], ['sc_ii_', 'SC'], ['sc_i_', 'SC'],
  ['st_', 'ST'], ['ews_', 'EWS'], ['oc_', 'OC'],
  ['chr_', 'CHR'], ['mus_', 'MUS'],
];
const CATEGORY_ORDER = ['OC', 'EWS', 'BC-A', 'BC-B', 'BC-C', 'BC-D', 'BC-E', 'SC', 'ST', 'CHR', 'MUS', 'OTHER'];

function classifyCategory(cat) {
  const c = String(cat || '').toLowerCase();
  let base = 'OTHER';
  for (const [prefix, label] of CATEGORY_PREFIXES) {
    if (c.startsWith(prefix)) { base = label; break; }
  }
  const gender = c.includes('girls') ? 'Girls' : 'Gen';
  return { base, gender };
}

function comboKey(base, gender) { return `${base}|${gender}`; }
function comboLabel(base, gender) { return gender === 'Girls' ? `${base} (G)` : base; }

/* Cutoff = the worst (highest-numbered) ECET rank that still got a seat, per
   branch per category, at a given college. Optionally scoped to one branch. */
function cutoffsForCollege(ccode, branchFilter) {
  const branchMap = new Map(); // bcode -> { bname, cutoffs: Map(comboKey -> worstRank) }
  const comboSet = new Set();

  for (const r of DATA) {
    if (r.ccode !== ccode) continue;
    if (branchFilter && r.bcode !== branchFilter) continue;
    const { base, gender } = classifyCategory(r.cat);
    const key = comboKey(base, gender);
    comboSet.add(key);
    if (!branchMap.has(r.bcode)) branchMap.set(r.bcode, { bname: r.bname, cutoffs: new Map() });
    const entry = branchMap.get(r.bcode);
    const rankNum = Number(r.rank);
    const existing = entry.cutoffs.get(key);
    if (existing === undefined || rankNum > existing) entry.cutoffs.set(key, rankNum);
  }

  const combos = [...comboSet].map(key => {
    const [base, gender] = key.split('|');
    return { key, base, gender, label: comboLabel(base, gender) };
  }).sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.base), bi = CATEGORY_ORDER.indexOf(b.base);
    if (ai !== bi) return ai - bi;
    return a.gender === b.gender ? 0 : (a.gender === 'Gen' ? -1 : 1);
  });

  const branches = [...branchMap.entries()]
    .map(([bcode, v]) => ({ bcode, bname: v.bname, cutoffs: v.cutoffs }))
    .sort((a, b) => a.bname.localeCompare(b.bname));

  return { combos, branches };
}

function renderCutoffsTable(collegeName, ccode, branchFilter) {
  const { combos, branches } = cutoffsForCollege(ccode, branchFilter);

  if (!branches.length) {
    return `<p class="cutoff-hint">No allotment records found${branchFilter ? ' for this branch' : ''} at this college — cutoffs unavailable.</p>`;
  }

  const headCells = combos.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
  const rows = branches.map(b => {
    const cells = combos.map(c => {
      const v = b.cutoffs.get(c.key);
      return `<td class="num">${v !== undefined ? fmtNum(v) : '—'}</td>`;
    }).join('');
    return `<tr><td class="b-name-cell">${escapeHtml(b.bname)}</td>${cells}</tr>`;
  }).join('');

  return `
    <p class="cutoff-caption">Last ECET rank allotted per category at <strong>${escapeHtml(collegeName)}</strong>${branchFilter ? ' (selected branch)' : ''}. A blank cell means no seat was allotted in that category.</p>
    <div class="cutoff-table-wrap">
      <table class="cutoff-table">
        <thead><tr><th>Branch</th>${headCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderSeatsSummary(collegeName, ccode, branchFilter) {
  const c = seatComparisonForCollege(ccode, branchFilter);
  const scopedLabel = branchFilter && c.branches[0] ? ` — ${c.branches[0].bname}` : '';

  const statTiles = c.hasSeatMatrix ? `
    <div class="seat-stat">
      <span class="seat-stat-label">Total Seats</span>
      <strong class="seat-stat-value tone-ink">${fmtNum(c.total)}</strong>
    </div>
    <div class="seat-stat">
      <span class="seat-stat-label">Allotted</span>
      <strong class="seat-stat-value tone-primary">${fmtNum(c.allottedTotal)}</strong>
    </div>
    <div class="seat-stat">
      <span class="seat-stat-label">Left</span>
      <strong class="seat-stat-value tone-teal">${fmtNum(c.left)}</strong>
    </div>` : `
    <div class="seat-stat">
      <span class="seat-stat-label">Allotted</span>
      <strong class="seat-stat-value tone-primary">${fmtNum(c.allottedTotal)}</strong>
    </div>`;

  const branchRows = c.branches.map(b => `
    <tr>
      <td class="b-name-cell">${escapeHtml(b.bname)}</td>
      ${c.hasSeatMatrix ? `<td class="num tone-ink">${fmtNum(b.total)}</td>` : ''}
      <td class="num tone-primary">${fmtNum(b.allotted)}</td>
      ${c.hasSeatMatrix ? `<td class="num tone-teal">${fmtNum(b.left)}</td>` : ''}
    </tr>`).join('');

  const dateNote = c.hasSeatMatrix && c.entryDate
    ? `<p class="seats-note">Total seats sourced from the sanctioned seat matrix published ${escapeHtml(fmtDate(c.entryDate))}. Allotted and Left reflect actual counselling results (Left = Total − Allotted).</p>`
    : `<p class="seats-note">Sanctioned-seat matrix not available for this college — showing actual allotment figures only.</p>`;

  return `
    <div class="seats-summary">
      <div class="seats-summary-head">
        <div>
          <p class="seats-summary-title">Seat Availability${branchFilter ? ' — Selected Branch' : ''}</p>
          <h3 class="seats-summary-college">${escapeHtml(collegeName)}${escapeHtml(scopedLabel)}</h3>
        </div>
        <div class="seat-stats">${statTiles}</div>
      </div>
      <div class="seats-table-wrap">
        <table class="seats-table">
          <thead>
            <tr>
              <th>Branch</th>
              ${c.hasSeatMatrix ? '<th>Total</th>' : ''}
              <th>Allotted</th>
              ${c.hasSeatMatrix ? '<th>Left</th>' : ''}
            </tr>
          </thead>
          <tbody>${branchRows}</tbody>
        </table>
      </div>
      ${dateNote}
    </div>`;
}

/* ---------- Tabs ---------- */
function initTabs() {
  const tabs = $$('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.panel').forEach(p => p.classList.remove('active'));
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

/* ---------- Rendering helpers ---------- */
function sexBadge(sex) {
  const cls = sex && sex.toLowerCase().startsWith('f') ? 'badge-sex-F' : 'badge-sex-M';
  return `<span class="badge ${cls}">${escapeHtml(sex || '—')}</span>`;
}

function catBadge(cat) {
  return `<span class="badge badge-cat">${escapeHtml((cat || '—').toUpperCase())}</span>`;
}

function emptyState(icon, title, msg) {
  return `<div class="table-wrap"><div class="empty-state">
    <div class="icon">${icon}</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(msg)}</p>
  </div></div>`;
}

function renderResultsTable(rows, { showCollege = false } = {}) {
  if (!rows.length) {
    return emptyState('0', 'No matching records', 'Try a different search term or check your spelling.');
  }
  const head = `
    <tr>
      <th>Hall Ticket</th>
      <th>Candidate</th>
      <th>Sex</th>
      <th>ECET Rank</th>
      <th>Integrated Rank</th>
      ${showCollege ? '<th>College</th>' : ''}
      <th>Branch</th>
      <th>Category</th>
    </tr>`;
  const body = rows.map(r => `
    <tr>
      <td class="num">${escapeHtml(r.ht)}</td>
      <td class="name-cell">${escapeHtml(r.name)}</td>
      <td>${sexBadge(r.sex)}</td>
      <td class="num">${escapeHtml(r.rank)}</td>
      <td class="num">${escapeHtml(r.irank)}</td>
      ${showCollege ? `<td class="college-name-cell">${escapeHtml(r.cname)}</td>` : ''}
      <td>${escapeHtml(r.bname)}</td>
      <td>${catBadge(r.cat)}</td>
    </tr>`).join('');
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function renderCertCard(r) {
  const allRanks = DATA.map(d => Number(d.rank)).filter(n => !isNaN(n));
  const minRank = Math.min(...allRanks);
  const maxRank = Math.max(...allRanks);
  const rankNum = Number(r.rank);
  const pct = maxRank > minRank
    ? Math.min(100, Math.max(0, ((rankNum - minRank) / (maxRank - minRank)) * 100))
    : 50;

  return `
    <div class="cert-card">
      <div class="cert-head">
        <div>
          <p class="cert-label">Allotment Record</p>
          <h3>${escapeHtml(r.name)}</h3>
        </div>
        <div class="cert-avatar">${escapeHtml(initials(r.name))}</div>
      </div>
      <div class="cert-body">

        <div class="rank-strip">
          <div class="rank-strip-top">
            <span class="label">ECET Rank</span>
            <span class="value">${escapeHtml(r.rank)}</span>
          </div>
          <div class="rank-track">
            <div class="rank-marker" style="left:${pct}%;"></div>
          </div>
          <div class="rank-strip-labels">
            <span>Rank ${minRank}</span>
            <span>Rank ${maxRank}</span>
          </div>
        </div>

        <dl class="cert-grid">
          <div class="cert-item">
            <dt>Hall Ticket No.</dt>
            <dd>${escapeHtml(r.ht)}</dd>
          </div>
          <div class="cert-item">
            <dt>Integrated Rank</dt>
            <dd>${escapeHtml(r.irank)}</dd>
          </div>
          <div class="cert-item">
            <dt>Sex</dt>
            <dd>${sexBadge(r.sex)}</dd>
          </div>
          <div class="cert-item">
            <dt>Caste</dt>
            <dd>${escapeHtml(r.caste)}</dd>
          </div>

          <div class="cert-divider"></div>

          <div class="cert-item wide">
            <dt>Allotted College</dt>
            <dd>${escapeHtml(r.cname)} <span style="color:var(--muted); font-weight:500;">(${escapeHtml(r.ccode)})</span></dd>
          </div>
          <div class="cert-item">
            <dt>Branch</dt>
            <dd>${escapeHtml(r.bname)}</dd>
          </div>
          <div class="cert-item">
            <dt>Branch Code</dt>
            <dd>${escapeHtml(r.bcode)}</dd>
          </div>
          <div class="cert-item">
            <dt>Seat Category</dt>
            <dd>${catBadge(r.cat)}</dd>
          </div>
        </dl>
      </div>
    </div>`;
}

function resultsMeta(count, label = 'record') {
  return `<div class="results-meta"><p class="results-count"><strong>${count}</strong> ${label}${count === 1 ? '' : 's'} found</p></div>`;
}

/* ---------- Panel 1: College ---------- */
function initCollegePanel() {
  const input = $('#college-input');
  const hiddenSel = $('#college-select');
  const list = $('#college-list');
  const branchSel = $('#college-branch-filter');
  const out = $('#college-results');
  const cutoffToggle = $('#college-cutoff-toggle');
  const cutoffPanel = $('#college-cutoff-panel');

  function renderList(query) {
    const matches = matchColleges(query);
    if (!matches.length) {
      list.innerHTML = `<div class="combo-empty">No colleges match "${escapeHtml(query)}"</div>`;
    } else {
      list.innerHTML = matches.map(([code, name]) => `
        <div class="combo-item" data-code="${escapeHtml(code)}" data-name="${escapeHtml(name)}" role="option">
          <span class="c-name">${escapeHtml(name)}</span>
          <span class="c-code">${escapeHtml(code)}</span>
        </div>`).join('');
    }
    list.classList.add('open');
  }

  function closeList() {
    list.classList.remove('open');
  }

  function selectCollege(code, name) {
    hiddenSel.value = code;
    input.value = `${name} (${code})`;
    closeList();
    populateBranchesForSelectedCollege(code);
    cutoffToggle.disabled = false;
    run();
  }

  function populateBranchesForSelectedCollege(code) {
    if (!code) {
      branchSel.innerHTML = '<option value="">Select a college first</option>';
      branchSel.disabled = true;
      return;
    }
    const c = seatComparisonForCollege(code);
    branchSel.disabled = false;
    const allLabel = c.hasSeatMatrix
      ? `All branches (${fmtNum(c.total)} total, ${fmtNum(c.allottedTotal)} allotted, ${fmtNum(c.left)} left)`
      : `All branches (${fmtNum(c.allottedTotal)} allotted)`;
    const options = [`<option value="">${allLabel}</option>`]
      .concat(c.branches.map(b => {
        const label = c.hasSeatMatrix
          ? `${b.bname} — ${fmtNum(b.total)} total, ${fmtNum(b.allotted)} allotted, ${fmtNum(b.left)} left`
          : `${b.bname} — ${fmtNum(b.allotted)} allotted`;
        return `<option value="${escapeHtml(b.bcode)}">${escapeHtml(label)}</option>`;
      }));
    branchSel.innerHTML = options.join('');
  }

  function renderCutoffPanelIfOpen() {
    if (cutoffPanel.hasAttribute('hidden')) return;
    const code = hiddenSel.value;
    if (!code) { cutoffPanel.innerHTML = ''; return; }
    const collegeEntry = SORTED_COLLEGES.find(c => c[0] === code);
    const name = collegeEntry ? collegeEntry[1] : code;
    cutoffPanel.innerHTML = renderCutoffsTable(name, code, branchSel.value);
  }

  function run() {
    const code = hiddenSel.value;
    if (!code) {
      out.innerHTML = emptyState('?', 'Select a college to begin', 'Search by college name or code above to view its allotment list.');
      return;
    }
    const collegeEntry = SORTED_COLLEGES.find(c => c[0] === code);
    const collegeName = collegeEntry ? collegeEntry[1] : code;
    const branch = branchSel.value;
    let rows = DATA.filter(r => r.ccode === code);
    if (branch) rows = rows.filter(r => r.bcode === branch);
    rows = [...rows].sort((a, b) => Number(a.rank) - Number(b.rank));
    out.innerHTML =
      renderSeatsSummary(collegeName, code, branch) +
      resultsMeta(rows.length) +
      renderResultsTable(rows, { showCollege: false });
    renderCutoffPanelIfOpen();
  }

  input.addEventListener('input', () => {
    // Typing invalidates any previously confirmed selection until a new pick is made.
    if (hiddenSel.value) {
      hiddenSel.value = '';
      populateBranchesForSelectedCollege('');
      cutoffToggle.disabled = true;
      cutoffPanel.setAttribute('hidden', '');
      cutoffToggle.classList.remove('open');
      out.innerHTML = emptyState('?', 'Select a college to begin', 'Search by college name or code above to view its allotment list.');
    }
    renderList(input.value);
  });
  input.addEventListener('focus', () => renderList(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeList();
    if (e.key === 'Enter') {
      const first = list.querySelector('.combo-item');
      if (first) selectCollege(first.dataset.code, first.dataset.name);
      e.preventDefault();
    }
  });

  list.addEventListener('click', e => {
    const item = e.target.closest('.combo-item');
    if (!item) return;
    selectCollege(item.dataset.code, item.dataset.name);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.combo')) closeList();
  });

  branchSel.addEventListener('change', run);

  cutoffToggle.addEventListener('click', () => {
    if (cutoffToggle.disabled) return;
    const isHidden = cutoffPanel.hasAttribute('hidden');
    if (isHidden) {
      cutoffPanel.removeAttribute('hidden');
      cutoffToggle.classList.add('open');
      renderCutoffPanelIfOpen();
    } else {
      cutoffPanel.setAttribute('hidden', '');
      cutoffToggle.classList.remove('open');
    }
  });

  populateBranchesForSelectedCollege('');
  run();
}

/* ---------- Panel 2: Name ---------- */
function initNamePanel() {
  const input = $('#name-input');
  const clearBtn = $('#name-clear');
  const out = $('#name-results');

  function run() {
    const q = input.value.trim().toLowerCase();
    if (q.length < 3) {
      out.innerHTML = emptyState('…', 'Keep typing…', 'Enter at least 3 characters of the candidate\u2019s name to search.');
      return;
    }
    const rows = DATA.filter(r => r.name.toLowerCase().includes(q)).slice(0, 200);
    out.innerHTML = resultsMeta(rows.length) + renderResultsTable(rows, { showCollege: true });
  }

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 180);
  });
  clearBtn.addEventListener('click', () => { input.value = ''; run(); input.focus(); });
  run();
}

/* ---------- Panel 3: Hall Ticket ---------- */
function initHallTicketPanel() {
  const input = $('#ht-input');
  const searchBtn = $('#ht-search');
  const clearBtn = $('#ht-clear');
  const out = $('#ht-results');

  function run() {
    const q = input.value.trim();
    if (!q) {
      out.innerHTML = emptyState('#', 'Enter a hall ticket number', 'Type the exact hall ticket number and press Search.');
      return;
    }
    const match = DATA.find(r => r.ht === q);
    if (!match) {
      out.innerHTML = emptyState('0', 'No record found', `No allotment record matches hall ticket "${q}". Double-check the number and try again.`);
      return;
    }
    out.innerHTML = renderCertCard(match);
  }

  searchBtn.addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  clearBtn.addEventListener('click', () => { input.value = ''; out.innerHTML = ''; input.focus(); });
  out.innerHTML = emptyState('#', 'Enter a hall ticket number', 'Type the exact hall ticket number and press Search.');
}

/* ---------- Reusable inline "View Cutoffs" widget ----------
   Used on the Name and Hall Ticket tabs, where there is no already-selected
   college. Mounts its own compact college search + branch filter the first
   time it is opened, then renders the cutoff table for whatever is chosen. */
function initInlineCutoffWidget(prefix) {
  const toggle = $(`#${prefix}-cutoff-toggle`);
  const panel = $(`#${prefix}-cutoff-panel`);
  if (!toggle || !panel) return;
  let mounted = false;

  function mount() {
    panel.innerHTML = `
      <div class="cutoff-widget">
        <div class="cutoff-widget-row">
          <div class="combo cutoff-combo">
            <input type="text" id="${prefix}-cutoff-college-input" placeholder="Search college by name or code…" autocomplete="off">
            <input type="hidden" id="${prefix}-cutoff-college-code" value="">
            <div class="combo-list" id="${prefix}-cutoff-college-list"></div>
          </div>
          <select id="${prefix}-cutoff-branch-select" disabled>
            <option value="">All branches</option>
          </select>
        </div>
        <div id="${prefix}-cutoff-result"></div>
      </div>`;

    const cInput = $(`#${prefix}-cutoff-college-input`);
    const cHidden = $(`#${prefix}-cutoff-college-code`);
    const cList = $(`#${prefix}-cutoff-college-list`);
    const bSel = $(`#${prefix}-cutoff-branch-select`);
    const result = $(`#${prefix}-cutoff-result`);

    function renderResult() {
      const code = cHidden.value;
      if (!code) {
        result.innerHTML = `<p class="cutoff-hint">Search and select a college above to view its cutoffs.</p>`;
        return;
      }
      const entry = SORTED_COLLEGES.find(c => c[0] === code);
      const name = entry ? entry[1] : code;
      result.innerHTML = renderCutoffsTable(name, code, bSel.value);
    }

    function populateBranches(code) {
      if (!code) {
        bSel.innerHTML = '<option value="">All branches</option>';
        bSel.disabled = true;
        return;
      }
      const c = seatComparisonForCollege(code);
      bSel.disabled = false;
      bSel.innerHTML = ['<option value="">All branches</option>']
        .concat(c.branches.map(b => `<option value="${escapeHtml(b.bcode)}">${escapeHtml(b.bname)}</option>`))
        .join('');
    }

    function selectCollege(code, name) {
      cHidden.value = code;
      cInput.value = `${name} (${code})`;
      cList.classList.remove('open');
      populateBranches(code);
      renderResult();
    }

    function renderList(query) {
      const matches = matchColleges(query);
      if (!matches.length) {
        cList.innerHTML = `<div class="combo-empty">No colleges match "${escapeHtml(query)}"</div>`;
      } else {
        cList.innerHTML = matches.map(([code, name]) => `
          <div class="combo-item" data-code="${escapeHtml(code)}" data-name="${escapeHtml(name)}">
            <span class="c-name">${escapeHtml(name)}</span><span class="c-code">${escapeHtml(code)}</span>
          </div>`).join('');
      }
      cList.classList.add('open');
    }

    cInput.addEventListener('input', () => {
      if (cHidden.value) {
        cHidden.value = '';
        populateBranches('');
        renderResult();
      }
      renderList(cInput.value);
    });
    cInput.addEventListener('focus', () => renderList(cInput.value));
    cList.addEventListener('click', e => {
      const item = e.target.closest('.combo-item');
      if (!item) return;
      selectCollege(item.dataset.code, item.dataset.name);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest(`#${prefix}-cutoff-panel .combo`)) cList.classList.remove('open');
    });
    bSel.addEventListener('change', renderResult);

    renderResult();
  }

  toggle.addEventListener('click', () => {
    const isHidden = panel.hasAttribute('hidden');
    if (isHidden) {
      if (!mounted) { mount(); mounted = true; }
      panel.removeAttribute('hidden');
      toggle.classList.add('open');
    } else {
      panel.setAttribute('hidden', '');
      toggle.classList.remove('open');
    }
  });
}

/* ---------- Init ---------- */
(async function init() {
  initTabs();
  try {
    await loadData();
    initCollegePanel();
    initNamePanel();
    initHallTicketPanel();
    initInlineCutoffWidget('name');
    initInlineCutoffWidget('ht');
  } catch (err) {
    document.querySelectorAll('.panel > div:last-child').forEach(el => {
      el.innerHTML = `<div class="table-wrap"><div class="empty-state"><div class="icon">!</div><h3>Could not load data</h3><p>data.json failed to load. Make sure it is uploaded in the same folder as this page.</p></div></div>`;
    });
    console.error(err);
  }
})();
