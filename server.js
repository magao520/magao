const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ─── HTTP 静态文件服务 ───
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const fp = path.join(__dirname, 'public', url);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── WebSocket 协作服务 ───
const wss = new WebSocket.Server({ server });

// ── 数据结构 ──
// projects: Map<projectId, { name, pages: [{id, name, elements: []}], createdAt }>
const projects = new Map();
// sessions: Map<sessionId, { projectId, users: Map<ws, {id,name,color}> }>
const sessions = new Map();
// ws -> { sessionId, userId }
const connections = new Map();

const COLORS = ['#6c5ce7','#00cec9','#fd79a8','#fdcb6e','#e17055','#00b894','#0984e3','#d63031','#a29bfe','#55efc4'];

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastSession(sessionId, msg, exclude = null) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const str = JSON.stringify(msg);
  session.users.forEach((_, w) => {
    if (w !== exclude && w.readyState === WebSocket.OPEN) w.send(str);
  });
}

function getSessionUsers(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return Array.from(session.users.entries()).map(([ws, u]) => ({ id: u.id, name: u.name, color: u.color }));
}

function getProjectData(projectId) {
  return projects.get(projectId) || null;
}

function createDefaultProject(name) {
  return {
    id: uuidv4(),
    name: name || '未命名项目',
    pages: [{
      id: uuidv4(),
      name: '首页',
      elements: [],
    }],
    createdAt: Date.now(),
  };
}

wss.on('connection', (ws) => {
  connections.set(ws, { sessionId: null, userId: uuidv4() });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const conn = connections.get(ws);
    if (!conn) return;

    switch (data.type) {

      // ── 加入协作会话 ──
      case 'joinSession': {
        const { sessionId, userName } = data;
        let session = sessions.get(sessionId);

        // 如果会话不存在，创建新项目
        if (!session) {
          const project = createDefaultProject(data.projectName);
          projects.set(project.id, project);
          session = {
            projectId: project.id,
            users: new Map(),
          };
          sessions.set(sessionId, session);
        }

        // 离开旧会话
        if (conn.sessionId && sessions.has(conn.sessionId)) {
          const old = sessions.get(conn.sessionId);
          old.users.delete(ws);
          broadcastSession(conn.sessionId, { type: 'userLeft', userId: conn.userId, users: getSessionUsers(conn.sessionId) });
          if (old.users.size === 0) sessions.delete(conn.sessionId);
        }

        conn.sessionId = sessionId;
        const color = COLORS[session.users.size % COLORS.length];
        const user = { id: conn.userId, name: (userName || '匿名用户').slice(0, 20), color };
        session.users.set(ws, user);

        // 发送当前项目状态
        const project = getProjectData(session.projectId);
        send(ws, {
          type: 'sessionJoined',
          sessionId,
          userId: conn.userId,
          userName: user.name,
          userColor: user.color,
          project,
          users: getSessionUsers(sessionId),
        });

        // 通知其他人
        broadcastSession(sessionId, { type: 'userJoined', user: { id: user.id, name: user.name, color: user.color }, users: getSessionUsers(sessionId) }, ws);
        break;
      }

      // ── 光标移动 ──
      case 'cursorMove': {
        if (!conn.sessionId) break;
        broadcastSession(conn.sessionId, {
          type: 'cursorUpdate',
          userId: conn.userId,
          x: data.x, y: data.y,
          elementId: data.elementId,
        }, ws);
        break;
      }

      // ── 元素操作：添加 ──
      case 'addElement': {
        if (!conn.sessionId) break;
        const session = sessions.get(conn.sessionId);
        const project = getProjectData(session.projectId);
        if (!project) break;
        const page = project.pages.find(p => p.id === data.pageId);
        if (!page) break;
        page.elements.push(data.element);
        broadcastSession(conn.sessionId, { type: 'elementAdded', pageId: data.pageId, element: data.element }, ws);
        break;
      }

      // ── 元素操作：更新 ──
      case 'updateElement': {
        if (!conn.sessionId) break;
        const session = sessions.get(conn.sessionId);
        const project = getProjectData(session.projectId);
        if (!project) break;
        const page = project.pages.find(p => p.id === data.pageId);
        if (!page) break;
        const idx = page.elements.findIndex(e => e.id === data.elementId);
        if (idx === -1) break;
        Object.assign(page.elements[idx], data.updates);
        broadcastSession(conn.sessionId, { type: 'elementUpdated', pageId: data.pageId, elementId: data.elementId, updates: data.updates }, ws);
        break;
      }

      // ── 元素操作：删除 ──
      case 'deleteElement': {
        if (!conn.sessionId) break;
        const session = sessions.get(conn.sessionId);
        const project = getProjectData(session.projectId);
        if (!project) break;
        const page = project.pages.find(p => p.id === data.pageId);
        if (!page) break;
        page.elements = page.elements.filter(e => e.id !== data.elementId);
        broadcastSession(conn.sessionId, { type: 'elementDeleted', pageId: data.pageId, elementId: data.elementId }, ws);
        break;
      }

      // ── 元素操作：移动（拖拽排序） ──
      case 'moveElement': {
        if (!conn.sessionId) break;
        const session = sessions.get(conn.sessionId);
        const project = getProjectData(session.projectId);
        if (!project) break;
        const page = project.pages.find(p => p.id === data.pageId);
        if (!page) break;
        const idx = page.elements.findIndex(e => e.id === data.elementId);
        if (idx === -1) break;
        const [el] = page.elements.splice(idx, 1);
        page.elements.splice(data.newIndex, 0, el);
        broadcastSession(conn.sessionId, { type: 'elementMoved', pageId: data.pageId, elementId: data.elementId, newIndex: data.newIndex }, ws);
        break;
      }

      // ── 页面操作：添加 ──
      case 'addPage': {
        if (!conn.sessionId) break;
        const session = sessions.get(conn.sessionId);
        const project = getProjectData(session.projectId);
        if (!project) break;
        const newPage = { id: uuidv4(), name: data.name || '新页面', elements: [] };
        project.pages.push(newPage);
        broadcastSession(conn.sessionId, { type: 'pageAdded', page: newPage }, ws);
        break;
      }

      // ── 页面操作：重命名 ──
      case 'renamePage': {
        if (!conn.sessionId) break;
        const session = sessions.get(conn.sessionId);
        const project = getProjectData(session.projectId);
        if (!project) break;
        const page = project.pages.find(p => p.id === data.pageId);
        if (!page) break;
        page.name = data.name;
        broadcastSession(conn.sessionId, { type: 'pageRenamed', pageId: data.pageId, name: data.name }, ws);
        break;
      }

      // ── 页面操作：删除 ──
      case 'deletePage': {
        if (!conn.sessionId) break;
        const session = sessions.get(conn.sessionId);
        const project = getProjectData(session.projectId);
        if (!project) break;
        if (project.pages.length <= 1) break;
        project.pages = project.pages.filter(p => p.id !== data.pageId);
        broadcastSession(conn.sessionId, { type: 'pageDeleted', pageId: data.pageId }, ws);
        break;
      }

      // ── 选中元素通知 ──
      case 'selectElement': {
        if (!conn.sessionId) break;
        broadcastSession(conn.sessionId, {
          type: 'elementSelected',
          userId: conn.userId,
          elementId: data.elementId,
        }, ws);
        break;
      }

      // ── 聊天 ──
      case 'chat': {
        if (!conn.sessionId) break;
        const user = sessions.get(conn.sessionId)?.users.get(ws);
        broadcastSession(conn.sessionId, {
          type: 'chat',
          user: { id: conn.userId, name: user?.name || '匿名', color: user?.color || '#999' },
          text: String(data.text).slice(0, 500),
          time: Date.now(),
        });
        break;
      }

      // ── 撤销/重做（广播状态快照） ──
      case 'syncState': {
        if (!conn.sessionId) break;
        broadcastSession(conn.sessionId, { type: 'stateSync', project: data.project }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    const conn = connections.get(ws);
    if (conn?.sessionId && sessions.has(conn.sessionId)) {
      const session = sessions.get(conn.sessionId);
      session.users.delete(ws);
      broadcastSession(conn.sessionId, { type: 'userLeft', userId: conn.userId, users: getSessionUsers(conn.sessionId) });
      if (session.users.size === 0) sessions.delete(conn.sessionId);
    }
    connections.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 协作建站平台已启动: http://localhost:${PORT}`);
});
