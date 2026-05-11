(async () => {
'use strict';

// ==================== UTILS & TOKENS ====================
const $1 = s => document.getElementById(s);
const on = (el, evt, cb) => (typeof el === 'string' ? $1(el) : el)?.addEventListener(evt, cb);
const off = (el, evt, cb) => (typeof el === 'string' ? $1(el) : el)?.removeEventListener(evt, cb);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = t => t ? String(t).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])) : '';

const estimateTokens = str => {
  if (!str) return 0;
  const zhCnt = (str.match(/[\u4e00-\u9fa5]/g) ||[]).length;
  return Math.ceil(zhCnt + (str.length - zhCnt) * 0.25);
};
const getMsgTokens = m => estimateTokens(m.content) + estimateTokens(m.reasoning);
const calcConvContextTokens = (c, p) => c.messages.reduce((t, m) => t + estimateTokens(m.content), estimateTokens(p));
const formatK = t => t < 1000 ? t : (t / 1000).toFixed(1) + 'k';

// ==================== DATABASE (IndexedDB) ====================
const STORAGE_KEY = 'ai_chat_v8';
const IDB = {
  db: null,
  init: () => new Promise((resolve, reject) => {
    const req = indexedDB.open('AIChatDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('store');
    req.onsuccess = e => { IDB.db = e.target.result; resolve(); };
    req.onerror = e => reject(e.target.error);
  }),
  exec: (mode, action) => new Promise((resolve, reject) => {
    if (!IDB.db) return resolve(null);
    const req = IDB.db.transaction('store', mode).objectStore('store')[action.method](...action.args);
    req.onsuccess = () => resolve(action.method === 'get' ? req.result : undefined);
    req.onerror = e => reject(e.target.error);
  }),
  get: key => IDB.exec('readonly', { method: 'get', args: [key] }),
  set: (key, val) => IDB.exec('readwrite', { method: 'put', args: [val, key] })
};

// ==================== STATE & MODELS ====================
let state = {
  assistants:[{ id: 'default-ast', name: '全能助手', systemPrompt: '你是一个高通用性、严谨且富有协作精神的AI助手。你的核心目标不是扮演特定角色，而是动态适配用户的真实需求。', temperature: 1.0, topP: 1.0, modelId: 'deepseek-v4-pro', reasoningEffort: 'off', groupId: 'default', conversations: [], activeConvId: null }], 
  groups: [{ id: 'default', name: '默认分组', expanded: true }], 
  activeAstId: null, deepseekKey: '', geminiKey: '', geminiBaseUrl: 'https://generativelanguage.googleapis.com', geminiModels: 'gemini-2.5-pro, gemini-3.0-flash', darkMode: false
};

let abortCtrl = null, streaming = false, editingMsg = null, userScrolledUp = false;
const DS_MODELS =[{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', icon: '<i class="ph-fill ph-diamond"></i>' }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', icon: '<i class="ph-fill ph-lightning"></i>' }];

const getModelInfo = id => DS_MODELS.find(m => m.id === id) || { icon: '<i class="ph-fill ph-sparkle"></i>', name: id, custom: true };
const isDeepSeek = id => DS_MODELS.some(m => m.id === id) || (id || '').toLowerCase().includes('deepseek');
const getCustomModels = () => (state.geminiModels || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadState() {
  try {
    let p = await IDB.get(STORAGE_KEY) || JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (p) {
      if (!p.groups?.length) p.groups =[{ id: 'default', name: '默认分组', expanded: true }];
      state = { ...state, ...p };
      await IDB.set(STORAGE_KEY, state);
    }
  } catch(e) {}
  state.assistants = state.assistants.map(fixAsst);
}

let saveTimer = null;
const saveState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => IDB.set(STORAGE_KEY, state).catch(() => toast('存储失败')), 300); };

function fixAsst(a) {
  return {
    ...a, id: a.id || genId(), name: a.name || '未命名助手', systemPrompt: a.systemPrompt || '', 
    temperature: a.temperature ?? 1.0, topP: a.topP ?? 1.0, modelId: a.modelId || a.geminiModel || 'deepseek-v4-pro', 
    reasoningEffort: a.reasoningEffort || 'off', groupId: a.groupId || 'default',
    conversations: (a.conversations ||[]).map(c => ({ 
      ...c, id: c.id || genId(), title: c.title || '新话题', 
      messages: (c.messages ||[]).map(m => ({ ...m, genTime: m.genTime || m.reasoningTime })) 
    }))
  };
}

const getActiveAst = () => state.assistants.find(a => a.id === state.activeAstId) || null;
const getActiveConv = (a = getActiveAst()) => a?.conversations.find(c => c.id === a.activeConvId) || null;
function ensureConv(a) {
  let c = getActiveConv(a);
  if (!c) { c = { id: genId(), title: '新话题', messages:[] }; a.conversations.unshift(c); a.activeConvId = c.id; saveState(); }
  return c;
}

function toast(m, d = 2000) {
  const t = $1('toast'); t.innerHTML = m; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), d);
}

// ==================== COPY & DIALOG (合并 Prompt/Confirm) ====================
async function copyText(text) {
  try { if (navigator.clipboard) return await navigator.clipboard.writeText(text); } catch(e) {}
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(e) {} document.body.removeChild(ta);
}

function showDialog(msg, isInput = false, defaultVal = '') {
  return new Promise(resolve => {
    $1('dialog-msg').textContent = msg;
    const inp = $1('dialog-input');
    $1('dialog-input-wrap').classList.toggle('hidden', !isInput);
    inp.value = isInput ? defaultVal : '';
    $1('dialog-overlay').classList.add('show');
    if (isInput) inp.focus();

    const cleanup = () => { $1('dialog-overlay').classList.remove('show'); off('dialog-ok', 'click', onOk); off('dialog-cancel', 'click', onCancel); off(inp, 'keydown', onKey); };
    const onOk = () => { cleanup(); resolve(isInput ? inp.value : true); }; 
    const onCancel = () => { cleanup(); resolve(isInput ? null : false); };
    const onKey = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    
    on('dialog-ok', 'click', onOk); on('dialog-cancel', 'click', onCancel);
    if (isInput) on(inp, 'keydown', onKey);
  });
}

// ==================== THEME & PWA ====================
function setupPWA() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(URL.createObjectURL(new Blob([`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>self.clients.claim());self.addEventListener('fetch',e=>{});`], { type: 'application/javascript' }))).catch(()=>{});
}
function applyTheme() {
  const d = state.darkMode; document.documentElement.setAttribute('data-theme', d ? 'dark' : 'light');
  $1('hljs-theme').href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github${d ? '-dark' : ''}.min.css`;
}

// ==================== NAVIGATION ====================
function goToAsts(fromHistory = false) { 
  if (!fromHistory && window.history.state?.page === 'chat') return window.history.back();
  $1('ast-page').classList.add('active'); $1('chat-page').classList.remove('active'); renderAstList(); 
}
function goToChat(id, fromHistory = false) { 
  state.activeAstId = id; saveState(); 
  if (!fromHistory) history.pushState({ page: 'chat', id }, '');
  $1('ast-page').classList.remove('active'); $1('chat-page').classList.add('active'); 
  renderChatPage(); closeAll(); userScrolledUp = false; scrollBottom(true, false); 
}

// ==================== ASSISTANT LIST ====================
function populateGroupSelect(defaultGid) {
  const sel = $1('new-ast-group');
  if (sel) sel.innerHTML = state.groups.map(g => `<option value="${g.id}" ${g.id === defaultGid ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
}

function renderAstList() {
  const l = $1('ast-list');
  if (!state.assistants.length && state.groups.length <= 1) return l.innerHTML = '<div class="empty"><i class="ph ph-ghost empty-icon"></i> 还没有助手，点击右上角 ＋ 创建</div>';
  l.innerHTML = state.groups.map(g => {
    const asts = state.assistants.filter(a => a.groupId === g.id);
    return `<div class="ast-group" data-gid="${g.id}">
      <div class="ast-group-header">
        <div class="ast-group-title"><i class="ph ph-caret-right arr ${g.expanded ? 'open' : ''}"></i> ${esc(g.name)} <span class="ast-group-count">(${asts.length})</span></div>
        <div class="ast-group-actions"><button class="icon-btn add-to-group" title="添加到此分组"><i class="ph ph-plus"></i></button>${g.id !== 'default' ? `<button class="icon-btn group-more" title="分组操作"><i class="ph ph-dots-three-vertical"></i></button>` : ''}</div>
      </div>
      <div class="ast-group-list ${g.expanded ? 'open' : ''}">${asts.map(a => `<div class="ast-card" data-id="${a.id}"><div class="ast-info"><div class="ast-name">${esc(a.name)}</div><div class="ast-prompt">${esc((a.systemPrompt || '').substring(0, 60))}${(a.systemPrompt || '').length > 60 ? '...' : ''}</div></div><button class="ast-more"><i class="ph ph-dots-three-vertical"></i></button></div>`).join('')}</div>
    </div>`;
  }).join('');
}

on('add-group-btn', 'click', async () => {
  const name = await showDialog('请输入新建的分组名称', true);
  if (name?.trim()) { state.groups.push({ id: genId(), name: name.trim(), expanded: true }); saveState(); renderAstList(); }
});

function handleGroupMore(gid, btn) {
  showDropdown(btn,[{ label: '重命名分组', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '删除分组', value: 'delete', icon: '<i class="ph ph-trash"></i>' }], async val => {
    const g = state.groups.find(x => x.id === gid); if (!g) return;
    if (val === 'rename') {
      const name = await showDialog('重命名分组', true, g.name);
      if (name?.trim()) { g.name = name.trim(); saveState(); renderAstList(); }
    } else if (val === 'delete' && await showDialog(`确定要删除【${g.name}】吗？\n如果该分组下有助手，将全部移至默认分组。`)) {
      state.assistants.forEach(a => { if (a.groupId === gid) a.groupId = 'default'; });
      state.groups = state.groups.filter(x => x.id !== gid); state.groups.find(x => x.id === 'default').expanded = true;
      saveState(); renderAstList();
    }
  });
}

function handleAstMore(id, btn) {
  const ast = state.assistants.find(a => a.id === id), groupAsts = state.assistants.filter(a => a.groupId === ast.groupId), idx = groupAsts.findIndex(a => a.id === id);
  const moveItems = state.groups.filter(g => g.id !== ast.groupId).map(g => ({ label: `移动到：${g.name}`, value: `move_${g.id}`, icon: '<i class="ph ph-folder-simple"></i>' }));
  const items =[...moveItems, ...(moveItems.length ? [{ isHeader: true, label: '操作' }] :[]), { label: '删除助手', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  if (idx > 0) items.push({ label: '上移', value: 'order_up', icon: '<i class="ph ph-arrow-up"></i>' });
  if (idx < groupAsts.length - 1) items.push({ label: '下移', value: 'order_down', icon: '<i class="ph ph-arrow-down"></i>' });

  showDropdown(btn, items, async val => {
    if (val === 'delete' && await showDialog('确定要删除此助手吗？')) {
      state.assistants = state.assistants.filter(a => a.id !== id); if (state.activeAstId === id) state.activeAstId = null;
    } else if (val === 'order_up' || val === 'order_down') {
      const tg = val === 'order_up' ? groupAsts[idx - 1] : groupAsts[idx + 1], i1 = state.assistants.indexOf(ast), i2 = state.assistants.indexOf(tg);[state.assistants[i1], state.assistants[i2]] = [state.assistants[i2], state.assistants[i1]];
    } else if (val.startsWith('move_')) {
      ast.groupId = val.replace('move_', ''); const tg = state.groups.find(g => g.id === ast.groupId); if (tg) tg.expanded = true;
    }
    saveState(); renderAstList();
  });
}

on('ast-list', 'click', e => {
  const gh = e.target.closest('.ast-group-header');
  if (gh) {
    const gid = gh.parentElement.dataset.gid;
    if (e.target.closest('.add-to-group')) { e.stopPropagation(); populateGroupSelect(gid); return openSheet('add-ast-sheet'); }
    if (e.target.closest('.group-more')) { e.stopPropagation(); return handleGroupMore(gid, e.target.closest('.group-more')); }
    const g = state.groups.find(x => x.id === gid); if (g) { g.expanded = !g.expanded; saveState(); renderAstList(); }
    return;
  }
  const card = e.target.closest('.ast-card'); if (!card) return;
  if (e.target.closest('.ast-more')) { e.stopPropagation(); return handleAstMore(card.dataset.id, e.target.closest('.ast-more')); }
  goToChat(card.dataset.id);
});

on('add-ast-btn', 'click', () => { populateGroupSelect('default'); openSheet('add-ast-sheet'); });
on('create-ast', 'click', () => {
  const n = $1('new-ast-name').value.trim(); if (!n) return toast('<i class="ph ph-warning-circle"></i> 请输入名称');
  const gid = $1('new-ast-group')?.value || 'default';
  state.assistants.unshift({ id: genId(), name: n, systemPrompt: $1('new-ast-prompt').value.trim(), temperature: 1.0, topP: 1.0, modelId: 'deepseek-v4-pro', reasoningEffort: 'off', groupId: gid, conversations:[], activeConvId: null });
  const tg = state.groups.find(g => g.id === gid); if (tg) tg.expanded = true;
  saveState(); closeAll(); renderAstList(); $1('new-ast-name').value = ''; toast('<i class="ph-fill ph-check-circle"></i> 已创建');
});

// ==================== CHAT PAGE & MARKDOWN ====================
function renderChatPage() {
  const a = getActiveAst(); if (!a) return goToAsts();
  const c = getActiveConv(a), m = getModelInfo(a.modelId);
  $1('chat-asst-name').innerHTML = `${esc(a.name)}${a.conversations.length ? ` <i class="ph ph-chat-centered-text" style="font-weight:normal; opacity:0.8; margin-left:4px;"></i> ${a.conversations.length}` : ''}`;
  $1('chat-topic-name').textContent = c ? c.title : '新话题';
  $1('chat-nav-tokens').textContent = `(${c ? c.messages.length : 0})`;
  $1('model-chip-label').textContent = m.name; $1('model-chip-btn').querySelector('.micon').innerHTML = m.icon;
  $1('reasoning-label').textContent = `推理：${{ off: '关闭', low: 'Low', high: 'High', max: 'Max' }[a.reasoningEffort] || a.reasoningEffort}`;
  renderMessages();
}

if (window.markedKatex) marked.use(window.markedKatex({ throwOnError: false }));
marked.setOptions({ breaks: true, gfm: true });

const md = t => {
  if (!t) return '';
  const text = String(t).replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$').replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  try { return marked.parse(text); } catch(e) { return esc(text).replace(/\n/g, '<br>'); }
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
    if (code) { try { hljs.highlightElement(code); } catch(e) {} }
  });
  c.querySelectorAll('table:not(.table-wrapper table)').forEach(t => { const w = document.createElement('div'); w.className = 'table-wrapper'; t.replaceWith(w); w.appendChild(t); });
}

function makeMsg(msg, idx) {
  const isAi = msg.role === 'assistant', d = document.createElement('div'); d.className = `msg ${isAi ? 'ai' : 'user'}`; d.dataset.index = idx;
  const rHTML = msg.reasoning ? `<div class="rblock"><button class="rhead"><span>${msg.isNote ? '<i class="ph ph-note-pencil"></i> 消息备注' : '<i class="ph ph-brain"></i> 思考过程'}</span><i class="ph ph-caret-right arr"></i></button><div class="rbody">${esc(msg.reasoning)}</div></div>` : '';
  const mInfo = getModelInfo(msg.modelId || getActiveAst()?.modelId);
  d.innerHTML = `<div class="bubble">${rHTML}<div class="markdown-body">${md(msg.content)}</div></div><div class="msg-actions"><div class="actions-left">${isAi ? `<span class="badge">${mInfo.custom ? '<i class="ph-fill ph-sparkle"></i>' : mInfo.icon} ${esc(mInfo.name)}</span><span class="gen-time"><i class="ph ph-timer"></i> ${msg.genTime || (msg.startTime ? ((Date.now()-msg.startTime)/1000).toFixed(0) : '0')}s</span>` : ''}</div><div class="msg-tokens">${isAi ? '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg)) : ''}</div><div class="actions-right">${isAi ? `<button data-a="cp"><i class="ph ph-copy"></i></button><button data-a="ed"><i class="ph ph-pencil-simple"></i></button><button data-a="del"><i class="ph ph-trash"></i></button><button data-a="re"><i class="ph ph-arrows-clockwise"></i></button>` : `<button data-a="cp"><i class="ph ph-copy"></i></button><button data-a="ed"><i class="ph ph-pencil-simple"></i></button><button data-a="del"><i class="ph ph-trash"></i></button><button data-a="re"><i class="ph ph-arrow-u-up-left"></i></button>`}</div></div>`;
  enhanceCodeBlocks(d); return d;
}

on('messages', 'click', async e => {
  const btn = e.target.closest('button[data-a]'), hint = e.target.closest('.welcome-hint'), rhead = e.target.closest('.rhead');
  if (hint) { $1('user-input').value = hint.dataset.prompt; return sendMessage(); }
  if (rhead) { rhead.classList.toggle('open'); rhead.nextElementSibling.classList.toggle('open'); return; }
  if (btn) {
    e.stopPropagation(); const act = btn.dataset.a, idx = parseInt(btn.closest('.msg').dataset.index, 10), conv = getActiveConv(), msg = conv.messages[idx];
    if (act === 'cp') return copyText(msg.content).then(() => toast('<i class="ph-fill ph-check-circle"></i> 已复制'));
    if (streaming) return toast('<i class="ph-fill ph-warning-circle"></i> 生成中不可操作');
    if (act === 'ed') openEditModal(msg);
    else if (act === 'del' && await showDialog('确定要删除这条消息吗？')) { conv.messages.splice(idx, 1); saveState(); renderChatPage(); }
    else if (act === 're' && await showDialog(`确定要重新${msg.role === 'assistant' ? '生成此回复' : '发送这条消息'}吗？`)) {
      let tIdx = idx; if (msg.role === 'assistant') { while (tIdx >= 0 && conv.messages[tIdx].role !== 'user') tIdx--; if (tIdx < 0) return toast('无法重新生成：缺用户消息'); }
      $1('user-input').value = conv.messages[tIdx].content; conv.messages = conv.messages.slice(0, tIdx);
      saveState(); renderChatPage(); $1('user-input').dispatchEvent(new Event('input')); sendMessage();
    }
  }
});

function renderMessages() {
  const msgs = $1('messages'), c = getActiveConv(); msgs.innerHTML = '';
  if (!c || !c.messages.length) return msgs.innerHTML = `<div class="welcome"><div class="emoji"><i class="ph-fill ph-sparkle"></i></div><h3>开始对话</h3><p>输入消息，点击发送按钮开始</p><div class="welcome-hints"><div class="welcome-hint" data-prompt="用简单的语言解释量子计算"><i class="ph ph-microscope"></i> 解释量子计算</div><div class="welcome-hint" data-prompt="写一首关于夏天的中国古诗"><i class="ph ph-pen-nib"></i> 写一首古诗</div><div class="welcome-hint" data-prompt="用Python写一个贪吃蛇游戏"><i class="ph ph-code"></i> 写贪吃蛇游戏</div><div class="welcome-hint" data-prompt="给我一个一周健身计划"><i class="ph ph-barbell"></i> 健身计划</div></div></div>`;
  c.messages.forEach((m, i) => msgs.appendChild(makeMsg(m, i)));
}

// ==================== EDIT MODAL ====================
function openEditModal(msg) { 
  editingMsg = msg; $1('edit-textarea').value = msg.content || ''; $1('edit-reasoning-textarea').value = msg.reasoning || '';
  const isNote = !msg.reasoning || msg.isNote;
  $1('edit-toggle-reasoning-btn').innerHTML = isNote ? '<i class="ph ph-note-pencil"></i> 消息备注' : '<i class="ph ph-brain"></i> 思考过程';
  $1('edit-reasoning-textarea').placeholder = isNote ? '输入消息备注…' : '输入思考过程…';
  $1('edit-reasoning-textarea').classList.remove('show'); $1('edit-toggle-reasoning-btn').classList.remove('active');
  $1('edit-overlay').classList.add('show'); 
}
function saveEdit() {
  if (!editingMsg) return;
  const val = $1('edit-textarea').value.trim(), rval = $1('edit-reasoning-textarea').value.trim();
  if (!val && !rval) return toast('内容不能为空');
  editingMsg.content = val; editingMsg.reasoning = rval || '';
  if (rval) { if ($1('edit-toggle-reasoning-btn').innerHTML.includes('备注')) editingMsg.isNote = true; else delete editingMsg.isNote; } else delete editingMsg.isNote;
  saveState(); renderChatPage(); $1('edit-overlay').classList.remove('show'); editingMsg = null; toast('<i class="ph-fill ph-check-circle"></i> 已保存');
}
on('edit-cancel-btn', 'click', () => { $1('edit-overlay').classList.remove('show'); editingMsg = null; });
on('edit-save-btn', 'click', saveEdit);
on('edit-toggle-reasoning-btn', 'click', () => { $1('edit-toggle-reasoning-btn').classList.toggle('active', $1('edit-reasoning-textarea').classList.toggle('show')); $1('edit-reasoning-textarea').focus(); });

// ==================== TOPIC LIST ====================
function renderTopicList() {
  const a = getActiveAst(), l = $1('topic-list');
  if (!a || !a.conversations.length) { l.innerHTML = '<div class="empty">暂无话题</div>'; $1('drawer-total-tokens').textContent = '0'; return; }
  let total = 0;
  l.innerHTML = a.conversations.map(c => {
    const tok = calcConvContextTokens(c, a.systemPrompt); total += tok;
    return `<div class="topic-item ${c.id === a.activeConvId ? 'active' : ''}" data-cid="${c.id}"><span><i class="ph ph-chat-teardrop-text"></i></span><div class="tinfo"><div class="ttitle-wrap"><div class="ttitle">${esc(c.title)}</div><span class="nav-tokens">${formatK(tok)}</span></div><div class="tmeta">${c.messages.length} 条消息</div></div><button class="ast-more topic-more"><i class="ph ph-dots-three-vertical"></i></button></div>`;
  }).join('');
  $1('drawer-total-tokens').textContent = formatK(total);
}

function handleTopicMore(cid, btn) {
  const a = getActiveAst(), idx = a?.conversations.findIndex(c => c.id === cid); if (idx < 0) return; const conv = a.conversations[idx];
  const items =[{ label: '重命名话题', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '复制话题', value: 'copy', icon: '<i class="ph ph-copy"></i>' }, ...(idx > 0 ?[{ label: '上移', value: 'order_up', icon: '<i class="ph ph-arrow-up"></i>' }] : []), ...(idx < a.conversations.length - 1 ?[{ label: '下移', value: 'order_down', icon: '<i class="ph ph-arrow-down"></i>' }] :[]), { label: '删除话题', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  showDropdown(btn, items, async val => {
    if (val === 'rename') { const nt = await showDialog('重命名话题', true, conv.title); if (nt?.trim() && nt.trim() !== conv.title) { conv.title = nt.trim(); saveState(); renderChatPage(); renderTopicList(); } }
    else if (val === 'copy') { const nc = JSON.parse(JSON.stringify(conv)); nc.id = genId(); nc.title += ' 副本'; a.conversations.splice(idx + 1, 0, nc); saveState(); renderTopicList(); toast('已复制话题'); }
    else if (val === 'order_up' || val === 'order_down') { const ti = val === 'order_up' ? idx - 1 : idx + 1;[a.conversations[idx], a.conversations[ti]] = [a.conversations[ti], a.conversations[idx]]; saveState(); renderTopicList(); }
    else if (val === 'delete' && await showDialog('确定要删除此话题吗？')) { a.conversations.splice(idx, 1); if (a.activeConvId === cid) a.activeConvId = a.conversations[0]?.id || null; saveState(); renderChatPage(); renderTopicList(); }
  });
}

on('topic-list', 'click', e => {
  const a = getActiveAst(), item = e.target.closest('.topic-item'); if (!a || !item) return;
  if (e.target.closest('.topic-more')) return handleTopicMore(item.dataset.cid, e.target.closest('.topic-more'));
  a.activeConvId = item.dataset.cid; saveState(); closeAll(); renderChatPage(); renderTopicList(); userScrolledUp = false; scrollBottom(true, false);
});
on('new-topic', 'click', () => { const a = getActiveAst(); if (a) { a.activeConvId = null; saveState(); closeAll(); renderChatPage(); userScrolledUp = false; scrollBottom(true, false); } });

// ==================== SETTINGS ====================
function renderSettings() {
  const a = getActiveAst(); if (!a) return;
  $1('settings-body').innerHTML = `
    <div class="section"><div class="field"><label>助手名称</label><input type="text" id="s-name" value="${esc(a.name)}"></div><div class="field"><label>系统提示词</label><div class="relative"><textarea id="s-prompt" rows="4">${esc(a.systemPrompt)}</textarea><button id="s-prompt-fs-btn" class="icon-btn abs-top-right"><i class="ph ph-corners-out"></i></button></div></div>
      <div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-sliders"></i> 高级参数 <i class="ph ph-caret-right arr"></i></button><div class="settings-fold-body"><div class="field"><label>Temperature：<strong id="s-tval">${a.temperature.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-temp" min="0" max="2" step=".05" value="${a.temperature}"><span class="slider-label">2</span></div></div><div class="field"><label>Top P：<strong id="s-pval">${a.topP.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-topp" min="0" max="1" step=".05" value="${a.topP}"><span class="slider-label">1</span></div></div></div></div>
    </div>
    <div class="section"><div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-plugs"></i> API 密钥与模型 <i class="ph ph-caret-right arr"></i></button><div class="settings-fold-body"><div class="field"><label>DeepSeek API Key</label><input type="password" id="s-dskey" value="${esc(state.deepseekKey)}"></div><div class="field"><label>第三方 API Key (Gemini)</label><input type="password" id="s-gmkey" value="${esc(state.geminiKey || '')}"></div><div class="field"><label>第三方 API 地址</label><input type="text" id="s-gmurl" value="${esc(state.geminiBaseUrl || 'https://generativelanguage.googleapis.com')}"></div><div class="field"><label>第三方模型列表</label><input type="text" id="s-gmmodels" value="${esc(state.geminiModels || 'gemini-2.5-pro')}"></div></div></div></div>
    <div class="section"><div class="t-row"><span id="theme-label">${state.darkMode ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'}</span><div class="tsw ${state.darkMode ? 'active' : ''}" id="s-theme"></div></div></div>
    <div class="section"><div class="data-actions"><button id="data-export"><i class="ph ph-upload-simple"></i> 导出备份</button><button id="data-import-btn"><i class="ph ph-download-simple"></i> 导入备份</button></div></div>
    <button class="btn-primary mt-8" id="s-save"><i class="ph ph-floppy-disk"></i> 保存设置</button>
  `;
}

on('settings-body', 'click', e => {
  if (e.target.closest('#data-export')) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ _meta: { version: 10, date: new Date().toISOString() }, data: state }, null, 2)], { type: 'application/json' })); a.download = `ai-chat-backup-${new Date().toISOString().split('T')[0]}.json`; a.click(); toast('已导出备份');
  } else if (e.target.closest('#data-import-btn')) $1('import-file').click();
  else if (e.target.closest('#s-save')) {
    const a = getActiveAst(), val = id => $1(id)?.value; if (!a) return;
    a.name = val('s-name')?.trim() || a.name; a.systemPrompt = val('s-prompt')?.trim() ?? a.systemPrompt; a.temperature = parseFloat(val('s-temp') || a.temperature); a.topP = parseFloat(val('s-topp') || a.topP);
    state.deepseekKey = val('s-dskey')?.trim() ?? state.deepseekKey; state.geminiKey = val('s-gmkey')?.trim() ?? state.geminiKey; state.geminiBaseUrl = val('s-gmurl')?.trim() ?? state.geminiBaseUrl; state.geminiModels = val('s-gmmodels')?.trim() || 'gemini-2.5-pro'; state.darkMode = $1('s-theme').classList.contains('active');
    saveState(); applyTheme(); renderChatPage(); renderAstList(); closeAll(); toast('设置已保存');
  } else {
    const head = e.target.closest('.settings-fold-head'); if (head) head.parentElement.classList.toggle('open');
    const themeSw = e.target.closest('#s-theme'); if (themeSw) { themeSw.classList.toggle('active'); $1('theme-label').innerHTML = themeSw.classList.contains('active') ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'; }
    if (e.target.closest('#s-prompt-fs-btn')) { $1('fs-prompt-textarea').value = $1('s-prompt').value; $1('fs-prompt-overlay').classList.add('show'); $1('fs-prompt-textarea').focus(); }
  }
});

on('import-file', 'change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const data = JSON.parse(ev.target.result).data || JSON.parse(ev.target.result);
      if (await showDialog('导入将深度合并原有话题，新分支自动追加，确认导入吗？')) {
        (data.groups ||[]).forEach(g => { if (!state.groups.find(x => x.id === g.id || x.name === g.name)) state.groups.push(g); });
        data.assistants?.forEach(ia => {
          const fa = fixAsst(ia), lg = state.groups.find(g => g.id === fa.groupId || g.name === (data.groups?.find(x=>x.id===fa.groupId)?.name));
          fa.groupId = lg ? lg.id : 'default';
          const ex = state.assistants.find(a => a.id === fa.id || a.name === fa.name);
          if (ex) fa.conversations.forEach(ic => { if (!ex.conversations.some(c => c.id === ic.id && c.messages.length === ic.messages.length)) { ic.id = genId(); ex.conversations.push(ic); } }); else state.assistants.push(fa);
        });
        Object.assign(state, { activeAstId: data.activeAstId ?? state.activeAstId, deepseekKey: data.deepseekKey ?? state.deepseekKey, geminiKey: data.geminiKey ?? state.geminiKey, geminiBaseUrl: data.geminiBaseUrl ?? state.geminiBaseUrl, geminiModels: data.geminiModels ?? state.geminiModels, darkMode: data.darkMode ?? state.darkMode });
        saveState(); applyTheme(); renderAstList(); goToAsts(); closeAll(); toast('导入成功');
      }
    } catch(err) { toast('文件格式错误'); }
  };
  reader.readAsText(file); e.target.value = '';
});

// FS Editor
const ta = $1('fs-prompt-textarea');
const ins = (p, s = '') => { ta.setRangeText(p + ta.value.substring(ta.selectionStart, ta.selectionEnd) + s, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus(); ta.dispatchEvent(new Event('input')); };
const ptb = { undo: () => document.execCommand('undo'), redo: () => document.execCommand('redo'), bold: () => ins('**', '**'), code: () => ins('`', '`'), heading: () => ins('## '), list: () => ins('- '), quote: () => ins('> ') };
on('fs-prompt-tb', 'click', e => { const btn = e.target.closest('button[data-md]'); if (btn) { ta.focus(); ptb[btn.dataset.md]?.(); } });
on('fs-prompt-save', 'click', () => { $1('s-prompt').value = ta.value; $1('s-save').click(); $1('fs-prompt-overlay').classList.remove('show'); });
on('fs-prompt-close', 'click', () => { $1('s-prompt').value = ta.value; $1('fs-prompt-overlay').classList.remove('show'); });

// ==================== DROPDOWN & DROPDOWN LOGIC ====================
function showDropdown(anchor, items, onSelect) {
  const dd = $1('dropdown-menu'); 
  dd.innerHTML = items.map((item, i) => item.isHeader ? `<div class="dropdown-header">${item.label}</div>` : `<div class="dropdown-item ${item.selected ? 'selected' : ''}" data-idx="${i}">${item.icon || ''}<span>${item.label}</span>${item.selected ? '<i class="ph ph-check check"></i>' : ''}</div>`).join('');
  const r = anchor.getBoundingClientRect(), mh = dd.offsetHeight;
  let top = r.top - mh - 4 > 0 ? r.top - mh - 4 : r.bottom + 4; if (top + mh > window.innerHeight) top = window.innerHeight - mh - 10;
  dd.style.cssText = `top:${top}px; left:${Math.max(5, Math.min(r.left, window.innerWidth - dd.offsetWidth - 5))}px`;
  dd.classList.add('show');
  const clickHandler = e => { if (e.target.closest('.dropdown-header')) return; const item = e.target.closest('.dropdown-item'); if (item) onSelect(items[item.dataset.idx].value); hideDropdown(); off(document, 'click', clickHandler); };
  setTimeout(() => on(document, 'click', clickHandler), 10);
}
const hideDropdown = () => $1('dropdown-menu').classList.remove('show');

on('model-chip-btn', 'click', e => {
  if (streaming) return toast('生成中不可切换模型');
  e.stopPropagation(); const a = getActiveAst();
  showDropdown(e.currentTarget,[{ isHeader: true, label: 'DeepSeek API' }, ...DS_MODELS.map(m => ({ label: `${m.icon} ${m.name}`, value: m.id, selected: a?.modelId === m.id })), { isHeader: true, label: '第三方 API' }, ...getCustomModels().map(n => ({ label: `<i class="ph-fill ph-sparkle"></i> ${n}`, value: n, selected: a?.modelId === n }))], id => { if (a) { a.modelId = id; const v = isDeepSeek(id) ? ['off', 'high', 'max'] :['off', 'low', 'high']; if (!v.includes(a.reasoningEffort)) a.reasoningEffort = 'off'; saveState(); renderChatPage(); toast('已切换模型'); } });
});

on('reasoning-btn', 'click', e => {
  if (streaming) return toast('生成中不可切换推理设置');
  e.stopPropagation(); const a = getActiveAst();
  showDropdown(e.currentTarget, (isDeepSeek(a?.modelId) ?[{label: '关闭', value: 'off'}, {label: 'High', value: 'high'}, {label: 'Max', value: 'max'}] :[{label: '关闭', value: 'off'}, {label: 'Low', value: 'low'}, {label: 'High', value: 'high'}]).map(o => ({ ...o, selected: o.value === a?.reasoningEffort })), val => { if (a) { a.reasoningEffort = val; saveState(); renderChatPage(); } });
});

// ==================== CHAT STREAM & EVENTS ====================
let isTouching = false; const chatC = $1('chat-container');
['touchstart','mousedown'].forEach(ev => chatC.addEventListener(ev, () => isTouching = true, { passive: true }));['touchend','touchcancel','mouseup'].forEach(ev => window.addEventListener(ev, () => isTouching = false, { passive: true }));
chatC.addEventListener('wheel', () => userScrolledUp = true, { passive: true });
on('chat-container', 'scroll', function() { const dist = this.scrollHeight - this.scrollTop - this.clientHeight; if (dist <= 25) userScrolledUp = false; else if (isTouching) userScrolledUp = true; $1('scroll-down').classList.toggle('show', dist > 200 && $1('messages').children.length > 1); });
const scrollBottom = (force, smooth = false) => { if (force || (!userScrolledUp && !isTouching)) requestAnimationFrame(() => chatC.scrollTo({ top: chatC.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })); };

function updateLive(idx, msg) {
  const bub = document.querySelector(`#messages .msg.ai[data-index="${idx}"] .bubble`); if (!bub) return;
  if (msg.reasoning) { 
    let rb = bub.querySelector('.rblock'); if (!rb) { bub.insertAdjacentHTML('afterbegin', '<div class="rblock"><button class="rhead open"><span><i class="ph ph-brain"></i> 思考过程</span><i class="ph ph-caret-right arr"></i></button><div class="rbody open"></div></div>'); rb = bub.querySelector('.rblock'); }
    if (msg.content.length > 0 && !rb.dataset.autoClosed) { rb.querySelector('.rhead').classList.remove('open'); rb.querySelector('.rbody').classList.remove('open'); rb.dataset.autoClosed = '1'; }
    rb.querySelector('.rbody').textContent = msg.reasoning;
  }
  let mc = bub.querySelector('.markdown-body'); if (!mc) { bub.insertAdjacentHTML('beforeend', '<div class="markdown-body"></div>'); mc = bub.querySelector('.markdown-body'); }
  mc.innerHTML = md(msg.content); enhanceCodeBlocks(bub);
  const tk = document.querySelector(`#messages .msg[data-index="${idx}"] .msg-tokens`); if (tk) tk.innerHTML = '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg));
}

function getApiConfig(a, c) {
  const msgs = c.messages.slice(0, -1);
  if (isDeepSeek(a.modelId)) {
    const body = { model: a.modelId, stream: true, messages:[{ role: 'system', content: a.systemPrompt }, ...msgs.map(m => ({ role: m.role, content: m.content }))] };
    Object.assign(body, a.reasoningEffort === 'off' ? { temperature: a.temperature, top_p: a.topP, thinking: { type: 'disabled' } } : { reasoning_effort: a.reasoningEffort, thinking: { type: 'enabled' } });
    return { url: 'https://api.deepseek.com/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.deepseekKey}` }, body };
  } else {
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': state.geminiKey };
    if (/^(sk-|Bearer )/.test(state.geminiKey)) headers['Authorization'] = state.geminiKey.startsWith('Bearer ') ? state.geminiKey : `Bearer ${state.geminiKey}`;
    const contents = msgs.reduce((acc, m) => {
      const parts = [...(m.thoughtSignatures || []).map(s => ({ thoughtSignature: s })), { text: m.content || ' ' }];
      if (acc.length && acc[acc.length - 1].role === (m.role === 'user' ? 'user' : 'model')) acc[acc.length - 1].parts.push(...parts); else acc.push({ role: m.role === 'user' ? 'user' : 'model', parts });
      return acc;
    },[]);
    const body = { contents, generationConfig: { temperature: a.temperature, topP: a.topP, thinkingConfig: a.reasoningEffort !== 'off' ? { includeThoughts: true,[a.modelId.includes('gemini-3') ? 'thinkingLevel' : 'thinkingBudget']: a.reasoningEffort === 'low' ? (a.modelId.includes('gemini-3') ? 'LOW' : 1024) : (a.modelId.includes('gemini-3') ? 'HIGH' : 8192) } : undefined } };
    if (a.systemPrompt) body.systemInstruction = { role: "system", parts: [{ text: a.systemPrompt }] };
    return { url: `${(state.geminiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')}/v1beta/models/${a.modelId}:streamGenerateContent?alt=sse`, headers, body };
  }
}

async function sendMessage() {
  if (streaming) return;
  const inputEl = $1('user-input'), txt = inputEl.value.trim(), a = getActiveAst(); if (!txt || !a) return;
  if (isDeepSeek(a.modelId) ? !state.deepseekKey : !state.geminiKey) return toast('请先设置 API Key') || $1('settings-btn').click();
  inputEl.value = ''; inputEl.style.height = 'auto';
  const c = ensureConv(a); c.messages.push({ role: 'user', content: txt }); if (c.title === '新话题') c.title = txt.substring(0, 28) + (txt.length > 28 ? '…' : '');
  userScrolledUp = false; renderMessages(); scrollBottom(true, true);
  
  const am = { role: 'assistant', content: '', reasoning: '', genTime: null, modelId: a.modelId, startTime: Date.now() }; c.messages.push(am); const ai = c.messages.length - 1;
  saveState(); renderMessages(); streaming = true; $1('send-btn').classList.add('hidden'); inputEl.disabled = true; $1('stop-btn').classList.remove('hidden'); $1('chat-nav-tokens').textContent = `(${c.messages.length})`;

  abortCtrl = new AbortController(); let genTimer = setInterval(() => { const el = document.querySelector(`#messages .msg.ai[data-index="${ai}"] .gen-time`); if (el) el.innerHTML = `<i class="ph ph-timer"></i> ${((Date.now() - am.startTime) / 1000).toFixed(0)}s`; }, 1000);
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
            for (const p of (chunk.candidates?.[0]?.content?.parts ||[])) {
              if (p.thoughtSignature || p.thought_signature) (am.thoughtSignatures ??=[]).push(p.thoughtSignature || p.thought_signature);
              if (String(p.thought) === "true") am.reasoning += (p.text || ''); else if (p.text) am.content += p.text;
            }
          } else {
            const d = chunk.choices?.[0]?.delta; if (d?.reasoning_content) am.reasoning += d.reasoning_content; if (d?.content) am.content += d.content;
          }
          $1('chat-nav-tokens').textContent = `(${c.messages.length})`; updateLive(ai, am); scrollBottom(false, false);
        } catch(e) {}
      }
    }
  } catch (err) { if (err.name !== 'AbortError') am.content = am.content || `❌ 错误：${err.message}`; }
  finally { streaming = false; abortCtrl = null; clearInterval(genTimer); am.genTime = ((Date.now() - am.startTime) / 1000).toFixed(0); delete am.startTime; saveState(); renderChatPage(); $1('send-btn').classList.remove('hidden'); inputEl.disabled = false; $1('stop-btn').classList.add('hidden'); }
}

const openSheet = id => { closeDrawers(); $1('overlay').classList.add('show'); $1(id).classList.add('open'); };
const closeDrawers = () =>['topics-drawer','settings-drawer','add-ast-sheet'].forEach(id => $1(id).classList.remove('open'));
const closeAll = () => { hideDropdown(); $1('overlay').classList.remove('show'); closeDrawers(); };

on('send-btn', 'click', sendMessage);
on('stop-btn', 'click', () => abortCtrl?.abort());
on('user-input', 'keydown', function(e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); } });
on('user-input', 'input', function() { this.style.height = 'auto'; this.style.height = `${Math.min(this.scrollHeight, 220)}px`; });
on('scroll-down', 'click', () => { userScrolledUp = false; scrollBottom(true, false); });
on('chat-back', 'click', goToAsts);
on('topic-toggle', 'click', e => { e.stopPropagation(); renderTopicList(); $1('overlay').classList.add('show'); $1('topics-drawer').classList.add('open'); });
on('settings-btn', 'click', () => { renderSettings(); $1('overlay').classList.add('show'); $1('settings-drawer').classList.add('open'); });['close-topics', 'close-settings', 'overlay'].forEach(id => on(id, 'click', closeAll));

await IDB.init().catch(()=>{}); await loadState(); setupPWA(); applyTheme(); renderAstList(); state.activeAstId = null; saveState(); history.replaceState({ page: 'home' }, '');
window.addEventListener('popstate', e => { closeAll(); if (e.state?.page === 'chat') goToChat(e.state.id, true); else goToAsts(true); });
})();