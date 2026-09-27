/* Interspeech 2026 聴講スケジュール — 単一ページアプリ（ビルド不要） */
(() => {
'use strict';

const LS_KEY = 'is2026:state';
const SS_NOW = 'is2026:now';
const SCHEMA = 1;
const LINKS = {
  archive: 'https://www.isca-archive.org/interspeech_2026/index.html',
  program: 'https://interspeech2026.org/en-AU/pages/program/program',
};

let DATA = null;
let TZ = 'Australia/Sydney';
let PAPERS = [];           // 全発表（重複を key でまとめたもの）
let OCC_BY_ANCHOR = {};    // anchorId → occurrence

const state = {
  view: 'today',
  day: null,
  choices: {},
  notes: {},
  done: {},
  star: {},
  picks: {},     // choiceId → 候補 ckey の配列
  lateOk: {},    // choiceId → 途中入室を許容するか
  theme: 'auto',
  mdOnlyAnnotated: false,
};
const ui = {
  openNotes: new Set(),
  openAlts: new Set(),
  compare: new Set(),
  editChoice: new Set(),   // 選択済みでも一時的に選択 UI を開いている choice
  search: '',
  fPrio: new Set(),
  fType: new Set(),
  fDone: false, fMemo: false, fStar: false,
  highlight: null,
  rlSearch: '',
};

/* ===== utils ===== */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const KIND_LABEL = (k) => (DATA?.legend?.kinds?.[k]) || k;
const TT_LABEL = { official: '公式', proposed: '訪問案', tentative: '進行未公表' };
// 発表番号からセッション名を導く（A07-O8-01 → Area07-Oral8、Long-O2-01 → Long-Oral2 …）
function sessionOf(code) {
  if (!code) return null;
  let m, key, label;
  if ((m = /^A(\d{2})-(O|P)(\d+)-/.exec(code))) { key = `A${m[1]}-${m[2]}${m[3]}`; label = `Area${m[1]}-${m[2] === 'O' ? 'Oral' : 'Poster'}${m[3]}`; }
  else if ((m = /^Long-O(\d+)-/.exec(code))) { key = `Long-O${m[1]}`; label = `Long-Oral${m[1]}`; }
  else if ((m = /^Surv-(\d{2})-/.exec(code))) { key = `A${m[1]}-O1`; label = `Survey（Area${m[1]}）`; }
  else if ((m = /^A(\d{2})-(\d)-/.exec(code))) { key = `A${m[1]}-${m[2]}`; label = `Area${m[1]}-${m[2]}（Special Session）`; }
  else return null;
  const name = DATA?.sessions?.[key];
  return { key, label, name, full: name ? `${label} — ${name}` : label };
}
function sessionChip(code) {
  const s = sessionOf(code); if (!s) return '';
  return `<span class="chip session" title="${esc(s.full)}">${esc(s.label)}${s.name ? ` <span class="sname">${esc(s.name)}</span>` : ''}</span>`;
}
function roomHint(room) {
  if (!room) return '';
  const h = DATA?.rooms?.hints || {};
  const base = room.replace(/（.*?）|\(.*?\)/g, '').trim();
  if (/gallery/i.test(base)) return h.Gallery || '';
  if (/^C2/.test(base)) return h.C2 || '';
  if (/^C3/.test(base)) return h.C3 || '';
  for (const k of Object.keys(h)) if (base.includes(k)) return h[k];
  return '';
}

function keyOf(obj, slotId) {
  if (obj.paperNo) return 'p:' + obj.paperNo;
  if (obj.code) return 'c:' + obj.code;
  return 's:' + (slotId || obj.id);
}
function paperLinks(p) {
  const q = encodeURIComponent(p.title || '');
  return `<div class="links" aria-label="論文リンク">
    <a href="${LINKS.archive}" target="_blank" rel="noopener">ISCA Archive</a>
    <a href="${LINKS.program}" target="_blank" rel="noopener">公式プログラム</a>
    <a href="https://scholar.google.com/scholar?q=${q}" target="_blank" rel="noopener">Scholar 検索</a>
  </div>`;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('コピーしました' + (text.length < 40 ? ': ' + text : `（${text.length} 文字）`)); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('コピーしました' + (text.length < 40 ? ': ' + text : `（${text.length} 文字）`)); }
}
function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ===== time (Asia/Sydney) ===== */
function nowSydney() {
  const override = sessionStorage.getItem(SS_NOW) || new URLSearchParams(location.search).get('now');
  if (override) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(override);
    if (m) return { date: m[1], min: +m[2] * 60 + +m[3], hhmm: `${m[2]}:${m[3]}`, simulated: true };
  }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now()));
  const g = (t) => parts.find((p) => p.type === t)?.value;
  let h = g('hour'); if (h === '24') h = '00';
  const mi = g('minute');
  return { date: `${g('year')}-${g('month')}-${g('day')}`, min: +h * 60 + +mi, hhmm: `${h}:${mi}`, simulated: false };
}

/* ===== persistence ===== */
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') {
      for (const k of ['choices', 'notes', 'done', 'star', 'picks', 'lateOk']) if (s[k] && typeof s[k] === 'object') state[k] = s[k];
      if (s.theme) state.theme = s.theme;
      if (typeof s.mdOnlyAnnotated === 'boolean') state.mdOnlyAnnotated = s.mdOnlyAnnotated;
    }
  } catch (e) { console.warn('state load failed', e); }
}
function saveState() {
  const s = { schemaVersion: SCHEMA, savedAt: new Date().toISOString(), choices: state.choices, notes: state.notes, done: state.done, star: state.star, picks: state.picks, lateOk: state.lateOk, theme: state.theme, mdOnlyAnnotated: state.mdOnlyAnnotated };
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { toast('保存に失敗しました'); }
}
function exportJSON() {
  return JSON.stringify({ app: 'is2026', schemaVersion: SCHEMA, exportedAt: new Date().toISOString(), choices: state.choices, notes: state.notes, done: state.done, star: state.star, picks: state.picks, lateOk: state.lateOk }, null, 2);
}
function importJSON(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== 'object') throw new Error('bad');
  if (s.schemaVersion && s.schemaVersion > SCHEMA) throw new Error('newer schema');
  let n = 0;
  for (const k of ['choices', 'notes', 'done', 'star', 'picks', 'lateOk']) {
    if (!s[k] || typeof s[k] !== 'object') continue;
    if (k === 'picks' || k === 'lateOk') { Object.assign(state[k], s[k]); n += Object.keys(s[k]).length; continue; }
    for (const [id, v] of Object.entries(s[k])) {
      if (k === 'notes' && !String(v).trim()) continue;
      if (k !== 'notes' && !v) { continue; }
      state[k][id] = v; n++;
    }
  }
  saveState();
  return n;
}

/* ===== theme ===== */
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', state.theme);
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
  applyTheme(); saveState();
  toast('テーマ: ' + ({ auto: 'OS に追従', light: 'ライト', dark: 'ダーク' })[state.theme]);
}

/* ===== data indexing ===== */
function selectedOption(choice) {
  const id = state.choices[choice.id] || choice.default;
  if (id === 'custom') return customOption(choice);
  return choice.options.find((o) => o.id === id) || choice.options[0];
}
function subPapers(slot) { return slot.items || slot.targets || []; }
function slotHasPaper(s) { return !!(s.paperNo || (s.code && (s.kind === 'talk' || s.kind === 'keynote'))); }

function buildIndex() {
  const byKey = new Map();
  OCC_BY_ANCHOR = {};
  const push = (occ) => {
    OCC_BY_ANCHOR[occ.anchorId] = occ;
    if (!byKey.has(occ.key)) byKey.set(occ.key, { key: occ.key, title: occ.title, team: occ.team, code: occ.code, paperNo: occ.paperNo, priority: occ.priority, reason: occ.reason, types: new Set(), occ: [] });
    const p = byKey.get(occ.key);
    p.types.add(occ.type);
    if (!p.priority && occ.priority) p.priority = occ.priority;
    if (occ.priority && 'SAB'.indexOf(occ.priority) < 'SAB'.indexOf(p.priority || 'B')) p.priority = occ.priority;
    p.occ.push(occ);
  };
  const walk = (s, day, choice, option) => {
    if (s.kind === 'choice') { for (const o of s.options) for (const ss of o.slots) walk(ss, day, s, o); return; }
    const base = { date: day.date, dayLabel: day.label, choiceId: choice?.id, optionId: option?.id, optionLabel: option?.label, slotId: s.id, room: s.room, start: s.start, end: s.end };
    if (s.kind === 'talk' && (s.paperNo || s.code)) {
      push({ ...base, key: keyOf(s), anchorId: 'card-' + s.id, title: s.title, team: s.team, code: s.code, paperNo: s.paperNo, priority: s.priority, reason: s.reason, type: 'oral' });
    }
    subPapers(s).forEach((it, i) => {
      const type = s.kind === 'special_session' ? 'special' : 'poster';
      push({ ...base, room: it.room || s.room, key: keyOf(it, s.id), anchorId: `card-${s.id}-${i}`, title: it.title, team: it.team, code: it.code, paperNo: it.paperNo, priority: it.priority, reason: it.reason, type });
    });
  };
  for (const day of DATA.days) for (const s of day.slots) walk(s, day, null, null);
  PAPERS = Array.from(byKey.values());
  const ord = { S: 0, A: 1, B: 2 };
  PAPERS.sort((a, b) => (ord[a.priority] ?? 3) - (ord[b.priority] ?? 3) || a.occ[0].date.localeCompare(b.occ[0].date) || a.occ[0].start.localeCompare(b.occ[0].start));
}

/* ===== rendering: common paper card ===== */
function actionButtons(key) {
  const done = !!state.done[key], star = !!state.star[key], memo = !!(state.notes[key] || '').trim();
  return `<div class="actions">
    <button type="button" class="act-done ${done ? 'active-done' : ''}" data-act="done" data-key="${esc(key)}" aria-pressed="${done}">${done ? '✓ 聴いた' : '聴いた'}</button>
    <button type="button" class="act-star ${star ? 'active-star' : ''}" data-act="star" data-key="${esc(key)}" aria-pressed="${star}" aria-label="後で読む">${star ? '★ 後で読む' : '☆ 後で読む'}</button>
    <button type="button" class="act-memo ${memo ? 'has-memo' : ''}" data-act="memo" data-key="${esc(key)}" aria-expanded="${ui.openNotes.has(key)}">${memo ? '✎ メモあり' : '✎ メモ'}</button>
  </div>`;
}
function noteBox(key, paperNo) {
  const qs = paperNo ? DATA.questions?.[paperNo] : null;
  const open = ui.openNotes.has(key);
  return `<div class="notebox" data-notebox="${esc(key)}" ${open ? '' : 'hidden'}>
    ${qs?.length ? `<div class="questions"><h4>用意した質問</h4><ol>${qs.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></div>` : ''}
    <div class="note-lbl"><span>メモ（自動保存）</span><span class="muted">${esc(key)}</span></div>
    <textarea data-note="${esc(key)}" aria-label="メモ" placeholder="気づき・質問・フォローアップ…">${esc(state.notes[key] || '')}</textarea>
  </div>`;
}
function roomBtn(room) {
  if (!room) return '';
  const hint = roomHint(room);
  return `<button type="button" class="room" data-copy="${esc(room)}" title="タップでコピー${hint ? ' · ' + esc(hint) : ''}"><span class="pin">📍</span><span class="room-main">${esc(room)}</span>${hint ? `<span class="room-hint">${esc(hint)}</span>` : ''}</button>`;
}
function reasonBlock(reason, open = false, label = '概要・選定理由') {
  if (!reason) return '';
  return `<details class="reason" ${open ? 'open' : ''}><summary>${label}</summary><p>${esc(reason)}</p></details>`;
}
function droppedBlock(dropped) {
  if (!dropped?.length) return '';
  return `<details class="dropped"><summary>この枠で落とす発表（${dropped.length}）</summary><ul>${dropped.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>`;
}
function ttChip(tt) { return tt ? `<span class="chip tt-${esc(tt)}">${TT_LABEL[tt] || esc(tt)}</span>` : ''; }
function prioBadge(p) { return p ? `<span class="prio ${esc(p)}" title="${esc(DATA.legend?.priority?.[p] || '')}">${esc(p)}</span>` : ''; }

function timeClass(s, ctx) {
  if (!ctx.isToday || !s.start || !s.end) return '';
  const a = toMin(s.start), b = toMin(s.end);
  if (ctx.now >= a && ctx.now < b) return 'is-now';
  if (ctx.now >= b) return 'is-past';
  return '';
}

function talkCard(s, ctx, opts = {}) {
  const key = keyOf(s);
  const cls = `card kind-${s.kind} ${timeClass(s, ctx)} ${ui.highlight === 'card-' + s.id ? 'flash' : ''}`;
  return `<article class="${cls}" id="card-${esc(s.id)}" data-key="${esc(key)}">
    <div class="card-head">
      <div class="time">${esc(s.start)}–${esc(s.end)} ${ttChip(s.timeType)}</div>
      <div class="badges">${prioBadge(s.priority)}<span class="chip">${esc(KIND_LABEL(s.kind))}</span></div>
    </div>
    <h3 class="title">${esc(s.title)}</h3>
    <div class="meta">${roomBtn(s.room)}${s.code ? `<span class="code">${esc(s.code)}</span>` : ''}${s.paperNo ? `<span class="pno">#${esc(s.paperNo)}</span>` : ''}${sessionChip(s.code)}</div>
    ${s.team ? `<div class="team">${esc(s.team)}</div>` : ''}
    ${reasonBlock(s.reason, !!opts.openReason)}
    ${s.note ? `<div class="note-text">${esc(s.note)}</div>` : ''}
    ${paperLinks(s)}
    ${droppedBlock(s.dropped)}
    ${actionButtons(key)}
    ${noteBox(key, s.paperNo)}
  </article>`;
}

function itemCard(it, i, slot, ctx) {
  const key = keyOf(it, slot.id);
  const id = `card-${slot.id}-${i}`;
  return `<article class="item ${ui.highlight === id ? 'flash' : ''}" id="${esc(id)}" data-key="${esc(key)}">
    <div class="card-head">
      <div class="time"><span class="ord" aria-label="順番">${it.order ?? i + 1}</span>${it.visit ? `<span class="mins">${esc(it.visit)}</span>` : ''}${it.minutes ? `<span class="mins">${it.minutes} 分</span>` : ''}</div>
      <div class="badges">${prioBadge(it.priority)}</div>
    </div>
    <h4 class="title">${esc(it.title)}</h4>
    <div class="meta">${roomBtn(it.room)}${it.code ? `<span class="code">${esc(it.code)}</span>` : ''}${it.paperNo ? `<span class="pno">#${esc(it.paperNo)}</span>` : ''}${sessionChip(it.code)}</div>
    ${it.team ? `<div class="team">${esc(it.team)}</div>` : ''}
    ${reasonBlock(it.reason)}
    ${paperLinks(it)}
    ${actionButtons(key)}
    ${noteBox(key, it.paperNo)}
  </article>`;
}

function groupCard(s, ctx) {
  // poster_tour / special_session / fixed（items 付き）/ keynote / break / social
  const key = keyOf(s);
  const subs = subPapers(s);
  const cls = `card kind-${s.kind} ${s.attending ? 'is-attending' : ''} ${timeClass(s, ctx)} ${ui.highlight === 'card-' + s.id ? 'flash' : ''}`;
  const simple = ['break', 'social'].includes(s.kind);
  return `<article class="${cls}" id="card-${esc(s.id)}" data-key="${esc(key)}">
    <div class="card-head">
      <div class="time">${esc(s.start)}–${esc(s.end)} ${ttChip(s.timeType)}</div>
      <div class="badges">${prioBadge(s.priority)}<span class="chip">${esc(KIND_LABEL(s.kind))}</span>${s.attending ? '<span class="chip attending">出席予定</span>' : ''}${subs.length ? `<span class="chip">${subs.length} 件</span>` : ''}</div>
    </div>
    <h3 class="title">${esc(s.title)}</h3>
    <div class="meta">${roomBtn(s.room)}${s.code ? `<span class="code">${esc(s.code)}</span>` : ''}${s.paperNo ? `<span class="pno">#${esc(s.paperNo)}</span>` : ''}${sessionChip(s.code)}</div>
    ${s.team ? `<div class="team">${esc(s.team)}</div>` : ''}
    ${s.kind === 'special_session' ? `<div class="decide"><strong>注意</strong> 個別時刻は未公表。冒頭に進行を確認する。</div>` : ''}
    ${s.note ? `<div class="note-text">${esc(s.note)}</div>` : ''}
    ${reasonBlock(s.reason)}
    ${subs.length ? `<div class="items">${subs.map((it, i) => itemCard(it, i, s, ctx)).join('')}</div>` : ''}
    ${droppedBlock(s.dropped)}
    ${simple && !s.reason ? '' : ''}
    ${s.kind === 'fixed' || s.kind === 'tutorial' || s.attending || s.paperNo || subs.length || s.kind === 'keynote' ? actionButtons(key) + noteBox(key, s.paperNo) : `<div class="actions"><button type="button" class="act-memo ${(state.notes[key] || '').trim() ? 'has-memo' : ''}" data-act="memo" data-key="${esc(key)}">✎ メモ</button></div>${noteBox(key, null)}`}
  </article>`;
}

function moveRow(s, ctx) {
  return `<div class="move ${timeClass(s, ctx)}" id="card-${esc(s.id)}"><span class="time">${esc(s.start)}–${esc(s.end)}</span><span>${esc(s.title)}</span></div>`;
}

function renderSlot(s, ctx, opts = {}) {
  switch (s.kind) {
    case 'choice': return choiceBlock(s, ctx);
    case 'move': return moveRow(s, ctx);
    case 'talk': return talkCard(s, ctx, opts);
    default: return groupCard(s, ctx);
  }
}

/* ===== choice ===== */
function optionPapers(o) {
  const out = [];
  for (const s of o.slots) {
    if (s.kind === 'talk' && (s.paperNo || s.code)) out.push({ ...s, when: `${s.start}–${s.end}`, kindLabel: KIND_LABEL(s.kind) });
    for (const it of subPapers(s)) out.push({ ...it, when: `${s.start}–${s.end}`, kindLabel: KIND_LABEL(s.kind), room: it.room || s.room });
  }
  return out;
}

/* ---- 候補枠：並列候補 → チェック → ルート自動生成 ---- */
const PRIO_ORD = { S: 0, A: 1, B: 2 };
function roomBase(room) { return (room || '').replace(/（.*?）|\(.*?\)/g, '').trim().split(/\s*→\s*/)[0].trim(); }
function zoneOf(room) { return /gallery/i.test(room || '') ? 'G' : 'C'; }
function travelMin(a, b) {
  if (!a || !b) return 5;
  const ra = roomBase(a), rb = roomBase(b);
  if (ra === rb) return 0;
  if (zoneOf(ra) !== zoneOf(rb)) return 8;
  return zoneOf(ra) === 'G' ? 2 : 3;
}
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// choice 内の全候補（重複排除）。block = 時刻固定（口頭・特別セッション・チュートリアル等）、poster = 時間自由
function candidatesOf(c) {
  if (candidatesOf._cache?.id === c.id && candidatesOf._cache.opts === c.options) return candidatesOf._cache.val;
  const blocks = new Map(), posters = new Map();
  const better = (x, y) => ((x.title || '').length + (x.reason || '').length + (x.team || '').length) >= ((y.title || '').length + (y.reason || '').length + (y.team || '').length) ? x : y;
  for (const o of c.options) for (const s of o.slots) {
    if (s.kind === 'move') continue;
    if (s.kind === 'poster_tour') {
      for (const it of s.items || []) {
        const key = keyOf(it, s.id); const cand = { ckey: key, type: 'poster', key, title: it.title, team: it.team, code: it.code, paperNo: it.paperNo, room: it.room || s.room, priority: it.priority, reason: it.reason, minutes: it.minutes || 10, from: new Set([o.id]) };
        if (posters.has(key)) { const e = posters.get(key); const m = Math.max(e.minutes, cand.minutes); const w = better(e, cand); w.minutes = m; w.from = new Set([...e.from, o.id]); posters.set(key, w); } else posters.set(key, cand);
      }
      continue;
    }
    const key = (s.kind === 'talk' || s.kind === 'keynote') && (s.paperNo || s.code) ? keyOf(s) : 's:' + s.id;
    const ckey = key + '@' + s.start;
    const cand = { ckey, type: 'block', key, slot: s, title: s.title, team: s.team, code: s.code, paperNo: s.paperNo, room: s.room, priority: s.priority, reason: s.reason, start: s.start, end: s.end, kind: s.kind, timeType: s.timeType, targets: s.targets, note: s.note, from: new Set([o.id]) };
    if (blocks.has(ckey)) { const e = blocks.get(ckey); const w = better(e, cand); w.from = new Set([...e.from, o.id]); if (w !== e) w.slot = better(e.slot, cand.slot); blocks.set(ckey, w); } else blocks.set(ckey, cand);
  }
  const val = { blocks: [...blocks.values()].sort((x, y) => toMin(x.start) - toMin(y.start) || (PRIO_ORD[x.priority] ?? 3) - (PRIO_ORD[y.priority] ?? 3)), posters: [...posters.values()].sort((x, y) => (PRIO_ORD[x.priority] ?? 3) - (PRIO_ORD[y.priority] ?? 3)) };
  candidatesOf._cache = { id: c.id, opts: c.options, val };
  return val;
}
function optionCandKeys(c, o) {
  const { blocks, posters } = candidatesOf(c);
  return new Set([...blocks.filter((b) => b.from.has(o.id)).map((b) => b.ckey), ...posters.filter((p) => p.from.has(o.id)).map((p) => p.ckey)]);
}
function picksOf(c) {
  const saved = state.picks[c.id];
  if (Array.isArray(saved)) return new Set(saved);
  const def = c.options.find((o) => o.id === c.default) || c.options[0];
  return optionCandKeys(c, def);
}
function lateOk(c) { return state.lateOk[c.id] !== false; }

// チェックからルートを組む
function buildPlan(c, picks, day) {
  const { blocks, posters } = candidatesOf(c);
  const pb = blocks.filter((b) => picks.has(b.ckey));
  const pp = posters.filter((p) => picks.has(p.ckey));
  const warnings = [], dropped = [];
  // 1) 時刻固定の競合解消（重なったら優先度が高い方、同じなら先に始まる方）
  const kept = [];
  for (const b of pb) {
    const s = toMin(b.start), e = toMin(b.end);
    const clash = kept.find((k) => toMin(k.start) < e && s < toMin(k.end));
    if (!clash) { kept.push(b); continue; }
    const bw = PRIO_ORD[b.priority] ?? 3, kw = PRIO_ORD[clash.priority] ?? 3;
    if (bw < kw) { kept.splice(kept.indexOf(clash), 1, b); dropped.push(clash); warnings.push(`${clash.start} ${shortT(clash.title)} は ${b.start} ${shortT(b.title)} と重なるため外した`); }
    else { dropped.push(b); warnings.push(`${b.start} ${shortT(b.title)} は ${clash.start} ${shortT(clash.title)} と重なるため外した`); }
  }
  kept.sort((x, y) => toMin(x.start) - toMin(y.start));
  // 2) ポスターを空き時間に配置（公式ポスター時間帯 ∩ 枠）
  const wins = (day?.officialPosterWindows || []).map((w) => [toMin(w.start), toMin(w.end)]);
  const cs = toMin(c.start), ce = toMin(c.end);
  const allowed = wins.length ? wins.map(([a, b]) => [Math.max(a, cs), Math.min(b, ce)]).filter(([a, b]) => b > a) : [[cs, ce]];
  const late = lateOk(c) ? 10 : 0;
  const gaps = []; let cur = cs, prev = null;
  for (const b of kept) { gaps.push({ a: cur, b: toMin(b.start), prevRoom: prev?.room, nextRoom: b.room, next: b }); cur = toMin(b.end); prev = b; }
  gaps.push({ a: cur, b: ce, prevRoom: prev?.room, nextRoom: null, next: null });
  const remaining = [...pp]; const tours = [];
  for (const g of gaps) {
    if (!remaining.length) break;
    for (const [wa, wb] of allowed) {
      const ga = Math.max(g.a, wa), gb = Math.min(g.b, wb);
      if (gb <= ga) continue;
      const firstRoom = remaining[0].room;
      const inMove = g.prevRoom ? travelMin(g.prevRoom, firstRoom) : 0;
      let t = ga + inMove;
      const items = []; let lastRoom = null;
      while (remaining.length) {
        const p = remaining[0];
        const hop = lastRoom ? travelMin(lastRoom, p.room) : 0;
        const outMove = g.next ? travelMin(p.room, g.next.room) : 0;
        const start = t + hop, end = start + p.minutes;
        if (end + outMove > gb + late) break;
        items.push({ ...p, pStart: start, pEnd: end }); t = end; lastRoom = p.room; remaining.shift();
      }
      if (items.length) {
        const outMove = g.next ? travelMin(lastRoom, g.next.room) : 0;
        const over = Math.max(0, t + outMove - gb);
        tours.push({ gap: g, items, start: items[0].pStart, end: t, inMove, outMove, over });
        if (over > 0 && g.next) warnings.push(`${g.next.start} ${shortT(g.next.title)} に約 ${over} 分遅れて入室`);
        g.a = t; // 同じ空きの続き（別の許可時間帯）にも入れられるよう更新
      }
    }
  }
  for (const p of remaining) warnings.push(`ポスター「${shortT(p.title)}」（${p.minutes} 分）が入らない → 口頭を 1 つ外すか、途中入室を許容`);
  // 3) Slot 列に変換
  const slots = []; let n = 0;
  const pushTour = (tr) => {
    if (tr.inMove > 0) slots.push({ id: `${c.id}-cm-${n++}`, kind: 'move', start: fmt(tr.start - tr.inMove), end: fmt(tr.start), title: `移動 → ${roomBase(tr.items[0].room)}` });
    const rooms = [...new Set(tr.items.map((i) => roomBase(i.room)))].join(' → ');
    slots.push({ id: `${c.id}-ct-${n++}`, kind: 'poster_tour', start: fmt(tr.start), end: fmt(tr.end), timeType: 'proposed', title: `ポスター巡回（自分で組んだ順）`, room: rooms, items: tr.items.map((it, i) => ({ order: i + 1, code: it.code, paperNo: it.paperNo, title: it.title, team: it.team, room: it.room, priority: it.priority, reason: it.reason, minutes: it.minutes, visit: `${fmt(it.pStart)}–${fmt(it.pEnd)}` })) });
    if (tr.gap.next && tr.outMove > 0) slots.push({ id: `${c.id}-cm-${n++}`, kind: 'move', start: fmt(tr.end), end: fmt(tr.end + tr.outMove), title: `移動 → ${roomBase(tr.gap.next.room)}${tr.over > 0 ? `（約 ${tr.over} 分の途中入室）` : ''}` });
  };
  let ti = 0, prevBlock = null, lastTourEndRoom = null;
  for (const b of kept) {
    let tourBefore = false;
    while (ti < tours.length && tours[ti].start < toMin(b.start)) { pushTour(tours[ti]); lastTourEndRoom = tours[ti].items.at(-1).room; ti++; tourBefore = true; }
    if (!tourBefore && prevBlock) {
      const tm = travelMin(prevBlock.room, b.room);
      if (tm > 0) {
        const gap = toMin(b.start) - toMin(prevBlock.end);
        const lateBy = Math.max(0, tm - gap);
        slots.push({ id: `${c.id}-cm-${n++}`, kind: 'move', start: prevBlock.end, end: fmt(toMin(prevBlock.end) + tm), title: `移動 ${roomBase(prevBlock.room)} → ${roomBase(b.room)}（約 ${tm} 分）${lateBy ? `・約 ${lateBy} 分の途中入室` : ''}` });
        if (lateBy) warnings.push(`${b.start} ${shortT(b.title)} は移動のため約 ${lateBy} 分遅れて入室`);
      }
    }
    slots.push(b.slot); prevBlock = b;
  }
  while (ti < tours.length) pushTour(tours[ti++]);
  const missed = [...dropped.map((d) => d.title), ...remaining.map((r) => r.title)];
  return { slots, warnings, missed, kept, tours, placed: pp.length - remaining.length, posters: pp.length };
}
function shortT(t) { return (t || '').split(/[:：—-]/)[0].trim().slice(0, 28); }

function customOption(c) {
  const day = DATA.days.find((d) => d.slots.includes(c));
  const plan = buildPlan(c, picksOf(c), day);
  return { id: 'custom', label: '自分で組んだプラン', tradeoff: plan.missed.length ? `入らなかった: ${plan.missed.map(shortT).join('、')}` : '—', slots: plan.slots, plan };
}

function candCard(c, cand, picked) {
  const kindLabel = cand.type === 'poster' ? 'ポスター' : KIND_LABEL(cand.kind);
  const time = cand.type === 'poster' ? `${cand.minutes} 分` : `${cand.start}–${cand.end}`;
  const targets = cand.targets?.length ? `<details class="reason"><summary>狙いの論文 ${cand.targets.length} 件</summary><p>${cand.targets.map((t) => `${esc(t.priority || '')} ${esc(t.title)}`).join('<br>')}</p></details>` : '';
  return `<button type="button" class="cand ${picked ? 'is-picked' : ''} prio-${esc(cand.priority || 'none')}" role="checkbox" aria-checked="${picked}" data-pick="${esc(c.id)}" data-ckey="${esc(cand.ckey)}">
    <span class="cand-head"><span class="cand-check" aria-hidden="true">${picked ? '✓' : ''}</span>${prioBadge(cand.priority)}<span class="chip">${esc(kindLabel)}</span>${cand.timeType ? ttChip(cand.timeType) : ''}<span class="cand-time">${esc(time)}</span></span>
    <span class="cand-title">${esc(cand.title)}</span>
    <span class="cand-room">${cand.room ? `📍 <strong>${esc(cand.room)}</strong>${roomHint(cand.room) ? ` <span class="muted">${esc(roomHint(cand.room))}</span>` : ''}` : '📍 会場未記載'}</span>
    <span class="cand-meta">${cand.code ? `<span class="code">${esc(cand.code)}</span>` : ''}${cand.paperNo ? ` · <span class="pno">#${esc(cand.paperNo)}</span>` : ''}${sessionOf(cand.code) ? ` · ${esc(sessionOf(cand.code).full)}` : ''}</span>
    ${cand.team ? `<span class="cand-team">${esc(cand.team)}</span>` : ''}
    ${cand.reason ? `<span class="cand-reason">${esc(cand.reason)}</span>` : ''}
  </button>${targets ? `<div class="cand-extra">${targets}</div>` : ''}`;
}

function choiceBlock(c, ctx) {
  const sel = selectedOption(c);
  const isNow = ctx.isToday && ctx.now >= toMin(c.start) && ctx.now < toMin(c.end);
  const decided = !!state.choices[c.id] && !ui.editChoice.has(c.id);
  const decideHtml = c.decideNote ? `<div class="decide"><strong>${c.decideAt ? esc(c.decideAt) + ' に確認' : '現地で確認'}</strong> ${esc(c.decideNote)}</div>` : '';
  if (decided) {
    const label = sel.id === 'custom' ? `自分で組んだプラン（${sel.plan.kept.length + sel.plan.placed} 件）` : sel.label;
    return `<section class="choice is-decided ${isNow ? 'is-now-wrap' : ''}" id="card-${esc(c.id)}" aria-label="${esc(c.title)}">
      <div class="choice-head compact">
        <div class="time">${esc(c.start)}–${esc(c.end)} <span class="lbl">選択済み</span></div>
        <div class="decided-row"><span class="decided-label">${esc(label)}</span><button type="button" class="edit-choice" data-edit-choice="${esc(c.id)}" aria-expanded="false">変更</button></div>
      </div>
      ${decideHtml}
      ${sel.id === 'custom' && sel.plan.warnings.length ? `<div class="plan-warn">${sel.plan.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
      <div class="chosen">${sel.slots.map((s) => renderSlot(s, ctx)).join('')}</div>
    </section>`;
  }
  // --- 未決定：並列候補 → チェック → プラン ---
  const { blocks, posters } = candidatesOf(c);
  const picks = picksOf(c);
  const byStart = new Map();
  for (const b of blocks) { if (!byStart.has(b.start)) byStart.set(b.start, []); byStart.get(b.start).push(b); }
  const rows = [...byStart.entries()].map(([st, list]) => `<div class="par-row"><div class="par-time">${esc(st)}</div><div class="par-cands">${list.map((b) => candCard(c, b, picks.has(b.ckey))).join('')}</div></div>`).join('');
  const posterRow = posters.length ? `<div class="par-row"><div class="par-time">ポスター<br><span class="muted">時間自由</span></div><div class="par-cands">${posters.map((p) => candCard(c, p, picks.has(p.ckey))).join('')}</div></div>` : '';
  const day = DATA.days.find((d) => d.slots.includes(c));
  const plan = buildPlan(c, picks, day);
  const steps = plan.slots.map((s) => {
    if (s.kind === 'move') return `<li class="step move-step">${esc(s.start)}–${esc(s.end)} ${esc(s.title)}</li>`;
    if (s.kind === 'poster_tour') return `<li class="step">${esc(s.start)}–${esc(s.end)} ポスター @ <strong>${esc(s.room)}</strong><ul>${s.items.map((it) => `<li>${esc(it.visit)} ${prioBadge(it.priority)} ${esc(it.title)} <strong>${esc(it.room)}</strong> <span class="code">${esc(it.code || '')}</span></li>`).join('')}</ul></li>`;
    return `<li class="step">${esc(s.start)}–${esc(s.end)} ${prioBadge(s.priority)} ${esc(s.title)} @ <strong>${esc(s.room || '')}</strong>${sessionOf(s.code) ? ` <span class="code">${esc(sessionOf(s.code).label)}</span>` : ''}</li>`;
  }).join('');
  const presets = c.options.map((o) => {
    const keys = optionCandKeys(c, o); const cover = [...picks].filter((k) => keys.has(k)).length;
    return `<div class="preset ${o.id === c.default ? 'is-default' : ''}">
      <div class="preset-head"><strong>${esc(o.label)}</strong><span class="chip">チェック ${cover}/${picks.size} 件をカバー</span>${o.id === c.default ? '<span class="chip">既定</span>' : ''}</div>
      <div class="muted">失うもの: ${esc(o.tradeoff || '—')}</div>
      <div class="btnrow"><button type="button" class="btn" data-pick-preset="${esc(c.id)}" data-opt="${esc(o.id)}">この案の内容をチェックに反映</button><button type="button" class="btn primary" data-choice="${esc(c.id)}" data-opt="${esc(o.id)}">この案をそのまま採用</button></div>
    </div>`;
  }).join('');
  return `<section class="choice ${isNow ? 'is-now-wrap' : ''}" id="card-${esc(c.id)}" aria-label="${esc(c.title)}">
    <div class="choice-head">
      <div class="lbl">候補から選択</div>
      <div class="time">${esc(c.start)}–${esc(c.end)}</div>
      <h3>${esc(c.title)}</h3>
    </div>
    ${decideHtml}
    <div class="step-lbl">1. 同じ時間帯にあるもの — 興味のあるものにチェック（${picks.size} 件）</div>
    <div class="parallel">${rows}${posterRow}</div>
    <div class="step-lbl">2. チェックから組んだ回り方</div>
    <div class="plan">
      <label class="row late"><input type="checkbox" data-late="${esc(c.id)}" ${lateOk(c) ? 'checked' : ''}> 口頭は 10 分までの途中入室を許容</label>
      ${plan.warnings.length ? `<div class="plan-warn">${plan.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
      <ol class="steps">${steps || '<li class="muted">チェックがありません</li>'}</ol>
      <div class="btnrow"><button type="button" class="btn primary" data-choice="${esc(c.id)}" data-opt="custom" ${plan.slots.length ? '' : 'disabled'}>このプランを採用</button>${state.choices[c.id] ? `<button type="button" class="btn" data-close-choice="${esc(c.id)}">変更せず閉じる</button>` : ''}</div>
    </div>
    <details class="presets"><summary>用意されたプラン（${c.options.length}）を見る・使う</summary><div class="preset-list">${presets}</div></details>
  </section>`;
}

/* ===== today view ===== */
function visibleSlots(day) {
  const out = [];
  for (const s of day.slots) {
    if (s.kind === 'choice') out.push(...selectedOption(s).slots.map((x) => ({ ...x, parent: s })));
    else out.push(s);
  }
  return out.sort((a, b) => toMin(a.start) - toMin(b.start));
}
function renderDaybar() {
  const now = nowSydney();
  $('#daybar').innerHTML = state.view === 'today' ? `<div class="daytabs" role="tablist" aria-label="日付">${DATA.days.map((d) => `<button type="button" role="tab" aria-selected="${d.date === state.day}" class="${d.date === now.date ? 'is-today' : ''}" data-day="${d.date}">${esc(d.label)}</button>`).join('')}</div>` : '';
}
function renderNowbar() {
  const el = $('#nowbar');
  if (state.view !== 'today') { el.innerHTML = ''; return; }
  const now = nowSydney();
  const day = DATA.days.find((d) => d.date === state.day);
  const today = DATA.days.find((d) => d.date === now.date);
  const sim = now.simulated ? `<span class="sim">仮時刻</span>` : '';
  if (!today) {
    el.className = 'nowbar is-other';
    el.innerHTML = `<span class="clock">${now.hhmm}</span>${sim}<span class="cur">シドニー時刻。会期外です（${esc(now.date)}）。</span>`;
    return;
  }
  const vis = visibleSlots(today);
  const cur = vis.filter((s) => now.min >= toMin(s.start) && now.min < toMin(s.end));
  const curMain = cur.find((s) => s.kind !== 'move') || cur[0];
  const nxt = vis.find((s) => toMin(s.start) > now.min && s.kind !== 'move');
  const remain = nxt ? toMin(nxt.start) - now.min : null;
  el.className = 'nowbar' + (state.day !== now.date ? ' is-other' : '');
  el.innerHTML = `<span class="clock" title="Australia/Sydney">${now.hhmm}</span>${sim}
    <span class="cur"><span class="lbl">進行中</span>${curMain ? `${esc(curMain.title)}${curMain.room ? ' @ ' + esc(curMain.room) : ''}` : '—'}</span>
    <span class="nxt"><span class="lbl">次</span>${nxt ? `<span class="remain">あと ${remain} 分</span> ${esc(nxt.start)} ${esc(nxt.title)}${nxt.room ? ' @ ' + esc(nxt.room) : ''}` : '本日は終了'}</span>
    ${state.day !== now.date ? `<button type="button" data-day="${now.date}">今日へ</button>` : `<button type="button" data-scroll-now>現在枠へ</button>`}`;
}
function renderToday() {
  const day = DATA.days.find((d) => d.date === state.day) || DATA.days[0];
  const now = nowSydney();
  const ctx = { isToday: day.date === now.date, now: now.min };
  const windows = (day.officialPosterWindows || []).map((w) => `${w.start}–${w.end}`).join(', ');
  const fixed = (DATA.fixed || []).filter((f) => f.date === day.date);
  return `<div class="day-head">
      <h2>${esc(day.label)} <span class="muted">${esc(day.date)}</span></h2>
      ${day.subtitle ? `<p class="sub">${esc(day.subtitle)}</p>` : ''}
      ${windows ? `<p class="windows">公式ポスター時間帯: ${esc(windows)}</p>` : ''}
      <div class="btnrow day-tools"><button type="button" class="btn" data-daytext="copy" data-date="${esc(day.date)}">この日の行程をコピー</button><button type="button" class="btn" data-daytext="dl" data-date="${esc(day.date)}">テキストで保存</button></div>
      ${fixed.length ? fixed.map((f) => `<div class="fixed-row"><span class="time">${esc(f.start)}–${esc(f.end)}</span><span><strong>固定</strong> ${esc(f.title)}${f.room ? ' @ ' + esc(f.room) : ''}</span></div>`).join('') : ''}
      ${day === DATA.days[0] && DATA.notes?.unresolved?.length ? `<details class="dropped"><summary>未確認事項（${DATA.notes.unresolved.length}）— 設定にも表示</summary><ul>${DATA.notes.unresolved.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></details>` : ''}
    </div>
    <div class="timeline">${day.slots.map((s) => renderSlot(s, ctx)).join('')}</div>`;
}

/* ===== all papers view ===== */
function typeLabel(t) { return ({ oral: '口頭', poster: 'ポスター', special: '特別セッション' })[t] || t; }
function renderPapers() {
  const q = ui.search.trim().toLowerCase();
  const rows = PAPERS.filter((p) => {
    if (ui.fPrio.size && !ui.fPrio.has(p.priority || 'B')) return false;
    if (ui.fType.size && ![...p.types].some((t) => ui.fType.has(t))) return false;
    if (ui.fDone && !state.done[p.key]) return false;
    if (ui.fStar && !state.star[p.key]) return false;
    if (ui.fMemo && !(state.notes[p.key] || '').trim()) return false;
    if (q) {
      const hay = [p.title, p.team, p.code, p.paperNo && '#' + p.paperNo, ...p.occ.map((o) => o.room), ...p.occ.map((o) => o.code)].join(' ').toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const fbtn = (set, v, label) => `<button type="button" data-filter="${set}" data-v="${v}" aria-pressed="${ui[set] instanceof Set ? ui[set].has(v) : !!ui[set]}">${label}</button>`;
  return `<div class="toolbar">
      <input class="search" type="search" id="search" placeholder="タイトル・著者・番号・会場で検索" value="${esc(ui.search)}" aria-label="検索">
      <div class="filters">
        ${fbtn('fPrio', 'S', 'S')}${fbtn('fPrio', 'A', 'A')}${fbtn('fPrio', 'B', 'B')}
        ${fbtn('fType', 'oral', '口頭')}${fbtn('fType', 'poster', 'ポスター')}${fbtn('fType', 'special', '特別')}
        ${fbtn('fDone', '1', '✓ 聴いた')}${fbtn('fStar', '1', '★ 後で読む')}${fbtn('fMemo', '1', '✎ メモあり')}
      </div>
      <div class="count">${rows.length} / ${PAPERS.length} 件</div>
    </div>
    <div class="list">${rows.map(paperRow).join('') || '<div class="empty">該当なし</div>'}</div>`;
}
function paperRow(p) {
  const key = p.key;
  return `<article class="card kind-talk" data-key="${esc(key)}">
    <div class="card-head">
      <div class="badges">${prioBadge(p.priority)}${[...p.types].map((t) => `<span class="chip">${typeLabel(t)}</span>`).join('')}</div>
      <div class="meta">${p.code ? `<span class="code">${esc(p.code)}</span>` : ''}${p.paperNo ? `<span class="pno">#${esc(p.paperNo)}</span>` : ''}${sessionChip(p.code)}</div>
    </div>
    <h3 class="title">${esc(p.title)}</h3>
    ${p.team ? `<div class="team">${esc(p.team)}</div>` : ''}
    ${reasonBlock(p.reason)}
    <div class="occ">${p.occ.map((o) => {
      const alt = o.choiceId && (state.choices[o.choiceId] || DATA.days.flatMap((d) => d.slots).find((s) => s.id === o.choiceId)?.default) !== o.optionId;
      return `<button type="button" data-goto="${esc(o.anchorId)}" title="タイムラインへ">${esc(o.dayLabel)} ${esc(o.start)}–${esc(o.end)} · ${esc(o.room || '')}${o.optionLabel ? ` <span class="alt-tag">[${alt ? '別案: ' : ''}${esc(o.optionLabel)}]</span>` : ''}</button>`;
    }).join('')}</div>
    ${paperLinks(p)}
    ${actionButtons(key)}
    ${noteBox(key, p.paperNo)}
  </article>`;
}

/* ===== reading list ===== */
function renderReading() {
  const q = ui.rlSearch.trim().toLowerCase();
  const rows = (DATA.readingList || []).filter((r) => !q || [r.title, r.team, r.code, r.paperNo, r.when, r.why].join(' ').toLowerCase().includes(q));
  return `<div class="toolbar">
      <input class="search" type="search" id="rl-search" placeholder="読む・別途話す候補を検索" value="${esc(ui.rlSearch)}" aria-label="検索">
      <div class="count">${rows.length} 件（自分の発表・座長と重複するもの等）</div>
    </div>
    <div class="list">${rows.map((r) => {
      const key = keyOf(r, 'rl-' + (r.code || r.title));
      return `<article class="card kind-special_session" data-key="${esc(key)}">
        <div class="card-head"><div class="badges"><span class="chip">読む・別途話す</span></div><div class="meta">${r.code ? `<span class="code">${esc(r.code)}</span>` : ''}${r.paperNo ? `<span class="pno">#${esc(r.paperNo)}</span>` : ''}</div></div>
        <h3 class="title">${esc(r.title)}</h3>
        ${r.team ? `<div class="team">${esc(r.team)}</div>` : ''}
        ${r.when ? `<div class="meta"><span class="chip">いつ</span><span>${esc(r.when)}</span></div>` : ''}
        ${reasonBlock(r.why, true, '概要・理由')}
        ${paperLinks(r)}
        ${actionButtons(key)}
        ${noteBox(key, r.paperNo)}
      </article>`;
    }).join('')}</div>`;
}

/* ===== settings ===== */
function renderSettings() {
  const now = nowSydney();
  const sim = sessionStorage.getItem(SS_NOW) || '';
  const counts = { notes: Object.values(state.notes).filter((v) => String(v).trim()).length, done: Object.values(state.done).filter(Boolean).length, star: Object.values(state.star).filter(Boolean).length, choices: Object.keys(state.choices).length };
  return `
  <section class="section"><h2>表示</h2>
    <div class="btnrow">
      ${['auto', 'light', 'dark'].map((t) => `<label class="row"><input type="radio" name="theme" value="${t}" ${state.theme === t ? 'checked' : ''}> ${({ auto: 'OS に追従', light: 'ライト', dark: 'ダーク' })[t]}</label>`).join('')}
    </div>
  </section>
  <section class="section"><h2>持ち出し・同期（PC ⇄ スマホ）</h2>
    <p class="muted">選択 ${counts.choices} · メモ ${counts.notes} · 聴いた ${counts.done} · ★ ${counts.star}。サーバーは使わないので、JSON を書き出して相手側で読み込む。</p>
    <div class="btnrow">
      <button type="button" class="btn primary" data-set="export-dl">JSON をダウンロード</button>
      <button type="button" class="btn" data-set="export-copy">JSON をクリップボードへ</button>
      <label class="btn" style="display:inline-flex;align-items:center;">ファイルから読み込む <input type="file" id="import-file" accept="application/json,.json" hidden></label>
    </div>
    <textarea id="import-text" placeholder="ここに JSON を貼り付けて「貼り付けから読み込む」" aria-label="インポート用 JSON"></textarea>
    <div class="btnrow"><button type="button" class="btn" data-set="import-text">貼り付けから読み込む（統合）</button></div>
  </section>
  <section class="section"><h2>最終行程をテキストで書き出す</h2>
    <p class="muted">各日の選択結果（自分で組んだプランを含む）を、時刻・会場・番号・セッション名付きのプレーンテキストにする。Today 画面の日付見出しにも 1 日分のボタンがある。</p>
    <div class="btnrow"><button type="button" class="btn primary" data-set="txt-dl">全日程をダウンロード</button><button type="button" class="btn" data-set="txt-copy">全日程をクリップボードへ</button></div>
  </section>
  <section class="section"><h2>メモを Markdown で書き出す</h2>
    <label class="row"><input type="checkbox" id="md-only" ${state.mdOnlyAnnotated ? 'checked' : ''}> メモ・チェック・★ のある発表だけを出力</label>
    <div class="btnrow">
      <button type="button" class="btn primary" data-set="md-dl">Markdown をダウンロード</button>
      <button type="button" class="btn" data-set="md-copy">Markdown をクリップボードへ</button>
    </div>
  </section>
  <section class="section"><h2>固定予定</h2>
    ${(DATA.fixed || []).map((f) => `<div class="fixed-row"><span class="time">${esc(f.date.slice(5).replace('-', '/'))} ${esc(f.start)}–${esc(f.end)}</span><span>${esc(f.title)}${f.room ? ' @ ' + esc(f.room) : ''}${f.code ? ` <span class="code">${esc(f.code)}</span>` : ''}</span></div>`).join('')}
  </section>
  <section class="section"><h2>未確認事項</h2><ul>${(DATA.notes?.unresolved || []).map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
    <h3>移動の目安</h3><ul>${(DATA.notes?.movement || []).map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
    ${DATA.notes?.impact?.length ? `<h3>参考</h3><ul>${DATA.notes.impact.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
  </section>
  <section class="section"><h2>凡例</h2>
    <ul>${Object.entries(DATA.legend?.priority || {}).map(([k, v]) => `<li>${prioBadge(k)} ${esc(v)}</li>`).join('')}</ul>
    <ul>${Object.entries(DATA.legend?.timeType || {}).map(([k, v]) => `<li>${ttChip(k)} ${esc(v)}</li>`).join('')}</ul>
  </section>
  <section class="section"><h2>時刻シミュレーション（テスト用）</h2>
    <p class="muted">現在のシドニー時刻: <strong>${esc(now.date)} ${now.hhmm}</strong>${now.simulated ? '（仮時刻）' : ''}。ここで設定した時刻を「今」として扱う（このタブのみ、URL に <code>?now=2026-09-29T14:05</code> でも可）。</p>
    <div class="btnrow"><input type="datetime-local" id="sim-now" value="${esc(sim.slice(0, 16))}" aria-label="仮の現在時刻"><button type="button" class="btn" data-set="sim-set">設定</button><button type="button" class="btn" data-set="sim-clear">解除</button></div>
  </section>
  <section class="section"><h2>データ・アプリ</h2>
    <p class="muted">${esc(DATA.meta?.conference)} · ${esc(DATA.meta?.venue)} · TZ ${esc(TZ)} · データ生成 ${esc(DATA.meta?.generatedAt)} · schema v${esc(DATA.meta?.schemaVersion ?? 1)} · 保存キー <code>${LS_KEY}</code></p>
    <ul>${(DATA.meta?.sources || []).map((s) => `<li><a href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a></li>`).join('')}</ul>
    <div class="btnrow">
      <button type="button" class="btn" data-set="reload">キャッシュを更新して再読み込み</button>
      <button type="button" class="btn danger" data-set="reset">保存データをすべて消去</button>
    </div>
  </section>`;
}

/* ===== 行程テキスト（1 日ごと） ===== */
function dayText(day) {
  const L = [`${day.label}（${day.date}）  ${DATA.meta?.conference || ''} @ ${DATA.meta?.venue || ''}`];
  if (day.subtitle) L.push(day.subtitle);
  const fixed = (DATA.fixed || []).filter((f) => f.date === day.date);
  for (const f of fixed) L.push(`固定 ${f.start}–${f.end} ${f.title}${f.room ? ' @ ' + f.room : ''}`);
  L.push('');
  const line = (s, indent = '') => {
    const sess = sessionOf(s.code);
    const meta = [s.code, s.paperNo && `#${s.paperNo}`].filter(Boolean).join(' ');
    L.push(`${indent}${s.start}–${s.end}  ${s.priority ? `[${s.priority}] ` : ''}${s.title}`);
    if (s.kind !== 'move' && s.kind !== 'break') L.push(`${indent}          @ ${s.room || '会場未記載'}${roomHint(s.room) ? `（${roomHint(s.room)}）` : ''}${meta ? `  ${meta}` : ''}${sess ? `  ${sess.full}` : ''}${s.timeType && s.timeType !== 'official' ? `  ※${TT_LABEL[s.timeType]}` : ''}`);
    else if (s.room) L.push(`${indent}          @ ${s.room}`);
    (s.items || s.targets || []).forEach((it, i) => {
      const ss = sessionOf(it.code);
      L.push(`${indent}    ${it.visit ? it.visit : `(${it.order ?? i + 1})`}  ${it.priority ? `[${it.priority}] ` : ''}${it.title}`);
      L.push(`${indent}          @ ${it.room || s.room || ''}  ${[it.code, it.paperNo && `#${it.paperNo}`].filter(Boolean).join(' ')}${ss ? `  ${ss.full}` : ''}${it.minutes ? `  ${it.minutes}分` : ''}`);
    });
  };
  for (const s of day.slots) {
    if (s.kind === 'choice') {
      const sel = selectedOption(s);
      L.push(`${s.start}–${s.end}  【${state.choices[s.id] ? '選択済' : '未選択・既定'}】${sel.label}`);
      if (s.decideNote) L.push(`          ※ ${s.decideNote}`);
      for (const ss of sel.slots) line(ss, '  ');
    } else line(s);
  }
  return L.join('\n');
}
function allDaysText() { return DATA.days.map(dayText).join('\n\n' + '='.repeat(48) + '\n\n'); }

/* ===== markdown export ===== */
function buildMarkdown() {
  const only = state.mdOnlyAnnotated;
  const out = [`# ${DATA.meta?.conference || 'Conference'} 聴講メモ`, '', `生成: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}　会場: ${DATA.meta?.venue || ''}`, ''];
  const seen = new Set();
  // 1 発表分の行を返す（only モードで注記が無ければ空配列）
  const entry = (title, meta, key, paperNo, indent = '') => {
    const memo = (state.notes[key] || '').trim(), done = !!state.done[key], star = !!state.star[key];
    if (only && !memo && !done && !star) return [];
    const dup = seen.has(key); seen.add(key);
    const st = [done ? '✅ 聴いた' : '', star ? '★ 後で読む' : ''].filter(Boolean).join(' ');
    const l = [`${indent}- ${done ? '[x]' : '[ ]'} **${title}** ${meta}${st ? `　${st}` : ''}`];
    if (dup) { l.push(`${indent}  - （メモは上記と共有）`); return l; }
    const qs = paperNo ? DATA.questions?.[paperNo] : null;
    if (qs?.length && !only) l.push(`${indent}  - 用意した質問:`, ...qs.map((q) => `${indent}    - ${q}`));
    if (memo) l.push(`${indent}  - メモ:`, ...memo.split('\n').map((x) => `${indent}    ${x}`));
    return l;
  };
  const metaOf = (o) => { const m = [o.code, o.paperNo && `#${o.paperNo}`, o.room].filter(Boolean).join(' · '); return m ? `（${m}）` : ''; };
  const slotLines = (s, indent) => {
    if (s.kind === 'move') return [];
    if (s.kind === 'choice') {
      const sel = selectedOption(s);
      const body = sel.slots.flatMap((ss) => slotLines(ss, indent + '  '));
      if (only && !body.length) return [];
      return [`${indent}- ${s.start}–${s.end} 【選択】${s.title} → **${sel.label}**`, ...body];
    }
    const head = entry(`${s.start}–${s.end} ${s.title}`, metaOf(s), keyOf(s), s.paperNo, indent);
    const subs = subPapers(s).flatMap((it, i) => entry(`${it.order ?? i + 1}. ${it.title}`, metaOf(it), keyOf(it, s.id), it.paperNo, indent + '  '));
    if (!head.length && !subs.length) return [];
    if (!head.length) return [`${indent}- ${s.start}–${s.end} ${s.title}`, ...subs];
    return [...head, ...subs];
  };
  for (const day of DATA.days) {
    const body = day.slots.flatMap((s) => slotLines(s, ''));
    if (only && !body.length) continue;
    out.push(`## ${day.label}（${day.date}）`, '', ...body, '');
  }
  if (DATA.readingList?.length) {
    const body = DATA.readingList.flatMap((r) => entry(r.title, metaOf({ ...r, room: r.when }), keyOf(r, 'rl-' + (r.code || r.title)), r.paperNo));
    if (!(only && !body.length)) out.push('## 読む・別途話す候補', '', ...body, '');
  }
  return out.join('\n');
}

/* ===== render root ===== */
const VIEWS = [
  { id: 'today', label: 'Today', ico: '▤' },
  { id: 'papers', label: 'All papers', ico: '☰' },
  { id: 'reading', label: 'Read later', ico: '★' },
  { id: 'settings', label: 'Settings', ico: '⚙' },
];
function renderNav() {
  const html = VIEWS.map((v) => `<button type="button" data-view="${v.id}" aria-current="${state.view === v.id ? 'page' : 'false'}"><span class="ico" aria-hidden="true">${v.ico}</span>${v.label}</button>`).join('');
  $('#nav-top').innerHTML = html; $('#nav-bottom').innerHTML = html;
}
function render() {
  renderNav(); renderDaybar(); renderNowbar(); requestAnimationFrame(syncHeaderHeight);
  const main = $('#main');
  const scrollY = window.scrollY;
  main.innerHTML = state.view === 'today' ? renderToday() : state.view === 'papers' ? renderPapers() : state.view === 'reading' ? renderReading() : renderSettings();
  if (ui.highlight) {
    const el = document.getElementById(ui.highlight);
    ui.highlight = null;
    if (el) { requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' })); }
  } else if (render._keepScroll) { window.scrollTo(0, scrollY); }
  render._keepScroll = false;
}
function rerenderKeep() { render._keepScroll = true; render(); }

function syncHeaderHeight() {
  const h = $('.topbar')?.getBoundingClientRect().height || 160;
  document.documentElement.style.setProperty('--header-h', Math.round(h + 8) + 'px');
}
function scrollToNow() {
  syncHeaderHeight();
  const el = $('.choice.is-now-wrap') || $('.timeline .is-now');
  if (el) { el.scrollIntoView({ behavior: scrollToNow._smooth ? 'smooth' : 'auto', block: 'start' }); scrollToNow._smooth = true; return true; }
  const now = nowSydney();
  const nxt = $$('.timeline [id^="card-"]').find((e) => { const t = e.querySelector('.time')?.textContent.match(/^(\d{2}:\d{2})/); return t && toMin(t[1]) > now.min; });
  if (nxt) nxt.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return !!nxt;
}

/* ===== interactions ===== */
function updateKeyUI(key) {
  const done = !!state.done[key], star = !!state.star[key], memo = !!(state.notes[key] || '').trim();
  for (const b of $$(`.act-done[data-key="${CSS.escape(key)}"]`)) { b.classList.toggle('active-done', done); b.setAttribute('aria-pressed', done); b.textContent = done ? '✓ 聴いた' : '聴いた'; }
  for (const b of $$(`.act-star[data-key="${CSS.escape(key)}"]`)) { b.classList.toggle('active-star', star); b.setAttribute('aria-pressed', star); b.textContent = star ? '★ 後で読む' : '☆ 後で読む'; }
  for (const b of $$(`.act-memo[data-key="${CSS.escape(key)}"]`)) { b.classList.toggle('has-memo', memo); b.textContent = memo ? '✎ メモあり' : '✎ メモ'; }
}
let noteTimer = null;
function onNoteInput(ta) {
  const key = ta.dataset.note;
  state.notes[key] = ta.value;
  for (const other of $$(`textarea[data-note="${CSS.escape(key)}"]`)) if (other !== ta) other.value = ta.value;
  clearTimeout(noteTimer); noteTimer = setTimeout(() => { saveState(); updateKeyUI(key); }, 300);
}

function goTo(anchorId) {
  const occ = OCC_BY_ANCHOR[anchorId];
  if (!occ) return;
  state.view = 'today'; state.day = occ.date;
  if (occ.choiceId) {
    const choice = DATA.days.flatMap((d) => d.slots).find((s) => s.id === occ.choiceId);
    if (choice && selectedOption(choice).id !== occ.optionId) ui.openAlts.add(occ.choiceId + ':' + occ.optionId);
  }
  ui.highlight = anchorId;
  render();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-goto]');
  if (!t) return;
  if (t.dataset.view) { state.view = t.dataset.view; render(); window.scrollTo(0, 0); return; }
  if (t.dataset.day) { state.day = t.dataset.day; render(); window.scrollTo(0, 0); return; }
  if (t.hasAttribute('data-scroll-now')) { if (!scrollToNow()) toast('本日の枠は終了しています'); return; }
  if (t.id === 'theme-btn') { cycleTheme(); return; }
  if (t.dataset.copy) { copyText(t.dataset.copy); return; }
  if (t.dataset.choice && t.dataset.opt) {
    state.choices[t.dataset.choice] = t.dataset.opt; saveState();
    ui.openAlts.forEach((k) => { if (k.startsWith(t.dataset.choice + ':')) ui.openAlts.delete(k); });
    ui.compare.delete(t.dataset.choice); ui.editChoice.delete(t.dataset.choice);
    ui.highlight = 'card-' + t.dataset.choice; render();
    toast('選択を保存しました');
    return;
  }
  if (t.dataset.daytext) {
    const day = DATA.days.find((d) => d.date === t.dataset.date);
    const txt = dayText(day);
    if (t.dataset.daytext === 'copy') copyText(txt); else download(`is2026-${day.date}.txt`, txt, 'text/plain');
    return;
  }
  if (t.dataset.pick) {
    const c = DATA.days.flatMap((d) => d.slots).find((x) => x.id === t.dataset.pick);
    const set = picksOf(c); set.has(t.dataset.ckey) ? set.delete(t.dataset.ckey) : set.add(t.dataset.ckey);
    state.picks[c.id] = [...set]; saveState(); rerenderKeep(); return;
  }
  if (t.dataset.pickPreset) {
    const c = DATA.days.flatMap((d) => d.slots).find((x) => x.id === t.dataset.pickPreset);
    const o = c.options.find((x) => x.id === t.dataset.opt);
    state.picks[c.id] = [...optionCandKeys(c, o)]; saveState(); rerenderKeep(); toast(`「${o.label}」の内容をチェックに反映`); return;
  }
  if (t.dataset.closeChoice) { ui.editChoice.delete(t.dataset.closeChoice); ui.compare.delete(t.dataset.closeChoice); ui.highlight = 'card-' + t.dataset.closeChoice; render(); return; }
  if (t.dataset.editChoice) { ui.editChoice.add(t.dataset.editChoice); ui.highlight = 'card-' + t.dataset.editChoice; render(); return; }
  if (t.dataset.compare) { const id = t.dataset.compare; ui.compare.has(id) ? ui.compare.delete(id) : ui.compare.add(id); rerenderKeep(); return; }
  if (t.dataset.act) {
    const key = t.dataset.key;
    if (t.dataset.act === 'done') state.done[key] = !state.done[key];
    else if (t.dataset.act === 'star') state.star[key] = !state.star[key];
    else if (t.dataset.act === 'memo') {
      const card = t.closest('article');
      const box = card?.querySelector(`.notebox[data-notebox="${CSS.escape(key)}"]`);
      if (box) {
        const open = box.hasAttribute('hidden');
        if (open) { box.removeAttribute('hidden'); ui.openNotes.add(key); box.querySelector('textarea')?.focus(); }
        else { box.setAttribute('hidden', ''); ui.openNotes.delete(key); }
        t.setAttribute('aria-expanded', open);
      }
      return;
    }
    saveState(); updateKeyUI(key); return;
  }
  if (t.dataset.goto) { goTo(t.dataset.goto); return; }
  if (t.dataset.filter) {
    const f = t.dataset.filter, v = t.dataset.v;
    if (ui[f] instanceof Set) { ui[f].has(v) ? ui[f].delete(v) : ui[f].add(v); } else ui[f] = !ui[f];
    rerenderKeep(); return;
  }
  if (t.dataset.set) { onSetting(t.dataset.set); return; }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches('textarea[data-note]')) onNoteInput(el);
  else if (el.id === 'search') { ui.search = el.value; const list = $('.list'); const tmp = document.createElement('div'); tmp.innerHTML = renderPapers(); $('.toolbar .count').textContent = tmp.querySelector('.count').textContent; list.innerHTML = tmp.querySelector('.list').innerHTML; }
  else if (el.id === 'rl-search') { ui.rlSearch = el.value; const tmp = document.createElement('div'); tmp.innerHTML = renderReading(); $('.list').innerHTML = tmp.querySelector('.list').innerHTML; $('.toolbar .count').textContent = tmp.querySelector('.count').textContent; }
  else if (el.dataset.late) { state.lateOk[el.dataset.late] = el.checked; saveState(); rerenderKeep(); }
  else if (el.id === 'md-only') { state.mdOnlyAnnotated = el.checked; saveState(); }
  else if (el.name === 'theme') { state.theme = el.value; applyTheme(); saveState(); }
});
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.matches?.('details.alt')) { d.open ? ui.openAlts.add(d.dataset.alt) : ui.openAlts.delete(d.dataset.alt); }
}, true);
document.addEventListener('change', async (e) => {
  if (e.target.id === 'import-file') {
    const f = e.target.files?.[0]; if (!f) return;
    try { const n = importJSON(await f.text()); toast(`${n} 件を読み込みました`); render(); } catch { toast('読み込みに失敗しました（形式を確認）'); }
  }
});

async function onSetting(what) {
  switch (what) {
    case 'export-dl': download(`is2026-state-${new Date().toISOString().slice(0, 10)}.json`, exportJSON()); break;
    case 'export-copy': await copyText(exportJSON()); break;
    case 'import-text': {
      const txt = $('#import-text').value.trim(); if (!txt) { toast('JSON を貼り付けてください'); return; }
      try { const n = importJSON(txt); toast(`${n} 件を読み込みました`); render(); } catch { toast('読み込みに失敗しました（形式を確認）'); }
      break;
    }
    case 'txt-dl': download(`is2026-itinerary-${new Date().toISOString().slice(0, 10)}.txt`, allDaysText(), 'text/plain'); break;
    case 'txt-copy': await copyText(allDaysText()); break;
    case 'md-dl': download(`is2026-notes-${new Date().toISOString().slice(0, 10)}.md`, buildMarkdown(), 'text/markdown'); break;
    case 'md-copy': await copyText(buildMarkdown()); break;
    case 'sim-set': { const v = $('#sim-now').value; if (!v) { toast('日時を入力'); return; } sessionStorage.setItem(SS_NOW, v); render(); toast('仮時刻を設定: ' + v.replace('T', ' ')); break; }
    case 'sim-clear': sessionStorage.removeItem(SS_NOW); history.replaceState(null, '', location.pathname); render(); toast('仮時刻を解除'); break;
    case 'reload': {
      if ('caches' in window) { for (const k of await caches.keys()) await caches.delete(k); }
      const regs = await navigator.serviceWorker?.getRegistrations?.() || []; for (const r of regs) await r.unregister();
      location.reload(); break;
    }
    case 'reset': if (confirm('メモ・選択・チェックをすべて消去します。よろしいですか？（先に JSON を書き出すことを推奨）')) { localStorage.removeItem(LS_KEY); location.reload(); } break;
  }
}

/* ===== boot ===== */
async function loadData() {
  try {
    const r = await fetch('schedule_data.json', { cache: 'no-cache' });
    if (r.ok) return await r.json();
  } catch { /* file:// など */ }
  if (window.SCHEDULE_DATA) return window.SCHEDULE_DATA;
  throw new Error('schedule_data.json を読み込めません');
}
async function boot() {
  loadState(); applyTheme();
  try { DATA = await loadData(); } catch (e) { $('#main').innerHTML = `<div class="empty">${esc(e.message)}<br>HTTP サーバー経由で開くか、schedule_data.js を生成してください。</div>`; return; }
  TZ = DATA.meta?.timezone || TZ;
  $('#brand-sub').textContent = `${DATA.meta?.conference || ''} · ${DATA.meta?.venue || ''}`;
  buildIndex();
  const now = nowSydney();
  state.day = DATA.days.some((d) => d.date === now.date) ? now.date : DATA.days[0].date;
  render();
  // 初回は現在枠へ。ブラウザのスクロール位置復元と競合するため数回試みる（ユーザー操作があれば中止）
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  let userScrolled = false;
  const stop = () => { userScrolled = true; };
  window.addEventListener('wheel', stop, { once: true, passive: true });
  window.addEventListener('touchstart', stop, { once: true, passive: true });
  for (const ms of [80, 400, 1000]) setTimeout(() => { if (!userScrolled && state.view === 'today') { scrollToNow._smooth = false; scrollToNow(); } }, ms);
  window.addEventListener('resize', syncHeaderHeight);
  // スマホのロック解除・タブ復帰時に「進行中」を即更新
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.view === 'today' && !document.activeElement?.matches?.('textarea')) rerenderKeep(); });
  setInterval(() => { if (state.view !== 'today') return; renderNowbar(); const n = nowSydney(); if (n.min !== boot._lastMin) { boot._lastMin = n.min; if (!document.activeElement?.matches?.('textarea')) rerenderKeep(); } }, 30000);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW register failed', e));
  }
  window.IS2026 = { nowSydney, state, ui, buildMarkdown, exportJSON, render, get DATA() { return DATA; } };
}
boot();
})();
