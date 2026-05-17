(async () => {
'use strict';

// 1. Utils & Context
const $ = id => document.getElementById(id);
const on = (el, evt, cb, opts) => (typeof el === 'string' ? $(el) : el)?.addEventListener(evt, cb, opts);
const off = (el, evt, cb) => (typeof el === 'string' ? $(el) : el)?.removeEventListener(evt, cb);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad0 = n => n.toString().padStart(2, '0');
const getBackupName = () => { const d = new Date(); return `AIChatBackup-${d.getFullYear()}${pad0(d.getMonth()+1)}${pad0(d.getDate())}-${pad0(d.getHours())}${pad0(d.getMinutes())}.json`; };
const getTokens = str => { if (!str) return 0; const zh = (str.match(/[\u4e00-\u9fa5]/g) || []).length; return Math.ceil(zh + (str.length - zh) * 0.25); };
const getMsgTokens = m => getTokens(m.content) + getTokens(m.reasoning);
const calcConvContextTokens = (c, p) => c.messages.reduce((t, m) => t + getTokens(m.content), getTokens(p));
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
  activeAstId: null, deepseekKey: '', geminiKey: '', geminiBaseUrl: DEFAULT_GM_URL, geminiModels: 'gemini-2.5-pro, gemini-3.0-flash', darkMode: false, webdavUser: '', webdavToken: ''
};

let abortCtrl = null, streaming = false, editingMsg = null, userScrolledUp = false;

const svgIco = (n, c) => c ? `<img src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}-color.svg" style="width:1.2em;height:1.2em;vertical-align:middle;">` : `<span style="display:inline-block;width:1.1em;height:1.1em;background-color:currentColor;-webkit-mask:url('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}.svg') center/contain no-repeat;mask:url('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}.svg') center/contain no-repeat;vertical-align:middle;"></span>`;
const IC_DS_C = svgIco('deepseek', 1), IC_DS_M = svgIco('deepseek', 0);
const IC_GM_C = svgIco('gemini', 1), IC_GM_M = svgIco('gemini', 0);
const DS_MODELS = [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', icC: IC_DS_C, icM: IC_DS_M }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', icC: IC_DS_C, icM: IC_DS_M }];

const getModelInfo = id => {
  const m = DS_MODELS.find(m => m.id === id); if (m) return { ...m, iconColor: m.icC, iconMono: m.icM };
  const nid = (id || '').toLowerCase();
  if (nid.includes('gemini')) return { iconColor: IC_GM_C, iconMono: IC_GM_M, name: id };
  if (nid.includes('deepseek')) return { iconColor: IC_DS_C, iconMono: IC_DS_M, name: id };
  const ic = '<i class="ph-fill ph-sparkle" style="vertical-align:middle;"></i>';
  return { iconColor: ic.replace('style', 'color:var(--acc); style'), iconMono: ic, name: id };
};

const isDeepSeek = id => DS_MODELS.some(m => m.id === id) || (id || '').toLowerCase().includes('deepseek');
const getCustomModels = () => (state.geminiModels || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadState() {
  try {
    let p = await IDB.get(STORE_KEY) || JSON.parse(localStorage.getItem(STORE_KEY));
    if (p) { delete p.groups; state = { ...state, ...p }; await IDB.set(STORE_KEY, state); }
  } catch(e) {}
  state.assistants = state.assistants.map(fixAsst);
  if (!state.assistants.length) state.assistants.push(fixAsst({ id: 'default-ast', name: '全能助手', systemPrompt: '你是一个高度通用的AI助手。' }));
}

let saveTimer = null;
const saveState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => IDB.set(STORE_KEY, state).catch(() => toast('存储失败')), 300); };

const fixAsst = a => ({
  ...a, id: a.id || genId(), name: a.name || '未命名助手', systemPrompt: a.systemPrompt || '', 
  temperature: a.temperature ?? 1.0, topP: a.topP ?? 1.0, modelId: a.modelId || a.geminiModel || DEFAULT_MODEL, reasoningEffort: a.reasoningEffort || 'off', 
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
  const t = $('toast'); if(!t) return;
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
    $('dialog-msg').textContent = msg; 
    const inp = $('dialog-input');
    $('dialog-input-wrap').classList.toggle('hidden', !isInput); inp.value = isInput ? defaultVal : '';
    $('dialog-overlay').classList.add('show'); 
    if (isInput) inp.focus();
    const cleanup = () => { $('dialog-overlay').classList.remove('show'); off('dialog-ok', 'click', onOk); off('dialog-cancel', 'click', onCancel); off(inp, 'keydown', onKey); };
    const onOk = () => { cleanup(); resolve(isInput ? inp.value : true); }; 
    const onCancel = () => { cleanup(); resolve(isInput ? null : false); };
    const onKey = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    on('dialog-ok', 'click', onOk); on('dialog-cancel', 'click', onCancel); if (isInput) on(inp, 'keydown', onKey);
  });
}

function applyTheme() { 
  document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light'); 
  const ht = $('hljs-theme'); if (ht) ht.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github${state.darkMode ? '-dark' : ''}.min.css`; 
}

function setupPWA() { 
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(URL.createObjectURL(new Blob([`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>self.clients.claim());`], { type: 'application/javascript' }))).catch(()=>{}); 
}

function toggleDrawer(side, forceState) {
  const app = $('app'); if (!app) return;
  const isLeft = side === 'left', cls = isLeft ? 'left-open' : 'right-open', opp = isLeft ? 'right-open' : 'left-open';
  const open = forceState !== undefined ? forceState : !app.classList.contains(cls);
  app.classList.toggle(cls, open); if (open) app.classList.remove(opp);
}

const closeDrawers = () => document.querySelectorAll('.sheet, .topics-modal').forEach(el => el.classList.remove('open'));
const closeAll = (fromPopState = false) => { 
  hideDropdown(); 
  const wasSheetOpen = $('sheet-overlay')?.classList.contains('show');
  $('sheet-overlay')?.classList.remove('show');
  if (window.innerWidth <= 768) { toggleDrawer('left', false); toggleDrawer('right', false); }
  closeDrawers(); 
  if (wasSheetOpen && !fromPopState && history.state?.drawer) { ignoreNextPopState = true; history.back(); }
};

const openSheet = id => { closeDrawers(); $('sheet-overlay')?.classList.add('show'); $(id)?.classList.add('open'); if (!history.state?.drawer) history.pushState({ ...history.state, drawer: true }, ''); };
function goToChat(id, fromHistory = false) { state.activeAstId = id; saveState(); if (!fromHistory) history.pushState({ page: 'chat', id }, ''); renderChatPage(); renderAstList(); closeAll(); userScrolledUp = false; scrollBottom(true, false); }

// 4. Renderers
function renderAstList() {
  const l = $('ast-list'); if (!l) return;
  if (!state.assistants.length) return l.innerHTML = '<div class="empty"><i class="ph ph-ghost empty-icon"></i> 无助手</div>';
  l.innerHTML = state.assistants.map(a => `<div class="ast-card ${a.id === state.activeAstId ? 'active' : ''}" data-id="${a.id}"><div class="ast-name">${a.name}</div><button class="ast-more"><i class="ph ph-dots-three-vertical"></i></button></div>`).join('');
}

function handleAstMore(id, btn) {
  const idx = state.assistants.findIndex(a => a.id === id); if (idx < 0) return;
  const items = [{ label: '删除助手', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  if (idx > 0) items.push({ label: '上移', value: 'up', icon: '<i class="ph ph-arrow-up"></i>' });
  if (idx < state.assistants.length - 1) items.push({ label: '下移', value: 'down', icon: '<i class="ph ph-arrow-down"></i>' });

  showDropdown(btn, items, async val => {
    if (val === 'delete' && await showDialog('删除此助手吗？')) { 
      state.assistants.splice(idx, 1); 
      if (state.activeAstId === id) state.activeAstId = state.assistants[0]?.id; 
      if (state.activeAstId) renderChatPage(); 
    } else if (val === 'up' || val === 'down') { 
      const t = val === 'up' ? idx - 1 : idx + 1; 
      [state.assistants[idx], state.assistants[t]] = [state.assistants[t], state.assistants[idx]]; 
    } 
    saveState(); renderAstList();
  });
}

function renderChatPage() {
  let a = getActiveAst(); 
  if (!a && state.assistants.length > 0) { state.activeAstId = state.assistants[0].id; a = getActiveAst(); }
  if (!a) return; 

  const c = getActiveConv(a), m = getModelInfo(a.modelId), upd = (id, html) => { if($(id)) $(id).innerHTML = html; };
  upd('chat-asst-name', a.name);
  upd('chat-topic-name', c ? c.title : '新话题'); 
  upd('chat-nav-tokens', `(${c ? c.messages.length : 0})`);
  upd('model-chip-btn', m.iconColor);
  upd('reasoning-btn', `<i class="ph ph-brain"></i><span>${{ off: '关闭', low: 'Low', high: 'High', max: 'Max' }[a.reasoningEffort] || a.reasoningEffort}</span>`);
  renderMessages();
}

if (window.markedKatex && window.marked) marked.use(window.markedKatex({ throwOnError: false }));
if (window.marked) marked.setOptions({ breaks: true, gfm: true });

const md = t => {
  if (!t) return '';
  const txt = String(t).replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$').replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  try { return window.marked ? marked.parse(txt) : txt.replace(/\n/g, '<br>'); } catch { return txt.replace(/\n/g, '<br>'); }
};

function enhanceCodeBlocks(c) {
  c.querySelectorAll('pre:not(.code-block-wrapper pre)').forEach(pre => {
    if (pre.dataset.e) return; pre.dataset.e = '1';
    const code = pre.querySelector('code'), lang = code?.className.match(/language-([\w-]+)/)?.[1] || 'text';
    const w = document.createElement('div'); w.className = 'code-block-wrapper collapsed';
    w.innerHTML = `<div class="code-block-header"><span class="code-lang">${lang}</span><div class="code-btns"><button class="code-btn copy-btn"><i class="ph ph-copy"></i> 复制</button><button class="code-btn fold-btn">展开</button></div></div>`;
    pre.replaceWith(w); w.appendChild(pre);
    on(w.querySelector('.copy-btn'), 'click', e => { e.stopPropagation(); copyText((code || pre).textContent || '').then(() => { e.target.innerHTML = '<i class="ph ph-check"></i> 已复制'; setTimeout(() => e.target.innerHTML = '<i class="ph ph-copy"></i> 复制', 1200); }); });
    on(w.querySelector('.fold-btn'), 'click', e => { e.stopPropagation(); e.target.textContent = w.classList.toggle('collapsed') ? '展开' : '折叠'; });
    if (code && window.hljs) { try { hljs.highlightElement(code); } catch(e) {} }
  });
  c.querySelectorAll('table:not(.table-wrapper table)').forEach(t => { const w = document.createElement('div'); w.className = 'table-wrapper'; t.replaceWith(w); w.appendChild(t); });
}

function makeMsg(msg, idx) {
  const isAi = msg.role === 'assistant', a = getActiveAst(), mInfo = getModelInfo(msg.modelId || a?.modelId);
  const d = document.createElement('div'); d.className = `msg ${isAi ? 'ai' : 'user'}`; d.dataset.index = idx;
  const rHTML = msg.reasoning ? `<div class="rblock"><button class="rhead"><span>${msg.isNote ? '<i class="ph ph-note-pencil"></i> 备注' : '<i class="ph ph-brain"></i> 思考过程'}</span><i class="ph ph-caret-right arr"></i></button><div class="rbody">${msg.reasoning}</div></div>` : '';
  const acts = `<button data-a="cp"><i class="ph ph-copy"></i></button><button data-a="ed"><i class="ph ph-pencil-simple"></i></button><button data-a="del"><i class="ph ph-trash"></i></button><button data-a="re"><i class="ph ${isAi ? 'ph-arrows-clockwise' : 'ph-arrow-u-up-left'}"></i></button>`;
  
  d.innerHTML = `<div class="bubble">${rHTML}<div class="markdown-body">${md(msg.content)}</div></div><div class="msg-actions"><div class="actions-left">${isAi ? `<span class="badge">${mInfo.iconMono} ${mInfo.name}</span><span class="gen-time"><i class="ph ph-timer"></i> ${msg.genTime || (msg.startTime ? ((Date.now()-msg.startTime)/1000).toFixed(0) : '0')}s</span>` : ''}</div><div class="msg-tokens">${isAi ? '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg)) : ''}</div><div class="actions-right">${acts}</div></div>`;
  enhanceCodeBlocks(d); return d;
}

function renderMessages() {
  const msgs = $('messages'); if(!msgs) return;
  const c = getActiveConv(); msgs.innerHTML = '';
  if (!c || !c.messages.length) return msgs.innerHTML = `<div class="welcome"><div class="emoji"><i class="ph-fill ph-sparkle"></i></div><h3>开始对话</h3><p>输入消息，点击发送开始</p><div class="welcome-hints"><div class="welcome-hint" data-prompt="用简单的语言解释量子计算"><i class="ph ph-microscope"></i> 解释量子计算</div><div class="welcome-hint" data-prompt="写一首关于夏天的古诗"><i class="ph ph-pen-nib"></i> 写一首古诗</div><div class="welcome-hint" data-prompt="用Python写贪吃蛇游戏"><i class="ph ph-code"></i> 写贪吃蛇游戏</div><div class="welcome-hint" data-prompt="给我一周的健身计划"><i class="ph ph-barbell"></i> 健身计划</div></div></div>`;
  c.messages.forEach((m, i) => msgs.appendChild(makeMsg(m, i)));
  setTimeout(updateDensityMap, 50);
}

function renderTopicList() {
  const a = getActiveAst(), l = $('topic-list'), dtk = $('drawer-total-tokens'); if(!l) return;
  if (!a || !a.conversations.length) { l.innerHTML = '<div class="empty">暂无话题</div>'; if(dtk) dtk.textContent = '0'; return; }
  let total = 0;
  l.innerHTML = a.conversations.map(c => {
    const tok = calcConvContextTokens(c, a.systemPrompt); total += tok;
    return `<div class="topic-item ${c.id === a.activeConvId ? 'active' : ''}" data-cid="${c.id}"><span><i class="ph ph-chat-teardrop-text"></i></span><div class="tinfo"><div class="ttitle-wrap"><div class="ttitle">${c.title}</div><span class="nav-tokens">${formatK(tok)}</span></div><div class="tmeta">${c.messages.length} 条消息</div></div><button class="topic-more"><i class="ph ph-dots-three-vertical"></i></button></div>`;
  }).join('');
  if(dtk) dtk.textContent = formatK(total);
}

function renderSettings() {
  const a = getActiveAst(), sb = $('settings-body'); if (!a || !sb) return;
  sb.innerHTML = `
    <div class="s-card">
      <div class="s-title"><i class="ph ph-robot"></i> 助手设置</div>
      <div class="field"><label>助手名称</label><input type="text" id="s-name" value="${a.name}"></div>
      <div class="field"><label>系统提示词</label>
        <div class="relative"><textarea id="s-prompt" rows="3">${a.systemPrompt}</textarea>
        <button id="s-prompt-fs-btn" class="icon-btn abs-top-right"><i class="ph ph-corners-out"></i></button></div>
      </div>
      <div class="field">
        <div class="flex-between"><label>Temperature</label><span class="v-badge" id="s-tval">${a.temperature.toFixed(2)}</span></div>
        <input type="range" id="s-temp" min="0" max="2" step="0.05" value="${a.temperature}" oninput="document.getElementById('s-tval').innerText=Number(this.value).toFixed(2)">
      </div>
      <div class="field">
        <div class="flex-between"><label>Top P</label><span class="v-badge" id="s-pval">${a.topP.toFixed(2)}</span></div>
        <input type="range" id="s-topp" min="0" max="1" step="0.05" value="${a.topP}" oninput="document.getElementById('s-pval').innerText=Number(this.value).toFixed(2)">
      </div>
    </div>
    <div class="s-card">
      <div class="s-title"><i class="ph ph-key"></i> 模型与 API 配置</div>
      <div class="field"><label>DeepSeek API Key</label><input type="password" id="s-dskey" value="${state.deepseekKey}"></div>
      <div class="field"><label>第三方 API Key (Gemini等)</label><input type="password" id="s-gmkey" value="${state.geminiKey || ''}"></div>
      <div class="field"><label>第三方 API 地址</label><input type="text" id="s-gmurl" value="${state.geminiBaseUrl || DEFAULT_GM_URL}"></div>
      <div class="field"><label>第三方模型列表 (逗号分隔)</label><input type="text" id="s-gmmodels" value="${state.geminiModels || 'gemini-2.5-pro'}"></div>
    </div>
    <div class="s-card">
      <div class="s-title"><i class="ph ph-cloud"></i> 坚果云 WebDAV 同步</div>
      <div class="field"><label>账号邮箱</label><input type="text" id="s-webdavUser" value="${state.webdavUser || ''}"></div>
      <div class="field"><label>应用密码</label><input type="password" id="s-webdavToken" value="${state.webdavToken || ''}"></div>
      <div class="btn-group"><button id="data-push"><i class="ph ph-cloud-arrow-up"></i> 推送云端</button><button id="data-pull"><i class="ph ph-cloud-arrow-down"></i> 拉取云端</button></div>
    </div>
    <div class="s-card">
      <div class="s-title"><i class="ph ph-gear"></i> 系统与数据</div>
      <div class="field flex-between"><span><i class="ph-fill ph-${state.darkMode ? 'moon' : 'sun'}"></i> ${state.darkMode ? '暗色模式' : '亮色模式'}</span><div class="tsw ${state.darkMode ? 'active' : ''}" id="s-theme"></div></div>
      <div class="btn-group"><button id="data-export"><i class="ph ph-upload-simple"></i> 导出备份</button><button id="data-import-btn"><i class="ph ph-download-simple"></i> 导入备份</button></div>
    </div>
    <button class="btn-primary mt-8" id="s-save" style="width:100%;"><i class="ph ph-floppy-disk"></i> 保存所有设置</button>
  `;
}

// 5. Chat & API Sync
function updateLive(el, m) {
  if (!el) return; const b = el.querySelector('.bubble'); if (!b) return;
  if (m.reasoning) { 
    let rb = b.querySelector('.rblock'); 
    if (!rb) { b.insertAdjacentHTML('afterbegin', '<div class="rblock"><button class="rhead open"><span><i class="ph ph-brain"></i> 思考过程</span><i class="ph ph-caret-right arr"></i></button><div class="rbody open"></div></div>'); rb = b.querySelector('.rblock'); }
    if (m.content.length > 0 && !rb.dataset.a) { rb.querySelector('.rhead').classList.remove('open'); rb.querySelector('.rbody').classList.remove('open'); rb.dataset.a = '1'; }
    rb.querySelector('.rbody').textContent = m.reasoning;
  }
  let mc = b.querySelector('.markdown-body'); 
  if (!mc) { b.insertAdjacentHTML('beforeend', '<div class="markdown-body"></div>'); mc = b.querySelector('.markdown-body'); }
  mc.innerHTML = md(m.content); enhanceCodeBlocks(b);
  const tk = el.querySelector('.msg-tokens'); if (tk) tk.innerHTML = '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(m));
}

const getApiConfig = (a, c) => {
  const msgs = c.messages.slice(0, -1);
  if (isDeepSeek(a.modelId)) {
    const body = { model: a.modelId, stream: true, messages: [{ role: 'system', content: a.systemPrompt }, ...msgs.map(m => ({ role: m.role, content: m.content }))] };
    Object.assign(body, a.reasoningEffort === 'off' ? { temperature: a.temperature, top_p: a.topP, thinking: { type: 'disabled' } } : { reasoning_effort: a.reasoningEffort, thinking: { type: 'enabled' } });
    return { url: 'https://api.deepseek.com/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.deepseekKey}` }, body };
  } else {
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': state.geminiKey };
    if (/^(sk-|Bearer )/.test(state.geminiKey)) headers['Authorization'] = state.geminiKey.startsWith('Bearer ') ? state.geminiKey : `Bearer ${state.geminiKey}`;
    const contents = msgs.reduce((acc, m) => {
      const parts = [...(m.thoughtSignatures || []).map(s => ({ thoughtSignature: s })), { text: m.content || ' ' }], role = m.role === 'user' ? 'user' : 'model';
      if (acc.length && acc[acc.length - 1].role === role) acc[acc.length - 1].parts.push(...parts); else acc.push({ role, parts });
      return acc;
    }, []);
    const body = { contents, generationConfig: { temperature: a.temperature, topP: a.topP, thinkingConfig: a.reasoningEffort !== 'off' ? { includeThoughts: true, [a.modelId.includes('gemini-3') ? 'thinkingLevel' : 'thinkingBudget']: a.reasoningEffort === 'low' ? (a.modelId.includes('gemini-3') ? 'LOW' : 1024) : (a.modelId.includes('gemini-3') ? 'HIGH' : 8192) } : undefined } };
    if (a.systemPrompt) body.systemInstruction = { role: "system", parts: [{ text: a.systemPrompt }] };
    return { url: `${(state.geminiBaseUrl || DEFAULT_GM_URL).replace(/\/+$/, '')}/v1beta/models/${a.modelId}:streamGenerateContent?alt=sse`, headers, body };
  }
};

async function sendMessage() {
  if (streaming) return;
  const inp = $('user-input'); if (!inp) return;
  const txt = inp.value.trim(), a = getActiveAst(); if (!txt || !a) return;
  if (isDeepSeek(a.modelId) ? !state.deepseekKey : !state.geminiKey) return toast('请先设置 API Key') || $('settings-btn')?.click();
  
  inp.value = ''; inp.style.height = 'auto';
  const c = ensureConv(a); c.messages.push({ role: 'user', content: txt }); 
  if (c.title === '新话题') c.title = txt.substring(0, 28) + (txt.length > 28 ? '…' : '');
  
  userScrolledUp = false; renderMessages(); scrollBottom(true, true);
  const am = { role: 'assistant', content: '', reasoning: '', genTime: null, modelId: a.modelId, startTime: Date.now() }; 
  c.messages.push(am); saveState(); renderMessages(); 
  
  streaming = true; $('send-btn')?.classList.add('hidden'); inp.disabled = true; $('stop-btn')?.classList.remove('hidden'); 
  const nTk = $('chat-nav-tokens'); if (nTk) nTk.textContent = `(${c.messages.length})`;
  const actMsg = $('messages')?.lastElementChild; abortCtrl = new AbortController(); 
  let gTmr = setInterval(() => { const el = actMsg?.querySelector('.gen-time'); if (el) el.innerHTML = `<i class="ph ph-timer"></i> ${((Date.now() - am.startTime) / 1000).toFixed(0)}s`; }, 1000);
  
  try {
    const { url, headers, body } = getApiConfig(a, c);
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abortCtrl.signal });
    if (!res.ok) throw new Error((await res.json().catch(()=>{})).error?.message || `HTTP ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
      for (let t of lines) {
        if (!t.trim() || !t.startsWith('data: ') || t.slice(6) === '[DONE]') continue;
        try {
          const chk = JSON.parse(t.slice(6));
          if (!isDeepSeek(a.modelId)) {
            for (const p of (chk.candidates?.[0]?.content?.parts || [])) {
              if (p.thoughtSignature || p.thought_signature) (am.thoughtSignatures ??= []).push(p.thoughtSignature || p.thought_signature);
              if (String(p.thought) === "true") am.reasoning += (p.text || ''); else if (p.text) am.content += p.text;
            }
          } else { const d = chk.choices?.[0]?.delta; if (d?.reasoning_content) am.reasoning += d.reasoning_content; if (d?.content) am.content += d.content; }
          if (nTk) nTk.textContent = `(${c.messages.length})`; updateLive(actMsg, am); scrollBottom(false, false);
        } catch(e) {}
      }
    }
  } catch (e) { if (e.name !== 'AbortError') am.content = am.content || `❌ 错误：${e.message}`; 
  } finally { streaming = false; abortCtrl = null; clearInterval(gTmr); am.genTime = ((Date.now() - am.startTime) / 1000).toFixed(0); delete am.startTime; saveState(); renderChatPage(); $('send-btn')?.classList.remove('hidden'); inp.disabled = false; $('stop-btn')?.classList.add('hidden'); }
}

async function mergeData(d, p) {
  if (!await showDialog(p)) return false;
  let nT = 0, uT = 0, nM = 0;
  for (const ia of (d.assistants || [])) {
    const fa = fixAsst(ia), ex = state.assistants.find(a => a.id === fa.id || a.name === fa.name);
    if (ex) {
      for (const ic of fa.conversations) {
        const exC = ex.conversations.find(c => c.id === ic.id || c.title === ic.title);
        if (exC) {
          if (ic.messages.length > exC.messages.length || JSON.stringify(ic.messages) !== JSON.stringify(exC.messages)) {
            nM += Math.max(0, ic.messages.length - exC.messages.length); uT++;
            exC.messages = ic.messages; exC.title = ic.title; if (exC.id !== ic.id) exC.id = ic.id; 
          }
        } else { ex.conversations.push(ic); nT++; nM += ic.messages.length; }
      }
      ex.conversations.sort((a, b) => b.id.localeCompare(a.id));
    } else { state.assistants.push(fa); nT += fa.conversations.length; nM += fa.conversations.reduce((s, c) => s + c.messages.length, 0); }
  }
  ['activeAstId', 'deepseekKey', 'geminiKey', 'geminiBaseUrl', 'geminiModels', 'darkMode', 'webdavUser', 'webdavToken'].forEach(k => { if (d[k] !== undefined && d[k] !== '') state[k] = d[k]; });
  saveState(); applyTheme(); renderAstList(); 
  if (!state.assistants.some(x => x.id === state.activeAstId)) state.activeAstId = state.assistants[0]?.id;
  renderChatPage(); closeAll(); 
  return { newTopics: nT, updatedTopics: uT, newMessages: nM };
}

const getWebDAVAuth = () => { 
  const u = $('s-webdavUser')?.value.trim(), t = $('s-webdavToken')?.value.trim(); 
  if (!u || !t) return toast('请填写账号和密码'), null; 
  state.webdavUser = u; state.webdavToken = t; saveState(); 
  return 'Basic ' + btoa(`${u}:${t}`); 
};
const fetchDAV = (p, auth, m='GET', b=null, h={}) => fetch(`/webdav-proxy/AIChat/${p}`, { method: m, headers: { Authorization: auth, ...(b ? {'Content-Type': 'application/json'} : {}), ...h }, body: b ? JSON.stringify(b) : null });

on('import-file', 'change', e => {
  const f = e.target.files[0]; if (!f) return; 
  const r = new FileReader();
  r.onload = async ev => { 
    try { const d = JSON.parse(ev.target.result), st = await mergeData(d.data || d, '深度合并数据，确认吗？'); if (st) toast(`导入成功`, 3500); } catch(err) { toast('文件格式错误'); } 
  };
  r.readAsText(f); e.target.value = '';
});

function updateScrollThumb() {
  const c = $('chat-container'), t = $('density-thumb'); if (!c || !t || c.scrollHeight <= 0) return;
  t.style.top = (c.scrollTop / c.scrollHeight) * 100 + '%'; t.style.height = Math.max((c.clientHeight / c.scrollHeight) * 100, 2) + '%';
}
function updateDensityMap() {
  const map = $('density-map'), chatC = $('chat-container'), msgs = $('messages'); if (!map || !chatC || !msgs || chatC.scrollHeight <= 0) return;
  let dotsC = $('density-dots'); if (!dotsC) { map.innerHTML = '<div id="density-dots"></div><div id="density-thumb"></div>'; dotsC = $('density-dots'); }
  dotsC.innerHTML = Array.from(msgs.children).filter(m => m.classList.contains('ai')).map(m => `<div class="density-dot" data-idx="${m.dataset.index}" style="top:${(m.offsetTop / chatC.scrollHeight) * 100}%; height:${(m.offsetHeight / chatC.scrollHeight) * 100}%;" title="跳至此消息"></div>`).join('');
  updateScrollThumb();
}
const chatObserver = new ResizeObserver(() => requestAnimationFrame(updateDensityMap)), chatC = $('chat-container'); 
if (chatC) chatObserver.observe(chatC); if ($('messages')) chatObserver.observe($('messages'));

let isTouching = false; const setTouch = v => () => isTouching = v;
if(chatC) {
  ['touchstart','mousedown'].forEach(ev => on(chatC, ev, setTouch(true), { passive: true }));
  ['touchend','touchcancel','mouseup'].forEach(ev => window.addEventListener(ev, setTouch(false), { passive: true }));
  chatC.addEventListener('wheel', () => userScrolledUp = true, { passive: true });
  on(chatC, 'scroll', function() { 
    updateScrollThumb(); const dist = this.scrollHeight - this.scrollTop - this.clientHeight; 
    if (dist <= 25) userScrolledUp = false; else if (isTouching) userScrolledUp = true; 
    $('scroll-down')?.classList.toggle('show', dist > 200 && $('messages').children.length > 1); 
  });
}
const scrollBottom = (force, smooth = false) => { if (force || (!userScrolledUp && !isTouching)) requestAnimationFrame(() => chatC?.scrollTo({ top: chatC.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })); };

// 6. Dropdowns & Modals
let _ddActive = null, _ddAnchor = null;
function showDropdown(anchor, items, onSelect) {
  const dd = $('dropdown-menu'); if(!dd) return;
  if (dd.classList.contains('show') && _ddAnchor === anchor) return hideDropdown();
  _ddAnchor = anchor;
  dd.innerHTML = items.map((item, i) => item.isHeader ? `<div class="dropdown-header">${item.label}</div>` : `<div class="dropdown-item ${item.selected ? 'selected' : ''}" data-idx="${i}">${item.icon || ''}<span>${item.label}</span>${item.selected ? '<i class="ph ph-check check"></i>' : ''}</div>`).join('');
  const r = anchor.getBoundingClientRect(), mh = dd.offsetHeight; let top = r.top - mh - 4 > 0 ? r.top - mh - 4 : r.bottom + 4; if (top + mh > window.innerHeight) top = window.innerHeight - mh - 10;
  dd.style.cssText = `top:${top}px; left:${Math.max(5, Math.min(r.left, window.innerWidth - dd.offsetWidth - 5))}px`; dd.classList.add('show');
  if (_ddActive) off(document, 'click', _ddActive);
  _ddActive = e => { if (e.target.closest('.dropdown-header')) return; const item = e.target.closest('.dropdown-item'); if (item) onSelect(items[item.dataset.idx].value); hideDropdown(); };
  setTimeout(() => on(document, 'click', _ddActive), 10);
}
const hideDropdown = () => { const dd = $('dropdown-menu'); if (dd) dd.classList.remove('show'); if (_ddActive) off(document, 'click', _ddActive); _ddActive = _ddAnchor = null; };

function handleTopicMore(cid, btn) {
  const a = getActiveAst(), idx = a?.conversations.findIndex(c => c.id === cid); if (idx < 0) return; 
  const conv = a.conversations[idx], items = [{ label: '重命名话题', value: 'rename', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '复制话题', value: 'copy', icon: '<i class="ph ph-copy"></i>' }, ...(idx > 0 ? [{ label: '上移', value: 'up', icon: '<i class="ph ph-arrow-up"></i>' }] : []), ...(idx < a.conversations.length - 1 ? [{ label: '下移', value: 'down', icon: '<i class="ph ph-arrow-down"></i>' }] : []), { label: '删除话题', value: 'delete', icon: '<i class="ph ph-trash"></i>' }];
  showDropdown(btn, items, async val => {
    if (val === 'rename') { const nt = await showDialog('重命名', true, conv.title); if (nt?.trim() && nt.trim() !== conv.title) { conv.title = nt.trim(); saveState(); renderChatPage(); renderTopicList(); } }
    else if (val === 'copy') { const nc = JSON.parse(JSON.stringify(conv)); nc.id = genId(); nc.title += ' 副本'; a.conversations.splice(idx + 1, 0, nc); saveState(); renderTopicList(); toast('已复制'); }
    else if (val === 'up' || val === 'down') { const ti = val === 'up' ? idx - 1 : idx + 1; [a.conversations[idx], a.conversations[ti]] = [a.conversations[ti], a.conversations[idx]]; saveState(); renderTopicList(); }
    else if (val === 'delete' && await showDialog('删除话题？')) { a.conversations.splice(idx, 1); if (a.activeConvId === cid) a.activeConvId = a.conversations[0]?.id || null; saveState(); renderChatPage(); renderTopicList(); }
  });
}

function openEditModal(msg) { 
  editingMsg = msg; const ta = $('edit-textarea'), rta = $('edit-reasoning-textarea'), btn = $('edit-toggle-reasoning-btn'), ov = $('edit-overlay'); if(!ta || !rta || !btn || !ov) return;
  ta.value = msg.content || ''; rta.value = msg.reasoning || '';
  const isNote = !msg.reasoning || msg.isNote; btn.innerHTML = isNote ? '<i class="ph ph-note-pencil"></i> 备注' : '<i class="ph ph-brain"></i> 思考过程'; rta.placeholder = isNote ? '备注…' : '思考…';
  rta.classList.remove('show'); btn.classList.remove('active'); ov.classList.add('show'); 
}

function saveEdit() {
  if (!editingMsg) return; const val = $('edit-textarea')?.value.trim() || '', rval = $('edit-reasoning-textarea')?.value.trim() || ''; if (!val && !rval) return toast('不能为空');
  editingMsg.content = val; editingMsg.reasoning = rval; if (rval && $('edit-toggle-reasoning-btn')?.innerHTML.includes('备注')) editingMsg.isNote = true; else delete editingMsg.isNote;
  saveState(); renderChatPage(); $('edit-overlay')?.classList.remove('show'); editingMsg = null; toast('已保存');
}

// 7. Fullscreen Editor & Events
let vditorInstance = null, fsPromptOriginalValue = '', fsPromptChanged = false, isFsPromptRawMode = false, ignoreNextPopState = false;

const syncUndoRedo = () => { const ub = $('fs-undo-btn'), rb = $('fs-redo-btn'); if (ub) ub.disabled = false; if (rb) rb.disabled = false; };
async function handleFsPromptClose(fromPopState = false) {
  const cVal = isFsPromptRawMode ? $('fs-prompt-raw-textarea').value : (vditorInstance ? vditorInstance.getValue() : '');
  if (cVal.trim() !== fsPromptOriginalValue.trim() && await showDialog('是否保存修改？')) { const sp = $('s-prompt'); if (sp) { sp.value = cVal; $('s-save')?.click(); } }
  $('fs-prompt-overlay')?.classList.remove('show'); fsPromptChanged = false;
  if (!fromPopState && history.state?.page === 'fs-prompt') { ignoreNextPopState = true; history.back(); }
}
document.addEventListener('input', e => { if (e.target.id === 'fs-prompt-raw-textarea') fsPromptChanged = true; });

document.addEventListener('click', async e => {
  const get = s => e.target.closest(s); let el;

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
    if (streaming) return toast('生成中不可切换'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    showDropdown(el, [{ isHeader: true, label: 'DeepSeek' }, ...DS_MODELS.map(m => ({ label: m.name, value: m.id, selected: a.modelId === m.id, icon: m.iconColor })), { isHeader: true, label: '自定义 API' }, ...getCustomModels().map(n => ({ label: n, value: n, selected: a.modelId === n, icon: getModelInfo(n).iconColor }))], id => {
      a.modelId = id; const v = isDeepSeek(id) ? ['off', 'high', 'max'] : ['off', 'low', 'high']; if (!v.includes(a.reasoningEffort)) a.reasoningEffort = 'off'; saveState(); renderChatPage(); toast('已切换');
    });
  }
  else if ((el = get('#reasoning-btn'))) {
    if (streaming) return toast('生成中不可切换'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    const rOpts = isDeepSeek(a.modelId) ? [{label: '关闭', value: 'off'}, {label: 'High', value: 'high'}, {label: 'Max', value: 'max'}] : [{label: '关闭', value: 'off'}, {label: 'Low', value: 'low'}, {label: 'High', value: 'high'}];
    showDropdown(el, rOpts.map(o => ({ label: o.label, value: o.value, selected: a.reasoningEffort === o.value, icon: '<i class="ph ph-brain"></i>' })), val => { a.reasoningEffort = val; saveState(); renderChatPage(); });
  }
  else if ((el = get('#add-ast-btn'))) openSheet('add-ast-sheet'); 
  else if ((el = get('#create-ast'))) {
    const n = $('new-ast-name')?.value.trim(); if (!n) return toast('请输入名称');
    state.assistants.unshift({ id: genId(), name: n, systemPrompt: $('new-ast-prompt')?.value.trim(), temperature: 1.0, topP: 1.0, modelId: DEFAULT_MODEL, reasoningEffort: 'off', conversations:[], activeConvId: null });
    saveState(); closeAll(); renderAstList(); $('new-ast-name').value = ''; toast('已创建');
  }
  else if ((el = get('#ast-list'))) {
    const card = get('.ast-card'); if (!card) return;
    if (get('.ast-more')) { e.stopPropagation(); return handleAstMore(card.dataset.id, get('.ast-more')); }
    goToChat(card.dataset.id);
  }
  else if ((el = get('#topic-list'))) {
    const a = getActiveAst(), item = get('.topic-item'); if (!a || !item) return;
    if ((el = get('.topic-more'))) return handleTopicMore(item.dataset.cid, el);
    a.activeConvId = item.dataset.cid; saveState(); closeAll(); renderChatPage(); renderTopicList(); userScrolledUp = false; scrollBottom(true, false);
  }
  else if ((el = get('#new-topic'))) { const a = getActiveAst(); if (a) { a.activeConvId = null; saveState(); closeAll(); renderChatPage(); userScrolledUp = false; scrollBottom(true, false); } }
  else if ((el = get('.density-dot'))) { const tg = $('#messages')?.querySelector(`.msg[data-index="${el.dataset.idx}"]`); if (tg) { $('#chat-container').scrollTo({ top: tg.offsetTop - 14, behavior: 'smooth' }); userScrolledUp = true; } }
  else if ((el = get('#messages'))) {
    const btn = get('button[data-a]'), hint = get('.welcome-hint'), rhead = get('.rhead');
    if (hint) { const uinp = $('#user-input'); if(uinp) uinp.value = hint.dataset.prompt; return sendMessage(); }
    if (rhead) { rhead.classList.toggle('open'); rhead.nextElementSibling?.classList.toggle('open'); return; }
    if (btn) {
      e.stopPropagation(); const act = btn.dataset.a, idx = parseInt(btn.closest('.msg').dataset.index, 10), conv = getActiveConv(), msg = conv.messages[idx];
      if (act === 'cp') return copyText(msg.content).then(() => toast('已复制'));
      if (streaming) return toast('生成中不可操作');
      if (act === 'ed') openEditModal(msg);
      else if (act === 'del' && await showDialog('删除这条消息吗？')) { conv.messages.splice(idx, 1); saveState(); renderChatPage(); }
      else if (act === 're' && await showDialog('重新操作？')) {
        let tIdx = idx; if (msg.role === 'assistant') { while (tIdx >= 0 && conv.messages[tIdx].role !== 'user') tIdx--; if (tIdx < 0) return toast('无法重新生成'); }
        const uinp = $('#user-input'); if(uinp){ uinp.value = conv.messages[tIdx].content; uinp.dispatchEvent(new Event('input')); }
        conv.messages = conv.messages.slice(0, tIdx); saveState(); renderChatPage(); sendMessage();
      }
    }
  }
  else if ((el = get('#settings-body'))) {
    const btn = s => get(s);
    if (btn('#data-export')) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ _meta: { version: 10, date: new Date().toISOString() }, data: state }, null, 2)], { type: 'application/json' })); a.download = getBackupName(); a.click(); toast('已导出备份'); } 
    else if (btn('#data-import-btn')) $('import-file')?.click();
    else if (btn('#data-push')) {
      const auth = getWebDAVAuth(); if (!auth) return; toast('正在同步...');
      const name = getBackupName(), data = { _meta: { version: 10, date: new Date().toISOString() }, data: state };
      fetchDAV(name, auth, 'PUT', data).then(async res => { 
        if(!(res.ok || res.status === 201 || res.status === 204)) throw new Error(res.status);
        let idx = []; try { const r = await fetchDAV('backup_index.json', auth); if (r.ok) idx = await r.json(); } catch(e) {}
        if (!Array.isArray(idx)) idx = []; if (!idx.includes(name)) { idx.unshift(name); await fetchDAV('backup_index.json', auth, 'PUT', idx); }
        toast('同步云端成功');
      }).catch(err => toast(`上传失败: ${err.message}`, 4000));
    }
    else if (btn('#data-pull')) {
      const auth = getWebDAVAuth(), pullBtn = btn('#data-pull'); if (!auth) return; toast('获取列表中...');
      fetchDAV('backup_index.json', auth, 'GET', null, { 'Cache-Control': 'no-cache, no-store' }).then(async res => { if(!res.ok) throw new Error(res.status); return res.json(); }).then(async files => {
        if (!Array.isArray(files) || !files.length) throw new Error('云端备份列表为空');
        showDropdown(pullBtn, [{ isHeader: true, label: '选择拉取的备份' }, ...files.map(f => ({ label: f, value: f, icon: '<i class="ph ph-file-json"></i>' }))], async val => {
          toast(`正在拉取...`);
          try { const r = await fetchDAV(val, auth, 'GET', null, { 'Cache-Control': 'no-cache' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const json = await r.json(); await mergeData(json.data || json, '拉取并覆盖合并？'); toast('拉取成功'); } catch(err) { toast(`失败: ${err.message}`); }
        });
      }).catch(err => toast(`失败: ${err.message}`, 4000));
    }
    else if (btn('#s-save')) {
      const a = getActiveAst(), val = id => $(id)?.value; if (!a) return;
      a.name = val('s-name')?.trim() || a.name; a.systemPrompt = val('s-prompt')?.trim() ?? a.systemPrompt; a.temperature = parseFloat(val('s-temp') || a.temperature); a.topP = parseFloat(val('s-topp') || a.topP);
      ['dskey:deepseekKey', 'gmkey:geminiKey', 'gmurl:geminiBaseUrl', 'webdavUser:webdavUser', 'webdavToken:webdavToken'].forEach(k => { const[id, sk]=k.split(':'); state[sk] = val('s-'+id)?.trim() ?? state[sk]; });
      state.geminiModels = val('s-gmmodels')?.trim() || 'gemini-2.5-pro'; state.darkMode = $('#s-theme')?.classList.contains('active') || false;
      saveState(); applyTheme(); renderChatPage(); renderAstList(); closeAll(); toast('设置已保存');
    } else {
      const themeSw = btn('#s-theme'); if (themeSw) { themeSw.classList.toggle('active'); const isD = themeSw.classList.contains('active'); themeSw.previousElementSibling.innerHTML = `<i class="ph-fill ph-${isD ? 'moon' : 'sun'}"></i> ${isD ? '暗色模式' : '亮色模式'}`; }
      if (btn('#s-prompt-fs-btn')) { 
        fsPromptOriginalValue = $('#s-prompt')?.value || ''; fsPromptChanged = false; isFsPromptRawMode = false;
        const toggleBtn = $('#fs-prompt-toggle-mode'); if (toggleBtn) { toggleBtn.innerHTML = '<i class="ph ph-file-text"></i>'; toggleBtn.title = '纯文本模式'; }
        $('#fs-prompt-raw-textarea')?.classList.add('hidden'); $('#fs-prompt-vditor')?.classList.remove('hidden'); $('#fs-prompt-overlay')?.classList.add('show'); history.pushState({ page: 'fs-prompt' }, '');
        if (!window.Vditor) return toast('编辑器加载中...');
        if (!vditorInstance) { vditorInstance = new Vditor('fs-prompt-vditor', { mode: 'ir', height: '100%', cache: { enable: false }, value: fsPromptOriginalValue, theme: state.darkMode ? 'dark' : 'classic', icon: 'material', toolbar: ['undo', 'redo'], input: () => { fsPromptChanged = true; setTimeout(syncUndoRedo, 100); }, after: () => { setTimeout(syncUndoRedo, 100); } });
        } else { vditorInstance.setValue(fsPromptOriginalValue); vditorInstance.setTheme(state.darkMode ? 'dark' : 'classic', state.darkMode ? 'dark' : 'light'); setTimeout(syncUndoRedo, 100); }
      }
    }
  }
  else if ((el = get('.prompt-toolbar'))) {
    if ((el = get('#fs-prompt-toggle-mode'))) {
      const rawTa = $('fs-prompt-raw-textarea'), vdContainer = $('fs-prompt-vditor'); isFsPromptRawMode = !isFsPromptRawMode;
      if (isFsPromptRawMode) { rawTa.value = vditorInstance ? vditorInstance.getValue() : ''; vdContainer.classList.add('hidden'); rawTa.classList.remove('hidden'); el.innerHTML = '<i class="ph ph-markdown-logo"></i>'; } else { if (vditorInstance) vditorInstance.setValue(rawTa.value); rawTa.classList.add('hidden'); vdContainer.classList.remove('hidden'); el.innerHTML = '<i class="ph ph-file-text"></i>'; }
      setTimeout(syncUndoRedo, 100); return;
    }
    const btn = get('button[data-md]'); if (btn) { const action = btn.dataset.md; if (isFsPromptRawMode) { $('fs-prompt-raw-textarea').focus(); document.execCommand(action); } else if (vditorInstance) { const b = document.querySelector(`#fs-prompt-vditor button[data-type="${action}"]`); if (b) b.click(); else document.execCommand(action); } setTimeout(syncUndoRedo, 100); } 
  }
  else if ((el = get('#fs-prompt-save'))) { const sp = $('s-prompt'); if (sp) { const newVal = isFsPromptRawMode ? $('fs-prompt-raw-textarea').value : (vditorInstance ? vditorInstance.getValue() : sp.value); sp.value = newVal; fsPromptOriginalValue = newVal; setTimeout(() => fsPromptChanged = false, 50); $('s-save')?.click(); } }
  else if ((el = get('#fs-prompt-close'))) handleFsPromptClose();
  else if ((el = get('#edit-cancel-btn'))) { $('edit-overlay')?.classList.remove('show'); editingMsg = null; }
  else if ((el = get('#edit-save-btn'))) saveEdit();
  else if ((el = get('#edit-toggle-reasoning-btn'))) { const rta = $('edit-reasoning-textarea'); if(rta) { const isActive = rta.classList.toggle('show'); el.classList.toggle('active', isActive); if(isActive) rta.focus(); } }
});

const userInput = $('user-input');
if(userInput) {
  on(userInput, 'keydown', function(e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); } });
  on(userInput, 'input', function() { this.style.height = 'auto'; this.style.height = `${Math.min(this.scrollHeight, 220)}px`; });
}

// 8. Init
await IDB.init().catch(()=>{}); 
await loadState(); 
setupPWA(); 
applyTheme(); 

if (!state.activeAstId || !state.assistants.some(a => a.id === state.activeAstId)) state.activeAstId = state.assistants[0]?.id || 'default-ast';
if (window.innerWidth > 768) $('app')?.classList.add('left-open');

renderAstList(); saveState(); 
history.replaceState({ page: 'chat', id: state.activeAstId }, '');
renderChatPage();

window.addEventListener('popstate', async e => { 
  if (ignoreNextPopState) return ignoreNextPopState = false;
  if ($('fs-prompt-overlay')?.classList.contains('show')) return handleFsPromptClose(true);
  if ($('sheet-overlay')?.classList.contains('show')) return closeAll(true);
  closeAll(true); 
  if (e.state?.page === 'chat' && e.state.id) state.activeAstId = e.state.id;
  renderChatPage(); 
});

})();