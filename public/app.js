// ═══════ CollabBuilder - 前端核心逻辑（PeerJS P2P 版） ═══════

// ─── 状态 ───
let peer = null;              // PeerJS 实例
let connections = [];          // 所有 DataConnection（房主持有多条）
let hostConn = null;          // 加入者到房主的连接
let isHost = false;           // 是否是房主
let myUserId = null;
let myName = '';
let myColor = '';
let roomCode = null;          // 6位协作码
let project = null;
let currentPageId = null;
let selectedElementId = null;
let remoteCursors = {};        // userId -> { el, label }
let otherSelected = {};        // userId -> elementId
let undoStack = [];
let redoStack = [];
let cursorThrottle = null;
let presenceUsers = {};       // userId -> { id, name, color }
let colorIndexCounter = 0;

const COLORS = ['#6c5ce7','#00cec9','#fd79a8','#fdcb6e','#e17055','#00b894','#0984e3','#d63031','#a29bfe','#55efc4'];
const MAX_PEERS = 6;          // 最多 6 人协作

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

// ─── PeerJS 连接管理 ───

/**
 * 发送消息
 * - 房主：广播给所有连接的 peer（排除发送者）
 * - 加入者：发送给房主（由房主广播）
 */
function send(data) {
  if (isHost) {
    // 房主广播给所有连接的 peer
    const msg = JSON.stringify(data);
    connections.forEach(conn => {
      if (conn.open) {
        try { conn.send(msg); } catch (e) { console.warn('发送失败:', e); }
      }
    });
  } else if (hostConn && hostConn.open) {
    // 加入者发送给房主
    try { hostConn.send(JSON.stringify(data)); } catch (e) { console.warn('发送失败:', e); }
  }
}

/**
 * 创建房间（房主模式）
 */
function createRoom(userName, projectName) {
  myUserId = uid();
  myName = (userName || '匿名用户').slice(0, 20);
  roomCode = genCode();
  isHost = true;
  colorIndexCounter = 0;
  myColor = COLORS[colorIndexCounter++];

  // 创建项目
  project = createDefaultProject(projectName || '未命名项目');

  // 创建 PeerJS Peer，ID 使用协作码作为前缀
  const peerId = 'collab-' + roomCode;
  peer = new Peer(peerId);

  peer.on('open', (id) => {
    console.log('[PeerJS] 房主已上线, peerId:', id);

    // 显示协作码
    entryCode.value = roomCode;
    const box = document.querySelector('.collab-code-box');
    if (box) box.remove();
    const div = document.createElement('div');
    div.className = 'collab-code-box';
    div.innerHTML = `<div class="code-label">协作码（分享给其他人加入）</div><div class="code-value">${roomCode}</div>`;
    entryView.querySelector('.entry-form').appendChild(div);

    // 初始化 presence（自己）
    presenceUsers = {};
    presenceUsers[myUserId] = { id: myUserId, name: myName, color: myColor };

    // 进入编辑器
    onSessionJoined({
      sessionId: roomCode,
      userId: myUserId,
      userName: myName,
      userColor: myColor,
      project,
      users: [{ id: myUserId, name: myName, color: myColor }],
    });
  });

  peer.on('connection', (conn) => {
    handleIncomingConnection(conn);
  });

  peer.on('error', (err) => {
    console.error('[PeerJS] 房主错误:', err);
    if (err.type === 'unavailable-id') {
      // 协作码冲突，重新生成
      alert('协作码冲突，请重试');
      cleanupPeer();
    } else {
      alert('连接错误: ' + err.message);
    }
  });

  peer.on('disconnected', () => {
    console.log('[PeerJS] 房主断开连接');
    // 尝试重连
    if (peer && !peer.destroyed) {
      peer.reconnect();
    }
  });
}

/**
 * 加入房间（加入者模式）
 */
function joinRoom(code, userName) {
  myUserId = uid();
  myName = (userName || '匿名用户').slice(0, 20);
  roomCode = code;
  isHost = false;

  // 创建随机 PeerJS Peer
  peer = new Peer();

  peer.on('open', (id) => {
    console.log('[PeerJS] 加入者已上线, peerId:', id);

    // 连接到房主
    const hostPeerId = 'collab-' + roomCode;
    hostConn = peer.connect(hostPeerId, { reliable: true });

    hostConn.on('open', () => {
      console.log('[PeerJS] 已连接到房主');

      // 发送加入请求（包含用户信息）
      hostConn.send(JSON.stringify({
        type: 'joinRequest',
        userId: myUserId,
        userName: myName,
      }));
    });

    hostConn.on('data', (rawData) => {
      handleIncomingData(rawData);
    });

    hostConn.on('close', () => {
      console.log('[PeerJS] 与房主的连接已关闭');
      addChatSystem('与房主的连接已断开');
    });

    hostConn.on('error', (err) => {
      console.error('[PeerJS] 连接房主错误:', err);
      alert('无法连接到房主，请检查协作码是否正确');
    });
  });

  peer.on('error', (err) => {
    console.error('[PeerJS] 加入者错误:', err);
    if (err.type === 'peer-unavailable') {
      alert('找不到该协作码对应的房间，请检查协作码是否正确');
    } else {
      alert('连接错误: ' + err.message);
    }
  });
}

/**
 * 房主处理新的 peer 连接
 */
function handleIncomingConnection(conn) {
  console.log('[PeerJS] 新的 peer 连接请求');

  // 检查人数限制
  if (connections.length >= MAX_PEERS - 1) {
    conn.on('open', () => {
      conn.send(JSON.stringify({ type: 'roomFull' }));
      conn.close();
    });
    return;
  }

  conn.on('open', () => {
    console.log('[PeerJS] peer 连接已建立');
    connections.push(conn);

    // 暂存连接，等待 joinRequest 消息来获取用户信息
    conn._pendingUser = true;
  });

  conn.on('data', (rawData) => {
    handleIncomingData(rawData, conn);
  });

  conn.on('close', () => {
    console.log('[PeerJS] peer 连接已关闭');
    const idx = connections.indexOf(conn);
    if (idx !== -1) {
      connections.splice(idx, 1);
      // 如果该连接有用户信息，通知其他人
      if (conn._userId) {
        onUserLeft({ userId: conn._userId });
        addChatSystem(`${conn._userName || '某人'} 离开了协作`);
        // 更新头像列表
        updatePresenceUsers();
        broadcastUserList();
      }
    }
  });

  conn.on('error', (err) => {
    console.error('[PeerJS] 连接错误:', err);
  });
}

/**
 * 处理收到的数据消息
 * @param {string} rawData - 原始数据（JSON 字符串或已解析的对象）
 * @param {DataConnection} fromConn - 发送者的连接（仅房主有）
 */
function handleIncomingData(rawData, fromConn) {
  let data;
  if (typeof rawData === 'string') {
    try { data = JSON.parse(rawData); } catch (e) { return; }
  } else {
    data = rawData;
  }

  switch (data.type) {

    // ── 加入请求（房主收到） ──
    case 'joinRequest': {
      if (!isHost || !fromConn) return;

      const color = COLORS[colorIndexCounter++ % COLORS.length];
      fromConn._userId = data.userId;
      fromConn._userName = data.userName;
      fromConn._pendingUser = false;

      // 记录用户
      presenceUsers[data.userId] = { id: data.userId, name: data.userName, color };

      // 发送当前项目状态给新用户
      fromConn.send(JSON.stringify({
        type: 'syncState',
        project: project,
        userId: data.userId,
        userColor: color,
      }));

      // 通知新用户当前在线列表
      fromConn.send(JSON.stringify({
        type: 'userList',
        users: getAllUsers(),
      }));

      // 广播给其他所有人：有新用户加入
      broadcastToOthers(fromConn, {
        type: 'userJoined',
        user: { id: data.userId, name: data.userName, color },
        users: getAllUsers(),
      });

      // 通知自己（房主）更新头像
      updatePresenceUsers();
      renderAvatars(getAllUsers());
      addChatSystem(`${data.userName} 加入了协作`);
      break;
    }

    // ── 房间已满 ──
    case 'roomFull': {
      alert('房间已满，最多支持 ' + MAX_PEERS + ' 人同时协作');
      cleanupPeer();
      break;
    }

    // ── 同步项目状态 ──
    case 'syncState': {
      // 场景1：加入者收到初始项目同步（来自房主的 joinRequest 响应）
      if (!isHost && (data.userId === myUserId || !data.userId) && !data.targetUserId) {
        if (data.userColor) myColor = data.userColor;
        project = data.project;
        currentPageId = project.pages[0]?.id;
        onSessionJoined({
          sessionId: roomCode,
          userId: myUserId,
          userName: myName,
          userColor: myColor,
          project,
          users: [{ id: myUserId, name: myName, color: myColor }],
        });
        break;
      }
      // 场景2：撤销/重做时广播状态同步
      if (data.targetUserId === '__all__' || data.targetUserId === myUserId) {
        project = data.project;
        currentPageId = project.pages[0]?.id;
        renderCanvas();
        renderPageTabs();
      }
      break;
    }

    // ── 用户列表更新 ──
    case 'userList': {
      if (isHost) return;
      // 更新 presenceUsers
      presenceUsers = {};
      data.users.forEach(u => {
        presenceUsers[u.id] = u;
      });
      // 确保自己在列表中
      if (!presenceUsers[myUserId]) {
        presenceUsers[myUserId] = { id: myUserId, name: myName, color: myColor };
      }
      renderAvatars(data.users);
      break;
    }

    // ── 有新用户加入（其他 peer 收到） ──
    case 'userJoined': {
      if (data.user) {
        presenceUsers[data.user.id] = data.user;
      }
      if (data.users) {
        renderAvatars(data.users);
      }
      if (data.user && data.user.id !== myUserId) {
        addChatSystem(`${data.user.name} 加入了协作`);
      }
      break;
    }

    // ── 光标移动 ──
    case 'cursorMove': {
      onCursorUpdate(data);
      break;
    }

    // ── 元素操作 ──
    case 'addElement': {
      onElementAdded(data);
      break;
    }
    case 'updateElement': {
      onElementUpdated(data);
      break;
    }
    case 'deleteElement': {
      onElementDeleted(data);
      break;
    }
    case 'moveElement': {
      onElementMoved(data);
      break;
    }

    // ── 页面操作 ──
    case 'addPage': {
      onPageAdded(data);
      break;
    }
    case 'renamePage': {
      onPageRenamed(data);
      break;
    }
    case 'deletePage': {
      onPageDeleted(data);
      break;
    }

    // ── 选中元素 ──
    case 'selectElement': {
      onElementSelected(data);
      break;
    }

    // ── 聊天 ──
    case 'chat': {
      onChat(data);
      break;
    }

    // ── 用户离开 ──
    case 'userLeft': {
      if (data.userId !== myUserId) {
        onUserLeft(data);
        addChatSystem('某人离开了协作');
      }
      break;
    }
  }
}

/**
 * 房主广播消息给除 fromConn 外的所有连接
 */
function broadcastToOthers(fromConn, data) {
  const msg = JSON.stringify(data);
  connections.forEach(conn => {
    if (conn !== fromConn && conn.open) {
      try { conn.send(msg); } catch (e) { console.warn('广播失败:', e); }
    }
  });
}

/**
 * 获取所有在线用户列表
 */
function getAllUsers() {
  const users = [];
  // 房主自己
  users.push({ id: myUserId, name: myName, color: myColor });
  // 所有连接的 peer
  connections.forEach(conn => {
    if (conn._userId) {
      users.push({
        id: conn._userId,
        name: conn._userName || '???',
        color: presenceUsers[conn._userId]?.color || '#999',
      });
    }
  });
  return users;
}

/**
 * 更新 presenceUsers（房主用）
 */
function updatePresenceUsers() {
  presenceUsers = {};
  presenceUsers[myUserId] = { id: myUserId, name: myName, color: myColor };
  connections.forEach(conn => {
    if (conn._userId && presenceUsers[conn._userId]) {
      presenceUsers[conn._userId] = {
        id: conn._userId,
        name: conn._userName || '???',
        color: presenceUsers[conn._userId].color,
      };
    }
  });
}

/**
 * 广播用户列表给所有人
 */
function broadcastUserList() {
  const users = getAllUsers();
  const msg = JSON.stringify({ type: 'userList', users });
  connections.forEach(conn => {
    if (conn.open) {
      try { conn.send(msg); } catch (e) {}
    }
  });
  // 更新自己的头像
  renderAvatars(users);
}

/**
 * 清理 PeerJS 连接
 */
function cleanupPeer() {
  if (hostConn) {
    try { hostConn.close(); } catch (e) {}
    hostConn = null;
  }
  connections.forEach(conn => {
    try { conn.close(); } catch (e) {}
  });
  connections = [];
  if (peer && !peer.destroyed) {
    peer.destroy();
  }
  peer = null;
  isHost = false;
  roomCode = null;
}

// ─── 项目创建 ───
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

// ─── 消息处理（远程事件） ───

// ─── 会话管理 ───
function onSessionJoined(data) {
  roomCode = data.sessionId;
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
  // 从 presenceUsers 中移除
  delete presenceUsers[data.userId];
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
  if (!roomCode) return;
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
    // 通知其他人
    send({ type: 'userLeft', userId: myUserId });

    // 清理连接
    cleanupPeer();

    // 重置状态
    roomCode = null;
    project = null;
    presenceUsers = {};
    remoteCursors = {};
    otherSelected = {};
    undoStack = [];
    redoStack = [];
    selectedElementId = null;
    currentPageId = null;
    showView(entryView);
  }
});

// ─── 入口按钮 ───
createBtn.addEventListener('click', () => {
  const name = entryName.value.trim() || '匿名用户';
  const proj = entryProject.value.trim() || '未命名项目';
  createRoom(name, proj);
});

joinBtn.addEventListener('click', () => {
  const code = entryCode.value.trim();
  const name = entryName.value.trim() || '匿名用户';
  if (!code) {
    alert('请输入协作码');
    return;
  }
  joinRoom(code, name);
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
