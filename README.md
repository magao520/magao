# CollabBuilder - 多人实时协作建站平台

## 在线体验

部署到以下任一平台即可获得公网链接：

### 方案一：Render.com（最简单，推荐）

1. 打开 [https://render.com](https://render.com)，注册/登录
2. 点击 **New** → **Web Service**
3. 连接你的 GitHub 仓库（或直接粘贴仓库 URL）
4. 设置：
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. 点击 **Create Web Service**
6. 等待部署完成，复制生成的公网链接即可分享

### 方案二：Railway.app

1. 打开 [https://railway.app](https://railway.app)，注册/登录
2. 点击 **New Project** → **Deploy from GitHub repo**
3. 选择你的仓库，Railway 会自动检测 Node.js 项目
4. 部署完成后复制公网链接

### 方案三：Fly.io

1. 安装 Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. 登录: `fly auth login`
3. 在项目目录运行:
   ```
   fly launch
   fly deploy
   ```
4. 部署完成后会显示公网链接

---

## 本地运行

```bash
npm install
npm start
# 打开 http://localhost:3000
```

## 使用方法

1. 打开链接，输入昵称和项目名，点击「创建新项目」
2. 记下生成的 6 位协作码，分享给其他人
3. 其他人打开同一链接，输入协作码点击「加入」即可实时协作
