# Web Drop

局域网 WebRTC 文件传输：
- 服务器只做配对与信令，不存文件。
- 同一 Wi-Fi / 局域网即可点对点传文件。
- 支持聊天、图片发送、发送/接收队列、接收确认弹窗。

## 功能概览

- 配对码 + 二维码扫码加入
- WebRTC DataChannel 点对点传输
- 发送/接收队列 + 进度与速度
- 接收确认弹窗（同意/拒绝）
- 在线设备列表（大厅）
- 可选 TURN 支持跨网传输

## 本地运行（Node 22+）

```bash
npm install
npm start
```

局域网中用浏览器打开 `http://<你的局域网IP>:3000`。

## 一键 Docker 部署

```bash
docker compose up -d --build
```

启动后访问 `http://<你的局域网IP>:3000`。

如需跨网传输，在 `docker-compose.yml` 中填入 TURN 配置（或改用环境变量）。

## 使用流程

1) 发送方点击“生成配对码”  
2) 接收方输入配对码或扫码  
3) 建立连接后选择文件发送  
4) 接收方在弹窗中确认接收  
5) 完成后自动保存到本地

## 配置项

### TURN / ICE 配置（跨网传输）

默认只用本机局域网 P2P。跨网传输建议配置 TURN。

方式一：简单环境变量

```
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:your.turn.server:3478
TURN_USERNAME=youruser
TURN_CREDENTIAL=yourpass
```

方式二：自定义 JSON（优先级最高）

```
ICE_SERVERS_JSON=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:your.turn.server:3478"],"username":"youruser","credential":"yourpass"}]
```

服务端会通过 `/config` 下发 ICE 配置，前端自动加载。

## 目录结构

```
.
├─ public/              # 前端页面与脚本
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ server.js            # Node + Socket.IO 信令
├─ Dockerfile
├─ docker-compose.yml
└─ README.md
```

## 运行环境与兼容性

- Node.js 22+
- Chrome / Edge / Safari (iOS 需允许文件下载)
- `BarcodeDetector` 不支持时可手动输入配对码

## 常见问题

### 1) 跨网无法连接/一直等待
通常是 NAT 类型导致 P2P 失败，需要配置 TURN。

### 2) 信令连接失败
确认端口 3000 可访问，或检查反向代理/WebSocket 是否放行。

### 3) 发送按钮不可用
需要先建立 WebRTC DataChannel 连接后才会解锁。

## 安全说明

- 文件通过 WebRTC 点对点传输，服务器不落盘。
- WebRTC 自带 DTLS 加密；若需更高安全级别，可在应用层加密。

## 许可证

MIT
