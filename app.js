// weel — read + track. Browse entries/, read in-app, hit T to time it,
// hit E to edit (markdown / plain text), hit R for a random file.

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const weekTotal = $('#weekTotal');

const KEY = 'weel.tracker.v1';
const KEY_TOPICMAP = 'weel.entryTopics.v1';
const EDITABLE_EXTS = new Set(['md', 'markdown', 'txt', 'text', 'log', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'js', 'ts', 'py', 'css', 'html', 'htm', 'sh']);
const PLAIN_VIEW_EXTS = new Set(['txt', 'text', 'log', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'js', 'ts', 'py', 'css', 'sh']);

let data = { topics: [], sessions: [], active_timer: null };
let entryTopics = {};

const lib = {
  rootHandle: null,
  entriesRoot: null,
  tree: null,
  filesByPath: new Map(),
  expanded: new Set(['md', 'pdf', 'notes', 'txt']),
  search: '',
};

// editor handle — set by renderFileEditor, read by global keydown so ⌘S / ⌘/
// still work when focus has left the textarea (e.g. preview mode).
let _editorAPI = null;

// theme ───────────────────────────────────────────────────────────
(function () {
  const s = localStorage.getItem('weel.theme');
  if (s) document.documentElement.setAttribute('data-theme', s);
})();
$('#themeBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('weel.theme', next);
});

// persistence ─────────────────────────────────────────────────────
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) data = Object.assign({ topics: [], sessions: [], active_timer: null }, JSON.parse(raw)); } catch (_) {}
  try { const raw = localStorage.getItem(KEY_TOPICMAP); if (raw) entryTopics = JSON.parse(raw) || {}; } catch (_) {}
}
function save() { localStorage.setItem(KEY, JSON.stringify(data)); }
function saveEntryTopics() { localStorage.setItem(KEY_TOPICMAP, JSON.stringify(entryTopics)); }

// IndexedDB ───────────────────────────────────────────────────────
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('weel', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly').objectStore('kv').get(k); tx.onsuccess = () => res(tx.result); tx.onerror = () => rej(tx.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); tx.onsuccess = () => res(); tx.onerror = () => rej(tx.error); }); },
};

// helpers ─────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function slugify(s) { return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'topic'; }
function today() { return ymd(new Date()); }
function ymd(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function fmtMin(m) { m = Math.round(m); if (m < 1) return '0'; if (m < 60) return m + 'm'; const h = Math.floor(m / 60), mm = m % 60; return mm === 0 ? `${h}h` : `${h}h ${mm}m`; }
function fmtHMS(sec) { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; const z = (n) => String(n).padStart(2, '0'); return h > 0 ? `${h}:${z(m)}:${z(s)}` : `${z(m)}:${z(s)}`; }
function weekStart(date = new Date()) { const d = new Date(date); d.setHours(0, 0, 0, 0); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return d; }
function extOf(name) { const i = name.lastIndexOf('.'); return i === -1 ? '' : name.slice(i + 1).toLowerCase(); }
function baseName(p) { const i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }
function dirName(p) { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }

// queries ─────────────────────────────────────────────────────────
function getTopic(id) { return data.topics.find(t => t.id === id); }
function activeTopics() { return data.topics.filter(t => !t.archived); }
function sessionsForTopic(id) { return data.sessions.filter(s => s.topic_id === id); }

function minutesIn(topicId, from, to) {
  let total = 0;
  for (const s of data.sessions) {
    if (topicId && s.topic_id !== topicId) continue;
    const d = new Date(s.start);
    if (d >= from && d < to) total += s.duration_minutes;
  }
  if (data.active_timer && (!topicId || data.active_timer.topic_id === topicId)) {
    const st = new Date(data.active_timer.start);
    if (st < to) {
      const up = new Date(Math.min(to.getTime(), Date.now()));
      if (up > from && up > st) { const e = st > from ? st : from; total += Math.max(0, (up - e) / 60000); }
    }
  }
  return total;
}
function minutesThisWeek(id) { const s = weekStart(); const e = new Date(s); e.setDate(s.getDate() + 7); return minutesIn(id, s, e); }
function minutesToday(id) { const [y, m, d] = today().split('-').map(Number); const s = new Date(y, m - 1, d); const e = new Date(s); e.setDate(s.getDate() + 1); return minutesIn(id, s, e); }
function minutesTotal(id) {
  let t = 0;
  for (const s of data.sessions) if (!id || s.topic_id === id) t += s.duration_minutes;
  if (data.active_timer && (!id || data.active_timer.topic_id === id)) t += Math.max(0, (Date.now() - new Date(data.active_timer.start).getTime()) / 60000);
  return t;
}
function dailyTotals(days) {
  const map = new Map();
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const earliest = new Date(now); earliest.setDate(now.getDate() - days + 1);
  for (const s of data.sessions) {
    const d = new Date(s.start);
    if (d < earliest) continue;
    const k = ymd(d); map.set(k, (map.get(k) || 0) + s.duration_minutes);
  }
  return map;
}
// files seen for a topic = union of session entry_paths and entryTopics map
function filesForTopic(id) {
  const m = new Map();
  for (const s of data.sessions) {
    if (s.topic_id !== id || !s.entry_path) continue;
    const r = m.get(s.entry_path) || { minutes: 0, sessions: 0, linked: false };
    r.minutes += s.duration_minutes; r.sessions += 1;
    m.set(s.entry_path, r);
  }
  for (const [path, tid] of Object.entries(entryTopics)) {
    if (tid !== id) continue;
    const r = m.get(path) || { minutes: 0, sessions: 0, linked: false };
    r.linked = true; m.set(path, r);
  }
  return [...m.entries()].sort((a, b) => b[1].minutes - a[1].minutes);
}

// mutations ───────────────────────────────────────────────────────
function addTopic({ name, weekly_goal_minutes = 0, note = '' }) {
  const base = slugify(name); let id = base, n = 1;
  while (data.topics.find(t => t.id === id)) id = base + '-' + (++n);
  data.topics.push({ id, name: name.trim(), weekly_goal_minutes, note, archived: false, created: today() });
  save(); return id;
}
function updateTopic(id, fields) { const t = getTopic(id); if (!t) return; Object.assign(t, fields); save(); }
function deleteTopic(id) {
  data.topics = data.topics.filter(t => t.id !== id);
  data.sessions = data.sessions.filter(s => s.topic_id !== id);
  if (data.active_timer && data.active_timer.topic_id === id) data.active_timer = null;
  for (const k of Object.keys(entryTopics)) if (entryTopics[k] === id) delete entryTopics[k];
  saveEntryTopics(); save();
}
function addSession({ topic_id, start, duration_minutes, note = '', entry_path = '' }) {
  const o = { id: uid(), topic_id, start, duration_minutes: Math.round(duration_minutes), note };
  if (entry_path) o.entry_path = entry_path;
  data.sessions.push(o); save(); return o.id;
}
function updateSession(id, fields) { const s = data.sessions.find(x => x.id === id); if (!s) return; Object.assign(s, fields); if (typeof s.duration_minutes === 'number') s.duration_minutes = Math.round(s.duration_minutes); save(); }
function deleteSession(id) { data.sessions = data.sessions.filter(s => s.id !== id); save(); }

// timer ───────────────────────────────────────────────────────────
function startTimer(topic_id, entry_path = '') {
  if (data.active_timer) return;
  if (!getTopic(topic_id)) return;
  data.active_timer = { topic_id, start: new Date().toISOString() };
  if (entry_path) data.active_timer.entry_path = entry_path;
  save(); updateTimerBar(); render();
}
function stopTimer() {
  const t = data.active_timer; if (!t) return;
  const minutes = Math.max(0, (Date.now() - new Date(t.start).getTime()) / 60000);
  if (minutes < 0.25) { if (!confirm('Less than 15 seconds — save anyway?')) { data.active_timer = null; save(); updateTimerBar(); render(); return; } }
  const note = prompt('quick note for this session (optional)') || '';
  addSession({ topic_id: t.topic_id, start: t.start, duration_minutes: minutes, note: note.trim(), entry_path: t.entry_path || '' });
  data.active_timer = null; save(); updateTimerBar(); render();
}
function cancelTimer() {
  if (!data.active_timer) return;
  if (!confirm('Discard timer and lose elapsed time?')) return;
  data.active_timer = null; save(); updateTimerBar(); render();
}
function updateTimerBar() {
  const bar = $('#timerBar');
  if (!data.active_timer) { bar.classList.add('hidden'); document.querySelector('header .tagline').textContent = 'locked in'; updateWeekTotal(); return; }
  const t = getTopic(data.active_timer.topic_id);
  if (!t) { data.active_timer = null; save(); bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#timerTopic').textContent = t.name;
  $('#timerEntry').textContent = data.active_timer.entry_path ? '· ' + data.active_timer.entry_path : '';
  $('#timerElapsed').textContent = fmtHMS((Date.now() - new Date(data.active_timer.start).getTime()) / 1000);
  document.querySelector('header .tagline').textContent = 'locked in · live';
  updateWeekTotal();
}
function updateWeekTotal() {
  const m = minutesThisWeek(null); const ts = fmtMin(m);
  weekTotal.textContent = (ts === '0') ? 'no time this week' : `${ts} this week`;
}
setInterval(() => { if (data.active_timer) updateTimerBar(); }, 1000);
$('#timerStop').addEventListener('click', stopTimer);
$('#timerCancel').addEventListener('click', cancelTimer);

async function ensureTopicForEntry(entry_path) {
  let id = entryTopics[entry_path];
  if (id && getTopic(id)) return id;
  const topics = activeTopics();
  if (topics.length === 0) {
    const name = prompt('What topic is this entry under? (creates it)'); if (!name) return null;
    id = addTopic({ name }); entryTopics[entry_path] = id; saveEntryTopics(); return id;
  }
  const lines = ['Topic for this entry:'].concat(topics.map((t, i) => `  ${i + 1}. ${t.name}`)).concat(['  0. + new topic']);
  const ans = prompt(lines.join('\n'), '1'); if (ans === null) return null;
  const n = parseInt(ans, 10);
  if (n === 0) { const name = prompt('new topic name'); if (!name) return null; id = addTopic({ name }); }
  else if (n >= 1 && n <= topics.length) id = topics[n - 1].id;
  else return null;
  entryTopics[entry_path] = id; saveEntryTopics(); return id;
}
async function toggleTimerForEntry(entry_path) {
  if (data.active_timer) { stopTimer(); return; }
  const id = await ensureTopicForEntry(entry_path); if (!id) return;
  startTimer(id, entry_path);
}

// FSA library ─────────────────────────────────────────────────────
async function pickLibraryFolder() {
  if (!('showDirectoryPicker' in window)) { alert('Library needs Chrome, Edge, or Opera.'); return; }
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'weel-library' });
    lib.rootHandle = h; await idb.set('libHandle', h);
    await scanTree(); render();
  } catch (e) { if (e.name !== 'AbortError') console.error(e); }
}
async function tryRestoreLib() {
  try {
    const h = await idb.get('libHandle'); if (!h) return false;
    const perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    lib.rootHandle = h; await scanTree(); return true;
  } catch (_) { return false; }
}
async function ensureLibWrite() {
  if (!lib.rootHandle) { await pickLibraryFolder(); return !!lib.rootHandle; }
  try {
    if ((await lib.rootHandle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await lib.rootHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch (_) { return false; }
}
async function scanTree() {
  if (!lib.rootHandle) { lib.tree = null; return; }
  let root = lib.rootHandle;
  try { root = await lib.rootHandle.getDirectoryHandle('entries', { create: false }); } catch (_) {}
  lib.entriesRoot = root;
  lib.filesByPath.clear();
  lib.tree = await walkDir(root, '');
}
async function walkDir(handle, prefix) {
  const out = [];
  for await (const [name, child] of handle.entries()) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const path = prefix ? prefix + '/' + name : name;
    if (child.kind === 'directory') out.push({ kind: 'dir', name, path, children: await walkDir(child, path) });
    else { out.push({ kind: 'file', name, path, handle: child }); lib.filesByPath.set(path, child); }
  }
  out.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  return out;
}
async function getDirForPath(parentPath) {
  if (!lib.entriesRoot) throw new Error('library not connected');
  let dir = lib.entriesRoot;
  if (!parentPath) return dir;
  for (const seg of parentPath.split('/')) { if (!seg) continue; dir = await dir.getDirectoryHandle(seg, { create: true }); }
  return dir;
}
async function writeFile(path, text) {
  if (!await ensureLibWrite()) throw new Error('write permission denied');
  const dir = await getDirForPath(dirName(path));
  const fh = await dir.getFileHandle(baseName(path), { create: true });
  const w = await fh.createWritable();
  await w.write(text); await w.close();
  lib.filesByPath.set(path, fh);
  return fh;
}

// router ──────────────────────────────────────────────────────────
window.addEventListener('hashchange', render);
function render() {
  _editorAPI = null; // renderFileEditor re-sets if we're going there
  updateWeekTotal(); updateTimerBar();
  const h = location.hash || '#/';
  if (h === '#/' || h === '') return renderLibrary();
  if (h === '#/new-file') return renderNewFileForm();
  if (h.startsWith('#/read/')) return renderReader(decodeURIComponent(h.slice('#/read/'.length)));
  if (h.startsWith('#/edit-file/')) return renderFileEditor(decodeURIComponent(h.slice('#/edit-file/'.length)));
  if (h === '#/topics') return renderTopics();
  if (h === '#/new-topic') return renderTopicForm();
  if (h.startsWith('#/edit-topic/')) return renderTopicForm(decodeURIComponent(h.slice('#/edit-topic/'.length)));
  if (h.startsWith('#/topic/')) return renderTopicDetail(decodeURIComponent(h.slice('#/topic/'.length)));
  if (h === '#/sessions') return renderSessions();
  if (h === '#/new-session') return renderSessionForm();
  if (h.startsWith('#/edit-session/')) return renderSessionForm(decodeURIComponent(h.slice('#/edit-session/'.length)));
  if (h === '#/stats') return renderStats();
  if (h === '#/data') return renderData();
  renderLibrary();
}

// library view ────────────────────────────────────────────────────
function renderLibrary() {
  if (!lib.rootHandle) {
    view.innerHTML = `
      <div class="page-head"><h1>library</h1></div>
      <div class="empty-state">
        <p>Pick the folder that contains your <code>entries/</code> directory (or the entries folder itself).</p>
        <p>Layout: <code>entries/md/</code>, <code>entries/pdf/</code>, … nesting fine.</p>
        <p><button id="pickBtn">pick folder</button></p>
        <p class="dim">Chrome / Edge / Opera. One pick, then the browser remembers.</p>
        <p class="dim" style="margin-top:24px">You can still use <a href="#/topics">topics</a> and the timer without it.</p>
      </div>`;
    $('#pickBtn').onclick = pickLibraryFolder;
    return;
  }
  view.innerHTML = `
    <div class="page-head">
      <h1>library</h1>
      <div class="right">
        <a href="#/new-file">+ new file</a>
        <button class="link" id="rescanBtn">rescan</button>
        <button class="link" id="repickBtn">change folder</button>
      </div>
    </div>
    <div class="search-box"><input type="search" id="fileSearch" placeholder="/ filter files" value="${esc(lib.search)}"></div>
    <div class="tree" id="tree">${treeHTML(lib.tree, 0)}</div>
  `;
  $('#rescanBtn').onclick = async () => { await scanTree(); render(); };
  $('#repickBtn').onclick = pickLibraryFolder;
  const search = $('#fileSearch');
  search.addEventListener('input', () => { lib.search = search.value.toLowerCase(); applyFilter(); });
  applyFilter();
  for (const el of view.querySelectorAll('[data-toggle]')) {
    el.onclick = (ev) => { ev.preventDefault(); const p = el.dataset.toggle; if (lib.expanded.has(p)) lib.expanded.delete(p); else lib.expanded.add(p); renderLibrary(); };
  }
  for (const el of view.querySelectorAll('[data-open]')) {
    el.onclick = (ev) => { ev.preventDefault(); location.hash = '#/read/' + encodeURIComponent(el.dataset.open); };
  }
}
function treeHTML(nodes, depth) {
  if (!nodes) return '';
  return nodes.map(n => {
    if (n.kind === 'dir') {
      const open = lib.expanded.has(n.path);
      return `
        <div class="tree-row" style="padding-left:${depth * 14}px" data-path="${esc(n.path)}" data-kind="dir">
          <a href="#" class="tree-dir" data-toggle="${esc(n.path)}">${open ? '▾' : '▸'} ${esc(n.name)}<span class="dim"> · ${n.children.length}</span></a>
        </div>
        ${open ? treeHTML(n.children, depth + 1) : ''}`;
    } else {
      const tid = entryTopics[n.path]; const t = tid ? getTopic(tid) : null;
      return `
        <div class="tree-row" style="padding-left:${depth * 14}px" data-path="${esc(n.path)}" data-kind="file">
          <span class="ext">${esc(extOf(n.name))}</span>
          <a href="#" class="tree-file" data-open="${esc(n.path)}">${esc(n.name)}</a>
          <span class="tree-meta">${t ? esc(t.name) : ''}</span>
        </div>`;
    }
  }).join('');
}
function applyFilter() {
  const q = lib.search;
  const rows = view.querySelectorAll('.tree-row');
  if (!q) { rows.forEach(r => r.classList.remove('match-hidden')); return; }
  const matched = new Set();
  function walk(nodes) {
    let any = false;
    for (const n of nodes) {
      if (n.kind === 'file') {
        if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) { matched.add(n.path); any = true; }
      } else { if (walk(n.children)) { matched.add(n.path); any = true; } }
    }
    return any;
  }
  walk(lib.tree);
  rows.forEach(r => { if (matched.has(r.dataset.path)) r.classList.remove('match-hidden'); else r.classList.add('match-hidden'); });
}

// reader ──────────────────────────────────────────────────────────
let _blobUrl = null;
async function renderReader(path) {
  if (!lib.rootHandle) { view.innerHTML = '<p class="dim">library not connected. <a href="#/">back</a></p>'; return; }
  const handle = lib.filesByPath.get(path);
  if (!handle) { view.innerHTML = `<p class="dim">file not found. try <a href="#/">rescan</a>.</p>`; return; }
  const name = baseName(path); const ext = extOf(name);
  const tid = entryTopics[path]; const t = tid ? getTopic(tid) : null;
  const running = data.active_timer && data.active_timer.entry_path === path;
  const editable = EDITABLE_EXTS.has(ext);

  view.innerHTML = `
    <a class="back" href="#/">← library</a>
    <div class="page-head reader-head">
      <h1>${esc(path)}</h1>
      <div class="right">
        <span>topic:</span>
        <select id="topicSel">
          <option value="">— none —</option>
          ${activeTopics().map(x => `<option value="${esc(x.id)}" ${x.id === tid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
          <option value="__new">+ new topic…</option>
        </select>
        <button class="link" id="readerTimerBtn">${running ? 'stop (t)' : 'start (t)'}</button>
        ${editable ? `<a href="#/edit-file/${encodeURIComponent(path)}">edit (e)</a>` : ''}
      </div>
    </div>
    <div class="reader-body" id="readerBody"><p class="dim">loading…</p></div>
  `;
  $('#topicSel').onchange = (ev) => {
    const v = ev.target.value;
    if (v === '__new') { const nm = prompt('new topic name'); if (!nm) { ev.target.value = tid || ''; return; } const id = addTopic({ name: nm }); entryTopics[path] = id; saveEntryTopics(); }
    else if (v === '') { delete entryTopics[path]; saveEntryTopics(); }
    else { entryTopics[path] = v; saveEntryTopics(); }
    render();
  };
  $('#readerTimerBtn').onclick = () => toggleTimerForEntry(path);

  if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl); } catch (_) {} _blobUrl = null; }
  const body = $('#readerBody');
  try {
    const file = await handle.getFile();
    if (ext === 'md' || ext === 'markdown') {
      const text = await file.text();
      const parsed = parseFrontmatter(text);
      const html = window.marked ? marked.parse(parsed.body) : esc(parsed.body);
      body.innerHTML = `<div class="md-body">${html}</div>`;
    } else if (ext === 'pdf') {
      const url = URL.createObjectURL(file); _blobUrl = url;
      body.innerHTML = `<iframe class="embed-frame" src="${url}#view=FitH"></iframe>`;
    } else if (['html', 'htm', 'svg'].includes(ext)) {
      const url = URL.createObjectURL(file); _blobUrl = url;
      body.innerHTML = `<iframe class="embed-frame" src="${url}" sandbox></iframe>`;
    } else if (PLAIN_VIEW_EXTS.has(ext)) {
      const text = await file.text();
      body.innerHTML = `<pre class="plain">${esc(text)}</pre>`;
    } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) {
      const url = URL.createObjectURL(file); _blobUrl = url;
      body.innerHTML = `<img src="${url}" style="max-width:100%;height:auto" alt="">`;
    } else {
      const url = URL.createObjectURL(file); _blobUrl = url;
      body.innerHTML = `<p class="dim">can't preview <code>.${esc(ext)}</code>. <a href="${url}" download="${esc(name)}">download</a></p>`;
    }
  } catch (e) { body.innerHTML = `<p class="dim">error: ${esc(e.message)}</p>`; }
}
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: '', body: text };
  return { meta: m[1], body: m[2] };
}

// file editor ─────────────────────────────────────────────────────
async function renderFileEditor(path) {
  if (!lib.rootHandle) { view.innerHTML = '<p class="dim">library not connected. <a href="#/">back</a></p>'; return; }
  const handle = lib.filesByPath.get(path);
  const ext = extOf(path);
  if (!EDITABLE_EXTS.has(ext)) { view.innerHTML = `<p class="dim">.${esc(ext)} not editable here.</p>`; return; }
  const isMd = ext === 'md' || ext === 'markdown';

  let content = '';
  if (handle) {
    try { content = await (await handle.getFile()).text(); } catch (e) { content = ''; }
  }

  view.innerHTML = `
    <a class="back" href="#/read/${encodeURIComponent(path)}">← cancel</a>
    <div class="page-head">
      <h1>${esc(path)}</h1>
      <div class="right">
        <span class="save-status" id="saveStatus"></span>
        <button class="link" id="saveBtn">save (⌘S)</button>
        ${isMd ? `<button class="link" id="previewBtn">preview (⌘/)</button>` : ''}
      </div>
    </div>
    ${isMd ? `<div class="editor-head">
      <div class="md-toolbar">
        <button type="button" data-md="bold" title="bold ⌘B"><b>B</b></button>
        <button type="button" data-md="italic" title="italic ⌘I"><i>i</i></button>
        <button type="button" data-md="code" title="inline code"><span class="mono">‹›</span></button>
        <button type="button" data-md="link" title="link ⌘K">link</button>
        <button type="button" data-md="h" title="heading">#</button>
        <button type="button" data-md="quote" title="quote">›</button>
        <button type="button" data-md="list" title="list">•</button>
        <button type="button" data-md="hr" title="rule">—</button>
      </div>
      <div class="editor-tools"><span id="wordCount"></span></div>
    </div>` : ''}
    <textarea id="editorTA" class="editor-textarea" spellcheck="${isMd ? 'true' : 'false'}">${esc(content)}</textarea>
    <div id="preview" class="md-body hidden" style="border-top:1px solid var(--line);padding-top:18px;margin-top:0;min-height:480px"></div>
  `;

  const ta = $('#editorTA');
  const status = $('#saveStatus');
  const wc = $('#wordCount');
  const pv = $('#preview');
  let dirty = false;
  function updateWords() { if (wc) { const t = ta.value.trim(); const w = t ? t.split(/\s+/).length : 0; wc.textContent = `${w} word${w === 1 ? '' : 's'} · ${ta.value.length} chars`; } }
  updateWords();

  async function doSave() {
    try {
      await writeFile(path, ta.value);
      dirty = false;
      status.textContent = 'saved'; status.classList.add('ok');
      setTimeout(() => { if (status.textContent === 'saved') { status.textContent = ''; status.classList.remove('ok'); } }, 1200);
    } catch (e) { status.textContent = 'save failed: ' + e.message; }
  }
  $('#saveBtn').onclick = doSave;
  ta.addEventListener('input', () => { dirty = true; status.textContent = 'unsaved'; status.classList.remove('ok'); updateWords(); });
  ta.focus();

  // markdown helpers
  function wrap(before, after, ph) {
    const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
    const inner = sel || ph;
    ta.setRangeText(before + inner + after, s, e, 'end');
    if (!sel) { ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + inner.length; }
    ta.focus(); updateWords();
  }
  function prefixLines(prefix) {
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const ls = v.lastIndexOf('\n', s - 1) + 1; const ne = v.indexOf('\n', e); const en = ne === -1 ? v.length : ne;
    const lines = v.slice(ls, en).split('\n').map(l => prefix + l).join('\n');
    ta.setRangeText(lines, ls, en, 'end'); ta.focus(); updateWords();
  }
  function applyMd(act) {
    switch (act) {
      case 'bold': return wrap('**', '**', 'bold');
      case 'italic': return wrap('*', '*', 'italic');
      case 'code': return wrap('`', '`', 'code');
      case 'link': { const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e) || 'text'; ta.setRangeText(`[${sel}](url)`, s, e, 'end'); const p = s + sel.length + 3; ta.selectionStart = p; ta.selectionEnd = p + 3; ta.focus(); return; }
      case 'quote': return prefixLines('> ');
      case 'h': return prefixLines('## ');
      case 'list': return prefixLines('- ');
      case 'hr': { const s = ta.selectionStart; ta.setRangeText('\n\n---\n\n', s, s, 'end'); ta.focus(); return; }
    }
  }
  for (const b of view.querySelectorAll('[data-md]')) b.addEventListener('click', () => { applyMd(b.dataset.md); dirty = true; status.textContent = 'unsaved'; status.classList.remove('ok'); });

  function togglePreview() {
    if (!isMd) return;
    if (pv.classList.contains('hidden')) {
      pv.innerHTML = window.marked ? marked.parse(ta.value) : esc(ta.value);
      pv.classList.remove('hidden'); ta.classList.add('hidden');
      $('#previewBtn').textContent = 'edit (⌘/)';
    } else { pv.classList.add('hidden'); ta.classList.remove('hidden'); $('#previewBtn').textContent = 'preview (⌘/)'; ta.focus(); }
  }
  if (isMd) $('#previewBtn').onclick = togglePreview;

  // expose to global keydown so ⌘S and ⌘/ work outside the textarea (preview mode)
  _editorAPI = { save: doSave };
  if (isMd) _editorAPI.togglePreview = togglePreview;

  ta.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && !ev.shiftKey && !ev.altKey) {
      if (ev.key === 's') { ev.preventDefault(); doSave(); return; }
      if (isMd) {
        if (ev.key === 'b') { ev.preventDefault(); applyMd('bold'); return; }
        if (ev.key === 'i') { ev.preventDefault(); applyMd('italic'); return; }
        if (ev.key === 'k') { ev.preventDefault(); applyMd('link'); return; }
        if (ev.key === '/') { ev.preventDefault(); togglePreview(); return; }
      }
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      if (ev.shiftKey) {
        const s = ta.selectionStart; const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
        if (ta.value.slice(ls, ls + 2) === '  ') ta.setRangeText('', ls, ls + 2, 'preserve');
        else if (ta.value[ls] === ' ') ta.setRangeText('', ls, ls + 1, 'preserve');
      } else ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    }
  });

  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}

// new file form ───────────────────────────────────────────────────
function renderNewFileForm() {
  if (!lib.rootHandle) { view.innerHTML = '<p class="dim">connect the library first. <a href="#/">back</a></p>'; return; }
  // collect dirs
  function dirs(nodes, acc = []) { for (const n of nodes || []) if (n.kind === 'dir') { acc.push(n.path); dirs(n.children, acc); } return acc; }
  const allDirs = ['', ...dirs(lib.tree).sort()];

  view.innerHTML = `
    <a class="back" href="#/">← back</a>
    <h1 style="font-size:22px;margin:4px 0 24px;font-weight:600">new file</h1>
    <form class="form" id="nfForm" autocomplete="off">
      <div class="row">
        <label>folder
          <select name="parent">
            ${allDirs.map(d => `<option value="${esc(d)}">${esc(d || '(entries root)')}</option>`).join('')}
            <option value="__custom">+ new folder…</option>
          </select>
        </label>
        <label>type
          <select name="ext">
            <option value="md" selected>.md (markdown)</option>
            <option value="txt">.txt</option>
            <option value="log">.log</option>
            <option value="json">.json</option>
            <option value="csv">.csv</option>
            <option value="yaml">.yaml</option>
          </select>
        </label>
      </div>
      <label id="customParentWrap" class="hidden">custom folder <span>(relative to entries/)</span><input name="customParent" placeholder="md/notes"></label>
      <label>name <span>(without extension)</span><input name="name" required autofocus placeholder="my-note"></label>
      <div class="actions">
        <button type="button" id="cancelBtn" class="ghost">cancel</button>
        <button type="submit">create &amp; edit</button>
      </div>
    </form>`;
  const form = $('#nfForm');
  const parentSel = form.parent;
  parentSel.onchange = () => { $('#customParentWrap').classList.toggle('hidden', parentSel.value !== '__custom'); };
  $('#cancelBtn').onclick = () => history.back();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    let parent = fd.get('parent');
    if (parent === '__custom') parent = (fd.get('customParent') || '').trim().replace(/^\/+|\/+$/g, '');
    const name = fd.get('name').trim().replace(/[\\/]/g, '-').replace(/^\.+/, '');
    if (!name) return;
    const ext = fd.get('ext');
    const filename = name.endsWith('.' + ext) ? name : name + '.' + ext;
    const path = parent ? parent + '/' + filename : filename;
    if (lib.filesByPath.has(path)) { if (!confirm(`${path} exists. Overwrite?`)) return; }
    const seed = ext === 'md'
      ? `# ${name.replace(/-/g, ' ')}\n\n`
      : ext === 'json' ? '{\n  \n}\n' : '';
    try {
      await writeFile(path, seed);
      await scanTree();
      location.hash = '#/edit-file/' + encodeURIComponent(path);
    } catch (e) { alert('create failed: ' + e.message); }
  });
}

// topics list ─────────────────────────────────────────────────────
function renderTopics() {
  const topics = activeTopics();
  const archived = data.topics.filter(t => t.archived);
  if (topics.length === 0 && archived.length === 0) {
    view.innerHTML = `
      <div class="page-head"><h1>topics</h1><div class="right"><a href="#/new-topic">+ new topic</a></div></div>
      <div class="empty-state">
        <p>No topics yet.</p>
        <p>A topic groups your reading time toward a weekly goal.</p>
        <p><a href="#/new-topic">add your first topic</a></p>
      </div>`;
    return;
  }
  const rows = topics.map(topicRowHTML).join('');
  const aRows = archived.length ? `<details style="margin-top:32px"><summary class="dim" style="cursor:pointer;font-size:13px">archived (${archived.length})</summary>${archived.map(t => topicRowHTML(t, true)).join('')}</details>` : '';
  view.innerHTML = `
    <div class="page-head"><h1>topics</h1><div class="right"><a href="#/new-topic">+ new topic</a></div></div>
    ${rows}${aRows}`;
  for (const el of view.querySelectorAll('[data-start]')) {
    el.addEventListener('click', (ev) => {
      ev.preventDefault(); const id = el.dataset.start;
      if (data.active_timer && data.active_timer.topic_id === id) stopTimer();
      else if (data.active_timer) { if (confirm('Stop the running timer first?')) stopTimer(); }
      else startTimer(id);
    });
  }
}
function topicRowHTML(t, isArchived = false) {
  const week = minutesThisWeek(t.id), goal = t.weekly_goal_minutes || 0;
  const pct = goal > 0 ? Math.min(100, (week / goal) * 100) : 0;
  const over = goal > 0 && week > goal;
  const running = data.active_timer && data.active_timer.topic_id === t.id;
  const txt = goal > 0 ? `<b>${fmtMin(week)}</b> / ${fmtMin(goal)}` : `<b>${fmtMin(week)}</b> this week · no goal`;
  return `
    <div class="topic-row">
      <div class="r1">
        <a href="#/topic/${encodeURIComponent(t.id)}" class="name${isArchived ? ' archived' : ''}">${esc(t.name)}</a>
        <span class="prog-text">${txt}</span>
        ${isArchived ? '' : `<button class="start ${running ? 'running' : ''}" data-start="${esc(t.id)}">${running ? 'stop' : 'start'}</button>`}
      </div>
      ${goal > 0 ? `<div class="bar ${over ? 'over' : ''}"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>` : ''}
    </div>`;
}

// topic detail ────────────────────────────────────────────────────
function renderTopicDetail(id) {
  const t = getTopic(id);
  if (!t) { view.innerHTML = `<p class="dim">topic not found. <a href="#/topics">back</a></p>`; return; }
  const week = minutesThisWeek(id), total = minutesTotal(id), todayM = minutesToday(id);
  const sessions = sessionsForTopic(id).sort((a, b) => b.start.localeCompare(a.start));
  const goal = t.weekly_goal_minutes || 0;
  const running = data.active_timer && data.active_timer.topic_id === id;
  const files = filesForTopic(id);

  view.innerHTML = `
    <a class="back" href="#/topics">← topics</a>
    <div class="page-head">
      <h1>${esc(t.name)}</h1>
      <div class="right">
        <button class="link" id="startBtn">${running ? 'stop' : 'start'}</button>
        <a href="#/new-session?topic=${encodeURIComponent(id)}">+ log</a>
        <a href="#/edit-topic/${encodeURIComponent(id)}">edit</a>
      </div>
    </div>
    <div class="detail-meta">
      total <b>${fmtMin(total)}</b> · this week <b>${fmtMin(week)}</b>${goal ? ` of <b>${fmtMin(goal)}</b>` : ' · no weekly goal'} · today <b>${fmtMin(todayM)}</b>
    </div>
    ${t.note ? `<p style="white-space:pre-wrap;color:var(--dim);font-size:14px;margin-bottom:24px">${esc(t.note)}</p>` : ''}

    ${files.length ? `
      <h3 class="dim" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;margin:24px 0 8px;font-weight:500">files (${files.length})</h3>
      <div style="font-size:14px">
        ${files.map(([path, r]) => `
          <div style="padding:6px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:14px">
            <a href="#/read/${encodeURIComponent(path)}" style="text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(path)}</a>
            <span class="dim">${r.minutes > 0 ? esc(fmtMin(r.minutes)) + ' · ' + r.sessions + ' sess' : 'linked'}</span>
          </div>`).join('')}
      </div>` : ''}

    <h3 class="dim" style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;margin:24px 0 8px;font-weight:500">sessions (${sessions.length})</h3>
    ${sessions.length === 0 ? '<p class="dim">no sessions yet.</p>' : sessions.slice(0, 30).map(sessionRowHTML).join('')}
    ${sessions.length > 30 ? `<p class="dim" style="font-size:13px;margin-top:12px">showing 30 of ${sessions.length} · <a href="#/sessions">all sessions</a></p>` : ''}
  `;
  $('#startBtn').addEventListener('click', () => {
    if (running) stopTimer();
    else if (data.active_timer) { if (confirm('Stop the running timer first?')) stopTimer(); }
    else startTimer(id);
  });
}
function sessionRowHTML(s) {
  const t = getTopic(s.topic_id);
  const path = s.entry_path ? ` · <a href="#/read/${encodeURIComponent(s.entry_path)}" class="dim" style="text-decoration:none">${esc(baseName(s.entry_path))}</a>` : '';
  return `
    <div class="session-row">
      <span class="date">${esc(ymd(new Date(s.start)))}</span>
      <span class="dur">${esc(fmtMin(s.duration_minutes))}</span>
      <span class="topic">${esc(t ? t.name : '(deleted)')}${path}${s.note ? ' · ' + esc(s.note) : ''}</span>
      <span class="actions"><a href="#/edit-session/${encodeURIComponent(s.id)}">edit</a></span>
    </div>`;
}

// sessions list ───────────────────────────────────────────────────
function renderSessions() {
  const all = data.sessions.slice().sort((a, b) => b.start.localeCompare(a.start));
  view.innerHTML = `
    <div class="page-head"><h1>sessions</h1><div class="right"><a href="#/new-session">+ log session</a></div></div>
    ${all.length === 0 ? '<p class="empty-state">no sessions yet.</p>' : all.map(sessionRowHTML).join('')}
  `;
}

// topic form ──────────────────────────────────────────────────────
function renderTopicForm(editId) {
  const editing = editId ? getTopic(editId) : null;
  const t = editing || { name: '', weekly_goal_minutes: 0, note: '' };
  const goalH = t.weekly_goal_minutes ? (t.weekly_goal_minutes / 60) : '';
  view.innerHTML = `
    <a class="back" href="${editing ? '#/topic/' + encodeURIComponent(editId) : '#/topics'}">← back</a>
    <h1 style="font-size:22px;margin:4px 0 24px;font-weight:600">${editing ? 'edit topic' : 'new topic'}</h1>
    <form class="form" id="tForm" autocomplete="off">
      <label>name<input name="name" required value="${esc(t.name)}" autofocus></label>
      <label>weekly goal <span>(hours per week, optional)</span><input name="goal" type="number" min="0" step="0.5" value="${goalH}"></label>
      <label>note <span>(optional)</span><textarea name="note">${esc(t.note || '')}</textarea></label>
      <div class="actions">
        ${editing ? `<button type="button" id="archiveBtn" class="ghost">${editing.archived ? 'unarchive' : 'archive'}</button>
        <button type="button" id="deleteBtn" class="ghost">delete</button>` : ''}
        <button type="button" id="cancelBtn" class="ghost">cancel</button>
        <button type="submit">${editing ? 'save' : 'create'}</button>
      </div>
    </form>`;
  $('#cancelBtn').onclick = () => history.back();
  if (editing) {
    $('#archiveBtn').onclick = () => { updateTopic(editId, { archived: !editing.archived }); location.hash = '#/topics'; };
    $('#deleteBtn').onclick = () => { if (confirm(`Delete "${editing.name}" and all its sessions?`)) { deleteTopic(editId); location.hash = '#/topics'; } };
  }
  $('#tForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const name = fd.get('name').trim(); if (!name) return;
    const goalM = Math.round((parseFloat(fd.get('goal')) || 0) * 60);
    const note = fd.get('note').trim();
    if (editing) { updateTopic(editId, { name, weekly_goal_minutes: goalM, note }); location.hash = '#/topic/' + encodeURIComponent(editId); }
    else { const id = addTopic({ name, weekly_goal_minutes: goalM, note }); location.hash = '#/topic/' + encodeURIComponent(id); }
  });
}

// session form ────────────────────────────────────────────────────
function renderSessionForm(editId) {
  const editing = editId ? data.sessions.find(s => s.id === editId) : null;
  const hashQ = new URLSearchParams((location.hash.split('?')[1] || ''));
  const preTopic = hashQ.get('topic');
  const s = editing || { topic_id: preTopic || (activeTopics()[0] || {}).id || '', start: new Date().toISOString(), duration_minutes: 30, note: '', entry_path: '' };
  if (data.topics.length === 0) { view.innerHTML = `<a class="back" href="#/topics">← back</a><p class="dim">add a topic first.</p>`; return; }
  const sd = new Date(s.start);
  const dateStr = ymd(sd);
  const timeStr = `${String(sd.getHours()).padStart(2, '0')}:${String(sd.getMinutes()).padStart(2, '0')}`;
  const hrs = Math.floor(s.duration_minutes / 60), mins = s.duration_minutes % 60;
  const durStr = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  view.innerHTML = `
    <a class="back" href="${editing ? '#/sessions' : '#/topics'}">← back</a>
    <h1 style="font-size:22px;margin:4px 0 24px;font-weight:600">${editing ? 'edit session' : 'log session'}</h1>
    <form class="form" id="sForm" autocomplete="off">
      <label>topic
        <select name="topic_id" required>
          ${data.topics.map(t => `<option value="${esc(t.id)}" ${t.id === s.topic_id ? 'selected' : ''}>${esc(t.name)}${t.archived ? ' (archived)' : ''}</option>`).join('')}
        </select>
      </label>
      <div class="row">
        <label>date<input name="date" type="date" required value="${dateStr}"></label>
        <label>start time<input name="time" type="time" value="${timeStr}"></label>
        <label>duration <span>(hh:mm)</span><input name="duration" required pattern="\\d{1,2}:\\d{2}" placeholder="0:30" value="${durStr}"></label>
      </div>
      <label>entry <span>(optional path)</span><input name="entry_path" value="${esc(s.entry_path || '')}" placeholder="md/foo.md"></label>
      <label>note <span>(optional)</span><textarea name="note">${esc(s.note || '')}</textarea></label>
      <div class="actions">
        ${editing ? `<button type="button" id="deleteBtn" class="ghost">delete</button>` : ''}
        <button type="button" id="cancelBtn" class="ghost">cancel</button>
        <button type="submit">${editing ? 'save' : 'log'}</button>
      </div>
    </form>`;
  $('#cancelBtn').onclick = () => history.back();
  if (editing) $('#deleteBtn').onclick = () => { if (confirm('Delete this session?')) { deleteSession(editId); history.back(); } };
  $('#sForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const topic_id = fd.get('topic_id');
    const m = fd.get('duration').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) { alert('duration must be h:mm'); return; }
    const minutes = (+m[1]) * 60 + (+m[2]); if (minutes <= 0) return;
    const [yy, mo, dd] = fd.get('date').split('-').map(Number);
    const [hh, mi] = (fd.get('time') || '00:00').split(':').map(Number);
    const start = new Date(yy, mo - 1, dd, hh, mi).toISOString();
    const note = fd.get('note').trim();
    const entry_path = fd.get('entry_path').trim();
    if (editing) updateSession(editId, { topic_id, start, duration_minutes: minutes, note, entry_path });
    else addSession({ topic_id, start, duration_minutes: minutes, note, entry_path });
    location.hash = '#/topic/' + encodeURIComponent(topic_id);
  });
}

// stats ───────────────────────────────────────────────────────────
function renderStats() {
  const totalAll = minutesTotal(null), weekAll = minutesThisWeek(null);
  const wkS = weekStart(); const lwS = new Date(wkS); lwS.setDate(wkS.getDate() - 7);
  const lastWeekMin = minutesIn(null, lwS, wkS);
  const daily = dailyTotals(30);
  const activeDays = [...daily.values()].filter(v => v > 0).length;
  const streak = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); const all = dailyTotals(400); if ((all.get(ymd(d)) || 0) === 0) d.setDate(d.getDate() - 1); let n = 0; while ((all.get(ymd(d)) || 0) > 0) { n++; d.setDate(d.getDate() - 1); } return n; })();
  const byTopic = data.topics.map(t => ({ t, total: minutesTotal(t.id) })).filter(x => x.total > 0).sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...byTopic.map(x => x.total));
  view.innerHTML = `
    <div class="stats">
      <a class="back" href="#/">← back</a>
      <h1>stats</h1>
      <div class="numbers">
        <div><div class="v">${fmtMin(totalAll)}</div><div class="k">total</div></div>
        <div><div class="v">${fmtMin(weekAll)}</div><div class="k">this week</div></div>
        <div><div class="v">${fmtMin(lastWeekMin)}</div><div class="k">last week</div></div>
        <div><div class="v">${activeDays}</div><div class="k">days in last 30</div></div>
        <div><div class="v">${streak}</div><div class="k">day streak</div></div>
      </div>
      <section>
        <h3>by topic (all time)</h3>
        ${byTopic.length === 0 ? '<p class="dim">no sessions yet.</p>' : `<div class="bars">${byTopic.map(x => `
          <div class="bar-row">
            <span><a href="#/topic/${encodeURIComponent(x.t.id)}" style="text-decoration:none">${esc(x.t.name)}</a></span>
            <span class="b"><span class="f" style="width:${(x.total / max * 100).toFixed(1)}%"></span></span>
            <span class="n">${esc(fmtMin(x.total))}</span>
          </div>`).join('')}</div>`}
      </section>
      <section>
        <h3>last 26 weeks</h3>
        ${renderHeatmap(182)}
      </section>
    </div>`;
}
function renderHeatmap(days) {
  const totals = dailyTotals(days);
  const max = Math.max(60, ...totals.values());
  const td = new Date(); td.setHours(0, 0, 0, 0);
  const end = new Date(td); end.setDate(td.getDate() + 1);
  const start = new Date(end); start.setDate(end.getDate() - days);
  while (start.getDay() !== 1) start.setDate(start.getDate() + 1);
  const totalDays = Math.floor((end - start) / 86400000);
  const weeks = Math.ceil(totalDays / 7);
  let html = '<div class="heatmap">';
  for (let w = 0; w < weeks; w++) {
    html += '<div class="hm-col">';
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start); cur.setDate(start.getDate() + w * 7 + d);
      if (cur >= end) { html += '<div class="hm-cell empty" style="visibility:hidden"></div>'; continue; }
      const k = ymd(cur); const m = totals.get(k) || 0;
      if (m === 0) html += `<div class="hm-cell empty" title="${k} · no activity"></div>`;
      else { const op = (0.25 + Math.min(1, m / max) * 0.75).toFixed(2); html += `<div class="hm-cell" style="opacity:${op}" title="${k} · ${fmtMin(m)}"></div>`; }
    }
    html += '</div>';
  }
  return html + '</div>';
}

// data view ───────────────────────────────────────────────────────
function renderData() {
  const sz = (new Blob([JSON.stringify({ data, entryTopics })]).size / 1024).toFixed(1);
  view.innerHTML = `
    <a class="back" href="#/">← back</a>
    <h1 style="font-size:22px;margin:4px 0 24px;font-weight:600">data</h1>
    <div class="data-section">
      <h3>summary</h3>
      <p>${data.topics.length} topic${data.topics.length === 1 ? '' : 's'} · ${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'} · ${Object.keys(entryTopics).length} entry-topic link${Object.keys(entryTopics).length === 1 ? '' : 's'} · ${sz} KB</p>
      <p>library folder: ${lib.rootHandle ? esc(lib.rootHandle.name) + '/' : '<span class="dim">not connected</span>'}</p>
    </div>
    <div class="data-section">
      <h3>export</h3>
      <p>Download everything as one JSON file.</p>
      <button id="exportBtn">download json</button>
    </div>
    <div class="data-section">
      <h3>import</h3>
      <p>Replace current data with a JSON file you exported.</p>
      <input type="file" id="importFile" accept="application/json,.json">
    </div>
    <div class="data-section">
      <h3>reset</h3>
      <p>Wipe topics, sessions, entry-topic links. Cannot be undone.</p>
      <button id="resetBtn" class="ghost">reset all data</button>
    </div>`;
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ data, entryTopics }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `weel-${today()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#importFile').onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      if (!parsed.data || !parsed.data.topics) throw new Error('not a weel export');
      if (!confirm(`Replace current data with ${parsed.data.topics.length} topics and ${parsed.data.sessions.length} sessions?`)) return;
      data = { topics: parsed.data.topics, sessions: parsed.data.sessions, active_timer: parsed.data.active_timer || null };
      entryTopics = parsed.entryTopics || {};
      save(); saveEntryTopics(); location.hash = '#/topics'; render();
    } catch (e) { alert('Import failed: ' + e.message); }
  };
  $('#resetBtn').onclick = () => {
    if (!confirm('Delete ALL tracker data?') || !confirm('Really sure?')) return;
    data = { topics: [], sessions: [], active_timer: null }; entryTopics = {};
    save(); saveEntryTopics(); location.hash = '#/'; render();
  };
}

// global keys ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  // editor mod-key shortcuts: still work when textarea isn't focused (preview)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && _editorAPI) {
    if (e.key === '/' && _editorAPI.togglePreview) { e.preventDefault(); _editorAPI.togglePreview(); return; }
    if (e.key === 's' && _editorAPI.save) { e.preventDefault(); _editorAPI.save(); return; }
  }
  if (e.key === 'n') { e.preventDefault(); location.hash = '#/new-topic'; }
  else if (e.key === 't') {
    e.preventDefault();
    const h = location.hash || '';
    if (h.startsWith('#/read/')) toggleTimerForEntry(decodeURIComponent(h.slice('#/read/'.length)));
    else if (data.active_timer) stopTimer();
    else if (activeTopics().length === 1) startTimer(activeTopics()[0].id);
    else location.hash = '#/topics';
  }
  else if (e.key === 'r') {
    e.preventDefault();
    const files = [...lib.filesByPath.keys()];
    if (files.length === 0) { location.hash = '#/'; return; }
    const p = files[Math.floor(Math.random() * files.length)];
    location.hash = '#/read/' + encodeURIComponent(p);
  }
  else if (e.key === 'e') {
    const h = location.hash || '';
    if (h.startsWith('#/read/')) {
      const p = decodeURIComponent(h.slice('#/read/'.length));
      if (EDITABLE_EXTS.has(extOf(p))) { e.preventDefault(); location.hash = '#/edit-file/' + encodeURIComponent(p); }
    }
  }
  else if (e.key === '/') { const s = $('#fileSearch'); if (s) { e.preventDefault(); s.focus(); } }
  else if (e.key === 'Escape') { location.hash = '#/'; }
});

// boot ────────────────────────────────────────────────────────────
(async function boot() {
  load();
  await tryRestoreLib();
  render();
})();
