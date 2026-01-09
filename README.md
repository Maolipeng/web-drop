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

## 说明

- 建议在同一 Wi-Fi 下使用。
- 需要浏览器支持 WebRTC 与 WebSocket。
- 扫码依赖 `BarcodeDetector`，不支持时可手动输入配对码。
