// ═══════ CollabBuilder - 前端核心逻辑（Supabase Realtime 版） ═══════

// ─── 状态 ───
let supabase = null;
let channel = null;
let myUserId = null;
let myName = '';
let myColor = '';
let sessionId = null;
let project = null;
let currentPageId = null;
let selectedElementId = null;
let remoteCursors = {};   // userId -> { el, label }
let otherSelected = {};   // userId -> elementId
let undoStack = [];
let redoStack = [];
let cursorThrottle = null;
let presenceUsers = {};   // userId -> { id, name, color }

const COLORS = ['#6c5ce7','#00cec9','#fd79a8','#fdcb6e','#e17055','#00b894','#0984e3','#d63031','#a29bfe','#55efc4'];

// ─── DOM ───
const $ = id => document.getElementById(id);
const entryView = $('entryView');
const editorView = $('editorView');
const entryName = $('entryName');
const entryProject = $('entryProject');
const entryCode = $('entryCode');
const createBtn = $('createBtn');
const joinBtn = $('joinBtn');
const projectNameEl = $('projectName');
const saveStatusEl = $('saveStatus');
const pageTabsEl = $('pageTabs');
const addPageBtn = $('addPageBtn');
const onlineAvatarsEl = $('onlineAvatars');
const canvasEl = $('canvas');
const canvasContent = $('canvasContent');
const remoteCursorsEl = $('remoteCursors');
const propsPanel = $('propsPanel');
const chatPanel = $('chatPanel');
const chatMessages = $('chatMessages');
const chatInput = $('chatInput');
const chatSend = $('chatSend');
const chatToggle = $('chatToggle');
const chatClose = $('chatClose');
const previewBtn = $('previewBtn');
const previewModal = $('previewModal');
const previewClose = $('previewClose');
const previewIframe = $('previewIframe');
const exportBtn = $('exportBtn');
const backBtn = $('backBtn');
const undoBtn = $('undoBtn');
const redoBtn = $('redoBtn');

// ─── 工具函数 ───
function uid() { return Math.random().toString(36).slice(2, 10); }
function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
function genCode() { return uid().toUpperCase().slice(0, 6); }
function showView(view) { [entryView, editorView].forEach(v => v.classList.remove('active')); view.classList.add('active'); }

function currentPage() {
  return project?.pages.find(p => p.id === currentPageId) || null;
}

// ─── Supabase 配置管理 ───
function loadSupabaseConfig() {
  const url = localStorage.getItem('supabase_url') || '';
  const key = localStorage.getItem('supabase_key') || '';
  $('supabaseUrl').value = url;
  $('supabaseKey').value = key;
  if (url && key) {
    initSupabase(url, key);
  } else {
    // 默认展开配置区域
    $('supabaseConfig').classList.add('open');
  }
}

function saveSupabaseConfig() {
  const url = $('supabaseUrl').value.trim();
  const key = $('supabaseKey').value.trim();
  if (!url || !key) {
    alert('请填写 Supabase URL 和 Anon Key');
    return;
  }
  localStorage.setItem('supabase_url', url);
  localStorage.setItem('supabase_key', key);
  initSupabase(url, key);
}

function initSupabase(url, key) {
  try {
    supabase = window.supabase.createClient(url, key);
    $('supabaseStatus').textContent = '已连接';
    $('supabaseStatus').classList.add('connected');
    $('supabaseConfig').classList.remove('open');
  } catch (err) {
    console.error('Supabase 初始化失败:', err);
    $('supabaseStatus').textContent = '连接失败';
    $('supabaseStatus').classList.remove('connected');
  }
}

// Supabase 配置 UI 交互
$('supabaseConfigToggle').addEventListener('click', () => {
  $('supabaseConfig').classList.toggle('open');
});
$('supabaseSaveBtn').addEventListener('click', saveSupabaseConfig);

// ─── Supabase Realtime 连接 ───
function send(data) {
  if (!channel) return;
  channel.send({
    type: 'broadcast',
    event: data.type,
    payload: data,
  });
}

function createDefaultProject(name) {
  return {
    id: uid(),
    name: name || '未命名项目',
    pages: [{
      id: uid(),
      name: '首页',
      elements: [],
    }],
    createdAt: Date.now(),
  };
}

function joinSession(sessionIdVal, userName, projectName) {
  if (!supabase) {
    alert('请先配置 Supabase 连接');
    return;
  }

  myUserId = uid();
  myName = (userName || '匿名用户').slice(0, 20);

  // 离开旧频道
  if (channel) {
    channel.unsubscribe();
    channel = null;
  }

  sessionId = sessionIdVal;

  // 创建或使用已有项目
  if (!project) {
    project = createDefaultProject(projectName);
  }

  // 分配颜色
  const colorIndex = Object.keys(presenceUsers).length % COLORS.length;
  myColor = COLORS[colorIndex];

  // 创建频道名称（使用 sessionId 作为频道标识）
  const channelName = `collab-${sessionId}`;

  channel = supabase.channel(channelName, {
    config: {
      broadcast: { self: false },
      presence: { key: myUserId },
    },
  });

  // ── Presence 事件 ──
  channel.on('presence', { event: 'sync' }, () => {
    const state = channel.presenceState();
    const users = [];
    presenceUsers = {};
    for (const [key, presences] of Object.entries(state)) {
      const p = presences[0];
      presenceUsers[key] = p;
      users.push({ id: p.userId, name: p.name, color: p.color });
    }
    // 添加自己
    if (!users.find(u => u.id === myUserId)) {
      users.push({ id: myUserId, name: myName, color: myColor });
      presenceUsers[myUserId] = { userId: myUserId, name: myName, color: myColor };
    }
    renderAvatars(users);
  });

  channel.on('presence', { event: 'join' }, ({ newPresences }) => {
    newPresences.forEach(p => {
      if (p.userId !== myUserId) {
        addChatSystem(`${p.name} 加入了协作`);
      }
    });
  });

  channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
    leftPresences.forEach(p => {
      if (p.userId !== myUserId) {
        // 移除远程光标
        if (remoteCursors[p.userId]) {
          remoteCursors[p.userId].el.remove();
          delete remoteCursors[p.userId];
        }
        if (otherSelected[p.userId]) {
          const el = canvasContent.querySelector(`[data-id="${otherSelected[p.userId]}"]`);
          if (el) el.classList.remove('other-selected');
          delete otherSelected[p.userId];
        }
        addChatSystem(`${p.name} 离开了协作`);
      }
    });
  });

  // ── Broadcast 事件 ──
  channel.on('broadcast', { event: 'cursorMove' }, ({ payload }) => {
    onCursorUpdate(payload);
  });

  channel.on('broadcast', { event: 'addElement' }, ({ payload }) => {
    onElementAdded(payload);
  });

  channel.on('broadcast', { event: 'updateElement' }, ({ payload }) => {
    onElementUpdated(payload);
  });

  channel.on('broadcast', { event: 'deleteElement' }, ({ payload }) => {
    onElementDeleted(payload);
  });

  channel.on('broadcast', { event: 'moveElement' }, ({ payload }) => {
    onElementMoved(payload);
  });

  channel.on('broadcast', { event: 'addPage' }, ({ payload }) => {
    onPageAdded(payload);
  });

  channel.on('broadcast', { event: 'renamePage' }, ({ payload }) => {
    onPageRenamed(payload);
  });

  channel.on('broadcast', { event: 'deletePage' }, ({ payload }) => {
    onPageDeleted(payload);
  });

  channel.on('broadcast', { event: 'selectElement' }, ({ payload }) => {
    onElementSelected(payload);
  });

  channel.on('broadcast', { event: 'chat' }, ({ payload }) => {
    onChat(payload);
  });

  channel.on('broadcast', { event: 'joinSession' }, ({ payload }) => {
    // 当有人加入时，如果我是第一个用户，发送当前项目状态
    // 新加入的用户需要请求项目数据
    if (payload.userId !== myUserId && project) {
      // 发送当前项目状态给新用户
      send({
        type: 'syncState',
        project: project,
        targetUserId: payload.userId,
      });
    }
  });

  channel.on('broadcast', { event: 'syncState' }, ({ payload }) => {
    if (payload.targetUserId === myUserId) {
      // 接收项目状态
      project = payload.project;
      currentPageId = project.pages[0]?.id;
      renderCanvas();
      renderPageTabs();
    }
  });

  channel.on('broadcast', { event: 'leaveSession' }, ({ payload }) => {
    onUserLeft(payload);
  });

  // ── 订阅频道 ──
  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      // 加入 Presence
      await channel.track({
        userId: myUserId,
        name: myName,
        color: myColor,
      });

      // 广播加入会话
      send({ type: 'joinSession', userId: myUserId, userName: myName });

      // 进入编辑器
      onSessionJoined({
        sessionId,
        userId: myUserId,
        userName: myName,
        userColor: myColor,
        project,
        users: [{ id: myUserId, name: myName, color: myColor }],
      });

      // 显示协作码
      if (!entryCode.value) {
        entryCode.value = sessionId;
        const box = document.querySelector('.collab-code-box');
        if (box) box.remove();
        const div = document.createElement('div');
        div.className = 'collab-code-box';
        div.innerHTML = `<div class="code-label">协作码（分享给其他人加入）</div><div class="code-value">${sessionId}</div>`;
        entryView.querySelector('.entry-form').appendChild(div);
      }
    }
  });
}

// ─── 消息处理（远程事件） ───

// ─── 会话管理 ───
function onSessionJoined(data) {
  sessionId = data.sessionId;
  myUserId = data.userId;
  myName = data.userName;
  myColor = data.userColor;
  project = data.project;
  currentPageId = project.pages[0]?.id;
  undoStack = [];
  redoStack = [];

  showView(editorView);
  projectNameEl.textContent = project.name;
  renderPageTabs();
  renderCanvas();
  renderAvatars(data.users);
}

function onUserJoined(data) {
  // Presence 会处理
}

function onUserLeft(data) {
  // 移除远程光标
  if (remoteCursors[data.userId]) {
    remoteCursors[data.userId].el.remove();
    delete remoteCursors[data.userId];
  }
  if (otherSelected[data.userId]) {
    const el = canvasContent.querySelector(`[data-id="${otherSelected[data.userId]}"]`);
    if (el) el.classList.remove('other-selected');
    delete otherSelected[data.userId];
  }
}

// ─── 远程光标 ───
function onCursorUpdate(data) {
  if (data.userId === myUserId) return;
  let cursor = remoteCursors[data.userId];
  if (!cursor) {
    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.innerHTML = `
      <svg class="remote-cursor-arrow" viewBox="0 0 16 16" fill="${data.color || '#6c5ce7'}"><path d="M0 0L16 6L8 8L6 16Z"/></svg>
      <span class="remote-cursor-label" style="background:${data.color || '#6c5ce7'}"></span>
    `;
    remoteCursorsEl.appendChild(el);
    cursor = { el, label: el.querySelector('.remote-cursor-label') };
    remoteCursors[data.userId] = cursor;
  }
  cursor.el.style.left = data.x + 'px';
  cursor.el.style.top = data.y + 'px';
  // 找到用户名
  const user = presenceUsers[data.userId];
  cursor.label.textContent = user?.name || '???';
}

// ─── 元素操作（远程） ───
function onElementAdded(data) {
  const page = project.pages.find(p => p.id === data.pageId);
  if (page) page.elements.push(data.element);
  if (data.pageId === currentPageId) renderCanvas();
}

function onElementUpdated(data) {
  const page = project.pages.find(p => p.id === data.pageId);
  if (!page) return;
  const el = page.elements.find(e => e.id === data.elementId);
  if (el) Object.assign(el, data.updates);
  if (data.pageId === currentPageId) {
    updateElementDOM(data.elementId, data.updates);
    if (selectedElementId === data.elementId) renderProps();
  }
}

function onElementDeleted(data) {
  const page = project.pages.find(p => p.id === data.pageId);
  if (page) page.elements = page.elements.filter(e => e.id !== data.elementId);
  if (data.pageId === currentPageId) {
    const dom = canvasContent.querySelector(`[data-id="${data.elementId}"]`);
    if (dom) dom.remove();
    if (selectedElementId === data.elementId) { selectedElementId = null; renderProps(); }
    if (page.elements.length === 0) renderCanvas();
  }
}

function onElementMoved(data) {
  const page = project.pages.find(p => p.id === data.pageId);
  if (!page) return;
  const idx = page.elements.findIndex(e => e.id === data.elementId);
  if (idx === -1) return;
  const [el] = page.elements.splice(idx, 1);
  page.elements.splice(data.newIndex, 0, el);
  if (data.pageId === currentPageId) renderCanvas();
}

function onElementSelected(data) {
  if (data.userId === myUserId) return;
  // 移除旧选中
  if (otherSelected[data.userId]) {
    const old = canvasContent.querySelector(`[data-id="${otherSelected[data.userId]}"]`);
    if (old) old.classList.remove('other-selected');
  }
  otherSelected[data.userId] = data.elementId;
  if (data.elementId) {
    const el = canvasContent.querySelector(`[data-id="${data.elementId}"]`);
    if (el) el.classList.add('other-selected');
  }
}

// ─── 页面操作 ───
function onPageAdded(data) {
  project.pages.push(data.page);
  renderPageTabs();
}
function onPageRenamed(data) {
  const page = project.pages.find(p => p.id === data.pageId);
  if (page) page.name = data.name;
  renderPageTabs();
}
function onPageDeleted(data) {
  project.pages = project.pages.filter(p => p.id !== data.pageId);
  if (currentPageId === data.pageId) {
    currentPageId = project.pages[0]?.id;
    renderCanvas();
  }
  renderPageTabs();
}

// ─── 聊天 ───
function onChat(data) {
  const div = document.createElement('div');
  div.className = 'chat-msg-item';
  const time = new Date(data.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="chat-msg-name" style="color:${data.user.color}">${esc(data.user.name)}</div>
    <div class="chat-msg-text">${esc(data.text)}</div>
    <div class="chat-msg-time">${time}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function addChatSystem(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg-item';
  div.innerHTML = `<div class="chat-msg-text" style="color:var(--text-muted);font-size:12px">${esc(text)}</div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ─── 渲染：头像 ───
function renderAvatars(users) {
  project._users = users;
  onlineAvatarsEl.innerHTML = users.map(u => `
    <div class="avatar-chip" style="background:${u.color}">
      ${u.name.charAt(0).toUpperCase()}
      <span class="avatar-tooltip">${esc(u.name)}${u.id === myUserId ? ' (你)' : ''}</span>
    </div>
  `).join('');
}

// ─── 渲染：页面标签 ───
function renderPageTabs() {
  pageTabsEl.innerHTML = project.pages.map(p => `
    <button class="page-tab ${p.id === currentPageId ? 'active' : ''}" data-page-id="${p.id}">
      ${esc(p.name)}
      ${project.pages.length > 1 ? `<span class="tab-close" data-page-id="${p.id}">&times;</span>` : ''}
    </button>
  `).join('');

  pageTabsEl.querySelectorAll('.page-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      if (e.target.classList.contains('tab-close')) return;
      currentPageId = tab.dataset.pageId;
      selectedElementId = null;
      renderCanvas();
      renderPageTabs();
      renderProps();
    });
  });
  pageTabsEl.querySelectorAll('.tab-close').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid = btn.dataset.pageId;
      if (project.pages.length > 1) {
        // 本地执行删除
        const page = project.pages.find(p => p.id === pid);
        if (page) {
          project.pages = project.pages.filter(p => p.id !== pid);
          if (currentPageId === pid) {
            currentPageId = project.pages[0]?.id;
            renderCanvas();
          }
          renderPageTabs();
        }
        send({ type: 'deletePage', pageId: pid });
      }
    });
  });
}

// ─── 渲染：画布 ───
function renderCanvas() {
  const page = currentPage();
  if (!page || page.elements.length === 0) {
    canvasContent.innerHTML = `
      <div class="canvas-empty">
        <div class="canvas-empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>
        </div>
        <div class="canvas-empty-text">从左侧拖拽组件到这里开始搭建</div>
        <div class="canvas-empty-hint">支持拖拽排序、实时协作编辑</div>
      </div>`;
    return;
  }
  canvasContent.innerHTML = page.elements.map(el => createElementDOM(el)).join('');
  // 绑定事件
  canvasContent.querySelectorAll('.canvas-element').forEach(dom => {
    dom.addEventListener('click', e => {
      e.stopPropagation();
      selectElement(dom.dataset.id);
    });
    // 双击编辑文本
    dom.addEventListener('dblclick', e => {
      e.stopPropagation();
      const id = dom.dataset.id;
      const el = currentPage()?.elements.find(e => e.id === id);
      if (!el) return;
      const textEl = dom.querySelector('[data-editable]');
      if (textEl) {
        textEl.contentEditable = true;
        textEl.focus();
        // 选中全部文字
        const range = document.createRange();
        range.selectNodeContents(textEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        const finish = () => {
          textEl.contentEditable = false;
          const newText = textEl.textContent;
          if (newText !== el.props?.text) {
            pushUndo();
            el.props = el.props || {};
            el.props.text = newText;
            send({ type: 'updateElement', pageId: currentPageId, elementId: id, updates: { props: el.props } });
          }
          textEl.removeEventListener('blur', finish);
        };
        textEl.addEventListener('blur', finish);
      }
    });
  });
}

function createElementDOM(el) {
  const actions = `
    <div class="element-actions">
      <button class="element-action-btn" data-action="up" title="上移">&#9650;</button>
      <button class="element-action-btn" data-action="down" title="下移">&#9660;</button>
      <button class="element-action-btn" data-action="dup" title="复制">&#10697;</button>
      <button class="element-action-btn danger" data-action="del" title="删除">&#10005;</button>
    </div>`;

  const cls = `canvas-element el-${el.type}` + (el.id === selectedElementId ? ' selected' : '') +
    (otherSelected[Object.keys(otherSelected).find(uid => otherSelected[uid] === el.id)] ? ' other-selected' : '');

  let inner = '';
  switch (el.type) {
    case 'heading': {
      const tag = el.props?.level || 'h2';
      const text = el.props?.text || '点击编辑标题';
      inner = `<${tag} data-editable="true">${esc(text)}</${tag}>`;
      break;
    }
    case 'text':
      inner = `<p data-editable="true">${esc(el.props?.text || '点击编辑文本内容')}</p>`;
      break;
    case 'image':
      if (el.props?.src) {
        inner = `<img src="${esc(el.props.src)}" alt="${esc(el.props?.alt || '')}">`;
      } else {
        inner = `<div class="el-image-placeholder">点击右侧属性面板设置图片URL</div>`;
      }
      break;
    case 'button':
      inner = `<button data-editable="true">${esc(el.props?.text || '点击按钮')}</button>`;
      break;
    case 'divider':
      inner = '<hr>';
      break;
    case 'spacer':
      inner = `<div style="height:${el.props?.height || 40}px"></div>`;
      break;
    case 'container':
      inner = '<div class="el-container-inner"><span style="color:#bbb;font-size:13px">容器 - 拖入组件</span></div>';
      break;
    case 'columns2':
      inner = `<div class="el-columns-row"><div><span style="color:#bbb;font-size:13px">左栏</span></div><div><span style="color:#bbb;font-size:13px">右栏</span></div></div>`;
      break;
    case 'columns3':
      inner = `<div class="el-columns-row"><div><span style="color:#bbb;font-size:13px">栏1</span></div><div><span style="color:#bbb;font-size:13px">栏2</span></div><div><span style="color:#bbb;font-size:13px">栏3</span></div></div>`;
      break;
    case 'hero':
      inner = `<h1 data-editable="true">${esc(el.props?.title || '欢迎来到我的网站')}</h1><p data-editable="true">${esc(el.props?.subtitle || '在这里添加描述文字')}</p>`;
      break;
    case 'card':
      inner = `<div class="el-card-inner"><div class="el-card-img"></div><div class="el-card-body"><h3 data-editable="true">${esc(el.props?.title || '卡片标题')}</h3><p data-editable="true">${esc(el.props?.text || '卡片描述内容')}</p></div></div>`;
      break;
    case 'navbar':
      inner = `<div class="el-navbar-inner"><div class="el-navbar-brand" data-editable="true">${esc(el.props?.brand || 'Brand')}</div><div class="el-navbar-links"><a href="#" data-editable="true">${esc(el.props?.link1 || '首页')}</a><a href="#" data-editable="true">${esc(el.props?.link2 || '关于')}</a><a href="#" data-editable="true">${esc(el.props?.link3 || '联系')}</a></div></div>`;
      break;
    case 'footer':
      inner = `<div class="el-footer-inner" data-editable="true">${esc(el.props?.text || '© 2026 版权所有')}</div>`;
      break;
    case 'form':
      inner = `<div class="el-form-group"><label>姓名</label><input type="text" placeholder="请输入"></div><div class="el-form-group"><label>邮箱</label><input type="email" placeholder="请输入"></div><div class="el-form-group"><label>留言</label><textarea placeholder="请输入"></textarea></div>`;
      break;
    case 'list':
      inner = `<ul>${(el.props?.items || ['列表项 1', '列表项 2', '列表项 3']).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
      break;
    default:
      inner = `<div style="padding:20px;color:#999">未知组件: ${el.type}</div>`;
  }

  return `<div class="${cls}" data-id="${el.id}" style="${el.style || ''}">${actions}${inner}</div>`;
}

function updateElementDOM(elementId, updates) {
  const dom = canvasContent.querySelector(`[data-id="${elementId}"]`);
  if (!dom) return;
  if (updates.style) dom.setAttribute('style', updates.style);
  if (updates.props) {
    // 简单重渲染该元素
    const el = currentPage()?.elements.find(e => e.id === elementId);
    if (el) {
      const temp = document.createElement('div');
      temp.innerHTML = createElementDOM(el);
      const newDom = temp.firstElementChild;
      dom.replaceWith(newDom);
      // 重新绑定事件
      newDom.addEventListener('click', e => { e.stopPropagation(); selectElement(elementId); });
    }
  }
}

// ─── 选中元素 ───
function selectElement(id) {
  selectedElementId = id;
  canvasContent.querySelectorAll('.canvas-element').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  renderProps();
  send({ type: 'selectElement', elementId: id, userId: myUserId });
  // 绑定操作按钮
  canvasContent.querySelectorAll('.element-action-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      handleElementAction(btn.dataset.action, id);
    };
  });
}

function deselectAll() {
  selectedElementId = null;
  canvasContent.querySelectorAll('.canvas-element.selected').forEach(el => el.classList.remove('selected'));
  renderProps();
}

canvasContent.addEventListener('click', e => {
  if (e.target === canvasContent || e.target.closest('.canvas-empty')) deselectAll();
});

// ─── 元素操作 ───
function handleElementAction(action, id) {
  const page = currentPage();
  if (!page) return;
  const idx = page.elements.findIndex(e => e.id === id);
  if (idx === -1) return;

  pushUndo();

  switch (action) {
    case 'del':
      page.elements.splice(idx, 1);
      send({ type: 'deleteElement', pageId: currentPageId, elementId: id });
      if (selectedElementId === id) deselectAll();
      renderCanvas();
      break;
    case 'up':
      if (idx > 0) {
        [page.elements[idx], page.elements[idx - 1]] = [page.elements[idx - 1], page.elements[idx]];
        send({ type: 'moveElement', pageId: currentPageId, elementId: id, newIndex: idx - 1 });
        renderCanvas();
      }
      break;
    case 'down':
      if (idx < page.elements.length - 1) {
        [page.elements[idx], page.elements[idx + 1]] = [page.elements[idx + 1], page.elements[idx]];
        send({ type: 'moveElement', pageId: currentPageId, elementId: id, newIndex: idx + 1 });
        renderCanvas();
      }
      break;
    case 'dup': {
      const clone = JSON.parse(JSON.stringify(page.elements[idx]));
      clone.id = uid();
      page.elements.splice(idx + 1, 0, clone);
      send({ type: 'addElement', pageId: currentPageId, element: clone });
      renderCanvas();
      break;
    }
  }
}

// ─── 撤销/重做 ───
function pushUndo() {
  undoStack.push(JSON.parse(JSON.stringify(currentPage()?.elements || [])));
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
  updateUndoRedoBtns();
}

undoBtn.addEventListener('click', () => {
  if (undoStack.length === 0) return;
  const page = currentPage();
  if (!page) return;
  redoStack.push(JSON.parse(JSON.stringify(page.elements)));
  page.elements = undoStack.pop();
  renderCanvas();
  updateUndoRedoBtns();
  send({ type: 'syncState', project, targetUserId: '__all__' });
});

redoBtn.addEventListener('click', () => {
  if (redoStack.length === 0) return;
  const page = currentPage();
  if (!page) return;
  undoStack.push(JSON.parse(JSON.stringify(page.elements)));
  page.elements = redoStack.pop();
  renderCanvas();
  updateUndoRedoBtns();
  send({ type: 'syncState', project, targetUserId: '__all__' });
});

function updateUndoRedoBtns() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

// ─── 属性面板 ───
function renderProps() {
  if (!selectedElementId) {
    propsPanel.innerHTML = '<div class="props-empty">选中画布上的元素以编辑属性</div>';
    return;
  }
  const el = currentPage()?.elements.find(e => e.id === selectedElementId);
  if (!el) { propsPanel.innerHTML = ''; return; }

  let html = `<div class="props-section"><div class="props-section-title">组件信息</div>`;
  html += `<div class="props-row"><span class="props-label">类型</span><input class="props-input" value="${el.type}" disabled></div>`;

  // 根据类型渲染不同属性
  const p = el.props || {};
  switch (el.type) {
    case 'heading':
      html += propText('标题', 'text', p.text || '');
      html += propSelect('级别', 'level', p.level || 'h2', ['h1', 'h2', 'h3']);
      break;
    case 'text':
      html += `<div class="props-row"><span class="props-label">内容</span></div><textarea class="props-textarea" data-prop="text">${esc(p.text || '')}</textarea>`;
      break;
    case 'image':
      html += propInput('图片URL', 'src', p.src || '');
      html += propInput('替代文本', 'alt', p.alt || '');
      break;
    case 'button':
      html += propText('按钮文字', 'text', p.text || '');
      html += propInput('链接URL', 'link', p.link || '');
      break;
    case 'spacer':
      html += propInput('高度(px)', 'height', p.height || 40);
      break;
    case 'hero':
      html += propText('主标题', 'title', p.title || '');
      html += `<div class="props-row"><span class="props-label">副标题</span></div><textarea class="props-textarea" data-prop="subtitle">${esc(p.subtitle || '')}</textarea>`;
      break;
    case 'card':
      html += propText('标题', 'title', p.title || '');
      html += `<div class="props-row"><span class="props-label">描述</span></div><textarea class="props-textarea" data-prop="text">${esc(p.text || '')}</textarea>`;
      break;
    case 'navbar':
      html += propText('品牌名', 'brand', p.brand || '');
      html += propText('链接1', 'link1', p.link1 || '');
      html += propText('链接2', 'link2', p.link2 || '');
      html += propText('链接3', 'link3', p.link3 || '');
      break;
    case 'footer':
      html += propText('内容', 'text', p.text || '');
      break;
    case 'list':
      html += `<div class="props-row"><span class="props-label">列表项</span></div><textarea class="props-textarea" data-prop="items" placeholder="每行一个列表项">${esc((p.items || []).join('\n'))}</textarea>`;
      break;
  }

  // 通用样式
  html += `</div><div class="props-section"><div class="props-section-title">样式</div>`;
  html += propInput('内边距', 'padding', el.style?.padding || '');
  html += propInput('外边距', 'margin', el.style?.margin || '');
  html += propInput('背景色', 'bgColor', el.style?.backgroundColor || '');
  html += propInput('圆角', 'borderRadius', el.style?.borderRadius || '');
  html += `</div>`;

  propsPanel.innerHTML = html;

  // 绑定属性变更
  propsPanel.querySelectorAll('[data-prop]').forEach(input => {
    const handler = () => {
      pushUndo();
      const prop = input.dataset.prop;
      let val = input.value;
      if (prop === 'items') {
        val = val.split('\n').filter(Boolean);
      } else if (prop === 'height') {
        val = parseInt(val) || 40;
      }
      el.props = el.props || {};
      el.props[prop] = val;
      send({ type: 'updateElement', pageId: currentPageId, elementId: el.id, updates: { props: el.props } });
      renderCanvas();
      selectElement(el.id);
    };
    input.addEventListener('change', handler);
    input.addEventListener('blur', handler);
  });

  // 绑定样式变更
  propsPanel.querySelectorAll('[data-style]').forEach(input => {
    const handler = () => {
      pushUndo();
      const styleProp = input.dataset.style;
      el.style = el.style || '';
      // 简单处理
      if (styleProp === 'padding') el.style = el.style.replace(/padding:[^;]+;?/g, '') + `padding:${input.value};`;
      else if (styleProp === 'margin') el.style = el.style.replace(/margin:[^;]+;?/g, '') + `margin:${input.value};`;
      else if (styleProp === 'bgColor') el.style = el.style.replace(/background-color:[^;]+;?/g, '') + `background-color:${input.value};`;
      else if (styleProp === 'borderRadius') el.style = el.style.replace(/border-radius:[^;]+;?/g, '') + `border-radius:${input.value};`;
      send({ type: 'updateElement', pageId: currentPageId, elementId: el.id, updates: { style: el.style } });
      renderCanvas();
      selectElement(el.id);
    };
    input.addEventListener('change', handler);
  });
}

function propInput(label, prop, value) {
  const isStyle = ['padding', 'margin', 'bgColor', 'borderRadius'].includes(prop);
  return `<div class="props-row"><span class="props-label">${label}</span><input class="props-input" data-${isStyle ? 'style' : 'prop'}="${prop}" value="${esc(String(value))}"></div>`;
}
function propText(label, prop, value) {
  return `<div class="props-row"><span class="props-label">${label}</span><input class="props-input" data-prop="${prop}" value="${esc(String(value))}"></div>`;
}
function propSelect(label, prop, value, options) {
  return `<div class="props-row"><span class="props-label">${label}</span><select class="props-select" data-prop="${prop}">${options.map(o => `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
}

// ─── 组件拖拽 ───
document.querySelectorAll('.comp-item[draggable]').forEach(item => {
  item.addEventListener('dragstart', e => {
    e.dataTransfer.setData('component-type', item.dataset.type);
    e.dataTransfer.effectAllowed = 'copy';
  });
});

canvasContent.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  canvasContent.classList.add('drag-over');
});
canvasContent.addEventListener('dragleave', () => canvasContent.classList.remove('drag-over'));
canvasContent.addEventListener('drop', e => {
  e.preventDefault();
  canvasContent.classList.remove('drag-over');
  const type = e.dataTransfer.getData('component-type');
  if (!type) return;
  addElement(type);
});

function addElement(type) {
  const defaults = {
    heading: { props: { text: '新标题', level: 'h2' } },
    text: { props: { text: '在这里输入文本内容...' } },
    image: { props: { src: '', alt: '' } },
    button: { props: { text: '点击按钮', link: '#' } },
    divider: { props: {} },
    spacer: { props: { height: 40 } },
    container: { props: {} },
    columns2: { props: {} },
    columns3: { props: {} },
    hero: { props: { title: '欢迎来到我的网站', subtitle: '在这里添加你的描述文字' } },
    card: { props: { title: '卡片标题', text: '这里是卡片描述内容' } },
    navbar: { props: { brand: 'Brand', link1: '首页', link2: '关于', link3: '联系' } },
    footer: { props: { text: '© 2026 版权所有' } },
    form: { props: {} },
    list: { props: { items: ['列表项 1', '列表项 2', '列表项 3'] } },
  };

  const el = {
    id: uid(),
    type,
    props: { ...(defaults[type]?.props || {}) },
    style: '',
  };

  pushUndo();
  const page = currentPage();
  if (page) page.elements.push(el);
  send({ type: 'addElement', pageId: currentPageId, element: el });
  renderCanvas();
}

// ─── 画布光标追踪 ───
canvasEl.addEventListener('mousemove', e => {
  if (!sessionId) return;
  const rect = canvasEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (cursorThrottle) return;
  cursorThrottle = setTimeout(() => { cursorThrottle = null; }, 50);
  send({ type: 'cursorMove', userId: myUserId, x, y, color: myColor });
});

// ─── 设备切换 ───
document.querySelectorAll('.device-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.device-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    canvasEl.classList.remove('tablet', 'mobile');
    if (btn.dataset.device === 'tablet') canvasEl.classList.add('tablet');
    if (btn.dataset.device === 'mobile') canvasEl.classList.add('mobile');
  });
});

// ─── 页面管理 ───
addPageBtn.addEventListener('click', () => {
  const name = prompt('新页面名称:', `页面${project.pages.length + 1}`);
  if (!name) return;
  const newPage = { id: uid(), name, elements: [] };
  project.pages.push(newPage);
  send({ type: 'addPage', page: newPage });
  renderPageTabs();
});

// ─── 预览 ───
previewBtn.addEventListener('click', () => {
  previewModal.classList.remove('hidden');
  const html = generateHTML();
  previewIframe.srcdoc = html;
});
previewClose.addEventListener('click', () => previewModal.classList.add('hidden'));
previewModal.querySelector('.modal-overlay').addEventListener('click', () => previewModal.classList.add('hidden'));

// ─── 导出 ───
exportBtn.addEventListener('click', () => {
  const html = generateHTML();
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${project.name || 'site'}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function generateHTML() {
  let body = '';
  for (const page of project.pages) {
    for (const el of page.elements) {
      body += renderElementHTML(el);
    }
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(project.name)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;color:#1a1a2e;line-height:1.6}
${generateCSS()}
</style>
</head>
<body>${body}</body>
</html>`;
}

function renderElementHTML(el) {
  const s = el.style || '';
  const p = el.props || {};
  switch (el.type) {
    case 'heading': { const t = p.level || 'h2'; return `<${t} style="${s}">${esc(p.text || '')}</${t}>`; }
    case 'text': return `<p style="${s}">${esc(p.text || '')}</p>`;
    case 'image': return p.src ? `<div style="${s}"><img src="${esc(p.src)}" alt="${esc(p.alt || '')}" style="max-width:100%;border-radius:8px"></div>` : '';
    case 'button': return `<div style="${s};text-align:center;padding:16px 0"><a href="${esc(p.link || '#')}" style="display:inline-block;padding:12px 32px;background:#6c5ce7;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${esc(p.text || '')}</a></div>`;
    case 'divider': return `<hr style="${s};border:none;border-top:1px solid #e0e0e0">`;
    case 'spacer': return `<div style="height:${p.height || 40}px"></div>`;
    case 'hero': return `<div style="padding:60px 40px;text-align:center;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;${s}"><h1 style="font-size:40px;font-weight:800;margin-bottom:12px">${esc(p.title || '')}</h1><p style="font-size:18px;opacity:.9;max-width:600px;margin:0 auto">${esc(p.subtitle || '')}</p></div>`;
    case 'card': return `<div style="padding:16px 20px;${s}"><div style="background:#f8f9fa;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)"><div style="width:100%;height:160px;background:#e8e8f0"></div><div style="padding:16px"><h3 style="font-size:18px;font-weight:700;margin-bottom:8px">${esc(p.title || '')}</h3><p style="font-size:14px;color:#666">${esc(p.text || '')}</p></div></div></div>`;
    case 'navbar': return `<div style="background:#1a1a2e;color:#fff;${s}"><div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;max-width:960px;margin:0 auto"><span style="font-size:18px;font-weight:800">${esc(p.brand || '')}</span><div style="display:flex;gap:24px"><a href="#" style="color:#ccc;text-decoration:none">${esc(p.link1 || '')}</a><a href="#" style="color:#ccc;text-decoration:none">${esc(p.link2 || '')}</a><a href="#" style="color:#ccc;text-decoration:none">${esc(p.link3 || '')}</a></div></div></div>`;
    case 'footer': return `<div style="background:#1a1a2e;color:#999;text-align:center;padding:24px;${s}">${esc(p.text || '')}</div>`;
    case 'form': return `<div style="padding:16px 20px;max-width:500px;${s}"><div style="margin-bottom:12px"><label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">姓名</label><input style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px"></div><div style="margin-bottom:12px"><label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">邮箱</label><input style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px"></div><div style="margin-bottom:12px"><label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">留言</label><textarea style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;min-height:80px"></textarea></div></div>`;
    case 'list': return `<div style="padding:16px 20px;${s}"><ul style="list-style:none">${(p.items || []).map(i => `<li style="padding:10px 0;border-bottom:1px solid #eee;display:flex;align-items:center;gap:8px"><span style="width:6px;height:6px;border-radius:50%;background:#6c5ce7;flex-shrink:0"></span>${esc(i)}</li>`).join('')}</ul></div>`;
    default: return '';
  }
}

function generateCSS() {
  return `img{max-width:100%} a{transition:opacity .2s} a:hover{opacity:.8}`;
}

// ─── 聊天 ───
chatToggle.addEventListener('click', () => chatPanel.classList.toggle('hidden'));
chatClose.addEventListener('click', () => chatPanel.classList.add('hidden'));
chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  send({
    type: 'chat',
    user: { id: myUserId, name: myName, color: myColor },
    text: String(text).slice(0, 500),
    time: Date.now(),
  });
  chatInput.value = '';
}

// ─── 返回 ───
backBtn.addEventListener('click', () => {
  if (confirm('确定离开项目？未保存的更改将丢失。')) {
    // 离开频道
    if (channel) {
      send({ type: 'leaveSession', userId: myUserId });
      channel.untrack();
      channel.unsubscribe();
      channel = null;
    }
    sessionId = null;
    project = null;
    presenceUsers = {};
    remoteCursors = {};
    otherSelected = {};
    showView(entryView);
  }
});

// ─── 入口按钮 ───
createBtn.addEventListener('click', () => {
  if (!supabase) {
    alert('请先配置 Supabase 连接');
    $('supabaseConfig').classList.add('open');
    return;
  }
  const name = entryName.value.trim() || '匿名用户';
  const proj = entryProject.value.trim() || '未命名项目';
  const code = genCode();
  entryCode.value = code;
  myName = name;
  // 创建新项目
  project = createDefaultProject(proj);
  joinSession(code, name, proj);
});

joinBtn.addEventListener('click', () => {
  if (!supabase) {
    alert('请先配置 Supabase 连接');
    $('supabaseConfig').classList.add('open');
    return;
  }
  const code = entryCode.value.trim();
  const name = entryName.value.trim() || '匿名用户';
  if (!code) return;
  myName = name;
  // 加入已有项目（project 设为 null，等待 syncState）
  project = null;
  joinSession(code, name, null);
});

// ─── 键盘快捷键 ───
document.addEventListener('keydown', e => {
  if (!editorView.classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.contentEditable === 'true') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedElementId) handleElementAction('del', selectedElementId);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoBtn.click(); else undoBtn.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
    e.preventDefault();
    if (selectedElementId) handleElementAction('dup', selectedElementId);
  }
});

// ─── 启动 ───
loadSupabaseConfig();
