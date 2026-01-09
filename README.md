# Web Drop

局域网 WebRTC 文件传输：
- 服务器只做配对与信令，不存文件。
- 设备在同一 Wi-Fi / 局域网内即可点对点传文件。

## 使用

```bash
npm install
npm start
```

局域网中用浏览器打开 `http://<你的局域网IP>:3000`。

## TURN / ICE 配置（跨网传输）

默认只用本机局域网 P2P。跨网传输建议配置 TURN。

支持三种方式（二选一）：

1) 简单环境变量

```
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:your.turn.server:3478
TURN_USERNAME=youruser
TURN_CREDENTIAL=yourpass
```

2) 自定义 JSON（优先级最高）

```
ICE_SERVERS_JSON=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:your.turn.server:3478"],"username":"youruser","credential":"yourpass"}]
```

服务端会通过 `/config` 下发 ICE 配置，前端会自动加载。

## 说明

- 建议在同一 Wi-Fi 下使用。
- 需要浏览器支持 WebRTC 与 WebSocket。
- 扫码依赖 `BarcodeDetector`，不支持时可手动输入配对码。
