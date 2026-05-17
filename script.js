(async () => {
'use strict';

const $ = s => typeof s === 'string' ? document.getElementById(s) : s;
const on = (e, evt, cb, opts) => $(e)?.addEventListener(evt, cb, opts);
const off = (e, evt, cb) => $(e)?.removeEventListener(evt, cb);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad0 = n => n.toString().padStart(2, '0');
const getBackupName = () => { const d = new Date(); return `AIChatBackup-${d.getFullYear()}${pad0(d.getMonth()+1)}${pad0(d.getDate())}-${pad0(d.getHours())}${pad0(d.getMinutes())}.json`; };
const getTokens = s => !s ? 0 : Math.ceil((s.match(/[\u4e00-\u9fa5]/g) || []).length + (s.length - (s.match(/[\u4e00-\u9fa5]/g) || []).length) * 0.25);
const getMsgTokens = m => getTokens(m.content) + getTokens(m.reasoning);
const formatK = t => t < 1000 ? t : (t / 1000).toFixed(1) + 'k';

const DEFAULT_MODEL = 'deepseek-v4-pro', DEFAULT_GM_URL = 'https://generativelanguage.googleapis.com', STORE_KEY = 'ai_chat_v8';

const IDB = {
  db: null,
  init: () => new Promise(r => { const req = indexedDB.open('AIChatDB', 1); req.onupgradeneeded = e => e.target.result.createObjectStore('store'); req.onsuccess = e => { IDB.db = e.target.result; r(); }; }),
  exec: (m, f, a) => new Promise(r => { if (!IDB.db) return r(null); const req = IDB.db.transaction('store', m).objectStore('store')[f](...a); req.onsuccess = () => r(f === 'get' ? req.result : undefined); }),
  get: k => IDB.exec('readonly', 'get', [k]), set: (k, v) => IDB.exec('readwrite', 'put', [v, k])
};

let state = { assistants: [], activeAstId: null, deepseekKey: '', geminiKey: '', geminiBaseUrl: DEFAULT_GM_URL, geminiModels: 'gemini-2.5-pro, gemini-3.0-flash', darkMode: false, webdavUser: '', webdavToken: '' };
let abortCtrl = null, streaming = false, editingMsg = null, userScrolledUp = false;

const svgIco = (n, c) => c ? `<img src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}-color.svg" style="width:1.2em;height:1.2em;vertical-align:middle;">` : `<span style="display:inline-block;width:1.1em;height:1.1em;background-color:currentColor;-webkit-mask:url('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${n}.svg') center/contain no-repeat;vertical-align:middle;"></span>`;
const IC_DS_C = svgIco('deepseek', 1), IC_DS_M = svgIco('deepseek', 0), IC_GM_C = svgIco('gemini', 1), IC_GM_M = svgIco('gemini', 0);
const DS_MODELS = [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', icC: IC_DS_C, icM: IC_DS_M }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', icC: IC_DS_C, icM: IC_DS_M }];

const getModelInfo = id => DS_MODELS.find(m => m.id === id) || { iconColor: id.includes('gemini') ? IC_GM_C : (id.includes('deepseek') ? IC_DS_C : '<i class="ph-fill ph-sparkle" style="color:var(--accent);"></i>'), iconMono: id.includes('gemini') ? IC_GM_M : (id.includes('deepseek') ? IC_DS_M : '<i class="ph-fill ph-sparkle"></i>'), name: id, custom: true };
const isDeepSeek = id => DS_MODELS.some(m => m.id === id) || (id || '').toLowerCase().includes('deepseek');
const getCustomModels = () => (state.geminiModels || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadState() {
  const p = await IDB.get(STORE_KEY) || JSON.parse(localStorage.getItem(STORE_KEY));
  if (p) { delete p.groups; state = { ...state, ...p }; await IDB.set(STORE_KEY, state); }
  state.assistants = state.assistants.map(a => ({ ...a, id: a.id || genId(), name: a.name || '未命名', systemPrompt: a.systemPrompt || '', temperature: a.temperature ?? 1.0, topP: a.topP ?? 1.0, modelId: a.modelId || a.geminiModel || DEFAULT_MODEL, reasoningEffort: a.reasoningEffort || 'off', conversations: (a.conversations || []).map(c => ({ ...c, id: c.id || genId(), title: c.title || '新话题', messages: (c.messages || []).map(m => ({ ...m, genTime: m.genTime || m.reasoningTime })) })) }));
  if (!state.assistants.length) state.assistants.push({ id: 'default-ast', name: '全能助手', systemPrompt: '你是一个高通用性、严谨且富有协作精神的AI助手。你的核心目标不是扮演特定角色，而是动态适配用户的真实需求。', temperature: 1.0, topP: 1.0, modelId: DEFAULT_MODEL, reasoningEffort: 'off', conversations: [], activeConvId: null });
}

let saveTimer = null;
const saveState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => IDB.set(STORE_KEY, state).catch(()=>{}), 300); };
const getActiveAst = () => state.assistants.find(a => a.id === state.activeAstId) || null;
const getActiveConv = (a = getActiveAst()) => a?.conversations.find(c => c.id === a.activeConvId) || null;
function ensureConv(a) { let c = getActiveConv(a); if (!c) { c = { id: genId(), title: '新话题', messages: [] }; a.conversations.unshift(c); a.activeConvId = c.id; saveState(); } return c; }

function toast(m, d = 2500) { const t = $('toast'); if(!t) return; t.innerHTML = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), d); }
const copyText = t => navigator.clipboard.writeText(t);

function showDialog(msg, isInput = false, defaultVal = '') {
  return new Promise(r => {
    $('dialog-msg').textContent = msg; const inp = $('dialog-input');
    $('dialog-input-wrap').classList.toggle('hidden', !isInput); inp.value = isInput ? defaultVal : '';
    $('dialog-overlay').classList.add('show'); if (isInput) setTimeout(() => inp.focus(), 50);
    const cleanup = () => { $('dialog-overlay').classList.remove('show'); off('dialog-ok', 'click', onOk); off('dialog-cancel', 'click', onCancel); off(inp, 'keydown', onKey); };
    const onOk = () => { cleanup(); r(isInput ? inp.value : true); }, onCancel = () => { cleanup(); r(isInput ? null : false); };
    const onKey = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    on('dialog-ok', 'click', onOk); on('dialog-cancel', 'click', onCancel); if (isInput) on(inp, 'keydown', onKey);
  });
}

function applyTheme() { document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light'); const ht = $('hljs-theme'); if (ht) ht.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github${state.darkMode ? '-dark' : ''}.min.css`; }
const setupPWA = () => navigator.serviceWorker?.register(URL.createObjectURL(new Blob([`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>self.clients.claim());`], { type: 'application/javascript' }))).catch(()=>{});

function toggleDrawer(side, force) { const app = $('app'); if (!app) return; const cls = `${side}-open`, opp = side === 'left' ? 'right-open' : 'left-open'; const open = force !== undefined ? force : !app.classList.contains(cls); app.classList.toggle(cls, open); if (open) app.classList.remove(opp); }
const closeDrawers = () => document.querySelectorAll('.sheet, .topics-modal').forEach(el => el.classList.remove('open'));
let ignoreNextPopState = false;
const closeAll = (pop = false) => { hideDropdown(); const ov = $('sheet-overlay'), was = ov?.classList.contains('show'); ov?.classList.remove('show'); if (window.innerWidth <= 768) { toggleDrawer('left', false); toggleDrawer('right', false); } closeDrawers(); if (was && !pop && history.state?.drawer) { ignoreNextPopState = true; history.back(); } };
const openSheet = id => { closeDrawers(); $('sheet-overlay')?.classList.add('show'); $(id)?.classList.add('open'); if (!history.state?.drawer) history.pushState({ ...history.state, drawer: true }, ''); };
function goToChat(id, fromHistory = false) { state.activeAstId = id; saveState(); if (!fromHistory) history.pushState({ page: 'chat', id }, ''); renderChatPage(); renderAstList(); closeAll(); userScrolledUp = false; scrollBottom(true); }

function renderAstList() {
  const l = $('ast-list'); if (!l) return;
  if (!state.assistants.length) return l.innerHTML = '<div class="empty"><i class="ph ph-ghost empty-icon"></i> 还没有助手，点击右上角 ＋ 创建</div>';
  l.innerHTML = state.assistants.map(a => `<div class="ast-card ${a.id === state.activeAstId ? 'active' : ''}" data-id="${a.id}"><div class="ast-name">${a.name}</div><button class="ast-more"><i class="ph ph-dots-three-vertical"></i></button></div>`).join('');
}

function handleAstMore(id, btn) {
  const i = state.assistants.findIndex(a => a.id === id); if (i < 0) return;
  const items = [{ label: '删除助手', value: 'del', icon: '<i class="ph ph-trash"></i>' }];
  if (i > 0) items.push({ label: '上移', value: 'up', icon: '<i class="ph ph-arrow-up"></i>' });
  if (i < state.assistants.length - 1) items.push({ label: '下移', value: 'down', icon: '<i class="ph ph-arrow-down"></i>' });
  showDropdown(btn, items, async v => {
    if (v === 'del' && await showDialog('确定删除此助手吗？')) { state.assistants.splice(i, 1); if (state.activeAstId === id) state.activeAstId = state.assistants[0]?.id; if (state.activeAstId) renderChatPage(); }
    else if (v === 'up' || v === 'down') { const t = v === 'up' ? i - 1 : i + 1; [state.assistants[i], state.assistants[t]] = [state.assistants[t], state.assistants[i]]; }
    saveState(); renderAstList();
  });
}

function renderChatPage() {
  let a = getActiveAst(); if (!a && state.assistants.length > 0) { state.activeAstId = state.assistants[0].id; a = getActiveAst(); } if (!a) return;
  const c = getActiveConv(a), m = getModelInfo(a.modelId);
  if ($('chat-asst-name')) $('chat-asst-name').textContent = a.name;
  if ($('chat-topic-name')) $('chat-topic-name').textContent = c ? c.title : '新话题'; 
  if ($('chat-nav-tokens')) $('chat-nav-tokens').textContent = `(${c ? c.messages.length : 0})`;
  if ($('model-chip-btn')) $('model-chip-btn').innerHTML = m.iconColor;
  if ($('reasoning-btn')) $('reasoning-btn').innerHTML = `<i class="ph ph-brain"></i><span>${{ off: '关闭', low: 'Low', high: 'High', max: 'Max' }[a.reasoningEffort] || a.reasoningEffort}</span>`;
  renderMessages();
}

if (window.markedKatex && window.marked) marked.use(window.markedKatex({ throwOnError: false }));
if (window.marked) marked.setOptions({ breaks: true, gfm: true });
const md = t => { const s = String(t||'').replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$').replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$'); try { return window.marked ? marked.parse(s) : s.replace(/\n/g, '<br>'); } catch(e) { return s.replace(/\n/g, '<br>'); } };

function enhanceCodeBlocks(c) {
  c.querySelectorAll('pre:not(.code-block-wrapper pre)').forEach(pre => {
    const code = pre.querySelector('code'), lang = code?.className.match(/language-(\w+)/)?.[1] || 'text';
    const w = document.createElement('div'); w.className = 'code-block-wrapper collapsed';
    w.innerHTML = `<div class="code-block-header"><span class="code-lang">${lang}</span><div class="code-btns"><button class="code-btn copy-btn"><i class="ph ph-copy"></i> 复制</button><button class="code-btn fold-btn">展开</button></div></div>`;
    pre.replaceWith(w); w.appendChild(pre);
    on(w.querySelector('.copy-btn'), 'click', e => { e.stopPropagation(); copyText((code || pre).textContent).then(() => { e.target.innerHTML = '<i class="ph ph-check"></i>'; setTimeout(() => e.target.innerHTML = '<i class="ph ph-copy"></i> 复制', 1200); }); });
    on(w.querySelector('.fold-btn'), 'click', e => { e.stopPropagation(); e.target.textContent = w.classList.toggle('collapsed') ? '展开' : '折叠'; });
    if (code && window.hljs) { try{ hljs.highlightElement(code); }catch(e){} }
  });
  c.querySelectorAll('table:not(.table-wrapper table)').forEach(t => { const w = document.createElement('div'); w.className = 'table-wrapper'; t.replaceWith(w); w.appendChild(t); });
}

function makeMsg(msg, idx) {
  const isAi = msg.role === 'assistant', d = document.createElement('div'); d.className = `msg ${isAi ? 'ai' : 'user'}`; d.dataset.index = idx;
  const rHTML = msg.reasoning ? `<div class="rblock"><button class="rhead"><span>${msg.isNote ? '<i class="ph ph-note-pencil"></i> 备注' : '<i class="ph ph-brain"></i> 思考'}</span><i class="ph ph-caret-right arr"></i></button><div class="rbody">${msg.reasoning}</div></div>` : '';
  const mi = getModelInfo(msg.modelId || getActiveAst()?.modelId);
  d.innerHTML = `<div class="bubble">${rHTML}<div class="markdown-body">${md(msg.content)}</div></div><div class="msg-actions"><div class="actions-left">${isAi ? `<span class="badge">${mi.iconMono} ${mi.name}</span><span class="gen-time"><i class="ph ph-timer"></i> ${msg.genTime || (msg.startTime ? ((Date.now()-msg.startTime)/1000).toFixed(0) : '0')}s</span>` : ''}</div><div class="msg-tokens">${isAi ? '<i class="ph ph-tag"></i> ' + formatK(getMsgTokens(msg)) : ''}</div><div class="actions-right"><button data-a="cp"><i class="ph ph-copy"></i></button><button data-a="ed"><i class="ph ph-pencil-simple"></i></button><button data-a="del"><i class="ph ph-trash"></i></button><button data-a="re"><i class="ph ${isAi ? 'ph-arrows-clockwise' : 'ph-arrow-u-up-left'}"></i></button></div></div>`;
  enhanceCodeBlocks(d); return d;
}

function renderMessages() {
  const msgs = $('messages'); if(!msgs) return; const c = getActiveConv(); msgs.innerHTML = '';
  if (!c || !c.messages.length) return msgs.innerHTML = `<div class="welcome"><div class="emoji"><i class="ph-fill ph-sparkle"></i></div><h3>开始对话</h3><p>输入消息，点击发送按钮开始</p><div class="welcome-hints"><div class="welcome-hint" data-prompt="用简单的语言解释量子计算"><i class="ph ph-microscope"></i> 解释量子计算</div><div class="welcome-hint" data-prompt="写一首关于夏天的中国古诗"><i class="ph ph-pen-nib"></i> 写一首古诗</div><div class="welcome-hint" data-prompt="用Python写一个贪吃蛇游戏"><i class="ph ph-code"></i> 写贪吃蛇游戏</div><div class="welcome-hint" data-prompt="给我一个一周健身计划"><i class="ph ph-barbell"></i> 健身计划</div></div></div>`;
  c.messages.forEach((m, i) => msgs.appendChild(makeMsg(m, i)));
  setTimeout(updateDensityMap, 50);
}

function renderTopicList() {
  const a = getActiveAst(), l = $('topic-list'), dtk = $('drawer-total-tokens'); if(!l) return;
  if (!a || !a.conversations.length) { l.innerHTML = '<div class="empty">暂无话题</div>'; if(dtk) dtk.textContent = '0'; return; }
  let tTk = 0; l.innerHTML = a.conversations.map(c => {
    const tk = c.messages.reduce((t, m) => t + getTokens(m.content), getTokens(a.systemPrompt)); tTk += tk;
    return `<div class="topic-item ${c.id === a.activeConvId ? 'active' : ''}" data-cid="${c.id}"><span><i class="ph ph-chat-teardrop-text"></i></span><div class="tinfo"><div class="ttitle-wrap"><div class="ttitle">${c.title}</div><span class="nav-tokens">${formatK(tk)}</span></div><div class="tmeta">${c.messages.length} 条消息</div></div><button class="topic-more"><i class="ph ph-dots-three-vertical"></i></button></div>`;
  }).join(''); if(dtk) dtk.textContent = formatK(tTk);
}

function renderSettings() {
  const a = getActiveAst(), sBody = $('settings-body'); if (!a || !sBody) return;
  sBody.innerHTML = `<div class="settings-group"><div class="settings-item"><label>助手名称</label><input id="s-name" value="${a.name}"></div><div class="settings-item col"><label>系统提示词 <button id="s-prompt-fs-btn" class="icon-btn"><i class="ph ph-corners-out"></i></button></label><textarea id="s-prompt" rows="3">${a.systemPrompt}</textarea></div><div class="settings-item col"><label>Temperature: <span id="s-tval">${a.temperature.toFixed(2)}</span></label><input type="range" id="s-temp" min="0" max="2" step="0.05" value="${a.temperature}" oninput="$('s-tval').textContent=this.value"></div><div class="settings-item col"><label>Top P: <span id="s-pval">${a.topP.toFixed(2)}</span></label><input type="range" id="s-topp" min="0" max="1" step="0.05" value="${a.topP}" oninput="$('s-pval').textContent=this.value"></div></div><div class="settings-group"><div class="settings-item"><label>DeepSeek Key</label><input type="password" id="s-dskey" value="${state.deepseekKey}" placeholder="sk-..."></div><div class="settings-item"><label>Gemini Key</label><input type="password" id="s-gmkey" value="${state.geminiKey || ''}" placeholder="AIzaSy..."></div><div class="settings-item"><label>Gemini URL</label><input id="s-gmurl" value="${state.geminiBaseUrl || DEFAULT_GM_URL}"></div><div class="settings-item"><label>Custom Models</label><input id="s-gmmodels" value="${state.geminiModels || 'gemini-2.5-pro'}" placeholder="逗号分隔"></div></div><div class="settings-group"><div class="settings-item"><label>坚果云账号</label><input id="s-webdavUser" value="${state.webdavUser || ''}" placeholder="邮箱"></div><div class="settings-item"><label>应用密码</label><input type="password" id="s-webdavToken" value="${state.webdavToken || ''}" placeholder="WebDAV 密码"></div><div class="settings-item row-btn"><button id="data-push"><i class="ph ph-cloud-arrow-up"></i> 云端推送</button><button id="data-pull"><i class="ph ph-cloud-arrow-down"></i> 云端拉取</button></div></div><div class="settings-group"><div class="settings-item row-btn"><button id="data-export"><i class="ph ph-upload-simple"></i> 导出本地备份</button><button id="data-import-btn"><i class="ph ph-download-simple"></i> 导入本地备份</button></div></div><div class="settings-group"><div class="settings-item"><label id="theme-label"><i class="ph-fill ph-${state.darkMode ? 'moon' : 'sun'}"></i> ${state.darkMode ? '暗色' : '亮色'}模式</label><div class="tsw ${state.darkMode ? 'active' : ''}" id="s-theme"></div></div></div><button class="btn-primary mt-8" style="width:100%;margin-bottom:20px;" id="s-save"><i class="ph ph-floppy-disk"></i> 保存所有设置</button>`;
}

function updateLive(msgEl, msg) {
  if (!msgEl) return; const bub = msgEl.querySelector('.bubble'); if (!bub) return;
  if (msg.reasoning) { let rb = bub.querySelector('.rblock'); if (!rb) { bub.insertAdjacentHTML('afterbegin', `<div class="rblock"><button class="rhead open"><span><i class="ph ph-brain"></i> 思考过程</span><i class="ph ph-caret-right arr"></i></button><div class="rbody open"></div></div>`); rb = bub.querySelector('.rblock'); } if (msg.content && !rb.dataset.cl) { rb.querySelector('.rhead').classList.remove('open'); rb.querySelector('.rbody').classList.remove('open'); rb.dataset.cl = '1'; } rb.querySelector('.rbody').textContent = msg.reasoning; }
  let mc = bub.querySelector('.markdown-body'); if (!mc) { bub.insertAdjacentHTML('beforeend', '<div class="markdown-body"></div>'); mc = bub.querySelector('.markdown-body'); } mc.innerHTML = md(msg.content); enhanceCodeBlocks(bub);
  const tk = msgEl.querySelector('.msg-tokens'); if (tk) tk.innerHTML = `<i class="ph ph-tag"></i> ${formatK(getMsgTokens(msg))}`;
}

function getApiConfig(a, c) {
  const msgs = c.messages.slice(0, -1);
  if (isDeepSeek(a.modelId)) return { url: 'https://api.deepseek.com/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.deepseekKey}` }, body: { model: a.modelId, stream: true, messages: [{ role: 'system', content: a.systemPrompt }, ...msgs.map(m => ({ role: m.role, content: m.content }))], ...(a.reasoningEffort === 'off' ? { temperature: a.temperature, top_p: a.topP, thinking: { type: 'disabled' } } : { reasoning_effort: a.reasoningEffort, thinking: { type: 'enabled' } }) } };
  const contents = msgs.reduce((acc, m) => { const parts = [...(m.thoughtSignatures || []).map(s => ({ thoughtSignature: s })), { text: m.content || ' ' }], role = m.role === 'user' ? 'user' : 'model'; if (acc.length && acc[acc.length - 1].role === role) acc[acc.length - 1].parts.push(...parts); else acc.push({ role, parts }); return acc; }, []);
  return { url: `${(state.geminiBaseUrl || DEFAULT_GM_URL).replace(/\/+$/, '')}/v1beta/models/${a.modelId}:streamGenerateContent?alt=sse`, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': state.geminiKey, ...(state.geminiKey.startsWith('sk-') ? {'Authorization': `Bearer ${state.geminiKey}`} : {}) }, body: { contents, systemInstruction: a.systemPrompt ? { role: "system", parts: [{ text: a.systemPrompt }] } : undefined, generationConfig: { temperature: a.temperature, topP: a.topP, thinkingConfig: a.reasoningEffort !== 'off' ? { includeThoughts: true, [a.modelId.includes('gemini-3') ? 'thinkingLevel' : 'thinkingBudget']: a.reasoningEffort === 'low' ? (a.modelId.includes('gemini-3') ? 'LOW' : 1024) : (a.modelId.includes('gemini-3') ? 'HIGH' : 8192) } : undefined } } };
}

async function sendMessage() {
  if (streaming) return; const inp = $('user-input'), txt = inp?.value.trim(), a = getActiveAst(); if (!txt || !a) return;
  if (isDeepSeek(a.modelId) ? !state.deepseekKey : !state.geminiKey) return toast('请先设置对应的 API Key') || $('settings-btn')?.click();
  inp.value = ''; inp.style.height = 'auto'; const c = ensureConv(a); c.messages.push({ role: 'user', content: txt }); if (c.title === '新话题') c.title = txt.substring(0, 28) + (txt.length > 28 ? '…' : '');
  userScrolledUp = false; renderMessages(); scrollBottom(true);
  const am = { role: 'assistant', content: '', reasoning: '', modelId: a.modelId, startTime: Date.now() }; c.messages.push(am); saveState(); renderMessages(); 
  streaming = true; $('send-btn').classList.add('hidden'); inp.disabled = true; $('stop-btn').classList.remove('hidden'); 
  if ($('chat-nav-tokens')) $('chat-nav-tokens').textContent = `(${c.messages.length})`; const el = $('messages')?.lastElementChild; abortCtrl = new AbortController(); 
  let t = setInterval(() => { const g = el?.querySelector('.gen-time'); if (g) g.innerHTML = `<i class="ph ph-timer"></i> ${((Date.now() - am.startTime)/1000).toFixed(0)}s`; }, 1000);
  try {
    const conf = getApiConfig(a, c), resp = await fetch(conf.url, { method: 'POST', headers: conf.headers, body: JSON.stringify(conf.body), signal: abortCtrl.signal });
    if (!resp.ok) throw new Error((await resp.json().catch(()=>{})).error?.message || `HTTP ${resp.status}`);
    const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop();
      for (let l of lines) {
        if (!l.trim() || l.startsWith('data: [DONE]')) continue;
        try { const chunk = JSON.parse(l.replace(/^data: /, ''));
          if (!isDeepSeek(a.modelId)) { for (const p of (chunk.candidates?.[0]?.content?.parts || [])) { if (p.thoughtSignature || p.thought_signature) (am.thoughtSignatures ??= []).push(p.thoughtSignature || p.thought_signature); if (String(p.thought) === "true") am.reasoning += (p.text || ''); else if (p.text) am.content += p.text; } } else { const d = chunk.choices?.[0]?.delta; am.reasoning += (d?.reasoning_content || ''); am.content += (d?.content || ''); }
          updateLive(el, am); scrollBottom();
        } catch(e){}
      }
    }
  } catch (err) { if (err.name !== 'AbortError') am.content = am.content || `❌ 错误：${err.message}`; } finally { streaming = false; abortCtrl = null; clearInterval(t); am.genTime = ((Date.now() - am.startTime)/1000).toFixed(0); delete am.startTime; saveState(); renderChatPage(); $('send-btn').classList.remove('hidden'); inp.disabled = false; $('stop-btn').classList.add('hidden'); }
}

async function mergeData(data, msg) {
  if (!await showDialog(msg)) return false; let nt = 0, ut = 0, nm = 0;
  for (const ia of (data.assistants || [])) {
    const ex = state.assistants.find(a => a.id === ia.id || a.name === ia.name);
    if (ex) {
      for (const ic of ia.conversations) {
        const exC = ex.conversations.find(c => c.id === ic.id || c.title === ic.title);
        if (exC) { if (ic.messages.length > exC.messages.length || JSON.stringify(ic.messages) !== JSON.stringify(exC.messages)) { nm += Math.max(0, ic.messages.length - exC.messages.length); ut++; exC.messages = ic.messages; exC.title = ic.title; exC.id = ic.id; } } else { ex.conversations.push(ic); nt++; nm += ic.messages.length; }
      }
      ex.conversations.sort((a, b) => b.id.localeCompare(a.id));
    } else { state.assistants.push(ia); nt += ia.conversations.length; nm += ia.conversations.reduce((s, c) => s + c.messages.length, 0); }
  }
  Object.assign(state, Object.fromEntries(Object.entries(data).filter(([k]) => ['activeAstId', 'deepseekKey', 'geminiKey', 'geminiBaseUrl', 'geminiModels', 'darkMode', 'webdavUser', 'webdavToken'].includes(k) && data[k] !== undefined && data[k] !== '')));
  saveState(); applyTheme(); renderAstList(); if (!state.assistants.some(x => x.id === state.activeAstId)) state.activeAstId = state.assistants[0]?.id; renderChatPage(); closeAll(); return { nt, ut, nm };
}

const getWebDAVAuth = () => { const u = $('s-webdavUser')?.value.trim(), t = $('s-webdavToken')?.value.trim(); if (!u || !t) return toast('请填写坚果云账号和密码'), null; state.webdavUser = u; state.webdavToken = t; saveState(); return 'Basic ' + btoa(`${u}:${t}`); };
const fetchDAV = (p, a, m='GET', b=null, h={}) => fetch(`/webdav-proxy/AIChat/${p}`, { method: m, headers: { Authorization: a, ...(b ? {'Content-Type': 'application/json'} : {}), ...h }, body: b ? JSON.stringify(b) : null });

on('import-file', 'change', e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = async ev => { try { const st = await mergeData(JSON.parse(ev.target.result)?.data || JSON.parse(ev.target.result), '导入将合并数据，确认吗？'); if (st) toast(`新增 ${st.nt} 话题，更新 ${st.ut} 话题，增补 ${st.nm} 消息`, 3500); } catch(err) { toast('文件解析错误'); } }; r.readAsText(f); e.target.value = ''; });

function updateDensityMap() { const m = $('density-map'), c = $('chat-container'), msgs = $('messages'); if (!m || !c || !msgs || c.scrollHeight <= 0) return; let dc = $('density-dots'); if (!dc) { m.innerHTML = '<div id="density-dots"></div><div id="density-thumb"></div>'; dc = $('density-dots'); } dc.innerHTML = Array.from(msgs.children).filter(x => x.classList.contains('ai')).map(x => `<div class="density-dot" data-idx="${x.dataset.index}" style="top:${(x.offsetTop/c.scrollHeight)*100}%; height:${(x.offsetHeight/c.scrollHeight)*100}%" title="跳转"></div>`).join(''); updateScrollThumb(); }
function updateScrollThumb() { const c = $('chat-container'), t = $('density-thumb'); if (!c || !t || c.scrollHeight <= 0) return; t.style.top = (c.scrollTop / c.scrollHeight) * 100 + '%'; t.style.height = Math.max((c.clientHeight / c.scrollHeight) * 100, 2) + '%'; }
const chatObserver = new ResizeObserver(() => requestAnimationFrame(updateDensityMap)), chatC = $('chat-container'); if (chatC) chatObserver.observe(chatC); if ($('messages')) chatObserver.observe($('messages'));

let isTouch = false; const setTouch = v => () => isTouch = v;
if(chatC) { ['touchstart','mousedown'].forEach(e => on(chatC, e, setTouch(true), { passive: true })); ['touchend','touchcancel','mouseup'].forEach(e => window.addEventListener(e, setTouch(false), { passive: true })); chatC.addEventListener('wheel', () => userScrolledUp = true, { passive: true }); on(chatC, 'scroll', function() { updateScrollThumb(); const dist = this.scrollHeight - this.scrollTop - this.clientHeight; if (dist <= 25) userScrolledUp = false; else if (isTouch) userScrolledUp = true; $('scroll-down')?.classList.toggle('show', dist > 200 && $('messages').children.length > 1); }); }
const scrollBottom = (force) => { if (force || (!userScrolledUp && !isTouch)) requestAnimationFrame(() => chatC?.scrollTo({ top: chatC.scrollHeight, behavior: 'smooth' })); };

let _ddActive = null, _ddAnchor = null;
function showDropdown(anchor, items, onSelect) {
  const dd = $('dropdown-menu'); if(!dd) return; if (dd.classList.contains('show') && _ddAnchor === anchor) return hideDropdown(); _ddAnchor = anchor;
  dd.innerHTML = items.map((item, i) => item.isHeader ? `<div class="dropdown-header">${item.label}</div>` : `<div class="dropdown-item ${item.selected ? 'selected' : ''}" data-idx="${i}">${item.icon || ''}<span>${item.label}</span>${item.selected ? '<i class="ph ph-check check" style="margin-left:auto"></i>' : ''}</div>`).join('');
  const r = anchor.getBoundingClientRect(), mh = dd.offsetHeight; let t = r.bottom + 8, l = r.left; if (t + mh > window.innerHeight) t = r.top - mh - 8; l = Math.max(8, Math.min(l, window.innerWidth - dd.offsetWidth - 8));
  dd.style.cssText = `top:${t}px; left:${l}px`; dd.classList.add('show');
  if (_ddActive) off(document, 'click', _ddActive); _ddActive = e => { if (e.target.closest('.dropdown-header')) return; const item = e.target.closest('.dropdown-item'); if (item) onSelect(items[item.dataset.idx].value); hideDropdown(); }; setTimeout(() => on(document, 'click', _ddActive), 10);
}
const hideDropdown = () => { const dd = $('dropdown-menu'); if (dd) dd.classList.remove('show'); if (_ddActive) off(document, 'click', _ddActive); _ddActive = _ddAnchor = null; };

function handleTopicMore(cid, btn) {
  const a = getActiveAst(), i = a?.conversations.findIndex(c => c.id === cid); if (i < 0) return; const c = a.conversations[i], items = [{ label: '重命名', value: 'rn', icon: '<i class="ph ph-pencil-simple"></i>' }, { label: '复制', value: 'cp', icon: '<i class="ph ph-copy"></i>' }, ...(i > 0 ? [{ label: '上移', value: 'up', icon: '<i class="ph ph-arrow-up"></i>' }] : []), ...(i < a.conversations.length - 1 ? [{ label: '下移', value: 'down', icon: '<i class="ph ph-arrow-down"></i>' }] : []), { label: '删除', value: 'del', icon: '<i class="ph ph-trash"></i>' }];
  showDropdown(btn, items, async v => { if (v === 'rn') { const nt = await showDialog('重命名话题', true, c.title); if (nt?.trim()) { c.title = nt.trim(); saveState(); renderChatPage(); renderTopicList(); } } else if (v === 'cp') { const nc = JSON.parse(JSON.stringify(c)); nc.id = genId(); nc.title += ' 副本'; a.conversations.splice(i + 1, 0, nc); saveState(); renderTopicList(); toast('已复制'); } else if (v === 'up' || v === 'down') { const t = v === 'up' ? i - 1 : i + 1; [a.conversations[i], a.conversations[t]] = [a.conversations[t], a.conversations[i]]; saveState(); renderTopicList(); } else if (v === 'del' && await showDialog('确定删除此话题？')) { a.conversations.splice(i, 1); if (a.activeConvId === cid) a.activeConvId = a.conversations[0]?.id || null; saveState(); renderChatPage(); renderTopicList(); } });
}

let vditorInstance = null, fsPromptOriginalValue = '', isFsPromptRawMode = false;
const syncUndoRedo = () => { if ($('fs-undo-btn')) $('fs-undo-btn').disabled = false; if ($('fs-redo-btn')) $('fs-redo-btn').disabled = false; };

document.addEventListener('click', async e => {
  const get = sel => e.target.closest(sel); let el;
  if ((el = get('#ast-drawer-btn'))) toggleDrawer('left'); else if ((el = get('#topic-toggle'))) { renderTopicList(); openSheet('topics-drawer'); } else if ((el = get('#settings-btn'))) { renderSettings(); toggleDrawer('right'); } else if ((el = get('#close-settings'))) toggleDrawer('right', false); else if ((el = get('#sheet-overlay'))) closeAll(); else if ((el = get('#chat-page-mask'))) { toggleDrawer('left', false); toggleDrawer('right', false); } else if ((el = get('#send-btn'))) sendMessage(); else if ((el = get('#stop-btn'))) abortCtrl?.abort(); else if ((el = get('#scroll-down'))) { userScrolledUp = false; scrollBottom(true); }
  else if ((el = get('#model-chip-btn'))) {
    if (streaming) return toast('生成中不可操作'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    showDropdown(el, [{ isHeader: true, label: 'DeepSeek' }, ...DS_MODELS.map(m => ({ label: m.name, value: m.id, selected: a.modelId === m.id, icon: m.iconColor })), { isHeader: true, label: '第三方模型' }, ...getCustomModels().map(n => ({ label: n, value: n, selected: a.modelId === n, icon: getModelInfo(n).iconColor }))], id => { a.modelId = id; const v = isDeepSeek(id) ? ['off', 'high', 'max'] : ['off', 'low', 'high']; if (!v.includes(a.reasoningEffort)) a.reasoningEffort = 'off'; saveState(); renderChatPage(); toast('已切换模型'); });
  }
  else if ((el = get('#reasoning-btn'))) {
    if (streaming) return toast('生成中不可操作'); e.stopPropagation(); const a = getActiveAst(); if (!a) return;
    const rOpts = isDeepSeek(a.modelId) ? [{label: '关闭', value: 'off'}, {label: 'High', value: 'high'}, {label: 'Max', value: 'max'}] : [{label: '关闭', value: 'off'}, {label: 'Low', value: 'low'}, {label: 'High', value: 'high'}];
    showDropdown(el, rOpts.map(o => ({ label: o.label, value: o.value, selected: a.reasoningEffort === o.value, icon: '<i class="ph ph-brain"></i>' })), val => { a.reasoningEffort = val; saveState(); renderChatPage(); });
  }
  else if ((el = get('#add-ast-btn'))) openSheet('add-ast-sheet'); 
  else if ((el = get('#create-ast'))) { const n = $('new-ast-name')?.value.trim(); if (!n) return toast('请输入名称'); state.assistants.unshift({ id: genId(), name: n, systemPrompt: $('new-ast-prompt')?.value.trim(), temperature: 1.0, topP: 1.0, modelId: DEFAULT_MODEL, reasoningEffort: 'off', conversations:[], activeConvId: null }); saveState(); closeAll(); renderAstList(); $('new-ast-name').value = ''; toast('已创建'); }
  else if ((el = get('#ast-list'))) { const c = get('.ast-card'); if (!c) return; if (get('.ast-more')) { e.stopPropagation(); return handleAstMore(c.dataset.id, get('.ast-more')); } goToChat(c.dataset.id); }
  else if ((el = get('#topic-list'))) { const a = getActiveAst(), i = get('.topic-item'); if (!a || !i) return; if ((el = get('.topic-more'))) return handleTopicMore(i.dataset.cid, el); a.activeConvId = i.dataset.cid; saveState(); closeAll(); renderChatPage(); renderTopicList(); userScrolledUp = false; scrollBottom(true); }
  else if ((el = get('#new-topic'))) { const a = getActiveAst(); if (a) { a.activeConvId = null; saveState(); closeAll(); renderChatPage(); userScrolledUp = false; scrollBottom(true); } }
  else if ((el = get('.density-dot'))) { const t = $('messages')?.querySelector(`.msg[data-index="${el.dataset.idx}"]`); if (t) { $('chat-container').scrollTo({ top: t.offsetTop - 14, behavior: 'smooth' }); userScrolledUp = true; } }
  else if ((el = get('#messages'))) {
    const btn = get('button[data-a]'), hint = get('.welcome-hint'), rhead = get('.rhead');
    if (hint) { const u = $('user-input'); if(u) u.value = hint.dataset.prompt; return sendMessage(); }
    if (rhead) { rhead.classList.toggle('open'); rhead.nextElementSibling?.classList.toggle('open'); return; }
    if (btn) { e.stopPropagation(); const act = btn.dataset.a, idx = parseInt(btn.closest('.msg').dataset.index, 10), c = getActiveConv(), msg = c.messages[idx];
      if (act === 'cp') return copyText(msg.content).then(() => toast('已复制')); if (streaming) return toast('生成中不可操作');
      if (act === 'ed') { editingMsg = msg; $('edit-textarea').value = msg.content || ''; const rta = $('edit-reasoning-textarea'), rbtn = $('edit-toggle-reasoning-btn'); rta.value = msg.reasoning || ''; const isN = !msg.reasoning || msg.isNote; rbtn.innerHTML = isN ? '<i class="ph ph-note-pencil"></i> 备注' : '<i class="ph ph-brain"></i> 思考'; rta.placeholder = isN ? '输入备注…' : '输入思考过程…'; rta.classList.remove('show'); rbtn.classList.remove('active'); $('edit-overlay').classList.add('show'); }
      else if (act === 'del' && await showDialog('确定删除？')) { c.messages.splice(idx, 1); saveState(); renderChatPage(); }
      else if (act === 're' && await showDialog('确定重新生成？')) { let ti = idx; if (msg.role === 'assistant') { while (ti >= 0 && c.messages[ti].role !== 'user') ti--; if (ti < 0) return toast('缺用户消息'); } const u = $('user-input'); if(u){ u.value = c.messages[ti].content; u.dispatchEvent(new Event('input')); } c.messages = c.messages.slice(0, ti); saveState(); renderChatPage(); sendMessage(); } }
  }
  else if ((el = get('.settings-group'))) {
    if ((el = get('#data-export'))) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ _meta: { version: 11, date: new Date().toISOString() }, data: state }, null, 2)], { type: 'application/json' })); a.download = getBackupName(); a.click(); toast('已导出'); }
    else if ((el = get('#data-import-btn'))) $('import-file')?.click();
    else if ((el = get('#data-push'))) {
      const auth = getWebDAVAuth(); if (!auth) return; toast('<i class="ph ph-hourglass"></i> 推送中...');
      const name = getBackupName(), data = { _meta: { version: 11, date: new Date().toISOString() }, data: state };
      try {
        const res = await fetchDAV(name, auth, 'PUT', data); if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('拒绝');
        let idx = []; try { const r = await fetchDAV('backup_index.json', auth); if (r.ok) idx = await r.json(); } catch(e){}
        if (!Array.isArray(idx)) idx = []; if (!idx.includes(name)) await fetchDAV('backup_index.json', auth, 'PUT', [name, ...idx]); toast('<i class="ph-fill ph-check-circle"></i> 推送成功');
      } catch(e) { toast(`失败: ${e.message}`); }
    }
    else if ((el = get('#data-pull'))) {
      const auth = getWebDAVAuth(); if (!auth) return; toast('<i class="ph ph-hourglass"></i> 获取列表...');
      try {
        const res = await fetchDAV('backup_index.json', auth, 'GET', null, { 'Cache-Control': 'no-cache' }); if (!res.ok) throw new Error('失败');
        const files = await res.json(); if (!files?.length) throw new Error('云端空'); toast('<i class="ph ph-hourglass"></i> 校验中...');
        const valids = (await Promise.all(files.map(async f => (await fetchDAV(f, auth, 'HEAD')).ok ? f : null))).filter(Boolean); if (!valids.length) throw new Error('已被删除');
        if (valids.length < files.length) fetchDAV('backup_index.json', auth, 'PUT', valids).catch(()=>{});
        showDropdown(get('#data-pull'), [{ isHeader: true, label: '选择备份' }, ...valids.map(f => ({ label: f, value: f, icon: '<i class="ph ph-file-json"></i>' }))], async val => { toast('<i class="ph ph-hourglass"></i> 拉取中...'); try { const r = await fetchDAV(val, auth, 'GET', null, { 'Cache-Control': 'no-cache' }), st = await mergeData((await r.json())?.data || await r.json(), '确认合并？'); if (st) toast(`拉取成功：新增 ${st.nt} 话题，更新 ${st.ut}，增补 ${st.nm} 消息`, 3500); } catch(err) { toast(`解析失败: ${err.message}`); } });
      } catch(e) { toast(`失败: ${e.message}`); }
    }
    else if ((el = get('#s-prompt-fs-btn'))) {
      fsPromptOriginalValue = $('s-prompt')?.value || ''; isFsPromptRawMode = false;
      $('fs-prompt-toggle-mode').innerHTML = '<i class="ph ph-file-text"></i>'; $('fs-prompt-raw-textarea').classList.add('hidden'); $('fs-prompt-vditor').classList.remove('hidden'); $('fs-prompt-overlay').classList.add('show'); history.pushState({ page: 'fs-prompt' }, '');
      if (!window.Vditor) return toast('加载中...');
      if (!vditorInstance) vditorInstance = new Vditor('fs-prompt-vditor', { mode: 'ir', height: '100%', cache: { enable: false }, value: fsPromptOriginalValue, theme: state.darkMode ? 'dark' : 'classic', icon: 'material', toolbar: ['undo', 'redo'], input: syncUndoRedo, after: syncUndoRedo });
      else { vditorInstance.setValue(fsPromptOriginalValue); vditorInstance.setTheme(state.darkMode ? 'dark' : 'classic', state.darkMode ? 'dark' : 'light'); }
    }
    else if ((el = get('#s-theme'))) { el.classList.toggle('active'); $('theme-label').innerHTML = `<i class="ph-fill ph-${el.classList.contains('active') ? 'moon' : 'sun'}"></i> ${el.classList.contains('active') ? '暗色' : '亮色'}模式`; }
  }
  else if ((el = get('#s-save'))) {
    const a = getActiveAst(), val = id => $(id)?.value; if (!a) return;
    a.name = val('s-name')?.trim() || a.name; a.systemPrompt = val('s-prompt') ?? a.systemPrompt; a.temperature = parseFloat(val('s-temp') || a.temperature); a.topP = parseFloat(val('s-topp') || a.topP);
    state.deepseekKey = val('s-dskey')?.trim() ?? state.deepseekKey; state.geminiKey = val('s-gmkey')?.trim() ?? state.geminiKey; state.geminiBaseUrl = val('s-gmurl')?.trim() ?? state.geminiBaseUrl; state.geminiModels = val('s-gmmodels')?.trim() || 'gemini-2.5-pro'; state.webdavUser = val('s-webdavUser')?.trim() ?? state.webdavUser; state.webdavToken = val('s-webdavToken')?.trim() ?? state.webdavToken; state.darkMode = $('s-theme')?.classList.contains('active') || false;
    saveState(); applyTheme(); renderChatPage(); renderAstList(); closeAll(); toast('设置已保存');
  }
  else if ((el = get('.prompt-toolbar'))) {
    if ((el = get('#fs-prompt-toggle-mode'))) { const raw = $('fs-prompt-raw-textarea'), vd = $('fs-prompt-vditor'); isFsPromptRawMode = !isFsPromptRawMode; if (isFsPromptRawMode) { raw.value = vditorInstance ? vditorInstance.getValue() : ''; vd.classList.add('hidden'); raw.classList.remove('hidden'); el.innerHTML = '<i class="ph ph-markdown-logo"></i>'; } else { if (vditorInstance) vditorInstance.setValue(raw.value); raw.classList.add('hidden'); vd.classList.remove('hidden'); el.innerHTML = '<i class="ph ph-file-text"></i>'; } syncUndoRedo(); return; }
    const btn = get('button[data-md]'); if (btn) { const act = btn.dataset.md; if (isFsPromptRawMode) { $('fs-prompt-raw-textarea').focus(); document.execCommand(act); } else if (vditorInstance) { const b = document.querySelector(`#fs-prompt-vditor button[data-type="${act}"]`); if (b) b.click(); else document.execCommand(act); } syncUndoRedo(); } 
  }
  else if ((el = get('#fs-prompt-save'))) { const sp = $('s-prompt'); if (sp) { sp.value = isFsPromptRawMode ? $('fs-prompt-raw-textarea').value : (vditorInstance ? vditorInstance.getValue() : sp.value); $('s-save')?.click(); } }
  else if ((el = get('#fs-prompt-close'))) { $('fs-prompt-overlay')?.classList.remove('show'); if (history.state?.page === 'fs-prompt') { ignoreNextPopState = true; history.back(); } }
  else if ((el = get('#edit-cancel-btn'))) { $('edit-overlay')?.classList.remove('show'); editingMsg = null; }
  else if ((el = get('#edit-save-btn'))) { if (!editingMsg) return; const val = $('edit-textarea')?.value.trim() || '', rval = $('edit-reasoning-textarea')?.value.trim() || ''; if (!val && !rval) return toast('不能为空'); editingMsg.content = val; editingMsg.reasoning = rval; if (rval && $('edit-toggle-reasoning-btn')?.innerHTML.includes('备注')) editingMsg.isNote = true; else delete editingMsg.isNote; saveState(); renderChatPage(); $('edit-overlay')?.classList.remove('show'); editingMsg = null; toast('已保存'); }
  else if ((el = get('#edit-toggle-reasoning-btn'))) { const rta = $('edit-reasoning-textarea'); if(rta) { const act = rta.classList.toggle('show'); el.classList.toggle('active', act); if(act) rta.focus(); } }
});

const inp = $('user-input');
if(inp) { on(inp, 'keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); } }); on(inp, 'input', function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 220) + 'px'; }); }

await IDB.init().catch(()=>{}); await loadState(); setupPWA(); applyTheme(); 
if (!state.activeAstId || !state.assistants.some(a => a.id === state.activeAstId)) state.activeAstId = state.assistants[0]?.id || 'default-ast';
if (window.innerWidth > 768) $('app')?.classList.add('left-open');
renderAstList(); saveState(); history.replaceState({ page: 'chat', id: state.activeAstId }, ''); renderChatPage();

window.addEventListener('popstate', async e => { if (ignoreNextPopState) return ignoreNextPopState = false; if ($('fs-prompt-overlay')?.classList.contains('show')) return $('fs-prompt-overlay').classList.remove('show'); if ($('sheet-overlay')?.classList.contains('show')) return closeAll(true); closeAll(true); if (e.state?.page === 'chat' && e.state.id) state.activeAstId = e.state.id; renderChatPage(); });

})();