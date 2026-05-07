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
const getContextTokens = m => estimateTokens(m.content);
const calcConvContextTokens = (c, p) => c.messages.reduce((t, m) => t + getContextTokens(m), estimateTokens(p));
const formatK = t => t < 1000 ? t : (t / 1000).toFixed(1) + 'k';

// ==================== DATABASE (IndexedDB) ====================
const STORAGE_KEY = 'ai_chat_v8';
const IDB = {
  db: null,
  init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('AIChatDB', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('store');
      req.onsuccess = e => { this.db = e.target.result; resolve(); };
      req.onerror = e => reject(e.target.error);
    });
  },
  get(key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve(null);
      const tx = this.db.transaction('store', 'readonly');
      const req = tx.objectStore('store').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  },
  set(key, val) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject('No DB');
      const tx = this.db.transaction('store', 'readwrite');
      const req = tx.objectStore('store').put(val, key);
      req.onsuccess = () => resolve();
      req.onerror = e => reject(e.target.error);
    });
  }
};

// ==================== STATE & MODELS ====================
let state = {
  assistants:[{
    id: 'default-ast', name: '全能助手', systemPrompt: '你是一个高通用性、严谨且富有协作精神的AI助手。你的核心目标不是扮演特定角色，而是动态适配用户的真实需求。',
    temperature: 1.0, topP: 1.0, modelId: 'deepseek-v4-pro', reasoningEffort: 'off',
    groupId: 'default', conversations: [], activeConvId: null
  }], 
  groups:[{ id: 'default', name: '默认分组', expanded: true }], 
  activeAstId: null, deepseekKey: '', geminiKey: '', 
  geminiBaseUrl: 'https://generativelanguage.googleapis.com', 
  geminiModels: 'gemini-2.5-pro, gemini-3.0-flash', darkMode: false
};

let abortCtrl = null, streaming = false, editingMsg = null, userScrolledUp = false;

const DS_MODELS =[
  { id: 'deepseek-v4-pro',   name: 'DeepSeek V4 Pro',   icon: '<i class="ph-fill ph-diamond"></i>' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', icon: '<i class="ph-fill ph-lightning"></i>' }
];

const getModelInfo = id => DS_MODELS.find(m => m.id === id) || { icon: '<i class="ph-fill ph-sparkle"></i>', name: id, custom: true };
const isDeepSeek = id => DS_MODELS.some(m => m.id === id) || (id || '').toLowerCase().includes('deepseek');
const getCustomModels = () => (state.geminiModels || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadState() {
  try {
    let p = await IDB.get(STORAGE_KEY);
    if (!p) {
      const r = localStorage.getItem(STORAGE_KEY);
      if (r) {
        p = JSON.parse(r);
        await IDB.set(STORAGE_KEY, p); 
      }
    }
    if (p) {
      if (!p.groups?.length) p.groups =[{ id: 'default', name: '默认分组', expanded: true }];
      state = { ...state, ...p };
    }
  } catch(e) { console.warn("读取数据失败, 使用默认状态", e); }
  
  state.assistants = state.assistants.map(fixAsst);
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    IDB.set(STORAGE_KEY, state).catch(() => toast('<i class="ph-fill ph-warning-circle"></i> 存储失败，空间不足或浏览器拦截'));
  }, 300);
}

function fixAsst(a) {
  let modelId = a.modelId || 'deepseek-v4-pro';
  if (a.provider === 'gemini' && a.geminiModel) { modelId = a.geminiModel; delete a.provider; delete a.geminiModel; }
  return {
    id: a.id || genId(), name: a.name || '未命名助手', systemPrompt: a.systemPrompt || '你是一个有帮助的AI助手。',
    temperature: a.temperature ?? 1.0, topP: a.topP ?? 1.0, modelId, reasoningEffort: a.reasoningEffort || 'off',
    groupId: a.groupId || 'default',
    conversations: (a.conversations ||[]).map(c => ({ 
      id: c.id || genId(), title: c.title || '新话题', 
      messages: (c.messages ||[]).map(m => {
        if (m.reasoningTime && !m.genTime) { m.genTime = m.reasoningTime; }
        delete m.reasoningTime; delete m.thinkTime; 
        return m;
      })
    })),
    activeConvId: a.activeConvId || null
  };
}

const getActiveAst = () => state.assistants.find(a => a.id === state.activeAstId) || null;
const getActiveConv = (a = getActiveAst()) => a ? a.conversations.find(c => c.id === a.activeConvId) : null;
function ensureConv(a) {
  let c = getActiveConv(a);
  if (!c) {
    c = { id: genId(), title: '新话题', messages:[] };
    a.conversations.unshift(c); a.activeConvId = c.id; saveState();
  }
  return c;
}

function toast(m, d = 2000) {
  const t = $1('toast'); t.innerHTML = m; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), d);
}

// ==================== COPY & CONFIRM ====================
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) return await navigator.clipboard.writeText(text); } catch(e) {}
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
}

function showConfirm(msg) {
  return new Promise(resolve => {
    $1('confirm-msg').textContent = msg; $1('confirm-overlay').classList.add('show');
    const cleanup = () => { $1('confirm-overlay').classList.remove('show'); off('confirm-ok', 'click', onOk); off('confirm-cancel', 'click', onCancel); };
    const onOk = () => { cleanup(); resolve(true); }; const onCancel = () => { cleanup(); resolve(false); };
    on('confirm-ok', 'click', onOk); on('confirm-cancel', 'click', onCancel);
  });
}

function showInputPrompt(msg, defaultVal = '') {
  return new Promise(resolve => {
    $1('custom-prompt-msg').textContent = msg;
    const inp = $1('custom-prompt-input');
    inp.value = defaultVal;
    $1('custom-prompt-overlay').classList.add('show');
    inp.focus();
    
    const cleanup = () => { $1('custom-prompt-overlay').classList.remove('show'); off('custom-prompt-ok', 'click', onOk); off('custom-prompt-cancel', 'click', onCancel); off(inp, 'keydown', onKey); };
    const onOk = () => { cleanup(); resolve(inp.value); }; 
    const onCancel = () => { cleanup(); resolve(null); };
    const onKey = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    
    on('custom-prompt-ok', 'click', onOk); on('custom-prompt-cancel', 'click', onCancel); on(inp, 'keydown', onKey);
  });
}

// ==================== PWA & THEME ====================
function setupPWA() {
  if ('serviceWorker' in navigator) {
    const swCode = `self.addEventListener('install', e => self.skipWaiting()); self.addEventListener('activate', e => self.clients.claim()); self.addEventListener('fetch', e => {});`;
    navigator.serviceWorker.register(URL.createObjectURL(new Blob([swCode], { type: 'application/javascript' }))).catch(e=>{});
  }
}

function applyTheme() {
  const d = state.darkMode;
  document.documentElement.setAttribute('data-theme', d ? 'dark' : 'light');
  $1('hljs-theme').href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github${d ? '-dark' : ''}.min.css`;
}

// ==================== NAVIGATION ====================
function goToAsts(fromHistory = false) { 
  if (fromHistory !== true && window.history.state?.page === 'chat') { window.history.back(); return; }
  $1('ast-page').classList.add('active'); $1('chat-page').classList.remove('active'); renderAstList(); 
}

function goToChat(id, fromHistory = false) { 
  state.activeAstId = id; saveState(); 
  if (fromHistory !== true) history.pushState({ page: 'chat', id }, '');
  
  $1('ast-page').classList.remove('active'); $1('chat-page').classList.add('active'); 
  renderChatPage(); closeAll(); 
  userScrolledUp = false; scrollBottom(true, false); 
}

// ==================== ASSISTANT LIST ====================
function populateGroupSelect(defaultGid) {
  const sel = $1('new-ast-group');
  if (sel) sel.innerHTML = state.groups.map(g => `<option value="${g.id}" ${g.id === defaultGid ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
}

function renderAstList() {
  const l = $1('ast-list');
  if (!state.assistants.length && state.groups.length <= 1) {
    l.innerHTML = '<div class="empty"><i class="ph ph-ghost empty-icon"></i> 还没有助手，点击右上角 ＋ 创建</div>'; return;
  }
  l.innerHTML = state.groups.map(g => {
    const asts = state.assistants.filter(a => a.groupId === g.id);
    return `
      <div class="ast-group" data-gid="${g.id}">
        <div class="ast-group-header">
          <div class="ast-group-title"><i class="ph ph-caret-right arr ${g.expanded ? 'open' : ''}"></i> ${esc(g.name)} <span class="ast-group-count">(${asts.length})</span></div>
          <div class="ast-group-actions">
            <button class="icon-btn add-to-group" title="添加到此分组"><i class="ph ph-plus"></i></button>
            ${g.id !== 'default' ? `<button class="icon-btn group-more" title="分组操作"><i class="ph ph-dots-three-vertical"></i></button>` : ''}
          </div>
        </div>
        <div class="ast-group-list ${g.expanded ? 'open' : ''}">
          ${asts.map(a => {
            return `<div class="ast-card" data-id="${a.id}">
              <div class="ast-info">
                <div class="ast-name">${esc(a.name)}</div>
                <div class="ast-prompt">${esc((a.systemPrompt || '').substring(0, 60))}${(a.systemPrompt || '').length > 60 ? '...' : ''}</div>
              </div>
              <button class="ast-more"><i class="ph ph-dots-three-vertical"></i></button>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

on('add-group-btn', 'click', async () => {
  const name = await showInputPrompt('请输入新建的分组名称');
  if (name && name.trim()) { state.groups.push({ id: genId(), name: name.trim(), expanded: true }); saveState(); renderAstList(); }
});

function handleGroupMore(gid, btn) {
  showDropdown(btn,[{ label: '重命名分组', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '删除分组', value: 'delete', icon: '<i class="ph ph-trash"></i>' }], async val => {
    const g = state.groups.find(x => x.id === gid); if (!g) return;
    if (val === 'rename') {
      const newName = await showInputPrompt('重命名分组', g.name);
      if (newName && newName.trim()) { g.name = newName.trim(); saveState(); renderAstList(); }
    } else if (val === 'delete') {
      if (!await showConfirm(`确定要删除【${g.name}】吗？\n如果该分组下有助手，将全部移至默认分组。`)) return;
      state.assistants.forEach(a => { if (a.groupId === gid) a.groupId = 'default'; });
      state.groups = state.groups.filter(x => x.id !== gid);
      const defG = state.groups.find(x => x.id === 'default'); if (defG) defG.expanded = true;
      saveState(); renderAstList();
    }
  });
}

function handleAstMore(id, btn) {
  const ast = state.assistants.find(a => a.id === id);
  const groupAsts = state.assistants.filter(a => a.groupId === ast.groupId);
  const groupIdx = groupAsts.findIndex(a => a.id === id);
  const moveItems = state.groups.filter(g => g.id !== ast.groupId).map(g => ({ label: `移动到：${g.name}`, value: `move_${g.id}`, icon: '<i class="ph ph-folder-simple"></i>' }));
  const items =[ ...moveItems, ...(moveItems.length ?[{ isHeader: true, label: '操作' }] :[]), { label: '删除助手', value: 'delete', icon: '<i class="ph ph-trash"></i>' } ];

  if (groupIdx > 0) items.push({ label: '上移', value: 'order_up', icon: '<i class="ph ph-arrow-up"></i>' });
  if (groupIdx < groupAsts.length - 1) items.push({ label: '下移', value: 'order_down', icon: '<i class="ph ph-arrow-down"></i>' });

  showDropdown(btn, items, async val => {
    if (val === 'delete') {
      if (!await showConfirm('确定要删除此助手吗？')) return;
      state.assistants = state.assistants.filter(a => a.id !== id);
      if (state.activeAstId === id) state.activeAstId = null;
      saveState(); renderAstList();
    } else if (val === 'order_up' || val === 'order_down') {
      const targetAst = val === 'order_up' ? groupAsts[groupIdx - 1] : groupAsts[groupIdx + 1];
      const idx1 = state.assistants.findIndex(a => a.id === ast.id);
      const idx2 = state.assistants.findIndex(a => a.id === targetAst.id);[state.assistants[idx1], state.assistants[idx2]] =[state.assistants[idx2], state.assistants[idx1]];
      saveState(); renderAstList();
    } else if (val.startsWith('move_')) {
      ast.groupId = val.replace('move_', '');
      const tg = state.groups.find(g => g.id === ast.groupId); if (tg) tg.expanded = true;
      saveState(); renderAstList();
    }
  });
}

on('ast-list', 'click', e => {
  const groupHead = e.target.closest('.ast-group-header');
  if (groupHead) {
    const gid = groupHead.parentElement.dataset.gid;
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
  state.assistants.unshift({
    id: genId(), name: n, systemPrompt: $1('new-ast-prompt').value.trim(),
    temperature: 1.0, topP: 1.0, modelId: 'deepseek-v4-pro', reasoningEffort: 'off',
    groupId: gid, conversations:[], activeConvId: null
  });
  const tg = state.groups.find(g => g.id === gid); if (tg) tg.expanded = true;
  saveState(); closeAll(); renderAstList(); $1('new-ast-name').value = ''; toast('<i class="ph-fill ph-check-circle"></i> 已创建');
});

// ==================== CHAT PAGE ====================
function renderChatPage() {
  const a = getActiveAst(); if (!a) return goToAsts();
  const c = getActiveConv(a); const m = getModelInfo(a.modelId);
  $1('chat-asst-name').innerHTML = `${esc(a.name)}${a.conversations.length ? ` <i class="ph ph-chat-centered-text" style="font-weight:normal; opacity:0.8; margin-left:4px;"></i> ${a.conversations.length}` : ''}`;
  $1('chat-topic-name').textContent = c ? c.title : '新话题';
  $1('chat-nav-tokens').textContent = c ? `(${c.messages.length})` : '(0)';
  $1('model-chip-label').textContent = m.name;
  $1('model-chip-btn').querySelector('.micon').innerHTML = m.icon;
  const R_LABELS = { off: '关闭', low: 'Low', high: 'High', max: 'Max' };
  $1('reasoning-label').textContent = `推理：${R_LABELS[a.reasoningEffort] || a.reasoningEffort}`;
  renderMessages();
}

// ==================== MARKDOWN & MATH RENDERING ====================
if (window.markedKatex) marked.use(window.markedKatex({ throwOnError: false }));
marked.setOptions({ breaks: true, gfm: true });

const md = t => { 
  if (!t) return ''; 
  const text = String(t).replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$').replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  try { return marked.parse(text); } catch(e) { return esc(text).replace(/\n/g, '<br>'); }
};

function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre:not(.code-block-wrapper pre)').forEach(pre => {
    if (pre.dataset.enhanced) return; pre.dataset.enhanced = '1';
    const code = pre.querySelector('code');
    const lang = code?.className.match(/language-([a-zA-Z0-9_\-]+)/)?.[1] || 'text';
    const wrapper = document.createElement('div'); wrapper.className = 'code-block-wrapper collapsed';
    wrapper.innerHTML = `<div class="code-block-header"><span class="code-lang">${lang}</span><div class="code-btns"><button class="code-btn copy-btn"><i class="ph ph-copy"></i> 复制</button><button class="code-btn fold-btn">展开</button></div></div>`;
    pre.parentNode.insertBefore(wrapper, pre); wrapper.appendChild(pre);

    on(wrapper.querySelector('.copy-btn'), 'click', e => {
      e.stopPropagation(); copyText((code || pre).textContent || '').then(() => { 
        e.target.innerHTML = '<i class="ph ph-check"></i> 已复制'; 
        clearTimeout(e.target._t); 
        e.target._t = setTimeout(() => e.target.innerHTML = '<i class="ph ph-copy"></i> 复制', 1200); 
      });
    });
    on(wrapper.querySelector('.fold-btn'), 'click', e => {
      e.stopPropagation(); const isCol = wrapper.classList.toggle('collapsed'); e.target.textContent = isCol ? '展开' : '折叠';
    });
    if (code && !code.dataset.hl) { try { hljs.highlightElement(code); code.dataset.hl = '1'; } catch(e) {} }
  });
  container.querySelectorAll('table:not(.table-wrapper table)').forEach(table => {
      const wrapper = document.createElement('div'); wrapper.className = 'table-wrapper';
      table.parentNode.insertBefore(wrapper, table); wrapper.appendChild(table);
  });
}

function makeMsg(msg, idx) {
  const isAi = msg.role === 'assistant';
  const d = document.createElement('div'); d.className = `msg ${isAi ? 'ai' : 'user'}`; d.dataset.index = idx;

  const isNote = !!msg.isNote;
  const rLabel = isNote ? '<i class="ph ph-note-pencil"></i> 消息备注' : '<i class="ph ph-brain"></i> 思考过程';
  const rHTML = msg.reasoning ? `<div class="rblock"><button class="rhead"><span>${rLabel}</span><i class="ph ph-caret-right arr"></i></button><div class="rbody">${esc(msg.reasoning)}</div></div>` : '';
  const mInfo = getModelInfo(msg.modelId || getActiveAst()?.modelId);
  const badgeHtml = mInfo.custom ? `<i class="ph-fill ph-sparkle"></i> ${esc(mInfo.name)}` : `${mInfo.icon} ${mInfo.name}`;
  
  const aiActions = `<button data-a="cp" title="复制"><i class="ph ph-copy"></i></button><button data-a="ed" title="编辑"><i class="ph ph-pencil-simple"></i></button><button data-a="del" title="删除"><i class="ph ph-trash"></i></button><button data-a="re" title="重新生成"><i class="ph ph-arrows-clockwise"></i></button>`;
  const userActions = `<button data-a="cp" title="复制"><i class="ph ph-copy"></i></button><button data-a="ed" title="编辑"><i class="ph ph-pencil-simple"></i></button><button data-a="del" title="删除"><i class="ph ph-trash"></i></button><button data-a="re" title="重新发送"><i class="ph ph-arrow-u-up-left"></i></button>`;

  const tokenDisplay = isAi ? '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg)) : '';
  const timeDisplay = isAi ? `<span class="gen-time"><i class="ph ph-timer"></i> ${msg.genTime || (msg.startTime ? ((Date.now()-msg.startTime)/1000).toFixed(0) : '0')}s</span>` : '';

  d.innerHTML = `<div class="bubble">${rHTML}<div class="markdown-body">${md(msg.content)}</div></div>
    <div class="msg-actions">
      <div class="actions-left">${isAi ? `<span class="badge">${badgeHtml}</span>${timeDisplay}` : ''}</div>
      <div class="msg-tokens">${tokenDisplay}</div>
      <div class="actions-right">${isAi ? aiActions : userActions}</div>
    </div>`;
  enhanceCodeBlocks(d); return d;
}

on('messages', 'click', async e => {
  const hint = e.target.closest('.welcome-hint'); if (hint) { $1('user-input').value = hint.dataset.prompt; return sendMessage(); }
  const rhead = e.target.closest('.rhead'); if (rhead) { rhead.classList.toggle('open'); rhead.nextElementSibling.classList.toggle('open'); return; }
  const btn = e.target.closest('button[data-a]');
  if (btn) {
    e.stopPropagation(); const act = btn.dataset.a, idx = parseInt(btn.closest('.msg').dataset.index, 10), conv = getActiveConv(), msg = conv.messages[idx];
    if (act === 'cp') return copyText(msg.content).then(() => toast('<i class="ph-fill ph-check-circle"></i> 已复制'));
    if (streaming) return toast('<i class="ph-fill ph-warning-circle"></i> 生成中不可操作');
    if (act === 'ed') openEditModal(msg);
    else if (act === 'del') deleteMessage(idx);
    else if (act === 're') retryMessage(idx, msg.role === 'assistant');
  }
});

async function deleteMessage(idx) {
  const conv = getActiveConv(); if (!conv || idx < 0 || idx >= conv.messages.length) return;
  if (!await showConfirm('确定要删除这条消息吗？')) return;
  conv.messages.splice(idx, 1); saveState(); renderChatPage();
}

async function retryMessage(idx, isAi) {
  const conv = getActiveConv(); if (!conv) return;
  if (!await showConfirm(`确定要重新${isAi ? '生成此回复' : '发送这条消息'}吗？`)) return;
  let targetIdx = idx;
  if (isAi) {
    while (targetIdx >= 0 && conv.messages[targetIdx].role !== 'user') targetIdx--;
    if (targetIdx < 0) return toast('无法重新生成：缺少关联的用户消息');
  }
  const userMsgContent = conv.messages[targetIdx].content;
  conv.messages = conv.messages.slice(0, targetIdx); 
  const input = $1('user-input'); input.value = userMsgContent; 
  saveState(); renderChatPage(); input.dispatchEvent(new Event('input')); sendMessage();
}

function renderMessages() {
  const msgs = $1('messages'), c = getActiveConv(); msgs.innerHTML = '';
  if (!c || c.messages.length === 0) {
    msgs.innerHTML = `<div class="welcome"><div class="emoji"><i class="ph-fill ph-sparkle"></i></div><h3>开始对话</h3><p>输入消息，点击发送按钮开始</p><div class="welcome-hints"><div class="welcome-hint" data-prompt="用简单的语言解释量子计算"><i class="ph ph-microscope"></i> 解释量子计算</div><div class="welcome-hint" data-prompt="写一首关于夏天的中国古诗"><i class="ph ph-pen-nib"></i> 写一首古诗</div><div class="welcome-hint" data-prompt="用Python写一个贪吃蛇游戏"><i class="ph ph-code"></i> 写贪吃蛇游戏</div><div class="welcome-hint" data-prompt="给我一个一周健身计划"><i class="ph ph-barbell"></i> 健身计划</div></div></div>`;
    return;
  }
  c.messages.forEach((m, i) => msgs.appendChild(makeMsg(m, i)));
}

// ==================== EDIT MODAL ====================
function openEditModal(msg) { 
  editingMsg = msg;
  $1('edit-textarea').value = msg.content || ''; 
  $1('edit-reasoning-textarea').value = msg.reasoning || '';
  
  const isNoteMode = !msg.reasoning || msg.isNote;
  $1('edit-toggle-reasoning-btn').innerHTML = isNoteMode ? '<i class="ph ph-note-pencil"></i> 消息备注' : '<i class="ph ph-brain"></i> 思考过程';
  $1('edit-reasoning-textarea').placeholder = isNoteMode ? '输入消息备注…' : '输入思考过程…';
  
  $1('edit-reasoning-textarea').classList.remove('show');
  $1('edit-toggle-reasoning-btn').classList.remove('active');
  
  $1('edit-overlay').classList.add('show'); 
}

function closeEditModal() { $1('edit-overlay').classList.remove('show'); editingMsg = null; }

function saveEdit() {
  if (!editingMsg) return; 
  const val = $1('edit-textarea').value.trim(); 
  const rval = $1('edit-reasoning-textarea').value.trim();
  if (!val && !rval) return toast('内容不能为空');
  
  const isNoteMode = $1('edit-toggle-reasoning-btn').innerHTML.includes('备注');
  editingMsg.content = val; editingMsg.reasoning = rval || '';
  
  if (rval) { if (isNoteMode) editingMsg.isNote = true; else delete editingMsg.isNote; } else delete editingMsg.isNote;
  
  saveState(); renderChatPage(); closeEditModal(); toast('<i class="ph-fill ph-check-circle"></i> 已保存');
}

on('edit-cancel-btn', 'click', closeEditModal); on('edit-save-btn', 'click', saveEdit);
on('edit-textarea', 'keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); } });
on('edit-reasoning-textarea', 'keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); } });
on('edit-toggle-reasoning-btn', 'click', () => {
  const ta = $1('edit-reasoning-textarea'), btn = $1('edit-toggle-reasoning-btn');
  const isShow = ta.classList.toggle('show'); btn.classList.toggle('active', isShow);
  if (isShow) ta.focus();
});

// ==================== TOPIC LIST ====================
function renderTopicList() {
  const a = getActiveAst(), l = $1('topic-list');
  if (!a || !a.conversations.length) { l.innerHTML = '<div class="empty">暂无话题</div>'; $1('drawer-total-tokens').textContent = '0'; return; }
  
  let totalTokens = 0;
  l.innerHTML = a.conversations.map(c => {
    const tok = calcConvContextTokens(c, a.systemPrompt); totalTokens += tok;
    return `<div class="topic-item ${c.id === a.activeConvId ? 'active' : ''}" data-cid="${c.id}">
      <span><i class="ph ph-chat-teardrop-text"></i></span>
      <div class="tinfo">
        <div class="ttitle-wrap"><div class="ttitle">${esc(c.title)}</div><span class="nav-tokens">${formatK(tok)}</span></div>
        <div class="tmeta">${c.messages.length} 条消息</div>
      </div>
      <button class="ast-more topic-more" title="话题操作"><i class="ph ph-dots-three-vertical"></i></button>
    </div>`;
  }).join('');
  $1('drawer-total-tokens').textContent = formatK(totalTokens);
}

function handleTopicMore(cid, btn) {
  const a = getActiveAst(); if (!a) return;
  const convIdx = a.conversations.findIndex(c => c.id === cid);
  if (convIdx < 0) return;
  const conv = a.conversations[convIdx];

  const items =[
    { label: '重命名话题', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' },
    { label: '复制话题', value: 'copy', icon: '<i class="ph ph-copy"></i>' },
    ...(convIdx > 0 ?[{ label: '上移', value: 'order_up', icon: '<i class="ph ph-arrow-up"></i>' }] : []),
    ...(convIdx < a.conversations.length - 1 ?[{ label: '下移', value: 'order_down', icon: '<i class="ph ph-arrow-down"></i>' }] :[]),
    { label: '删除话题', value: 'delete', icon: '<i class="ph ph-trash"></i>' }
  ];

  showDropdown(btn, items, async val => {
    if (val === 'rename') {
      const nt = await showInputPrompt('重命名话题', conv.title);
      if (nt && nt.trim() && nt.trim() !== conv.title) { 
        conv.title = nt.trim(); saveState(); renderChatPage(); renderTopicList(); 
      }
    } else if (val === 'copy') {
      const newConv = JSON.parse(JSON.stringify(conv)); 
      newConv.id = genId(); newConv.title = conv.title + ' 副本';
      a.conversations.splice(convIdx + 1, 0, newConv); 
      saveState(); renderTopicList(); toast('<i class="ph-fill ph-check-circle"></i> 已复制话题');
    } else if (val === 'order_up' || val === 'order_down') {
      const targetIdx = val === 'order_up' ? convIdx - 1 : convIdx + 1;[a.conversations[convIdx], a.conversations[targetIdx]] = [a.conversations[targetIdx], a.conversations[convIdx]];
      saveState(); renderTopicList();
    } else if (val === 'delete') {
      if (!await showConfirm('确定要删除此话题吗？')) return;
      a.conversations.splice(convIdx, 1);
      if (a.activeConvId === cid) a.activeConvId = a.conversations[0]?.id || null;
      saveState(); renderChatPage(); renderTopicList();
    }
  });
}

on('topic-list', 'click', async e => {
  const a = getActiveAst(); if (!a) return;
  const item = e.target.closest('.topic-item'); if (!item) return;
  const cid = item.dataset.cid;

  if (e.target.closest('.topic-more')) {
    e.stopPropagation(); return handleTopicMore(cid, e.target.closest('.topic-more'));
  }
  
  a.activeConvId = cid; saveState(); closeAll(); 
  renderChatPage(); renderTopicList(); 
  userScrolledUp = false; scrollBottom(true, false);
});

on('new-topic', 'click', () => { 
  const a = getActiveAst(); if (!a) return; 
  a.activeConvId = null; saveState(); closeAll(); 
  renderChatPage(); 
  userScrolledUp = false; scrollBottom(true, false);
});

// ==================== SETTINGS ====================
function renderSettings() {
  const a = getActiveAst(); if (!a) return;
  $1('settings-body').innerHTML = `
    <div class="section"><div class="field"><label>助手名称</label><input type="text" id="s-name" value="${esc(a.name)}"></div>
      <div class="field"><label>系统提示词</label><div class="relative"><textarea id="s-prompt" rows="4">${esc(a.systemPrompt)}</textarea><button id="s-prompt-fs-btn" class="icon-btn abs-top-right" title="全屏编辑"><i class="ph ph-corners-out"></i></button></div></div>
      <div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-sliders"></i> 高级参数 <i class="ph ph-caret-right arr"></i></button>
        <div class="settings-fold-body">
          <div class="field"><label>温度 Temperature：<strong id="s-tval">${a.temperature.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-temp" min="0" max="2" step=".05" value="${a.temperature}"><span class="slider-label">2</span></div><div class="hint">官方推荐：代码/数学 0.0 | 通用 1.3 | 创意 1.5</div></div>
          <div class="field"><label>Top P：<strong id="s-pval">${a.topP.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-topp" min="0" max="1" step=".05" value="${a.topP}"><span class="slider-label">1</span></div></div>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="settings-fold">
        <button class="settings-fold-head"><i class="ph ph-plugs"></i> API 密钥与模型设置 <i class="ph ph-caret-right arr"></i></button>
        <div class="settings-fold-body">
          <div class="field"><label>DeepSeek API Key</label><input type="password" id="s-dskey" value="${esc(state.deepseekKey)}" placeholder="sk-..."></div>
          <div class="field"><label>第三方 API Key (Gemini)</label><input type="password" id="s-gmkey" value="${esc(state.geminiKey || '')}" placeholder="sk-... / AIza..."></div>
          <div class="field"><label>第三方 API 地址</label><input type="text" id="s-gmurl" value="${esc(state.geminiBaseUrl || 'https://generativelanguage.googleapis.com')}" placeholder="https://generativelanguage.googleapis.com"></div>
          <div class="field"><label>第三方模型列表 (英文逗号分隔)</label><input type="text" id="s-gmmodels" value="${esc(state.geminiModels || 'gemini-2.5-pro, gemini-2.0-flash-thinking-exp')}" placeholder="gemini-2.5-pro, ..."></div>
        </div>
      </div>
    </div>
    <div class="section"><div class="t-row"><span id="theme-label">${state.darkMode ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'}</span><div class="tsw ${state.darkMode ? 'active' : ''}" id="s-theme"></div></div></div>
    <div class="section"><div class="data-actions"><button id="data-export"><i class="ph ph-upload-simple"></i> 导出备份</button><button id="data-import-btn"><i class="ph ph-download-simple"></i> 导入备份</button></div></div>
    <button class="btn-primary mt-8" id="s-save"><i class="ph ph-floppy-disk"></i> 保存设置</button>
  `;
}

on('settings-body', 'click', e => {
  if (e.target.closest('#data-export')) exportData();
  else if (e.target.closest('#data-import-btn')) $1('import-file').click();
  else if (e.target.closest('#s-save')) applyAndSaveSettings();
  else {
    const head = e.target.closest('.settings-fold-head'); if (head) head.parentElement.classList.toggle('open');
    const themeSw = e.target.closest('#s-theme');
    if (themeSw) { themeSw.classList.toggle('active'); $1('theme-label').innerHTML = themeSw.classList.contains('active') ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'; }
    const fsBtn = e.target.closest('#s-prompt-fs-btn');
    if (fsBtn) { $1('fs-prompt-textarea').value = $1('s-prompt').value; $1('fs-prompt-overlay').classList.add('show'); $1('fs-prompt-textarea').focus(); }
  }
});

on('settings-body', 'input', e => {
  if (e.target.id === 's-temp') $1('s-tval').textContent = parseFloat(e.target.value).toFixed(2);
  if (e.target.id === 's-topp') $1('s-pval').textContent = parseFloat(e.target.value).toFixed(2);
});

function applyAndSaveSettings() {
  const a = getActiveAst(); if (!a) return;
  const val = id => $1(id)?.value ?? null;
  if (val('s-name') !== null) a.name = val('s-name').trim() || a.name;
  if (val('s-prompt') !== null) a.systemPrompt = val('s-prompt').trim();
  if (val('s-temp') !== null) a.temperature = parseFloat(val('s-temp'));
  if (val('s-topp') !== null) a.topP = parseFloat(val('s-topp'));
  if (val('s-dskey') !== null) state.deepseekKey = val('s-dskey').trim();
  if (val('s-gmkey') !== null) state.geminiKey = val('s-gmkey').trim();
  if (val('s-gmurl') !== null) state.geminiBaseUrl = val('s-gmurl').trim();
  if (val('s-gmmodels') !== null) state.geminiModels = val('s-gmmodels').trim() || 'gemini-2.5-pro';
  if ($1('s-theme')) state.darkMode = $1('s-theme').classList.contains('active');
  saveState(); applyTheme(); renderChatPage(); renderAstList(); closeAll(); toast('<i class="ph-fill ph-check-circle"></i> 设置已保存');
}

function exportData() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const payload = { _meta: { version: 10, date: now.toISOString() }, data: state };
  const a = document.createElement('a'); 
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); 
  a.download = `ai-chat-backup-${dateStr}.json`; 
  a.click(); URL.revokeObjectURL(a.href); toast('<i class="ph-fill ph-check-circle"></i> 已导出备份');
}

on('import-file', 'change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const parsed = JSON.parse(ev.target.result);
      const data = parsed._meta ? parsed.data : parsed; 
      if (!Array.isArray(data.assistants)) throw new Error('Invalid format');
      
      if (await showConfirm('导入将“深度合并”数据（原有话题不会丢失，新分支将自动追加）')) {
        if (Array.isArray(data.groups)) {
          data.groups.forEach(g => { if (!state.groups.find(x => x.id === g.id || x.name === g.name)) { state.groups.push(g); }});
        }
        let importedAstCount = 0, importedConvCount = 0;
        data.assistants.forEach(importedA => {
          const fixed = fixAsst(importedA);
          const originGroup = (data.groups ||[]).find(g => g.id === fixed.groupId);
          let localGroup = state.groups.find(g => g.id === fixed.groupId);
          if (!localGroup && originGroup) localGroup = state.groups.find(g => g.name === originGroup.name);
          fixed.groupId = localGroup ? localGroup.id : 'default';

          let existing = state.assistants.find(a => a.id === fixed.id) || state.assistants.find(a => a.name.trim() === fixed.name.trim());
          if (existing) {
            fixed.conversations.forEach(ic => {
              const isExactSame = existing.conversations.some(c => c.id === ic.id && c.title === ic.title && c.messages.length === ic.messages.length);
              if (isExactSame) return; 
              const conflictById = existing.conversations.find(c => c.id === ic.id);
              if (conflictById) { ic.id = genId(); existing.conversations.push(ic); importedConvCount++; }
              else {
                const isDuplicateContent = existing.conversations.some(c => c.title === ic.title && c.messages.length === ic.messages.length && ic.messages.length > 0);
                if (isDuplicateContent) return; 
                existing.conversations.push(ic); importedConvCount++;
              }
            });
          } else { state.assistants.push(fixed); importedAstCount++; importedConvCount += fixed.conversations.length; }
        });
        Object.assign(state, {
          activeAstId: data.activeAstId ?? state.activeAstId, deepseekKey: data.deepseekKey ?? state.deepseekKey,
          geminiKey: data.geminiKey ?? state.geminiKey, geminiBaseUrl: data.geminiBaseUrl ?? state.geminiBaseUrl,
          geminiModels: data.geminiModels ?? state.geminiModels, darkMode: data.darkMode ?? state.darkMode
        });
        saveState(); applyTheme(); renderAstList(); goToAsts(); closeAll(); 
        toast(`<i class="ph-fill ph-check-circle"></i> 成功导入${importedAstCount}个助手${importedConvCount}个话题`);
      }
    } catch(err) { toast('<i class="ph-fill ph-warning-circle"></i> 文件格式错误或数据损坏'); console.error(err); }
  };
  reader.readAsText(file); e.target.value = '';
});

// FULLSCREEN PROMPT EDITOR
const setupPromptToolbar = ta => {
  const insert = (p, s = '') => { ta.setRangeText(p + ta.value.substring(ta.selectionStart, ta.selectionEnd) + s, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus(); ta.dispatchEvent(new Event('input')); };
  return { undo: () => { ta.focus(); document.execCommand('undo'); }, redo: () => { ta.focus(); document.execCommand('redo'); }, bold: () => insert('**', '**'), italic: () => insert('*', '*'), code: () => insert('`', '`'), heading: () => insert('## '), list: () => insert('- '), quote: () => insert('> ') };
};
const ptb = setupPromptToolbar($1('fs-prompt-textarea'));
on('fs-prompt-tb', 'click', e => { const btn = e.target.closest('button[data-md]'); if (btn && ptb[btn.dataset.md]) ptb[btn.dataset.md](); });
const closeFsPrompt = (save) => { if ($1('s-prompt')) $1('s-prompt').value = $1('fs-prompt-textarea').value; if (save) applyAndSaveSettings(); $1('fs-prompt-overlay').classList.remove('show'); };
on('fs-prompt-save', 'click', () => closeFsPrompt(true));
on('fs-prompt-close', 'click', () => closeFsPrompt(false));

// ==================== DROPDOWN ====================
// 使用 CSS visibility接管原先冗杂的 JS display 计算方式
function showDropdown(anchor, items, onSelect) {
  const dd = $1('dropdown-menu'); 
  dd.innerHTML = items.map((item, idx) => item.isHeader ? `<div class="dropdown-header">${item.label}</div>` : `<div class="dropdown-item ${item.selected ? 'selected' : ''}" data-idx="${idx}">${item.icon || ''}<span>${item.label}</span>${item.selected ? '<i class="ph ph-check check"></i>' : ''}</div>`).join('');
  
  const r = anchor.getBoundingClientRect(), mh = dd.offsetHeight;
  let top = r.top - mh - 4 > 0 ? r.top - mh - 4 : r.bottom + 4; 
  if (top + mh > window.innerHeight) top = window.innerHeight - mh - 10;
  
  dd.style.top = `${top}px`; 
  dd.style.left = `${Math.max(5, Math.min(r.left, window.innerWidth - dd.offsetWidth - 5))}px`;
  dd.classList.add('show');
  
  const clickHandler = e => { if (e.target.closest('.dropdown-header')) return; const item = e.target.closest('.dropdown-item'); if (item) onSelect(items[item.dataset.idx].value); hideDropdown(); off(document, 'click', clickHandler); };
  setTimeout(() => on(document, 'click', clickHandler), 10);
}
function hideDropdown() { $1('dropdown-menu').classList.remove('show'); }

on('model-chip-btn', 'click', e => {
  if (streaming) return toast('<i class="ph-fill ph-warning-circle"></i> 生成中不可切换模型');
  e.stopPropagation(); const ast = getActiveAst();
  const items =[
      { isHeader: true, label: 'DeepSeek API' }, ...DS_MODELS.map(m => ({ label: `${m.icon} ${m.name}`, value: m.id, selected: ast?.modelId === m.id })),
      { isHeader: true, label: '第三方 API' }, ...getCustomModels().map(name => ({ label: `<i class="ph-fill ph-sparkle"></i> ${name}`, value: name, selected: ast?.modelId === name }))
  ];
  showDropdown(e.currentTarget, items, id => { 
      if (ast) { 
          ast.modelId = id; const validOpts = isDeepSeek(id) ? ['off', 'high', 'max'] :['off', 'low', 'high'];
          if (!validOpts.includes(ast.reasoningEffort)) ast.reasoningEffort = (ast.reasoningEffort === 'max' ? 'high' : (ast.reasoningEffort === 'low' ? 'off' : 'off'));
          saveState(); renderChatPage(); toast('<i class="ph-fill ph-check-circle"></i> 已切换模型'); 
      } 
  });
});

on('reasoning-btn', 'click', e => {
  if (streaming) return toast('<i class="ph-fill ph-warning-circle"></i> 生成中不可切换推理设置');
  e.stopPropagation(); const ast = getActiveAst(), cur = ast?.reasoningEffort || 'off', isDs = isDeepSeek(ast?.modelId);
  const opts = isDs ?[{label: '关闭', value: 'off'}, {label: 'High', value: 'high'}, {label: 'Max', value: 'max'}] :[{label: '关闭', value: 'off'}, {label: 'Low', value: 'low'}, {label: 'High', value: 'high'}];
  showDropdown(e.currentTarget, opts.map(o => ({ ...o, selected: o.value === cur })), val => { 
      if (ast) { ast.reasoningEffort = val; saveState(); renderChatPage(); toast({ off:'推理已关闭', low:'推理深度：Low', high:'推理深度：High', max:'推理深度：Max' }[val] || ''); } 
  });
});

// ==================== CHAT LOGIC & SCROLL ====================
let isTouching = false;
const chatC = $1('chat-container');

chatC.addEventListener('touchstart', () => isTouching = true, { passive: true });
chatC.addEventListener('touchend', () => isTouching = false, { passive: true });
chatC.addEventListener('touchcancel', () => isTouching = false, { passive: true });
chatC.addEventListener('mousedown', () => isTouching = true, { passive: true });
window.addEventListener('mouseup', () => isTouching = false, { passive: true });
chatC.addEventListener('wheel', () => userScrolledUp = true, { passive: true });

on('chat-container', 'scroll', function() { 
  const dist = this.scrollHeight - this.scrollTop - this.clientHeight;
  if (dist <= 25) userScrolledUp = false; else if (isTouching) userScrolledUp = true;
  $1('scroll-down').classList.toggle('show', dist > 200 && $1('messages').children.length > 1); 
});

const scrollBottom = (force, smooth = false) => {
  if (force || (!userScrolledUp && !isTouching)) {
    requestAnimationFrame(() => { chatC.scrollTo({ top: chatC.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); });
  }
};

const setStreamingUI = stream => { 
  const sendBtn = $1('send-btn'), inp = $1('user-input');
  sendBtn.classList.toggle('hidden', stream);
  inp.disabled = stream;
  $1('stop-btn').classList.toggle('hidden', !stream);
};

function updateLive(idx, msg) {
  const bub = document.querySelector(`#messages .msg.ai[data-index="${idx}"] .bubble`); if (!bub) return;
  const isThinking = msg.content.length === 0; 
  if (msg.reasoning) { 
      let rb = bub.querySelector('.rblock');
      if (!rb) { 
          bub.insertAdjacentHTML('afterbegin', '<div class="rblock"><button class="rhead open"><span><i class="ph ph-brain"></i> 思考过程</span><i class="ph ph-caret-right arr"></i></button><div class="rbody open"></div></div>'); 
          rb = bub.querySelector('.rblock');
      }
      if (!isThinking && !rb.dataset.autoClosed) {
          rb.querySelector('.rhead').classList.remove('open'); rb.querySelector('.rbody').classList.remove('open'); 
          rb.dataset.autoClosed = '1';
      }
      rb.querySelector('.rbody').textContent = msg.reasoning;
  }
  let mc = bub.querySelector('.markdown-body');
  if (!mc) { bub.insertAdjacentHTML('beforeend', '<div class="markdown-body"></div>'); mc = bub.querySelector('.markdown-body'); }
  mc.innerHTML = md(msg.content); enhanceCodeBlocks(bub);
  const tokensEl = document.querySelector(`#messages .msg[data-index="${idx}"] .msg-tokens`);
  if (tokensEl) tokensEl.innerHTML = '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg));
}

function getApiConfig(a, c) {
  if (isDeepSeek(a.modelId)) {
    const body = { model: a.modelId, stream: true, messages:[{ role: 'system', content: a.systemPrompt }, ...c.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }))] };
    if (a.reasoningEffort === 'off') Object.assign(body, { temperature: a.temperature, top_p: a.topP, thinking: { type: 'disabled' } }); else Object.assign(body, { reasoning_effort: a.reasoningEffort, thinking: { type: 'enabled' } });
    return { url: 'https://api.deepseek.com/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.deepseekKey}` }, body };
  } else {
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': state.geminiKey };
    if (state.geminiKey.startsWith('sk-') || state.geminiKey.startsWith('Bearer ')) headers['Authorization'] = state.geminiKey.startsWith('Bearer ') ? state.geminiKey : `Bearer ${state.geminiKey}`;
    const contents =[];
    for (const m of c.messages.slice(0, -1)) {
      const role = m.role === 'user' ? 'user' : 'model', parts = (m.thoughtSignatures ||[]).map(sig => ({ thoughtSignature: sig })); parts.push({ text: m.content || ' ' });
      if (contents.length > 0 && contents[contents.length - 1].role === role) contents[contents.length - 1].parts.push(...parts); else contents.push({ role, parts });
    }
    const body = { contents, generationConfig: { temperature: a.temperature, topP: a.topP } };
    if (a.systemPrompt) body.systemInstruction = { role: "system", parts: [{ text: a.systemPrompt }] };
    if (a.reasoningEffort !== 'off') body.generationConfig.thinkingConfig = a.modelId.includes('gemini-3') ? { includeThoughts: true, thinkingLevel: a.reasoningEffort === 'low' ? 'LOW' : 'HIGH' } : { includeThoughts: true, thinkingBudget: a.reasoningEffort === 'low' ? 1024 : 8192 };
    return { url: `${(state.geminiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')}/v1beta/models/${a.modelId}:streamGenerateContent?alt=sse`, headers, body };
  }
}

function parseChunk(modelId, chunk, am) {
  if (!isDeepSeek(modelId)) {
    for (const part of (chunk.candidates?.[0]?.content?.parts ||[])) {
      if (part.thoughtSignature || part.thought_signature) { am.thoughtSignatures ??=[]; am.thoughtSignatures.push(part.thoughtSignature || part.thought_signature); }
      if (part.thought === true || String(part.thought) === "true") am.reasoning += (part.text || ''); else if (part.text) am.content += part.text;
    }
  } else {
    const delta = chunk.choices?.[0]?.delta; if (!delta) return;
    if (delta.reasoning_content) am.reasoning += delta.reasoning_content;
    if (delta.content) am.content += delta.content;
  }
}

async function sendMessage() {
  if (streaming) return;
  const inputEl = $1('user-input'), txt = inputEl.value.trim(); if (!txt) return;
  const a = getActiveAst(); if (!a) return;
  
  if (isDeepSeek(a.modelId)) { if (!state.deepseekKey) return toast('<i class="ph-fill ph-warning-circle"></i> 请先设置 DeepSeek API Key') || openSettings(); } 
  else { if (!state.geminiKey) return toast('<i class="ph-fill ph-warning-circle"></i> 请先设置 第三方 API Key') || openSettings(); }
  
  inputEl.value = ''; inputEl.style.height = 'auto';
  const c = ensureConv(a); c.messages.push({ role: 'user', content: txt });
  if (c.title === '新话题') c.title = txt.substring(0, 28) + (txt.length > 28 ? '…' : '');
  
  userScrolledUp = false; saveState(); renderMessages(); scrollBottom(true, true);

  const am = { role: 'assistant', content: '', reasoning: '', genTime: null, modelId: a.modelId };
  c.messages.push(am); const ai = c.messages.length - 1;
  saveState(); renderMessages(); setStreamingUI(true); streaming = true;
  $1('chat-nav-tokens').textContent = `(${c.messages.length})`;

  const { url, headers, body } = getApiConfig(a, c);
  abortCtrl = new AbortController(); let genTimer;

  try {
    am.startTime = Date.now();
    genTimer = setInterval(() => {
      const el = document.querySelector(`#messages .msg.ai[data-index="${ai}"] .gen-time`);
      if (el) el.innerHTML = `<i class="ph ph-timer"></i> ${((Date.now() - am.startTime) / 1000).toFixed(0)}s`;
    }, 1000);

    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abortCtrl.signal });
    if (!resp.ok) { let em = `HTTP ${resp.status}`; try { em = (await resp.json()).error?.message || em; } catch(e){} throw new Error(em); }
    
    const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
      for (let t of lines) {
        t = t.trim(); if (!t || !t.startsWith('data: ')) continue;
        const dataStr = t.slice(6); if (dataStr === '[DONE]') continue;
        try { 
          parseChunk(a.modelId, JSON.parse(dataStr), am); 
          $1('chat-nav-tokens').textContent = `(${c.messages.length})`; 
          updateLive(ai, am); scrollBottom(false, false); 
        } catch(e) {}
      }
    }
  } catch (err) { if (err.name !== 'AbortError') am.content = am.content || `❌ 错误：${err.message}`; }
  finally {
    streaming = false; abortCtrl = null; setStreamingUI(false);
    if (genTimer) clearInterval(genTimer);
    am.genTime = am.startTime ? ((Date.now() - am.startTime) / 1000).toFixed(0) : null;
    delete am.startTime; saveState(); renderChatPage();
  }
}

// ==================== BINDINGS ====================
const openSheet = id => { closeDrawers(); $1('overlay').classList.add('show'); $1(id).classList.add('open'); };
const openDrawer = id => { $1('overlay').classList.add('show'); $1(id).classList.add('open'); };
const closeDrawers = () =>['topics-drawer','settings-drawer','add-ast-sheet'].forEach(id => $1(id).classList.remove('open'));
const closeAll = () => { hideDropdown(); $1('overlay').classList.remove('show'); closeDrawers(); };
const openSettings = () => { renderSettings(); openDrawer('settings-drawer'); };

on('send-btn', 'click', sendMessage);
on('stop-btn', 'click', () => abortCtrl?.abort());
on('user-input', 'keydown', function(e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); } });
on('user-input', 'input', function() { this.style.height = 'auto'; this.style.height = `${Math.min(this.scrollHeight, 220)}px`; });

on('scroll-down', 'click', () => { userScrolledUp = false; scrollBottom(true, false); });
on('chat-back', 'click', goToAsts);
on('topic-toggle', 'click', e => { e.stopPropagation(); renderTopicList(); openDrawer('topics-drawer'); });
on('settings-btn', 'click', openSettings);
on('close-topics', 'click', closeAll);
on('close-settings', 'click', closeAll);
on('overlay', 'click', closeAll);

await IDB.init().catch(console.error);
await loadState(); setupPWA(); applyTheme(); renderAstList(); 
state.activeAstId = null; saveState();
history.replaceState({ page: 'home' }, '');

window.addEventListener('popstate', e => {
  closeAll(); 
  if (e.state?.page === 'chat') goToChat(e.state.id, true);
  else goToAsts(true);
});
})();
