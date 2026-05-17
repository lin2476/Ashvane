(async () => {
'use strict';

// 1. Utils & Context
const $1 = s => document.getElementById(s);
const on = (el, evt, cb, opts) => (typeof el === 'string' ? $1(el) : el)?.addEventListener(evt, cb, opts);
const off = (el, evt, cb) => (typeof el === 'string' ? $1(el) : el)?.removeEventListener(evt, cb);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = t => t ? String(t).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])) : '';
const pad0 = n => n.toString().padStart(2, '0');
const getBackupName = () => { const d = new Date(); return `AIChatBackup-${d.getFullYear()}-${pad0(d.getMonth()+1)}${pad0(d.getDate())}-${pad0(d.getHours())}${pad0(d.getMinutes())}.json`; };
const getTokens = str => { if (!str) return 0; const zh = (str.match(/[\u4e00-\u9fa5]/g) || []).length; return Math.ceil(zh + (str.length - zh) * 0.25); };
const getMsgTokens = m => getTokens(m.content) + getTokens(m.reasoning);
const formatK = t => t < 1000 ? t : (t / 1000).toFixed(1) + 'k';

const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_GM_URL = 'https://generativelanguage.googleapis.com';

// 2. State & DB
const STORE_KEY = 'ai_chat_v8';
const IDB = {
  db: null,
  init: () => new Promise((res, rej) => {
    const req = indexedDB.open('AIChatDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('store');
    req.onsuccess = e => { IDB.db = e.target.result; res(); };
    req.onerror = e => rej(e.target.error);
  }),
  exec: (m, f, a) => new Promise((res, rej) => {
    if (!IDB.db) return res(null);
    const req = IDB.db.transaction('store', m).objectStore('store')[f](...a);
    req.onsuccess = () => res(f === 'get' ? req.result : undefined);
    req.onerror = e => rej(e.target.error);
  }),
  get: k => IDB.exec('readonly', 'get', [k]),
  set: (k, v) => IDB.exec('readwrite', 'put', [v, k])
};

let state = {
  assistants: [{ id: 'default-ast', name: '全能助手', systemPrompt: '你是一个高通用性、严谨且富有协作精神的AI助手。你的核心目标不是扮演特定角色，而是动态适配用户的真实需求。', temperature: 1.0, topP: 1.0, modelId: DEFAULT_MODEL, reasoningEffort: 'off', conversations: [], activeConvId: null }], 
  activeAstId: null, deepseekKey: '', geminiKey: '', geminiBaseUrl: DEFAULT_GM_URL, geminiModels: 'gemini-2.0-pro-exp-02-05, gemini-2.0-flash', darkMode: false, webdavUser: '', webdavToken: ''
};

let abortCtrl = null, streaming = false, editingMsg = null, userScrolledUp = false;

// 优化图标生成逻辑，确保彩色图标能正常显示
const svgIco = (n, c) => c 
  ? `<img src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}-color.svg" style="width:1.2em; height:1.2em; vertical-align:middle; display:inline-block;">` 
  : `<span style="display:inline-block; width:1.1em; height:1.1em; background-color:currentColor; -webkit-mask:url('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}.svg') center/contain no-repeat; mask:url('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}.svg') center/contain no-repeat; vertical-align:middle;"></span>`;

const IC_DS_C = svgIco('deepseek', 1), IC_DS_M = svgIco('deepseek', 0);
const IC_GM_C = svgIco('gemini', 1), IC_GM_M = svgIco('gemini', 0);
const DS_MODELS = [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', icC: IC_DS_C, icM: IC_DS_M }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', icC: IC_DS_C, icM: IC_DS_M }];

const getModelInfo = id => {
  const m = DS_MODELS.find(m => m.id === id); 
  if (m) return { ...m, iconColor: m.icC, iconMono: m.icM };
  const nid = (id || '').toLowerCase();
  if (nid.includes('gemini')) return { iconColor: IC_GM_C, iconMono: IC_GM_M, name: id, custom: true };
  if (nid.includes('deepseek')) return { iconColor: IC_DS_C, iconMono: IC_DS_M, name: id, custom: true };
  const ic = '<i class="ph-fill ph-sparkle" style="vertical-align:middle;"></i>';
  return { iconColor: ic.replace('style', 'color:var(--accent); style'), iconMono: ic, name: id, custom: true };
};

const isDeepSeek = id => DS_MODELS.some(m => m.id === id) || (id || '').toLowerCase().includes('deepseek');
const getCustomModels = () => (state.geminiModels || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadState() {
  try {
    let p = await IDB.get(STORE_KEY) || JSON.parse(localStorage.getItem(STORE_KEY));
    if (p) { delete p.groups; state = { ...state, ...p }; await IDB.set(STORE_KEY, state); }
  } catch(e) {}
  state.assistants = state.assistants.map(fixAsst);
  if (!state.assistants.length) state.assistants.push(fixAsst({ id: 'default-ast', name: '全能助手', systemPrompt: '你是一个AI助手。' }));
}

let saveTimer = null;
const saveState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => IDB.set(STORE_KEY, state).catch(() => toast('存储失败')), 300); };

const fixAsst = a => ({
  ...a, id: a.id || genId(), name: a.name || '未命名助手', systemPrompt: a.systemPrompt || '', 
  temperature: a.temperature ?? 1.0, topP: a.topP ?? 1.0, modelId: a.modelId || DEFAULT_MODEL, reasoningEffort: a.reasoningEffort || 'off', 
  conversations: (a.conversations || []).map(c => ({ ...c, id: c.id || genId(), title: c.title || '新话题', messages: (c.messages || []).map(m => ({ ...m, genTime: m.genTime || m.reasoningTime })) }))
});

const getActiveAst = () => state.assistants.find(a => a.id === state.activeAstId) || null;
const getActiveConv = (a = getActiveAst()) => a?.conversations.find(c => c.id === a.activeConvId) || null;

function ensureConv(a) {
  let c = getActiveConv(a);
  if (!c) { c = { id: genId(), title: '新话题', messages: [] }; a.conversations.unshift(c); a.activeConvId = c.id; saveState(); }
  return c;
}

// 3. UI Helpers
function toast(m, d = 2500) {
  const t = $1('toast'); if(!t) return;
  t.innerHTML = m; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), d);
}

async function copyText(text) {
  try { if (navigator.clipboard) return await navigator.clipboard.writeText(text); } catch(e) {}
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta); ta.select(); 
  try { document.execCommand('copy'); } catch(e) {} document.body.removeChild(ta);
}

function showDialog(msg, isInput = false, defaultVal = '') {
  return new Promise(resolve => {
    $1('dialog-msg').textContent = msg; 
    const inp = $1('dialog-input');
    $1('dialog-input-wrap').classList.toggle('hidden', !isInput); inp.value = isInput ? defaultVal : '';
    $1('dialog-overlay').classList.add('show'); 
    if (isInput) inp.focus();
    const cleanup = () => { $1('dialog-overlay').classList.remove('show'); off('dialog-ok', 'click', onOk); off('dialog-cancel', 'click', onCancel); off(inp, 'keydown', onKey); };
    const onOk = () => { cleanup(); resolve(isInput ? inp.value : true); }; 
    const onCancel = () => { cleanup(); resolve(isInput ? null : false); };
    const onKey = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    on('dialog-ok', 'click', onOk); on('dialog-cancel', 'click', onCancel); if (isInput) on(inp, 'keydown', onKey);
  });
}

function applyTheme() { 
  document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light'); 
  const ht = $1('hljs-theme'); if (ht) ht.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github${state.darkMode ? '-dark' : ''}.min.css`; 
}

function toggleDrawer(side, forceState) {
  const app = $1('app'); if (!app) return;
  const isLeft = side === 'left', cls = isLeft ? 'left-open' : 'right-open', opp = isLeft ? 'right-open' : 'left-open';
  const open = forceState !== undefined ? forceState : !app.classList.contains(cls);
  app.classList.toggle(cls, open); if (open) app.classList.remove(opp);
}

const closeDrawers = () => document.querySelectorAll('.sheet, .topics-modal').forEach(el => el.classList.remove('open'));
const closeAll = (fromPopState = false) => { 
  hideDropdown(); 
  const wasSheetOpen = $1('sheet-overlay')?.classList.contains('show');
  $1('sheet-overlay')?.classList.remove('show');
  if (window.innerWidth <= 768) { toggleDrawer('left', false); toggleDrawer('right', false); }
  closeDrawers(); 
  if (wasSheetOpen && !fromPopState && history.state?.drawer) { ignoreNextPopState = true; history.back(); }
};

const openSheet = id => { closeDrawers(); $1('sheet-overlay')?.classList.add('show'); $1(id)?.classList.add('open'); if (!history.state?.drawer) history.pushState({ ...history.state, drawer: true }, ''); };
function goToChat(id, fromHistory = false) { state.activeAstId = id; saveState(); if (!fromHistory) history.pushState({ page: 'chat', id }, ''); renderChatPage(); renderAstList(); closeAll(); userScrolledUp = false; scrollBottom(true, false); }

// 4. Renderers
function renderAstList() {
  const l = $1('ast-list'); if (!l) return;
  if (!state.assistants.length) return l.innerHTML = '<div class="empty"><i class="ph ph-ghost empty-icon"></i> 还没有助手，点击右上角 ＋ 创建</div>';
  l.innerHTML = state.assistants.map(a => `<div class="ast-card ${a.id === state.activeAstId ? 'active' : ''}" data-id="${a.id}"><div class="ast-name">${esc(a.name)}</div><button class="ast-more"><i class="ph ph-dots-three-vertical"></i></button></div>`).join('');
}

function handleAstMore(id, btn) {
  if (streaming) return toast('生成中不可操作');
  const card = btn.closest('.ast-card');
  card?.classList.add('menu-active'); // 添加高亮类

  const idx = state.assistants.findIndex(a => a.id === id); if (idx < 0) return;
  const items = [{ label: '删除助手', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  if (idx > 0) items.push({ label: '上移', value: 'up', icon: '<i class="ph ph-arrow-up"></i>' });
  if (idx < state.assistants.length - 1) items.push({ label: '下移', value: 'down', icon: '<i class="ph ph-arrow-down"></i>' });

  showDropdown(btn, items, async val => {
    if (val === 'delete' && await showDialog('确定要删除此助手吗？')) { 
      state.assistants.splice(idx, 1); 
      if (state.activeAstId === id) state.activeAstId = state.assistants[0]?.id; 
      renderChatPage();
    } else if (val === 'up' || val === 'down') { 
      const t = val === 'up' ? idx - 1 : idx + 1; 
      [state.assistants[idx], state.assistants[t]] = [state.assistants[t], state.assistants[idx]]; 
    } 
    saveState(); renderAstList();
  }, () => card?.classList.remove('menu-active')); // 菜单关闭时移除高亮
}

function renderChatPage() {
  let a = getActiveAst(); 
  if (!a && state.assistants.length > 0) { state.activeAstId = state.assistants[0].id; a = getActiveAst(); }
  if (!a) {
    if ($1('chat-asst-name')) $1('chat-asst-name').innerHTML = '无助手';
    if ($1('chat-topic-name')) $1('chat-topic-name').textContent = '暂无话题';
    if ($1('messages')) $1('messages').innerHTML = '<div class="welcome"><div class="emoji"><i class="ph-fill ph-ghost"></i></div><h3>没有助手</h3><p>点击左侧栏 + 号创建一个</p></div>';
    return;
  }

  const c = getActiveConv(a), m = getModelInfo(a.modelId);
  if ($1('chat-asst-name')) $1('chat-asst-name').innerHTML = esc(a.name);
  if ($1('chat-topic-name')) $1('chat-topic-name').textContent = c ? c.title : '新话题'; 
  if ($1('chat-nav-tokens')) $1('chat-nav-tokens').textContent = `(${c ? c.messages.length : 0})`;
  if ($1('model-chip-btn')) $1('model-chip-btn').innerHTML = m.iconColor;
  if ($1('reasoning-btn')) $1('reasoning-btn').innerHTML = `<i class="ph ph-brain"></i><span>${{ off: '关闭', low: 'Low', high: 'High', max: 'Max' }[a.reasoningEffort] || a.reasoningEffort}</span>`;
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
    const wrapper = document.createElement('div'); wrapper.className = 'code-block-wrapper';
    wrapper.innerHTML = `<div class="code-block-header"><span class="code-lang">${lang}</span><div class="code-btns"><button class="code-btn copy-btn"><i class="ph ph-copy"></i> 复制</button><button class="code-btn fold-btn">折叠</button></div></div>`;
    pre.replaceWith(wrapper); wrapper.appendChild(pre);
    
    on(wrapper.querySelector('.copy-btn'), 'click', e => { 
      e.stopPropagation(); copyText((code || pre).textContent || '').then(() => { e.target.innerHTML = '<i class="ph ph-check"></i> 已复制'; setTimeout(() => e.target.innerHTML = '<i class="ph ph-copy"></i> 复制', 1200); }); 
    });
    on(wrapper.querySelector('.fold-btn'), 'click', e => { e.stopPropagation(); e.target.textContent = wrapper.classList.toggle('collapsed') ? '展开' : '折叠'; });
    if (code && window.hljs) { try { hljs.highlightElement(code); } catch(e) {} }
  });
  c.querySelectorAll('table:not(.table-wrapper table)').forEach(t => { const w = document.createElement('div'); w.className = 'table-wrapper'; t.replaceWith(w); w.appendChild(t); });
}

function makeMsg(msg, idx) {
  const isAi = msg.role === 'assistant';
  const d = document.createElement('div'); d.className = `msg ${isAi ? 'ai' : 'user'}`; d.dataset.index = idx;
  const rHTML = msg.reasoning ? `<div class="rblock"><button class="rhead"><span>${msg.isNote ? '<i class="ph ph-note-pencil"></i> 消息备注' : '<i class="ph ph-brain"></i> 思考过程'}</span><i class="ph ph-caret-right arr"></i></button><div class="rbody">${esc(msg.reasoning)}</div></div>` : '';
  const mInfo = getModelInfo(msg.modelId || getActiveAst()?.modelId);
  const acts = `<button data-a="cp"><i class="ph ph-copy"></i></button><button data-a="ed"><i class="ph ph-pencil-simple"></i></button><button data-a="del"><i class="ph ph-trash"></i></button><button data-a="re"><i class="ph ${isAi ? 'ph-arrows-clockwise' : 'ph-arrow-u-up-left'}"></i></button>`;
  
  d.innerHTML = `<div class="bubble">${rHTML}<div class="markdown-body">${md(msg.content)}</div></div><div class="msg-actions"><div class="actions-left">${isAi ? `<span class="badge">${mInfo.iconMono} ${esc(mInfo.name)}</span><span class="gen-time"><i class="ph ph-timer"></i> ${msg.genTime || (msg.startTime ? ((Date.now()-msg.startTime)/1000).toFixed(0) : '0')}s</span>` : ''}</div><div class="msg-tokens">${isAi ? '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg)) : ''}</div><div class="actions-right">${acts}</div></div>`;
  enhanceCodeBlocks(d); return d;
}

function renderMessages() {
  const msgs = $1('messages'); if(!msgs) return;
  const c = getActiveConv(); msgs.innerHTML = '';
  
  if (!c || !c.messages.length) return msgs.innerHTML = `<div class="welcome"><div class="emoji"><i class="ph-fill ph-sparkle"></i></div><h3>开始对话</h3><p>输入消息开始聊天</p><div class="welcome-hints"><div class="welcome-hint" data-prompt="解释量子纠缠"><i class="ph ph-microscope"></i> 解释量子纠缠</div><div class="welcome-hint" data-prompt="写一段Python爬虫代码"><i class="ph ph-code"></i> 爬虫代码</div></div></div>`;
  c.messages.forEach((m, i) => msgs.appendChild(makeMsg(m, i)));
  setTimeout(updateDensityMap, 50);
}

function renderTopicList() {
  const a = getActiveAst(), l = $1('topic-list'), dtk = $1('drawer-total-tokens'); if(!l) return;
  if (!a || !a.conversations.length) { l.innerHTML = '<div class="empty">暂无话题</div>'; if(dtk) dtk.textContent = '0'; return; }
  
  l.innerHTML = a.conversations.map(c => {
    return `<div class="topic-item ${c.id === a.activeConvId ? 'active' : ''}" data-cid="${c.id}"><span><i class="ph ph-chat-teardrop-text"></i></span><div class="tinfo"><div class="ttitle-wrap"><div class="ttitle">${esc(c.title)}</div></div><div class="tmeta">${c.messages.length} 条消息</div></div><button class="ast-more topic-more"><i class="ph ph-dots-three-vertical"></i></button></div>`;
  }).join('');
}

function renderSettings() {
  const a = getActiveAst(), sBody = $1('settings-body'); if (!a || !sBody) return;
  sBody.innerHTML = `<div class="section"><div class="field"><label>助手名称</label><input type="text" id="s-name" value="${esc(a.name)}"></div><div class="field"><label>系统提示词</label><div class="relative"><textarea id="s-prompt" rows="4">${esc(a.systemPrompt)}</textarea><button id="s-prompt-fs-btn" class="icon-btn abs-top-right"><i class="ph ph-corners-out"></i></button></div></div><div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-sliders"></i> 高级参数 <i class="ph ph-caret-right arr"></i></button><div class="settings-fold-body"><div class="field"><label>Temperature：<strong id="s-tval">${a.temperature.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-temp" min="0" max="2" step=".05" value="${a.temperature}"><span class="slider-label">2</span></div></div><div class="field"><label>Top P：<strong id="s-pval">${a.topP.toFixed(2)}</strong></label><div class="slider-row"><span class="slider-label">0</span><input type="range" id="s-topp" min="0" max="1" step=".05" value="${a.topP}"><span class="slider-label">1</span></div></div></div></div></div><div class="section"><div class="settings-fold"><button class="settings-fold-head"><i class="ph ph-plugs"></i> 接口设置 <i class="ph ph-caret-right arr"></i></button><div class="settings-fold-body"><div class="field"><label>DeepSeek Key</label><input type="password" id="s-dskey" value="${esc(state.deepseekKey)}"></div><div class="field"><label>Gemini Key</label><input type="password" id="s-gmkey" value="${esc(state.geminiKey || '')}"></div><div class="field"><label>Gemini 代理地址</label><input type="text" id="s-gmurl" value="${esc(state.geminiBaseUrl || DEFAULT_GM_URL)}"></div><div class="field"><label>Gemini 模型列表</label><input type="text" id="s-gmmodels" value="${esc(state.geminiModels || '')}"></div></div></div></div><div class="section"><div class="t-row"><span id="theme-label">${state.darkMode ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'}</span><div class="tsw ${state.darkMode ? 'active' : ''}" id="s-theme"></div></div></div><div class="section"><div class="data-actions"><button id="data-export"><i class="ph ph-upload-simple"></i> 导出备份</button><button id="data-import-btn"><i class="ph ph-download-simple"></i> 导入备份</button></div></div><button class="btn-primary mt-8" id="s-save">保存设置</button>`;
}

// 5. Chat & API Sync
function updateLive(msgEl, msg) {
  if (!msgEl) return; const bub = msgEl.querySelector('.bubble'); if (!bub) return;
  if (msg.reasoning) { 
    let rb = bub.querySelector('.rblock'); 
    if (!rb) { bub.insertAdjacentHTML('afterbegin', '<div class="rblock"><button class="rhead open"><span><i class="ph ph-brain"></i> 思考过程</span><i class="ph ph-caret-right arr"></i></button><div class="rbody open"></div></div>'); rb = bub.querySelector('.rblock'); }
    if (msg.content.length > 0 && !rb.dataset.autoClosed) { rb.querySelector('.rhead').classList.remove('open'); rb.querySelector('.rbody').classList.remove('open'); rb.dataset.autoClosed = '1'; }
    rb.querySelector('.rbody').textContent = msg.reasoning;
  }
  let mc = bub.querySelector('.markdown-body'); 
  if (!mc) { bub.insertAdjacentHTML('beforeend', '<div class="markdown-body"></div>'); mc = bub.querySelector('.markdown-body'); }
  mc.innerHTML = md(msg.content); enhanceCodeBlocks(bub);
  const tk = msgEl.querySelector('.msg-tokens'); if (tk) tk.innerHTML = '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg));
}

function getApiConfig(a, c) {
  const msgs = c.messages.slice(0, -1);
  if (isDeepSeek(a.modelId)) {
    const body = { model: a.modelId, stream: true, messages: [{ role: 'system', content: a.systemPrompt }, ...msgs.map(m => ({ role: m.role, content: m.content }))] };
    Object.assign(body, a.reasoningEffort === 'off' ? { temperature: a.temperature, top_p: a.topP } : { reasoning_effort: a.reasoningEffort });
    return { url: 'https://api.deepseek.com/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.deepseekKey}` }, body };
  } else {
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': state.geminiKey };
    const contents = msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content || ' ' }] }));
    const body = { contents, generationConfig: { temperature: a.temperature, topP: a.topP, thinkingConfig: a.reasoningEffort !== 'off' ? { includeThoughts: true } : undefined } };
    if (a.systemPrompt) body.systemInstruction = { parts: [{ text: a.systemPrompt }] };
    return { url: `${(state.geminiBaseUrl || DEFAULT_GM_URL).replace(/\/+$/, '')}/v1beta/models/${a.modelId}:streamGenerateContent?alt=sse`, headers, body };
  }
}

async function sendMessage() {
  if (streaming) return;
  const inputEl = $1('user-input'); if (!inputEl) return;
  const txt = inputEl.value.trim(), a = getActiveAst(); if (!txt || !a) return;
  if (isDeepSeek(a.modelId) ? !state.deepseekKey : !state.geminiKey) return toast('请先设置 API Key') || $1('settings-btn')?.click();
  
  inputEl.value = ''; inputEl.style.height = 'auto';
  const c = ensureConv(a); c.messages.push({ role: 'user', content: txt }); 
  if (c.title === '新话题') c.title = txt.substring(0, 20);
  
  userScrolledUp = false; renderMessages(); scrollBottom(true, true);
  const am = { role: 'assistant', content: '', reasoning: '', genTime: null, modelId: a.modelId, startTime: Date.now() }; 
  c.messages.push(am); saveState(); renderMessages(); 
  
  streaming = true; $1('send-btn')?.classList.add('hidden'); inputEl.disabled = true; $1('stop-btn')?.classList.remove('hidden'); 
  const activeMsgEl = $1('messages')?.lastElementChild; abortCtrl = new AbortController(); 
  
  try {
    const { url, headers, body } = getApiConfig(a, c);
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abortCtrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
      for (let t of lines) {
        if (!t.trim() || !t.startsWith('data: ') || t.slice(6) === '[DONE]') continue;
        try {
          const chunk = JSON.parse(t.slice(6));
          if (isDeepSeek(a.modelId)) {
            const d = chunk.choices?.[0]?.delta; 
            if (d?.reasoning_content) am.reasoning += d.reasoning_content; 
            if (d?.content) am.content += d.content;
          } else {
            for (const p of (chunk.candidates?.[0]?.content?.parts || [])) {
              if (p.text) am.content += p.text;
              if (p.thought) am.reasoning += p.thought;
            }
          }
          updateLive(activeMsgEl, am); scrollBottom(false, false);
        } catch(e) {}
      }
    }
  } catch (err) { if (err.name !== 'AbortError') am.content += `\n❌ 错误：${err.message}`; 
  } finally { streaming = false; abortCtrl = null; am.genTime = ((Date.now() - am.startTime) / 1000).toFixed(1); saveState(); renderChatPage(); $1('send-btn')?.classList.remove('hidden'); inputEl.disabled = false; $1('stop-btn')?.classList.add('hidden'); }
}

async function mergeData(data, promptMsg) {
  if (!await showDialog(promptMsg)) return false;
  state.assistants = data.assistants || state.assistants;
  ['deepseekKey', 'geminiKey', 'geminiBaseUrl', 'geminiModels', 'darkMode'].forEach(k => { if (data[k]) state[k] = data[k]; });
  saveState(); applyTheme(); renderAstList(); renderChatPage(); return true;
}

// 6. Dropdowns & Modals
let _ddActive = null, _ddAnchor = null;
function showDropdown(anchor, items, onSelect, onClose) {
  const dd = $1('dropdown-menu'); if(!dd) return;
  if (dd.classList.contains('show') && _ddAnchor === anchor) return hideDropdown();
  
  _ddAnchor = anchor;
  dd.innerHTML = items.map((item, i) => item.isHeader ? `<div class="dropdown-header">${item.label}</div>` : `<div class="dropdown-item ${item.selected ? 'selected' : ''}" data-idx="${i}">${item.icon || ''}<span>${item.label}</span>${item.selected ? '<i class="ph ph-check check"></i>' : ''}</div>`).join('');
  
  const r = anchor.getBoundingClientRect(), mh = dd.offsetHeight; 
  let top = r.top - mh - 4 > 0 ? r.top - mh - 4 : r.bottom + 4; 
  dd.style.cssText = `top:${top}px; left:${Math.max(5, Math.min(r.left, window.innerWidth - dd.offsetWidth - 5))}px`; dd.classList.add('show');
  
  const cleanup = () => { dd.classList.remove('show'); off(document, 'click', _ddActive); _ddActive = _ddAnchor = null; if (onClose) onClose(); };
  _ddActive = e => { if (e.target.closest('.dropdown-header')) return; const item = e.target.closest('.dropdown-item'); if (item) onSelect(items[item.dataset.idx].value); cleanup(); };
  setTimeout(() => on(document, 'click', _ddActive), 10);
}
const hideDropdown = () => { if (_ddActive) document.dispatchEvent(new MouseEvent('click')); };

function handleTopicMore(cid, btn) {
  if (streaming) return toast('生成中不可操作');
  const card = btn.closest('.topic-item');
  card?.classList.add('menu-active'); // 添加高亮类

  const a = getActiveAst(), idx = a?.conversations.findIndex(c => c.id === cid); if (idx < 0) return; 
  const conv = a.conversations[idx];
  const items = [{ label: '重命名', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '删除', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  
  showDropdown(btn, items, async val => {
    if (val === 'rename') { const nt = await showDialog('重命名话题', true, conv.title); if (nt?.trim()) { conv.title = nt.trim(); saveState(); renderChatPage(); renderTopicList(); } }
    else if (val === 'delete' && await showDialog('确定删除此话题吗？')) { a.conversations.splice(idx, 1); if (a.activeConvId === cid) a.activeConvId = a.conversations[0]?.id || null; saveState(); renderChatPage(); renderTopicList(); }
  }, () => card?.classList.remove('menu-active')); // 菜单关闭时移除高亮
}

// 7. Fullscreen Editor & Events
let vditorInstance = null, fsPromptOriginalValue = '', isFsPromptRawMode = false, ignoreNextPopState = false;

async function handleFsPromptClose(fromPopState = false) {
  const currentVal = isFsPromptRawMode ? $1('fs-prompt-raw-textarea').value : (vditorInstance ? vditorInstance.getValue() : '');
  if (currentVal.trim() !== fsPromptOriginalValue.trim()) { if (await showDialog('保存修改？')) { const sp = $1('s-prompt'); if (sp) { sp.value = currentVal; $1('s-save')?.click(); } } }
  $1('fs-prompt-overlay')?.classList.remove('show');
  if (!fromPopState && history.state?.page === 'fs-prompt') { ignoreNextPopState = true; history.back(); }
}

function updateDensityMap() {
  const map = $1('density-map'), chatC = $1('chat-container'), msgs = $1('messages'); if (!map || !chatC || !msgs || chatC.scrollHeight <= 0) return;
  let dotsC = $1('density-dots'); if (!dotsC) { map.innerHTML = '<div id="density-dots"></div><div id="density-thumb"></div>'; dotsC = $1('density-dots'); }
  dotsC.innerHTML = Array.from(msgs.children).filter(m => m.classList.contains('ai')).map(m => `<div class="density-dot" data-idx="${m.dataset.index}" style="top:${(m.offsetTop / chatC.scrollHeight) * 100}%; height:${(m.offsetHeight / chatC.scrollHeight) * 100}%;" title="跳至此消息"></div>`).join('');
  updateScrollThumb();
}
function updateScrollThumb() {
  const c = $1('chat-container'), t = $1('density-thumb'); if (!c || !t || c.scrollHeight <= 0) return;
  t.style.top = (c.scrollTop / c.scrollHeight) * 100 + '%'; t.style.height = Math.max((c.clientHeight / c.scrollHeight) * 100, 2) + '%';
}
const scrollBottom = (force, smooth = false) => { if (force || !userScrolledUp) requestAnimationFrame(() => chatC?.scrollTo({ top: chatC.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })); };

document.addEventListener('input', e => { 
  if (e.target.id === 's-temp') $1('s-tval').textContent = parseFloat(e.target.value).toFixed(2);
  if (e.target.id === 's-topp') $1('s-pval').textContent = parseFloat(e.target.value).toFixed(2);
});

document.addEventListener('click', async e => {
  const get = sel => e.target.closest(sel); let el;

  if ((el = get('#ast-drawer-btn'))) toggleDrawer('left');
  else if ((el = get('#topic-toggle'))) { e.stopPropagation(); renderTopicList(); openSheet('topics-drawer'); }
  else if ((el = get('#settings-btn'))) { renderSettings(); toggleDrawer('right'); }
  else if ((el = get('#close-settings'))) toggleDrawer('right', false);
  else if ((el = get('#sheet-overlay'))) closeAll();
  else if ((el = get('#chat-page-mask'))) { toggleDrawer('left', false); toggleDrawer('right', false); }
  else if ((el = get('#send-btn'))) sendMessage();
  else if ((el = get('#stop-btn'))) abortCtrl?.abort();
  else if ((el = get('#scroll-down'))) { userScrolledUp = false; scrollBottom(true, false); }
  else if ((el = get('#model-chip-btn'))) {
    if (streaming) return toast('生成中不可操作'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    showDropdown(el, [{ isHeader: true, label: 'DeepSeek' }, ...DS_MODELS.map(m => ({ label: m.name, value: m.id, selected: a.modelId === m.id, icon: m.iconColor })), { isHeader: true, label: 'Gemini' }, ...getCustomModels().map(n => ({ label: n, value: n, selected: a.modelId === n, icon: getModelInfo(n).iconColor }))], id => {
      a.modelId = id; saveState(); renderChatPage();
    });
  }
  else if ((el = get('#reasoning-btn'))) {
    if (streaming) return toast('生成中不可操作'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    const rOpts = [{label: '关闭', value: 'off'}, {label: 'Low', value: 'low'}, {label: 'High', value: 'high'}];
    showDropdown(el, rOpts.map(o => ({ label: o.label, value: o.value, selected: a.reasoningEffort === o.value, icon: '<i class="ph ph-brain"></i>' })), val => { a.reasoningEffort = val; saveState(); renderChatPage(); });
  }
  else if ((el = get('#add-ast-btn'))) openSheet('add-ast-sheet'); 
  else if ((el = get('#create-ast'))) {
    const n = $1('new-ast-name')?.value.trim(); if (!n) return toast('请输入名称');
    state.assistants.unshift(fixAsst({ name: n, systemPrompt: $1('new-ast-prompt')?.value.trim() }));
    saveState(); closeAll(); renderAstList(); $1('new-ast-name').value = '';
  }
  else if ((el = get('#ast-list'))) {
    const card = get('.ast-card'); if (!card) return;
    if (get('.ast-more')) { e.stopPropagation(); return handleAstMore(card.dataset.id, get('.ast-more')); }
    if (streaming) return toast('生成中不可操作');
    goToChat(card.dataset.id);
  }
  else if ((el = get('#topic-list'))) {
    const a = getActiveAst(), item = get('.topic-item'); if (!a || !item) return;
    if ((el = get('.topic-more'))) return handleTopicMore(item.dataset.cid, el);
    if (streaming) return toast('生成中不可操作');
    a.activeConvId = item.dataset.cid; saveState(); closeAll(); renderChatPage();
  }
  else if ((el = get('#new-topic'))) { if (streaming) return toast('生成中不可操作'); const a = getActiveAst(); if (a) { a.activeConvId = null; saveState(); closeAll(); renderChatPage(); } }
  else if ((el = get('.density-dot'))) { const tg = $1('messages')?.querySelector(`.msg[data-index="${el.dataset.idx}"]`); if (tg) { $1('chat-container').scrollTo({ top: tg.offsetTop - 14, behavior: 'smooth' }); userScrolledUp = true; } }
  else if ((el = get('#messages'))) {
    const btn = get('button[data-a]'), rhead = get('.rhead');
    if (rhead) { rhead.classList.toggle('open'); rhead.nextElementSibling?.classList.toggle('open'); return; }
    if (btn) {
      e.stopPropagation(); const act = btn.dataset.a, idx = parseInt(btn.closest('.msg').dataset.index, 10), conv = getActiveConv(), msg = conv.messages[idx];
      if (act === 'cp') return copyText(msg.content).then(() => toast('已复制'));
      if (streaming) return toast('生成中不可操作');
      if (act === 'ed') openEditModal(msg);
      else if (act === 'del' && await showDialog('删除消息？')) { conv.messages.splice(idx, 1); saveState(); renderChatPage(); }
      else if (act === 're') { conv.messages = conv.messages.slice(0, idx); saveState(); renderChatPage(); sendMessage(); }
    }
  }
  else if ((el = get('#settings-body'))) {
    if (get('#data-export')) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: 'application/json' })); a.download = getBackupName(); a.click(); } 
    else if (get('#data-import-btn')) $1('import-file')?.click();
    else if (get('#s-save')) {
      const a = getActiveAst(), val = id => $1(id)?.value; if (!a) return;
      a.name = val('s-name') || a.name; a.systemPrompt = val('s-prompt') || ''; a.temperature = parseFloat(val('s-temp')); a.topP = parseFloat(val('s-topp'));
      state.deepseekKey = val('s-dskey'); state.geminiKey = val('s-gmkey'); state.geminiBaseUrl = val('s-gmurl'); state.geminiModels = val('s-gmmodels');
      state.darkMode = $1('s-theme')?.classList.contains('active'); saveState(); applyTheme(); closeAll(); renderChatPage(); renderAstList(); toast('设置已保存');
    } else {
      const themeSw = get('#s-theme'); if (themeSw) { themeSw.classList.toggle('active'); state.darkMode = themeSw.classList.contains('active'); saveState(); applyTheme(); $1('theme-label').innerHTML = state.darkMode ? '<i class="ph-fill ph-moon"></i> 暗色' : '<i class="ph-fill ph-sun"></i> 亮色'; }
      if (get('#s-prompt-fs-btn')) { 
        fsPromptOriginalValue = $1('s-prompt')?.value || ''; $1('fs-prompt-overlay')?.classList.add('show'); history.pushState({ page: 'fs-prompt' }, '');
        if (!vditorInstance) vditorInstance = new Vditor('fs-prompt-vditor', { mode: 'ir', height: '100%', cache: { enable: false }, value: fsPromptOriginalValue, theme: state.darkMode ? 'dark' : 'classic' });
        else vditorInstance.setValue(fsPromptOriginalValue);
      }
    }
  }
  else if ((el = get('#fs-prompt-save'))) { const newVal = vditorInstance ? vditorInstance.getValue() : ''; const sp = $1('s-prompt'); if (sp) sp.value = newVal; fsPromptOriginalValue = newVal; toast('修改已暂存'); }
  else if ((el = get('#fs-prompt-close'))) handleFsPromptClose();
});

// 8. Init
await IDB.init().catch(()=>{}); 
await loadState(); 
applyTheme(); 
if (window.innerWidth > 768) $1('app')?.classList.add('left-open');
renderAstList(); renderChatPage();

window.addEventListener('popstate', async e => { 
  if (ignoreNextPopState) return ignoreNextPopState = false;
  if ($1('fs-prompt-overlay')?.classList.contains('show')) return handleFsPromptClose(true);
  closeAll(true); 
});

const chatC = $1('chat-container');
chatC.addEventListener('scroll', () => { 
  updateScrollThumb(); 
  const dist = chatC.scrollHeight - chatC.scrollTop - chatC.clientHeight;
  userScrolledUp = dist > 40;
  $1('scroll-down')?.classList.toggle('show', dist > 200); 
}, { passive: true });

const userInput = $1('user-input');
on(userInput, 'keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); } });
on(userInput, 'input', function() { this.style.height = 'auto'; this.style.height = `${Math.min(this.scrollHeight, 220)}px`; });

})();