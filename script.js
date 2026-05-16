(async () => {
'use strict';

// ==================== UTILS & TOKENS ====================
const $1 = s => document.getElementById(s);
const on = (el, evt, cb, opts) => (typeof el === 'string' ? $1(el) : el)?.addEventListener(evt, cb, opts);
const off = (el, evt, cb) => (typeof el === 'string' ? $1(el) : el)?.removeEventListener(evt, cb);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = t => t ? String(t).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])) : '';

const padZero = n => n.toString().padStart(2, '0');
const getBackupName = () => { const d = new Date(); return `AIChatBackup-${d.getFullYear()}-${padZero(d.getMonth()+1)}${padZero(d.getDate())}-${padZero(d.getHours())}${padZero(d.getMinutes())}.json`; };

const estimateTokens = str => {
  if (!str) return 0;
  const zhCnt = (str.match(/[\u4e00-\u9fa5]/g) || []).length;
  return Math.ceil(zhCnt + (str.length - zhCnt) * 0.25);
};
const getMsgTokens = m => estimateTokens(m.content) + estimateTokens(m.reasoning);
const calcConvContextTokens = (c, p) => c.messages.reduce((t, m) => t + estimateTokens(m.content), estimateTokens(p));
const formatK = t => t < 1000 ? t : (t / 1000).toFixed(1) + 'k';

const DEFAULT_MODEL = 'deepseek-v4-pro', DEFAULT_GRP = 'default', DEFAULT_GM_URL = 'https://generativelanguage.googleapis.com';

// ==================== DATABASE ====================
const STORAGE_KEY = 'ai_chat_v8';
const IDB = {
  db: null,
  init: () => new Promise((resolve, reject) => {
    const req = indexedDB.open('AIChatDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('store');
    req.onsuccess = e => { IDB.db = e.target.result; resolve(); };
    req.onerror = e => reject(e.target.error);
  }),
  exec: (m, f, a) => new Promise((r, j) => {
    if (!IDB.db) return r(null);
    const req = IDB.db.transaction('store', m).objectStore('store')[f](...a);
    req.onsuccess = () => r(f === 'get' ? req.result : undefined);
    req.onerror = e => j(e.target.error);
  }),
  get: k => IDB.exec('readonly', 'get', [k]),
  set: (k, v) => IDB.exec('readwrite', 'put', [v, k])
};

// ==================== STATE & MODELS ====================
let state = {
  assistants: [{ id: 'default-ast', name: '全能助手', systemPrompt: '你是一个高通用性、严谨且富有协作精神的AI助手。你的核心目标不是扮演特定角色，而是动态适配用户的真实需求。', temperature: 1.0, topP: 1.0, modelId: DEFAULT_MODEL, reasoningEffort: 'off', groupId: DEFAULT_GRP, conversations: [], activeConvId: null }], 
  groups: [{ id: DEFAULT_GRP, name: '默认分组', expanded: true }], 
  activeAstId: null, deepseekKey: '', geminiKey: '', geminiBaseUrl: DEFAULT_GM_URL, geminiModels: 'gemini-2.5-pro, gemini-3.0-flash', darkMode: false, webdavUser: '', webdavToken: ''
};

let abortCtrl = null, streaming = false, editingMsg = null, userScrolledUp = false;

const svgIco = (n, c) => c ? `<img src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}-color.svg" style="width:1.2em; height:1.2em; vertical-align:middle;">` : `<span style="display:inline-block; width:1.1em; height:1.1em; background-color:currentColor; -webkit-mask:url('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}.svg') center/contain no-repeat; mask:url('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}.svg') center/contain no-repeat; vertical-align:middle;"></span>`;

const ICON_DS_COLOR = svgIco('deepseek', 1), ICON_DS_MONO = svgIco('deepseek', 0);
const ICON_GM_COLOR = svgIco('gemini', 1), ICON_GM_MONO = svgIco('gemini', 0);

const DS_MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', iconColor: ICON_DS_COLOR, iconMono: ICON_DS_MONO }, 
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', iconColor: ICON_DS_COLOR, iconMono: ICON_DS_MONO }
];

const getModelInfo = id => {
  const m = DS_MODELS.find(m => m.id === id); if (m) return m;
  const nid = (id || '').toLowerCase();
  if (nid.includes('gemini')) return { iconColor: ICON_GM_COLOR, iconMono: ICON_GM_MONO, name: id, custom: true };
  if (nid.includes('deepseek')) return { iconColor: ICON_DS_COLOR, iconMono: ICON_DS_MONO, name: id, custom: true };
  return { iconColor: '<i class="ph-fill ph-sparkle" style="color:var(--accent); vertical-align:middle;"></i>', iconMono: '<i class="ph-fill ph-sparkle" style="vertical-align:middle;"></i>', name: id, custom: true };
};
const isDeepSeek = id => DS_MODELS.some(m => m.id === id) || (id || '').toLowerCase().includes('deepseek');
const getCustomModels = () => (state.geminiModels || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadState() {
  try {
    let p = await IDB.get(STORAGE_KEY) || JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (p) {
      if (!p.groups?.length) p.groups = [{ id: DEFAULT_GRP, name: '默认分组', expanded: true }];
      state = { ...state, ...p }; await IDB.set(STORAGE_KEY, state);
    }
  } catch(e) {}
  state.assistants = state.assistants.map(fixAsst);
  
  // 确保底层状态绝不丢失全能助手
  if (state.assistants.length === 0) {
      state.assistants.push(fixAsst({ id: 'default-ast', name: '全能助手', systemPrompt: '你是一个高通用性、严谨且富有协作精神的AI助手。你的核心目标不是扮演特定角色，而是动态适配用户的真实需求。' }));
  }
}

let saveTimer = null;
const saveState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => IDB.set(STORAGE_KEY, state).catch(() => toast('存储失败')), 300); };

function fixAsst(a) {
  return {
    ...a, id: a.id || genId(), name: a.name || '未命名助手', systemPrompt: a.systemPrompt || '', 
    temperature: a.temperature ?? 1.0, topP: a.topP ?? 1.0, modelId: a.modelId || a.geminiModel || DEFAULT_MODEL, 
    reasoningEffort: a.reasoningEffort || 'off', groupId: a.groupId || DEFAULT_GRP,
    conversations: (a.conversations || []).map(c => ({ 
      ...c, id: c.id || genId(), title: c.title || '新话题', messages: (c.messages || []).map(m => ({ ...m, genTime: m.genTime || m.reasoningTime })) 
    }))
  };
}

const getActiveAst = () => state.assistants.find(a => a.id === state.activeAstId) || null;
const getActiveConv = (a = getActiveAst()) => a?.conversations.find(c => c.id === a.activeConvId) || null;
function ensureConv(a) {
  let c = getActiveConv(a);
  if (!c) { c = { id: genId(), title: '新话题', messages: [] }; a.conversations.unshift(c); a.activeConvId = c.id; saveState(); }
  return c;
}

function toast(m, d = 2500) {
  const t = $1('toast'); if(!t) return;
  t.innerHTML = m; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), d);
}

// ==================== COPY & DIALOG ====================
async function copyText(text) {
  try { if (navigator.clipboard) return await navigator.clipboard.writeText(text); } catch(e) {}
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(e) {} document.body.removeChild(ta);
}

function showDialog(msg, isInput = false, defaultVal = '') {
  return new Promise(resolve => {
    $1('dialog-msg').textContent = msg; const inp = $1('dialog-input');
    $1('dialog-input-wrap').classList.toggle('hidden', !isInput); inp.value = isInput ? defaultVal : '';
    $1('dialog-overlay').classList.add('show'); if (isInput) inp.focus();

    const cleanup = () => { $1('dialog-overlay').classList.remove('show'); off('dialog-ok', 'click', onOk); off('dialog-cancel', 'click', onCancel); off(inp, 'keydown', onKey); };
    const onOk = () => { cleanup(); resolve(isInput ? inp.value : true); }; 
    const onCancel = () => { cleanup(); resolve(isInput ? null : false); };
    const onKey = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    
    on('dialog-ok', 'click', onOk); on('dialog-cancel', 'click', onCancel); if (isInput) on(inp, 'keydown', onKey);
  });
}

function applyTheme() { 
  document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light'); 
  const ht = $1('hljs-theme'); if(ht) ht.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github${state.darkMode ? '-dark' : ''}.min.css`; 
}
function setupPWA() { if ('serviceWorker' in navigator) navigator.serviceWorker.register(URL.createObjectURL(new Blob([`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>self.clients.claim());`], { type: 'application/javascript' }))).catch(()=>{}); }

// ==================== NAVIGATION ====================
function goToChat(id, fromHistory = false) { 
  state.activeAstId = id; saveState(); 
  if (!fromHistory) history.pushState({ page: 'chat', id }, '');
  renderChatPage(); closeAll(); userScrolledUp = false; scrollBottom(true, false); 
}

// ==================== UI RENDERING ====================
function populateGroupSelect(defaultGid) { const sel = $1('new-ast-group'); if (sel) sel.innerHTML = state.groups.map(g => `<option value="${g.id}" ${g.id === defaultGid ? 'selected' : ''}>${esc(g.name)}</option>`).join(''); }

function renderAstList() {
  const l = $1('ast-list'); if(!l) return;
  if (!state.assistants.length && state.groups.length <= 1) return l.innerHTML = '<div class="empty"><i class="ph ph-ghost empty-icon"></i> 还没有助手，点击右上角 ＋ 创建</div>';
  l.innerHTML = state.groups.map(g => {
    const asts = state.assistants.filter(a => a.groupId === g.id);
    return `<div class="ast-group" data-gid="${g.id}"><div class="ast-group-header"><div class="ast-group-title"><i class="ph ph-caret-right arr ${g.expanded ? 'open' : ''}"></i> ${esc(g.name)} <span class="ast-group-count">(${asts.length})</span></div><div class="ast-group-actions"><button class="icon-btn add-to-group" title="添加到此分组"><i class="ph ph-plus"></i></button>${g.id !== DEFAULT_GRP ? `<button class="icon-btn group-more" title="分组操作"><i class="ph ph-dots-three-vertical"></i></button>` : ''}</div></div><div class="ast-group-list ${g.expanded ? 'open' : ''}">${asts.map(a => `<div class="ast-card" data-id="${a.id}"><div class="ast-info"><div class="ast-name">${esc(a.name)}</div><div class="ast-prompt">${esc(a.systemPrompt?.substring(0, 60))}${a.systemPrompt?.length > 60 ? '...' : ''}</div></div><button class="ast-more"><i class="ph ph-dots-three-vertical"></i></button></div>`).join('')}</div></div>`;
  }).join('');
}

function handleGroupMore(gid, btn) {
  showDropdown(btn, [{ label: '重命名分组', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '删除分组', value: 'delete', icon: '<i class="ph ph-trash"></i>' }], async val => {
    const g = state.groups.find(x => x.id === gid); if (!g) return;
    if (val === 'rename') { const name = await showDialog('重命名分组', true, g.name); if (name?.trim()) { g.name = name.trim(); saveState(); renderAstList(); } } 
    else if (val === 'delete' && await showDialog(`确定要删除【${g.name}】吗？\n如果该分组下有助手，将全部移至默认分组。`)) {
      state.assistants.forEach(a => { if (a.groupId === gid) a.groupId = DEFAULT_GRP; }); state.groups = state.groups.filter(x => x.id !== gid); state.groups.find(x => x.id === DEFAULT_GRP).expanded = true; saveState(); renderAstList();
    }
  });
}

function handleAstMore(id, btn) {
  const ast = state.assistants.find(a => a.id === id), groupAsts = state.assistants.filter(a => a.groupId === ast.groupId), idx = groupAsts.findIndex(a => a.id === id);
  const moveItems = state.groups.filter(g => g.id !== ast.groupId).map(g => ({ label: `移动到：${g.name}`, value: `move_${g.id}`, icon: '<i class="ph ph-folder-simple"></i>' }));
  const items = [...moveItems, ...(moveItems.length ? [{ isHeader: true, label: '操作' }] : []), { label: '删除助手', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  if (idx > 0) items.push({ label: '上移', value: 'order_up', icon: '<i class="ph ph-arrow-up"></i>' });
  if (idx < groupAsts.length - 1) items.push({ label: '下移', value: 'order_down', icon: '<i class="ph ph-arrow-down"></i>' });

  showDropdown(btn, items, async val => {
    if (val === 'delete' && await showDialog('确定要删除此助手吗？')) { 
      state.assistants = state.assistants.filter(a => a.id !== id); 
      if (state.activeAstId === id) { state.activeAstId = state.assistants[0]?.id; renderChatPage(); }
    } 
    else if (val === 'order_up' || val === 'order_down') { const tg = val === 'order_up' ? groupAsts[idx - 1] : groupAsts[idx + 1], i1 = state.assistants.indexOf(ast), i2 = state.assistants.indexOf(tg); [state.assistants[i1], state.assistants[i2]] = [state.assistants[i2], state.assistants[i1]]; } 
    else if (val.startsWith('move_')) { ast.groupId = val.replace('move_', ''); const tg = state.groups.find(g => g.id === ast.groupId); if (tg) tg.expanded = true; }
    saveState(); renderAstList();
  });
}

function renderChatPage() {
  let a = getActiveAst(); 
  if (!a && state.assistants.length > 0) {
      state.activeAstId = state.assistants[0].id;
      a = getActiveAst();
  }
  if (!a) return; 

  const c = getActiveConv(a), m = getModelInfo(a.modelId);
  const asstNameEl = $1('chat-asst-name'); if(asstNameEl) asstNameEl.innerHTML = `${esc(a.name)}${a.conversations.length ? ` <i class="ph ph-chat-centered-text" style="font-weight:normal; opacity:0.8; margin-left:4px;"></i> ${a.conversations.length}` : ''}`;
  const topicNameEl = $1('chat-topic-name'); if(topicNameEl) topicNameEl.textContent = c ? c.title : '新话题'; 
  const navTokensEl = $1('chat-nav-tokens'); if(navTokensEl) navTokensEl.textContent = `(${c ? c.messages.length : 0})`;
  const modelChipBtn = $1('model-chip-btn'); if(modelChipBtn) modelChipBtn.innerHTML = m.iconColor;
  const reasoningBtn = $1('reasoning-btn'); if(reasoningBtn) reasoningBtn.innerHTML = `<i class="ph ph-brain"></i><span>${{ off: '关闭', low: 'Low', high: 'High', max: 'Max' }[a.reasoningEffort] || a.reasoningEffort}</span>`;
  renderMessages();
}

if (window.markedKatex && window.marked) marked.use(window.markedKatex({ throwOnError: false }));
if (window.marked) marked.setOptions({ breaks: true, gfm: true });
const md = t => {
  if (!t) return '';
  const text = String(t).replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$').replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  try { return window.marked ? marked.parse(text) : esc(text).replace(/\n/g, '<br>'); } catch(e) { return esc(text).replace(/\n/g, '<br>'); }
};

function enhanceCodeBlocks(c) {
  c.querySelectorAll('pre:not(.code-block-wrapper pre)').forEach(pre => {
    if (pre.dataset.enhanced) return; pre.dataset.enhanced = '1';
    const code = pre.querySelector('code'), lang = code?.className.match(/language-([a-zA-Z0-9_\-]+)/)?.[1] || 'text';
    const wrapper = document.createElement('div'); wrapper.className = 'code-block-wrapper collapsed';
    wrapper.innerHTML = `<div class="code-block-header"><span class="code-lang">${lang}</span><div class="code-btns"><button class="code-btn copy-btn"><i class="ph ph-copy"></i> 复制</button><button class="code-btn fold-btn">展开</button></div></div>`;
    pre.replaceWith(wrapper); wrapper.appendChild(pre);
    on(wrapper.querySelector('.copy-btn'), 'click', e => { e.stopPropagation(); copyText((code || pre).textContent || '').then(() => { e.target.innerHTML = '<i class="ph ph-check"></i> 已复制'; setTimeout(() => e.target.innerHTML = '<i class="ph ph-copy"></i> 复制', 1200); }); });
    on(wrapper.querySelector('.fold-btn'), 'click', e => { e.stopPropagation(); e.target.textContent = wrapper.classList.toggle('collapsed') ? '展开' : '折叠'; });
    if (code && window.hljs) { try { hljs.highlightElement(code); } catch(e) {} }
  });
  c.querySelectorAll('table:not(.table-wrapper table)').forEach(t => { const w = document.createElement('div'); w.className = 'table-wrapper'; t.replaceWith(w); w.appendChild(t); });
}

function makeMsg(msg, idx) {
  const isAi = msg.role === 'assistant', d = document.createElement('div'); d.className = `msg ${isAi ? 'ai' : 'user'}`; d.dataset.index = idx;
  const rHTML = msg.reasoning ? `<div class="rblock"><button class="rhead"><span>${msg.isNote ? '<i class="ph ph-note-pencil"></i> 消息备注' : '<i class="ph ph-brain"></i> 思考过程'}</span><i class="ph ph-caret-right arr"></i></button><div class="rbody">${esc(msg.reasoning)}</div></div>` : '';
  const mInfo = getModelInfo(msg.modelId || getActiveAst()?.modelId);
  const acts = `<button data-a="cp"><i class="ph ph-copy"></i></button><button data-a="ed"><i class="ph ph-pencil-simple"></i></button><button data-a="del"><i class="ph ph-trash"></i></button><button data-a="re"><i class="ph ${isAi ? 'ph-arrows-clockwise' : 'ph-arrow-u-up-left'}"></i></button>`;
  d.innerHTML = `<div class="bubble">${rHTML}<div class="markdown-body">${md(msg.content)}</div></div><div class="msg-actions"><div class="actions-left">${isAi ? `<span class="badge">${mInfo.iconMono} ${esc(mInfo.name)}</span><span class="gen-time"><i class="ph ph-timer"></i> ${msg.genTime || (msg.startTime ? ((Date.now()-msg.startTime)/1000).toFixed(0) : '0')}s</span>` : ''}</div><div class="msg-tokens">${isAi ? '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg)) : ''}</div><div class="actions-right">${acts}</div></div>`;
  enhanceCodeBlocks(d); return d;
}

function renderMessages() {
  const msgs = $1('messages'); if(!msgs) return;
  const c = getActiveConv(); msgs.innerHTML = '';
  if (!c || !c.messages.length) return msgs.innerHTML = `<div class="welcome"><div class="emoji"><i class="ph-fill ph-sparkle"></i></div><h3>开始对话</h3><p>输入消息，点击发送按钮开始</p><div class="welcome-hints"><div class="welcome-hint" data-prompt="用简单的语言解释量子计算"><i class="ph ph-microscope"></i> 解释量子计算</div><div class="welcome-hint" data-prompt="写一首关于夏天的中国古诗"><i class="ph ph-pen-nib"></i> 写一首古诗</div><div class="welcome-hint" data-prompt="用Python写一个贪吃蛇游戏"><i class="ph ph-code"></i> 写贪吃蛇游戏</div><div class="welcome-hint" data-prompt="给我一个一周健身计划"><i class="ph ph-barbell"></i> 健身计划</div></div></div>`;
  c.messages.forEach((m, i) => msgs.appendChild(makeMsg(m, i)));
  setTimeout(updateDensityMap, 50);
}

// ==================== EDIT & TOPIC LIST ====================
function openEditModal(msg) { 
  editingMsg = msg; const ta = $1('edit-textarea'), rta = $1('edit-reasoning-textarea'), btn = $1('edit-toggle-reasoning-btn'), ov = $1('edit-overlay');
  if(!ta || !rta || !btn || !ov) return;
  ta.value = msg.content || ''; rta.value = msg.reasoning || '';
  const isNote = !msg.reasoning || msg.isNote;
  btn.innerHTML = isNote ? '<i class="ph ph-note-pencil"></i> 消息备注' : '<i class="ph ph-brain"></i> 思考过程';
  rta.placeholder = isNote ? '输入消息备注…' : '输入思考过程…';
  rta.classList.remove('show'); btn.classList.remove('active'); ov.classList.add('show'); 
}

function saveEdit() {
  if (!editingMsg) return;
  const val = $1('edit-textarea')?.value.trim() || '', rval = $1('edit-reasoning-textarea')?.value.trim() || '';
  if (!val && !rval) return toast('内容不能为空');
  editingMsg.content = val; editingMsg.reasoning = rval;
  if (rval && $1('edit-toggle-reasoning-btn')?.innerHTML.includes('备注')) editingMsg.isNote = true; else delete editingMsg.isNote;
  saveState(); renderChatPage(); $1('edit-overlay')?.classList.remove('show'); editingMsg = null; toast('<i class="ph-fill ph-check-circle"></i> 已保存');
}

function renderTopicList() {
  const a = getActiveAst(), l = $1('topic-list'), dtk = $1('drawer-total-tokens'); if(!l) return;
  if (!a || !a.conversations.length) { l.innerHTML = '<div class="empty">暂无话题</div>'; if(dtk) dtk.textContent = '0'; return; }
  let total = 0;
  l.innerHTML = a.conversations.map(c => {
    const tok = calcConvContextTokens(c, a.systemPrompt); total += tok;
    return `<div class="topic-item ${c.id === a.activeConvId ? 'active' : ''}" data-cid="${c.id}"><span><i class="ph ph-chat-teardrop-text"></i></span><div class="tinfo"><div class="ttitle-wrap"><div class="ttitle">${esc(c.title)}</div><span class="nav-tokens">${formatK(tok)}</span></div><div class="tmeta">${c.messages.length} 条消息</div></div><button class="ast-more topic-more"><i class="ph ph-dots-three-vertical"></i></button></div>`;
  }).join('');
  if(dtk) dtk.textContent = formatK(total);
}

function handleTopicMore(cid, btn) {
  const a = getActiveAst(), idx = a?.conversations.findIndex(c => c.id === cid); if (idx < 0) return; const conv = a.conversations[idx];
  const items = [{ label: '重命名话题', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '复制话题', value: 'copy', icon: '<i class="ph ph-copy"></i>' }, ...(idx > 0 ? [{ label: '上移', value: 'order_up', icon: '<i class="ph ph-arrow-up"></i>' }] : []), ...(idx < a.conversations.length - 1 ? [{ label: '下移', value: 'order_down', icon: '<i class="ph ph-arrow-down"></i>' }] : []), { label: '删除话题', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  showDropdown(btn, items, async val => {
    if (val === 'rename') { const nt = await showDialog('重命名话题', true, conv.title); if (nt?.trim() && nt.trim() !== conv.title) { conv.title = nt.trim(); saveState(); renderChatPage(); renderTopicList(); } }
    else if (val === 'copy') { const nc = JSON.parse(JSON.stringify(conv)); nc.id = genId(); nc.title += ' 副本'; a.conversations.splice(idx + 1, 0, nc); saveState(); renderTopicList(); toast('已复制话题'); }
    else if (val === 'order_up' || val === 'order_down') { const ti = val === 'order_up' ? idx - 1 : idx + 1; [a.conversations[idx], a.conversations[ti]] = [a.conversations[ti], a.conversations[idx]]; saveState(); renderTopicList(); }
    else if (val === 'delete' && await showDialog('确定要删除此话题吗？')) { a.conversations.splice(idx, 1); if (a.activeConvId === cid) a.activeConvId = a.conversations[0]?.id || null; saveState(); renderChatPage(); renderTopicList(); }
  });
}

function renderSettings() {
  const a = getActiveAst(), sBody = $1('settings-body'); if (!a || !sBody) return;
  sBody.innerHTML = `<div class="section"><div class="field"><label>助手名称</label><input type="text" id="s-name" value="${esc(a.name)}"></div><div class="field"><label>系统提示词</label><div class="relative"><textarea id="s-prompt" rows="4">${esc(a.systemPrompt)}</textarea><button id="s-prompt-fs-btn" class="icon-btn abs-top-right"><i class="ph ph-corners-out"></i></button></div></div><div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-sliders"></i> 高级参数 <i class="ph ph-caret-right arr"></i></button><div class="settings-fold-body"><div class="field"><label>Temperature：<strong id="s-tval">${a.temperature.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-temp" min="0" max="2" step=".05" value="${a.temperature}"><span class="slider-label">2</span></div></div><div class="field"><label>Top P：<strong id="s-pval">${a.topP.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-topp" min="0" max="1" step=".05" value="${a.topP}"><span class="slider-label">1</span></div></div></div></div></div><div class="section"><div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-cloud"></i> 坚果云 WebDAV 同步 <i class="ph ph-caret-right arr"></i></button><div class="settings-fold-body"><div class="field"><label>坚果云账号</label><input type="text" id="s-webdavUser" value="${esc(state.webdavUser || '')}" placeholder="坚果云登录邮箱"></div><div class="field"><label>应用密码</label><input type="password" id="s-webdavToken" value="${esc(state.webdavToken || '')}" placeholder="坚果云的第三方应用密码"></div><div class="data-actions"><button id="data-push"><i class="ph ph-cloud-arrow-up"></i> 推送</button><button id="data-pull"><i class="ph ph-cloud-arrow-down"></i> 拉取</button></div><div class="hint mt-8">注：已通过 Vercel 服务端代理解决跨域限制。</div></div></div></div><div class="section"><div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-plugs"></i> API 密钥与模型 <i class="ph ph-caret-right arr"></i></button><div class="settings-fold-body"><div class="field"><label>DeepSeek API Key</label><input type="password" id="s-dskey" value="${esc(state.deepseekKey)}"></div><div class="field"><label>第三方 API Key (Gemini)</label><input type="password" id="s-gmkey" value="${esc(state.geminiKey || '')}"></div><div class="field"><label>第三方 API 地址</label><input type="text" id="s-gmurl" value="${esc(state.geminiBaseUrl || DEFAULT_GM_URL)}"></div><div class="field"><label>第三方模型列表</label><input type="text" id="s-gmmodels" value="${esc(state.geminiModels || 'gemini-2.5-pro')}"></div></div></div></div><div class="section"><div class="t-row"><span id="theme-label">${state.darkMode ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'}</span><div class="tsw ${state.darkMode ? 'active' : ''}" id="s-theme"></div></div></div><div class="section"><div class="data-actions"><button id="data-export"><i class="ph ph-upload-simple"></i> 导出备份</button><button id="data-import-btn"><i class="ph ph-download-simple"></i> 导入备份</button></div></div><button class="btn-primary mt-8" id="s-save"><i class="ph ph-floppy-disk"></i> 保存设置</button>`;
}

async function mergeData(data, promptMsg) {
  if (!await showDialog(promptMsg)) return false;
  let newTopics = 0, updatedTopics = 0, newMessages = 0;

  for (const g of (data.groups || [])) if (!state.groups.some(x => x.id === g.id || x.name === g.name)) state.groups.push(g);
  for (const ia of (data.assistants || [])) {
    const fa = fixAsst(ia), lg = state.groups.find(g => g.id === fa.groupId || g.name === data.groups?.find(x=>x.id===fa.groupId)?.name);
    fa.groupId = lg ? lg.id : DEFAULT_GRP; const ex = state.assistants.find(a => a.id === fa.id || a.name === fa.name);
    if (ex) {
      for (const ic of fa.conversations) {
        const exConv = ex.conversations.find(c => c.id === ic.id || c.title === ic.title);
        if (exConv) {
          if (ic.messages.length > exConv.messages.length || (ic.messages.length === exConv.messages.length && JSON.stringify(ic.messages) !== JSON.stringify(exConv.messages))) {
            newMessages += Math.max(0, ic.messages.length - exConv.messages.length); updatedTopics++;
            exConv.messages = ic.messages; exConv.title = ic.title; if (exConv.id !== ic.id) exConv.id = ic.id; 
          }
        } else { ex.conversations.push(ic); newTopics++; newMessages += ic.messages.length; }
      }
      ex.conversations.sort((a, b) => b.id.localeCompare(a.id));
    } else { state.assistants.push(fa); newTopics += fa.conversations.length; newMessages += fa.conversations.reduce((s, c) => s + c.messages.length, 0); }
  }
  
  ['activeAstId', 'deepseekKey', 'geminiKey', 'geminiBaseUrl', 'geminiModels', 'darkMode', 'webdavUser', 'webdavToken'].forEach(k => { if (data[k] !== undefined && data[k] !== '') state[k] = data[k]; });
  saveState(); applyTheme(); renderAstList(); 
  
  if (!state.assistants.some(x => x.id === state.activeAstId)) state.activeAstId = state.assistants[0]?.id;
  renderChatPage(); closeAll(); 
  return { newTopics, updatedTopics, newMessages };
}

const getWebDAVAuth = () => { const u = $1('s-webdavUser')?.value.trim(), t = $1('s-webdavToken')?.value.trim(); if (!u || !t) { toast('请填写坚果云账号和应用密码'); return null; } state.webdavUser = u; state.webdavToken = t; saveState(); return 'Basic ' + btoa(`${u}:${t}`); };
const fetchDAV = (p, auth, m='GET', b=null, h={}) => fetch(`/webdav-proxy/AIChat/${p}`, { method: m, headers: { Authorization: auth, ...(b ? {'Content-Type': 'application/json'} : {}), ...h }, body: b ? JSON.stringify(b) : null });

on('import-file', 'change', e => {
  const file = e.target.files[0]; if (!file) return; const reader = new FileReader();
  reader.onload = async ev => { try { const d = JSON.parse(ev.target.result), st = await mergeData(d.data || d, '导入将深度合并数据，确认吗？'); if (st) toast(`导入成功：新增 ${st.newTopics} 话题，更新 ${st.updatedTopics} 话题，增补 ${st.newMessages} 消息`, 3500); } catch(err) { toast('文件格式错误'); } };
  reader.readAsText(file); e.target.value = '';
});

// ==================== DROPDOWNS ====================
let _ddActive = null, _ddAnchor = null;
function showDropdown(anchor, items, onSelect) {
  const dd = $1('dropdown-menu'); if(!dd) return;
  if (dd.classList.contains('show') && _ddAnchor === anchor) return hideDropdown();
  _ddAnchor = anchor;
  dd.innerHTML = items.map((item, i) => item.isHeader ? `<div class="dropdown-header">${item.label}</div>` : `<div class="dropdown-item ${item.selected ? 'selected' : ''}" data-idx="${i}">${item.icon || ''}<span>${item.label}</span>${item.selected ? '<i class="ph ph-check check"></i>' : ''}</div>`).join('');
  const r = anchor.getBoundingClientRect(), mh = dd.offsetHeight; let top = r.top - mh - 4 > 0 ? r.top - mh - 4 : r.bottom + 4; if (top + mh > window.innerHeight) top = window.innerHeight - mh - 10;
  dd.style.cssText = `top:${top}px; left:${Math.max(5, Math.min(r.left, window.innerWidth - dd.offsetWidth - 5))}px`; dd.classList.add('show');
  
  if (_ddActive) off(document, 'click', _ddActive);
  _ddActive = e => { if (e.target.closest('.dropdown-header')) return; const item = e.target.closest('.dropdown-item'); if (item) onSelect(items[item.dataset.idx].value); hideDropdown(); };
  setTimeout(() => on(document, 'click', _ddActive), 10);
}
const hideDropdown = () => { const dd = $1('dropdown-menu'); if (dd) dd.classList.remove('show'); if (_ddActive) off(document, 'click', _ddActive); _ddActive = _ddAnchor = null; };

// ==================== CHAT STREAM ====================
function updateScrollThumb() {
  const c = $1('chat-container'), t = $1('density-thumb'); if (!c || !t || c.scrollHeight <= 0) return;
  t.style.top = (c.scrollTop / c.scrollHeight) * 100 + '%'; t.style.height = Math.max((c.clientHeight / c.scrollHeight) * 100, 2) + '%';
}
function updateDensityMap() {
  const map = $1('density-map'), chatC = $1('chat-container'), msgs = $1('messages'); if (!map || !chatC || !msgs || chatC.scrollHeight <= 0) return;
  let dotsC = $1('density-dots'); if (!dotsC) { map.innerHTML = '<div id="density-dots"></div><div id="density-thumb"></div>'; dotsC = $1('density-dots'); }
  dotsC.innerHTML = Array.from(msgs.children).filter(m => m.classList.contains('ai')).map(m => `<div class="density-dot" data-idx="${m.dataset.index}" style="top:${(m.offsetTop / chatC.scrollHeight) * 100}%; height:${(m.offsetHeight / chatC.scrollHeight) * 100}%;" title="跳至此消息"></div>`).join('');
  updateScrollThumb();
}
const chatObserver = new ResizeObserver(() => requestAnimationFrame(updateDensityMap));
const chatC = $1('chat-container'); if (chatC) chatObserver.observe(chatC); if ($1('messages')) chatObserver.observe($1('messages'));

let isTouching = false; const setTouch = v => () => isTouching = v;
if(chatC) {
  ['touchstart','mousedown'].forEach(ev => on(chatC, ev, setTouch(true), { passive: true }));
  ['touchend','touchcancel','mouseup'].forEach(ev => window.addEventListener(ev, setTouch(false), { passive: true }));
  chatC.addEventListener('wheel', () => userScrolledUp = true, { passive: true });
  on(chatC, 'scroll', function() { updateScrollThumb(); const dist = this.scrollHeight - this.scrollTop - this.clientHeight; if (dist <= 25) userScrolledUp = false; else if (isTouching) userScrolledUp = true; $1('scroll-down')?.classList.toggle('show', dist > 200 && $1('messages').children.length > 1); });
}
const scrollBottom = (force, smooth = false) => { if (force || (!userScrolledUp && !isTouching)) requestAnimationFrame(() => chatC?.scrollTo({ top: chatC.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })); };

function updateLive(msgEl, msg) {
  if (!msgEl) return; const bub = msgEl.querySelector('.bubble'); if (!bub) return;
  if (msg.reasoning) { 
    let rb = bub.querySelector('.rblock'); if (!rb) { bub.insertAdjacentHTML('afterbegin', '<div class="rblock"><button class="rhead open"><span><i class="ph ph-brain"></i> 思考过程</span><i class="ph ph-caret-right arr"></i></button><div class="rbody open"></div></div>'); rb = bub.querySelector('.rblock'); }
    if (msg.content.length > 0 && !rb.dataset.autoClosed) { rb.querySelector('.rhead').classList.remove('open'); rb.querySelector('.rbody').classList.remove('open'); rb.dataset.autoClosed = '1'; }
    rb.querySelector('.rbody').textContent = msg.reasoning;
  }
  let mc = bub.querySelector('.markdown-body'); if (!mc) { bub.insertAdjacentHTML('beforeend', '<div class="markdown-body"></div>'); mc = bub.querySelector('.markdown-body'); }
  mc.innerHTML = md(msg.content); enhanceCodeBlocks(bub);
  const tk = msgEl.querySelector('.msg-tokens'); if (tk) tk.innerHTML = '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg));
}

function getApiConfig(a, c) {
  const msgs = c.messages.slice(0, -1);
  if (isDeepSeek(a.modelId)) {
    const body = { model: a.modelId, stream: true, messages: [{ role: 'system', content: a.systemPrompt }, ...msgs.map(m => ({ role: m.role, content: m.content }))] };
    Object.assign(body, a.reasoningEffort === 'off' ? { temperature: a.temperature, top_p: a.topP, thinking: { type: 'disabled' } } : { reasoning_effort: a.reasoningEffort, thinking: { type: 'enabled' } });
    return { url: 'https://api.deepseek.com/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.deepseekKey}` }, body };
  } else {
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': state.geminiKey };
    if (/^(sk-|Bearer )/.test(state.geminiKey)) headers['Authorization'] = state.geminiKey.startsWith('Bearer ') ? state.geminiKey : `Bearer ${state.geminiKey}`;
    const contents = msgs.reduce((acc, m) => {
      const parts = [...(m.thoughtSignatures || []).map(s => ({ thoughtSignature: s })), { text: m.content || ' ' }];
      if (acc.length && acc[acc.length - 1].role === (m.role === 'user' ? 'user' : 'model')) acc[acc.length - 1].parts.push(...parts); else acc.push({ role: m.role === 'user' ? 'user' : 'model', parts });
      return acc;
    }, []);
    const body = { contents, generationConfig: { temperature: a.temperature, topP: a.topP, thinkingConfig: a.reasoningEffort !== 'off' ? { includeThoughts: true, [a.modelId.includes('gemini-3') ? 'thinkingLevel' : 'thinkingBudget']: a.reasoningEffort === 'low' ? (a.modelId.includes('gemini-3') ? 'LOW' : 1024) : (a.modelId.includes('gemini-3') ? 'HIGH' : 8192) } : undefined } };
    if (a.systemPrompt) body.systemInstruction = { role: "system", parts: [{ text: a.systemPrompt }] };
    return { url: `${(state.geminiBaseUrl || DEFAULT_GM_URL).replace(/\/+$/, '')}/v1beta/models/${a.modelId}:streamGenerateContent?alt=sse`, headers, body };
  }
}

async function sendMessage() {
  if (streaming) return;
  const inputEl = $1('user-input'); if(!inputEl) return;
  const txt = inputEl.value.trim(), a = getActiveAst(); if (!txt || !a) return;
  if (isDeepSeek(a.modelId) ? !state.deepseekKey : !state.geminiKey) return toast('请先设置 API Key') || $1('settings-btn')?.click();
  inputEl.value = ''; inputEl.style.height = 'auto';
  const c = ensureConv(a); c.messages.push({ role: 'user', content: txt }); if (c.title === '新话题') c.title = txt.substring(0, 28) + (txt.length > 28 ? '…' : '');
  userScrolledUp = false; renderMessages(); scrollBottom(true, true);
  
  const am = { role: 'assistant', content: '', reasoning: '', genTime: null, modelId: a.modelId, startTime: Date.now() }; c.messages.push(am);
  saveState(); renderMessages(); streaming = true; $1('send-btn')?.classList.add('hidden'); inputEl.disabled = true; $1('stop-btn')?.classList.remove('hidden'); const nTk = $1('chat-nav-tokens'); if(nTk) nTk.textContent = `(${c.messages.length})`;

  const activeMsgEl = $1('messages')?.lastElementChild; abortCtrl = new AbortController(); 
  let genTimer = setInterval(() => { const el = activeMsgEl?.querySelector('.gen-time'); if (el) el.innerHTML = `<i class="ph ph-timer"></i> ${((Date.now() - am.startTime) / 1000).toFixed(0)}s`; }, 1000);
  
  try {
    const { url, headers, body } = getApiConfig(a, c), resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abortCtrl.signal });
    if (!resp.ok) throw new Error((await resp.json().catch(()=>{})).error?.message || `HTTP ${resp.status}`);
    const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
      for (let t of lines) {
        if (!t.trim() || !t.startsWith('data: ') || t.slice(6) === '[DONE]') continue;
        try {
          const chunk = JSON.parse(t.slice(6));
          if (!isDeepSeek(a.modelId)) {
            for (const p of (chunk.candidates?.[0]?.content?.parts || [])) {
              if (p.thoughtSignature || p.thought_signature) (am.thoughtSignatures ??= []).push(p.thoughtSignature || p.thought_signature);
              if (String(p.thought) === "true") am.reasoning += (p.text || ''); else if (p.text) am.content += p.text;
            }
          } else { const d = chunk.choices?.[0]?.delta; if (d?.reasoning_content) am.reasoning += d.reasoning_content; if (d?.content) am.content += d.content; }
          if(nTk) nTk.textContent = `(${c.messages.length})`; updateLive(activeMsgEl, am); scrollBottom(false, false);
        } catch(e) {}
      }
    }
  } catch (err) { if (err.name !== 'AbortError') am.content = am.content || `❌ 错误：${err.message}`; }
  finally { streaming = false; abortCtrl = null; clearInterval(genTimer); am.genTime = ((Date.now() - am.startTime) / 1000).toFixed(0); delete am.startTime; saveState(); renderChatPage(); $1('send-btn')?.classList.remove('hidden'); inputEl.disabled = false; $1('stop-btn')?.classList.add('hidden'); }
}

const openSheet = id => { 
  closeDrawers(); 
  $1('overlay')?.classList.add('show'); 
  $1(id)?.classList.add('open'); 
  if (!history.state?.drawer) history.pushState({ ...history.state, drawer: true }, '');
};
const closeDrawers = () => document.querySelectorAll('.drawer, .sheet, .topics-modal').forEach(el => el.classList.remove('open'));
const closeAll = (fromPopState = false) => { 
  hideDropdown(); 
  const wasOpen = $1('overlay')?.classList.contains('show');
  $1('overlay')?.classList.remove('show'); 
  $1('sheet-overlay')?.classList.remove('show');
  closeDrawers(); 
  if (wasOpen && !fromPopState && history.state?.drawer) {
    ignoreNextPopState = true;
    history.back();
  }
};

// ==================== FS PROMPT EDITOR LOGIC ====================
let vditorInstance = null, fsPromptOriginalValue = '', fsPromptChanged = false, isFsPromptRawMode = false, ignoreNextPopState = false;

async function handleFsPromptClose(fromPopState = false) {
  const currentVal = isFsPromptRawMode ? $1('fs-prompt-raw-textarea').value : (vditorInstance ? vditorInstance.getValue() : '');
  
  if (currentVal.trim() !== fsPromptOriginalValue.trim()) {
    if (await showDialog('有未保存的修改，是否保存？')) {
      const sp = $1('s-prompt'); if (sp) { sp.value = currentVal; $1('s-save')?.click(); }
    }
  }
  
  $1('fs-prompt-overlay')?.classList.remove('show'); 
  fsPromptChanged = false;
  if (!fromPopState && history.state?.page === 'fs-prompt') { ignoreNextPopState = true; history.back(); }
}
document.addEventListener('input', e => { if (e.target.id === 'fs-prompt-raw-textarea') fsPromptChanged = true; });

// ==================== GLOBAL EVENT DELEGATION (Optimized) ====================
document.addEventListener('click', async e => {
  const get = sel => e.target.closest(sel);
  let el;

  // 1. Navigation & Modals
  if ((el = get('#ast-drawer-btn'))) openSheet('ast-drawer');
  else if ((el = get('#topic-toggle'))) { e.stopPropagation(); renderTopicList(); openSheet('topics-drawer'); }
  else if ((el = get('#settings-btn'))) { renderSettings(); openSheet('settings-drawer'); }
  else if ((el = get('#close-settings')) || get('#overlay')) closeAll();
  else if ((el = get('#sheet-overlay'))) { el.classList.remove('show'); $1('add-ast-sheet')?.classList.remove('open'); }

  // 2. Chat Input Controls
  else if ((el = get('#send-btn'))) sendMessage();
  else if ((el = get('#stop-btn'))) abortCtrl?.abort();
  else if ((el = get('#scroll-down'))) { userScrolledUp = false; scrollBottom(true, false); }
  else if ((el = get('#model-chip-btn'))) {
    if (streaming) return toast('生成中不可切换模型'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    showDropdown(el, [{ isHeader: true, label: 'DeepSeek 模型' }, ...DS_MODELS.map(m => ({ label: m.name, value: m.id, selected: a.modelId === m.id, icon: m.iconColor })), { isHeader: true, label: '第三方 API 模型' }, ...getCustomModels().map(n => ({ label: n, value: n, selected: a.modelId === n, icon: getModelInfo(n).iconColor }))], id => {
      a.modelId = id; const v = isDeepSeek(id) ? ['off', 'high', 'max'] : ['off', 'low', 'high']; if (!v.includes(a.reasoningEffort)) a.reasoningEffort = 'off'; saveState(); renderChatPage(); toast('已切换模型');
    });
  }
  else if ((el = get('#reasoning-btn'))) {
    if (streaming) return toast('生成中不可切换推理设置'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    const rOpts = isDeepSeek(a.modelId) ? [{label: '关闭', value: 'off'}, {label: 'High', value: 'high'}, {label: 'Max', value: 'max'}] : [{label: '关闭', value: 'off'}, {label: 'Low', value: 'low'}, {label: 'High', value: 'high'}];
    showDropdown(el, rOpts.map(o => ({ label: o.label, value: o.value, selected: a.reasoningEffort === o.value, icon: '<i class="ph ph-brain"></i>' })), val => { a.reasoningEffort = val; saveState(); renderChatPage(); });
  }

  // 3. Ast List Interactions
  else if ((el = get('#add-group-btn'))) { const name = await showDialog('请输入新建分组名称', true); if (name?.trim()) { state.groups.push({ id: genId(), name: name.trim(), expanded: true }); saveState(); renderAstList(); toast('<i class="ph-fill ph-check-circle"></i> 已创建分组'); } }
  else if ((el = get('#add-ast-btn'))) { populateGroupSelect(DEFAULT_GRP); $1('sheet-overlay')?.classList.add('show'); $1('add-ast-sheet')?.classList.add('open'); }
  else if ((el = get('#create-ast'))) {
    const n = $1('new-ast-name')?.value.trim(); if (!n) return toast('<i class="ph ph-warning-circle"></i> 请输入名称');
    const gid = $1('new-ast-group')?.value || DEFAULT_GRP;
    state.assistants.unshift({ id: genId(), name: n, systemPrompt: $1('new-ast-prompt')?.value.trim(), temperature: 1.0, topP: 1.0, modelId: DEFAULT_MODEL, reasoningEffort: 'off', groupId: gid, conversations:[], activeConvId: null });
    const tg = state.groups.find(g => g.id === gid); if (tg) tg.expanded = true; saveState(); closeAll(); renderAstList(); $1('new-ast-name').value = ''; toast('<i class="ph-fill ph-check-circle"></i> 已创建');
  }
  else if ((el = get('#ast-list'))) {
    const gh = get('.ast-group-header');
    if (gh) {
      const gid = gh.parentElement.dataset.gid;
      if (get('.add-to-group')) { e.stopPropagation(); populateGroupSelect(gid); $1('sheet-overlay')?.classList.add('show'); return $1('add-ast-sheet')?.classList.add('open'); }
      if (get('.group-more')) { e.stopPropagation(); return handleGroupMore(gid, get('.group-more')); }
      const g = state.groups.find(x => x.id === gid); if (g) { g.expanded = !g.expanded; saveState(); renderAstList(); }
      return;
    }
    const card = get('.ast-card'); if (!card) return;
    if (get('.ast-more')) { e.stopPropagation(); return handleAstMore(card.dataset.id, get('.ast-more')); }
    goToChat(card.dataset.id);
  }

  // 4. Topics Modal
  else if ((el = get('#topic-list'))) {
    const a = getActiveAst(), item = get('.topic-item'); if (!a || !item) return;
    if ((el = get('.topic-more'))) return handleTopicMore(item.dataset.cid, el);
    a.activeConvId = item.dataset.cid; saveState(); closeAll(); renderChatPage(); renderTopicList(); userScrolledUp = false; scrollBottom(true, false);
  }
  else if ((el = get('#new-topic'))) { const a = getActiveAst(); if (a) { a.activeConvId = null; saveState(); closeAll(); renderChatPage(); userScrolledUp = false; scrollBottom(true, false); } }

  // 5. Messages
  else if ((el = get('.density-dot'))) {
    const tg = $1('messages')?.querySelector(`.msg[data-index="${el.dataset.idx}"]`);
    if (tg) { $1('chat-container').scrollTo({ top: tg.offsetTop - 14, behavior: 'smooth' }); userScrolledUp = true; }
  }
  else if ((el = get('#messages'))) {
    const btn = get('button[data-a]'), hint = get('.welcome-hint'), rhead = get('.rhead');
    if (hint) { const uinp = $1('user-input'); if(uinp) uinp.value = hint.dataset.prompt; return sendMessage(); }
    if (rhead) { rhead.classList.toggle('open'); rhead.nextElementSibling?.classList.toggle('open'); return; }
    if (btn) {
      e.stopPropagation(); const act = btn.dataset.a, idx = parseInt(btn.closest('.msg').dataset.index, 10), conv = getActiveConv(), msg = conv.messages[idx];
      if (act === 'cp') return copyText(msg.content).then(() => toast('<i class="ph-fill ph-check-circle"></i> 已复制'));
      if (streaming) return toast('<i class="ph-fill ph-warning-circle"></i> 生成中不可操作');
      if (act === 'ed') openEditModal(msg);
      else if (act === 'del' && await showDialog('确定要删除这条消息吗？')) { conv.messages.splice(idx, 1); saveState(); renderChatPage(); }
      else if (act === 're' && await showDialog(`确定要重新${msg.role === 'assistant' ? '生成此回复' : '发送这条消息'}吗？`)) {
        let tIdx = idx; if (msg.role === 'assistant') { while (tIdx >= 0 && conv.messages[tIdx].role !== 'user') tIdx--; if (tIdx < 0) return toast('无法重新生成：缺用户消息'); }
        const uinp = $1('user-input'); if(uinp){ uinp.value = conv.messages[tIdx].content; uinp.dispatchEvent(new Event('input')); }
        conv.messages = conv.messages.slice(0, tIdx); saveState(); renderChatPage(); sendMessage();
      }
    }
  }

  // 6. Settings interactions
  else if ((el = get('#settings-body'))) {
    const btn = s => get(s);
    if (btn('#data-export')) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ _meta: { version: 10, date: new Date().toISOString() }, data: state }, null, 2)], { type: 'application/json' })); a.download = getBackupName(); a.click(); toast('已导出备份'); } 
    else if (btn('#data-import-btn')) $1('import-file')?.click();
    else if (btn('#data-push')) {
      const auth = getWebDAVAuth(); if (!auth) return; toast('<i class="ph ph-hourglass"></i> 正在同步...');
      const name = getBackupName(), data = { _meta: { version: 10, date: new Date().toISOString() }, data: state };
      fetchDAV(name, auth, 'PUT', data).then(async res => { 
        if(!(res.ok || res.status === 201 || res.status === 204)) throw new Error(`${res.status} [${(await res.text()).toLowerCase().includes('vercel') ? 'Vercel代理未生效' : '被拒绝'}]`);
        let idx = []; try { const r = await fetchDAV('backup_index.json', auth); if (r.ok) idx = await r.json(); } catch(e) {}
        if (!Array.isArray(idx)) idx = []; if (!idx.includes(name)) { idx.unshift(name); await fetchDAV('backup_index.json', auth, 'PUT', idx); }
        toast('<i class="ph-fill ph-check-circle"></i> 同步至云端成功');
      }).catch(err => toast(`<i class="ph-fill ph-warning-circle"></i> 上传失败: ${err.message}`, 4000));
    }
    else if (btn('#data-pull')) {
      const auth = getWebDAVAuth(), pullBtn = btn('#data-pull'); if (!auth) return; toast('<i class="ph ph-hourglass"></i> 正在获取列表...');
      fetchDAV('backup_index.json', auth, 'GET', null, { 'Cache-Control': 'no-cache, no-store, must-revalidate' }).then(async res => { 
        if(!res.ok) throw new Error(`${res.status} [${res.status===404 ? '暂无索引，请先推送' : '获取失败'}]`); return res.json(); 
      }).then(async files => {
        if (!Array.isArray(files) || !files.length) throw new Error('云端备份列表为空'); toast('<i class="ph ph-hourglass"></i> 校验真实性...');
        const valids = (await Promise.all(files.map(async f => { try { return (await fetchDAV(f, auth, 'HEAD', null, { 'Cache-Control': 'no-cache' })).ok ? f : null; } catch(e) { return null; } }))).filter(Boolean);
        if (!valids.length) throw new Error('云端备份实际已被删除，请重新推送');
        if (valids.length < files.length) fetchDAV('backup_index.json', auth, 'PUT', valids).catch(()=>{});
        
        showDropdown(pullBtn, [{ isHeader: true, label: '选择拉取的云端备份' }, ...valids.map(f => ({ label: f, value: f, icon: '<i class="ph ph-file-json"></i>' }))], async val => {
          toast(`<i class="ph ph-hourglass"></i> 正在拉取...`);
          try { 
            const r = await fetchDAV(val, auth, 'GET', null, { 'Cache-Control': 'no-cache' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); 
            const json = await r.json(), stats = await mergeData(json.data || json, '确认拉取并深度合并吗？'); 
            if (stats) toast(`拉取成功：新增 ${stats.newTopics} 话题，更新 ${stats.updatedTopics} 话题，增补 ${stats.newMessages} 消息`, 3500); 
          } catch(err) { toast(`<i class="ph-fill ph-warning-circle"></i> 解析失败: ${err.message}`); }
        });
      }).catch(err => toast(`<i class="ph-fill ph-warning-circle"></i> 拉取失败: ${err.message}`, 4000));
    }
    else if (btn('#s-save')) {
      const a = getActiveAst(), val = id => $1(id)?.value; if (!a) return;
      a.name = val('s-name')?.trim() || a.name; a.systemPrompt = val('s-prompt')?.trim() ?? a.systemPrompt; a.temperature = parseFloat(val('s-temp') || a.temperature); a.topP = parseFloat(val('s-topp') || a.topP);
      ['dskey:deepseekKey', 'gmkey:geminiKey', 'gmurl:geminiBaseUrl', 'webdavUser:webdavUser', 'webdavToken:webdavToken'].forEach(k => { const[id, sk]=k.split(':'); state[sk] = val('s-'+id)?.trim() ?? state[sk]; });
      state.geminiModels = val('s-gmmodels')?.trim() || 'gemini-2.5-pro'; state.darkMode = $1('s-theme')?.classList.contains('active') || false;
      saveState(); applyTheme(); renderChatPage(); renderAstList(); closeAll(); toast('设置已保存');
    } else {
      const head = btn('.settings-fold-head'); if (head) head.parentElement.classList.toggle('open');
      const themeSw = btn('#s-theme'); if (themeSw) { themeSw.classList.toggle('active'); const tl = $1('theme-label'); if(tl) tl.innerHTML = themeSw.classList.contains('active') ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'; }
      if (btn('#s-prompt-fs-btn')) { 
        fsPromptOriginalValue = $1('s-prompt')?.value || ''; fsPromptChanged = false; isFsPromptRawMode = false;
        const toggleBtn = $1('fs-prompt-toggle-mode'); if (toggleBtn) { toggleBtn.innerHTML = '<i class="ph ph-file-text"></i>'; toggleBtn.title = '纯文本模式'; }
        $1('fs-prompt-raw-textarea')?.classList.add('hidden'); $1('fs-prompt-vditor')?.classList.remove('hidden'); $1('fs-prompt-overlay')?.classList.add('show'); history.pushState({ page: 'fs-prompt' }, '');
        if (!window.Vditor) return toast('<i class="ph ph-hourglass"></i> 编辑器加载中...');
        if (!vditorInstance) {
            vditorInstance = new Vditor('fs-prompt-vditor', { mode: 'ir', height: '100%', cache: { enable: false }, value: fsPromptOriginalValue, theme: state.darkMode ? 'dark' : 'classic', icon: 'material', toolbar: ['undo', 'redo'], input: () => { fsPromptChanged = true; } });
        } else { vditorInstance.setValue(fsPromptOriginalValue); vditorInstance.setTheme(state.darkMode ? 'dark' : 'classic', state.darkMode ? 'dark' : 'light'); }
      }
    }
  }

  // 7. Fullscreen Prompt Custom Toolbar
  else if ((el = get('.prompt-toolbar'))) {
    if ((el = get('#fs-prompt-toggle-mode'))) {
      const rawTa = $1('fs-prompt-raw-textarea'), vdContainer = $1('fs-prompt-vditor'); isFsPromptRawMode = !isFsPromptRawMode;
      if (isFsPromptRawMode) { rawTa.value = vditorInstance ? vditorInstance.getValue() : ''; vdContainer.classList.add('hidden'); rawTa.classList.remove('hidden'); el.innerHTML = '<i class="ph ph-markdown-logo"></i>'; el.title = 'Markdown模式'; } 
      else { if (vditorInstance) vditorInstance.setValue(rawTa.value); rawTa.classList.add('hidden'); vdContainer.classList.remove('hidden'); el.innerHTML = '<i class="ph ph-file-text"></i>'; el.title = '纯文本模式'; }
      return;
    }
    const btn = get('button[data-md]'); 
    if (btn) { 
      const action = btn.dataset.md;
      if (isFsPromptRawMode) { $1('fs-prompt-raw-textarea').focus(); document.execCommand(action); } 
      else if (vditorInstance) { const b = document.querySelector(`#fs-prompt-vditor button[data-type="${action}"]`); if (b) b.click(); else document.execCommand(action); }
    } 
  }
  else if ((el = get('#fs-prompt-save'))) { 
    const sp = $1('s-prompt'); 
    if (sp) { 
      const newVal = isFsPromptRawMode ? $1('fs-prompt-raw-textarea').value : (vditorInstance ? vditorInstance.getValue() : sp.value);
      sp.value = newVal; 
      fsPromptOriginalValue = newVal; // 同步最新的基准值
      setTimeout(() => fsPromptChanged = false, 50); // 稍微延迟重置，覆盖掉编辑器失焦产生的多余 input 事件
      $1('s-save')?.click(); 
    } 
  }
  else if ((el = get('#fs-prompt-close'))) handleFsPromptClose();
  
  // 8. Edit Msg Modal
  else if ((el = get('#edit-cancel-btn'))) { $1('edit-overlay')?.classList.remove('show'); editingMsg = null; }
  else if ((el = get('#edit-save-btn'))) saveEdit();
  else if ((el = get('#edit-toggle-reasoning-btn'))) { const rta = $1('edit-reasoning-textarea'); if(rta) { const isActive = rta.classList.toggle('show'); el.classList.toggle('active', isActive); if(isActive) rta.focus(); } }

}); // END Document Click

const userInput = $1('user-input');
if(userInput) {
  on(userInput, 'keydown', function(e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); } });
  on(userInput, 'input', function() { this.style.height = 'auto'; this.style.height = `${Math.min(this.scrollHeight, 220)}px`; });
}

await IDB.init().catch(()=>{}); 
await loadState(); 
setupPWA(); 
applyTheme(); 

// Ensure application defaults into the core Chat experience reliably.
if (!state.activeAstId || !state.assistants.some(a => a.id === state.activeAstId)) {
    state.activeAstId = state.assistants[0]?.id || 'default-ast';
}

renderAstList(); 
saveState(); 
history.replaceState({ page: 'chat', id: state.activeAstId }, '');
renderChatPage();

window.addEventListener('popstate', async e => { 
  if (ignoreNextPopState) return ignoreNextPopState = false;
  if ($1('fs-prompt-overlay')?.classList.contains('show')) return handleFsPromptClose(true);
  
  // 拦截设备的物理返回按键：如果存在抽屉或弹窗则仅仅关闭弹窗
  if ($1('overlay')?.classList.contains('show')) { closeAll(true); return; }
  
  closeAll(true); 
  
  if (e.state?.page === 'chat' && e.state.id) { 
      state.activeAstId = e.state.id;
  }
  renderChatPage(); 
});
})();