const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // 提高稳定性
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6 // 1MB
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const LOCK_FILE = path.join(DATA_DIR, 'store.lock');
const PORT = process.env.PORT || 3000;

// ============================================================
//  数据持久化（带文件锁防止并发写冲突）
// ============================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (lockAge > 5000) {
        // 锁超时，强制释放
        fs.unlinkSync(LOCK_FILE);
      } else {
        return false;
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
    return true;
  } catch (e) { return false; }
}

function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

function loadData() {
  let waited = 0;
  while (!acquireLock() && waited < 3000) {
    // 等待锁释放（最多3秒）
    const start = Date.now();
    while (Date.now() - start < 50) {} // 忙等50ms
    waited += 50;
  }
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      return data;
    }
  } catch (e) {
    console.error('❌ 数据加载失败:', e.message);
  } finally {
    releaseLock();
  }
  return { _version: 0, _createdAt: new Date().toISOString() };
}

function saveData(data) {
  let waited = 0;
  while (!acquireLock() && waited < 3000) {
    const start = Date.now();
    while (Date.now() - start < 50) {}
    waited += 50;
  }
  try {
    // 先写临时文件，再原子重命名
    const tmpFile = DATA_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
    return true;
  } catch (e) {
    console.error('❌ 数据保存失败:', e.message);
    return false;
  } finally {
    releaseLock();
  }
}

// ============================================================
//  初始数据
// ============================================================
let store = loadData();
let version = store._version || 0;

// 确保 store 有基本结构
if (!store._version) {
  store._version = 0;
  store._createdAt = store._createdAt || new Date().toISOString();
  saveData(store);
}

// 在线用户管理
const connectedUsers = new Map(); // socketId -> { id, name, color, joinedAt, lastActive }
const USER_COLORS = ['#B8924A','#2D6A4F','#3D5A80','#B86E1E','#8B2635','#6B6C78','#1B6FA8','#C67A2E'];

function getUserColor(socketId) {
  let hash = 0;
  for (let i = 0; i < socketId.length; i++) {
    hash = ((hash << 5) - hash) + socketId.charCodeAt(i);
    hash |= 0;
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

// ============================================================
//  Express 中间件与路由
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version,
    users: connectedUsers.size,
    lastUpdated: store._lastUpdated || null,
    uptime: process.uptime()
  });
});

// REST 获取全量数据
app.get('/api/data', (req, res) => {
  res.json({ data: store, version, users: connectedUsers.size });
});

// REST 保存数据（兼容非 WebSocket 场景）
app.put('/api/data', (req, res) => {
  const { bbq, hike, lunch, clientVersion } = req.body;
  if (clientVersion !== undefined && clientVersion !== version) {
    return res.status(409).json({
      error: '版本冲突',
      serverVersion: version,
      serverData: store
    });
  }
  if (bbq !== undefined) store.bbq = bbq;
  if (hike !== undefined) store.hike = hike;
  if (lunch !== undefined) store.lunch = lunch;
  version++;
  store._version = version;
  store._lastUpdated = new Date().toISOString();
  saveData(store);
  // 通过 WebSocket 广播给其他客户端
  io.emit('remote-update-all', {
    data: { bbq: store.bbq, hike: store.hike, lunch: store.lunch },
    version,
    updatedBy: 'REST API'
  });
  res.json({ success: true, version });
});

// ============================================================
//  Socket.IO 实时协作
// ============================================================
io.on('connection', (socket) => {
  const userColor = getUserColor(socket.id);
  const userInfo = {
    id: socket.id,
    name: '游客' + socket.id.substring(0, 4),
    color: userColor,
    joinedAt: Date.now(),
    lastActive: Date.now()
  };
  connectedUsers.set(socket.id, userInfo);
  console.log(`✅ 用户连接: ${userInfo.name} (${connectedUsers.size} 在线)`);

  // ----- 发送初始状态给新连接的客户端 -----
  socket.emit('init', {
    success: true,
    data: {
      bbq: store.bbq || null,
      hike: store.hike || null,
      lunch: store.lunch || null
    },
    version,
    myId: socket.id,
    myColor: userColor,
    users: Array.from(connectedUsers.values()).map(u => ({
      id: u.id,
      name: u.name,
      color: u.color
    }))
  });

  // 广播用户列表更新
  socket.broadcast.emit('user-joined', {
    id: socket.id,
    name: userInfo.name,
    color: userColor
  });
  io.emit('users-update', Array.from(connectedUsers.values()).map(u => ({
    id: u.id,
    name: u.name,
    color: u.color
  })));

  // ----- 设置用户名 -----
  socket.on('set-name', (name) => {
    const trimmed = String(name || '').trim().substring(0, 20);
    if (!trimmed) return;
    const user = connectedUsers.get(socket.id);
    if (user) {
      const oldName = user.name;
      user.name = trimmed;
      user.lastActive = Date.now();
      io.emit('users-update', Array.from(connectedUsers.values()).map(u => ({
        id: u.id,
        name: u.name,
        color: u.color
      })));
      console.log(`📝 ${oldName} → ${trimmed}`);
    }
  });

  // ----- 单页签数据更新（实时协作核心）-----
  socket.on('data-update', (payload, callback) => {
    const user = connectedUsers.get(socket.id);
    if (user) user.lastActive = Date.now();

    const { section, data, clientVersion } = payload || {};
    const validSections = ['bbq', 'hike', 'lunch'];

    if (!validSections.includes(section)) {
      if (callback) callback({ success: false, error: '无效的 section' });
      return;
    }

    // 版本冲突检测
    if (clientVersion !== undefined && clientVersion !== version) {
      if (callback) callback({
        success: false,
        conflict: true,
        serverVersion: version,
        serverData: { [section]: store[section] || null },
        message: '数据已被其他人修改，请刷新后再试'
      });
      return;
    }

    // 应用更新
    store[section] = data;
    version++;
    store._version = version;
    store._lastUpdated = new Date().toISOString();
    store._lastUpdatedBy = user ? user.name : '系统';

    // 持久化
    const saved = saveData(store);

    // 广播给其他客户端
    socket.broadcast.emit('remote-update', {
      section,
      data,
      version,
      updatedBy: user ? user.name : '未知用户',
      updatedById: socket.id,
      timestamp: Date.now()
    });

    if (callback) callback({ success: true, version, saved });
    console.log(`💾 ${section} 已更新 (v${version}) by ${user?.name || socket.id}`);
  });

  // ----- 全部保存（三个页签一起）-----
  socket.on('save-all', (payload, callback) => {
    const user = connectedUsers.get(socket.id);
    if (user) user.lastActive = Date.now();

    const { bbq, hike, lunch, clientVersion } = payload || {};

    if (clientVersion !== undefined && clientVersion !== version) {
      if (callback) callback({
        success: false,
        conflict: true,
        serverVersion: version,
        serverData: { bbq: store.bbq, hike: store.hike, lunch: store.lunch },
        message: '数据已被其他人修改，请刷新后再试'
      });
      return;
    }

    if (bbq !== undefined) store.bbq = bbq;
    if (hike !== undefined) store.hike = hike;
    if (lunch !== undefined) store.lunch = lunch;
    version++;
    store._version = version;
    store._lastUpdated = new Date().toISOString();
    store._lastUpdatedBy = user ? user.name : '系统';

    const saved = saveData(store);

    socket.broadcast.emit('remote-update-all', {
      data: { bbq: store.bbq, hike: store.hike, lunch: store.lunch },
      version,
      updatedBy: user ? user.name : '未知用户',
      updatedById: socket.id,
      timestamp: Date.now()
    });

    if (callback) callback({ success: true, version, saved });
    console.log(`📦 全部保存 (v${version}) by ${user?.name || socket.id}`);
  });

  // ----- 请求最新数据（手动刷新）-----
  socket.on('request-refresh', (_, callback) => {
    if (callback) callback({
      success: true,
      data: { bbq: store.bbq, hike: store.hike, lunch: store.lunch },
      version
    });
  });

  // ----- 心跳（保持活跃）-----
  socket.on('heartbeat', () => {
    const user = connectedUsers.get(socket.id);
    if (user) user.lastActive = Date.now();
  });

  // ----- 断开连接 -----
  socket.on('disconnect', (reason) => {
    const user = connectedUsers.get(socket.id);
    connectedUsers.delete(socket.id);
    console.log(`👋 用户断开: ${user?.name || socket.id} (${reason}), ${connectedUsers.size} 在线`);
    io.emit('user-left', { id: socket.id, name: user?.name || '未知' });
    io.emit('users-update', Array.from(connectedUsers.values()).map(u => ({
      id: u.id,
      name: u.name,
      color: u.color
    })));
  });
});

// ============================================================
//  定期清理过期用户 + 自动备份
// ============================================================
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5分钟无心跳视为离线
  for (const [id, user] of connectedUsers) {
    if (now - user.lastActive > timeout) {
      connectedUsers.delete(id);
      console.log(`🧹 清理超时用户: ${user.name}`);
      io.emit('users-update', Array.from(connectedUsers.values()).map(u => ({
        id: u.id, name: u.name, color: u.color
      })));
    }
  }
}, 60000);

// 自动备份（每30分钟）
setInterval(() => {
  const backupDir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `store-${stamp}.json`);
  try {
    fs.writeFileSync(backupFile, JSON.stringify(store, null, 2), 'utf-8');
    // 只保留最近50个备份
    const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).sort();
    if (backups.length > 50) {
      backups.slice(0, backups.length - 50).forEach(f => {
        fs.unlinkSync(path.join(backupDir, f));
      });
    }
  } catch (e) { /* 静默失败 */ }
}, 30 * 60 * 1000);

// ============================================================
//  启动服务
// ============================================================
server.listen(PORT, () => {
  console.log('');
  console.log('  🏕️  ============================================');
  console.log('      锦和出行 · 活动安排协作服务器');
  console.log('  ============================================');
  console.log(`  🚀 HTTP 服务:  http://localhost:${PORT}`);
  console.log(`  📡 WebSocket:  ws://localhost:${PORT}`);
  console.log(`  👥 支持多人实时协作编辑`);
  console.log(`  💾 数据目录:  ${DATA_DIR}`);
  console.log(`  📦 当前版本:  v${version}`);
  console.log('  ============================================');
  console.log('');
});
