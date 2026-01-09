const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const codeInput = document.getElementById("code-input");
const nameInput = document.getElementById("name-input");
const createBtn = document.getElementById("create-btn");
const joinBtn = document.getElementById("join-btn");
const scanBtn = document.getElementById("scan-btn");
const scanArea = document.getElementById("scan-area");
const scanVideo = document.getElementById("scan-video");
const scanClose = document.getElementById("scan-close");
const fileInput = document.getElementById("file-input");
const sendBtn = document.getElementById("send-btn");
const sendBar = document.getElementById("send-bar");
const receiveBar = document.getElementById("receive-bar");
const qrImg = document.getElementById("qr-img");
const chatList = document.getElementById("chat-list");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatImageBtn = document.getElementById("chat-image-btn");
const chatImageInput = document.getElementById("chat-image-input");
const deviceList = document.getElementById("device-list");
const deviceEmpty = document.getElementById("device-empty");
const sendQueueEl = document.getElementById("send-queue");
const receiveQueueEl = document.getElementById("receive-queue");
const receiveModal = document.getElementById("receive-modal");
const modalFileName = document.getElementById("modal-file-name");
const modalFileMeta = document.getElementById("modal-file-meta");
const modalFileHash = document.getElementById("modal-file-hash");
const modalAccept = document.getElementById("modal-accept");
const modalReject = document.getElementById("modal-reject");

const ENABLE_HASH = false;

const socket = io();
let peer;
let dataChannel;
let role = "";
let receiveBuffer = [];
let receiveSize = 0;
let receiveMeta = null;
let receiveDone = false;
let activeReceive = null;
let pendingReceive = null;
let sending = false;
let sendQueue = [];
let receiveQueue = [];
let pendingApprovals = new Map();
let lobbyRooms = [];
let pendingJoin = null;
let iceServers = [];

const CHUNK_SIZE = 16 * 1024;

function setStatus(text) {
  statusEl.textContent = text;
}

function warnInsecureHost() {
  const host = location.hostname;
  if (host === "0.0.0.0") {
    setStatus("请用 http://localhost 或 HTTPS 访问，0.0.0.0 无法用于扫码");
    return;
  }
  if (location.protocol !== "https:" && host !== "localhost" && host !== "127.0.0.1") {
    setStatus("非 HTTPS 环境扫码不可用，请改用 HTTPS 或 localhost");
  }
}

function appendLog(text) {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${text}\n${logEl.textContent}`.trim();
}

function normalizeCode(code) {
  return String(code || "").trim().replace(/\s+/g, "").toUpperCase();
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function enableTransfer(enable) {
  fileInput.disabled = !enable;
  chatInput.disabled = !enable;
  chatSendBtn.disabled = !enable;
  chatImageBtn.disabled = !enable;
  updateSendReady();
}

function updateQr(code) {
  if (!qrImg) return;
  const text = normalizeCode(code);
  if (!text) {
    qrImg.removeAttribute("src");
    return;
  }
  qrImg.src = `/qr?code=${encodeURIComponent(text)}&t=${Date.now()}`;
}

function resetTransfer() {
  sendBar.style.width = "0%";
  receiveBar.style.width = "0%";
  receiveBuffer = [];
  receiveSize = 0;
  receiveMeta = null;
  receiveDone = false;
  activeReceive = null;
  pendingReceive = null;
  sending = false;
  sendQueue = [];
  receiveQueue = [];
  pendingApprovals.clear();
  enableTransfer(false);
  if (chatList) {
    chatList.textContent = "";
  }
  renderSendQueue();
  renderReceiveQueue();
}

function cleanupPeer() {
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }
  if (peer) {
    peer.close();
    peer = null;
  }
  resetTransfer();
}

function initPeerConnection() {
  peer = new RTCPeerConnection({ iceServers });

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("candidate", { candidate: event.candidate });
    }
  };

  peer.onconnectionstatechange = () => {
    setStatus(`连接状态: ${peer.connectionState}`);
    if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
      appendLog("连接已断开");
      cleanupPeer();
    }
  };

  peer.ondatachannel = (event) => {
    setupDataChannel(event.channel);
  };
}

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.binaryType = "arraybuffer";
  dataChannel.onopen = () => {
    appendLog("数据通道已建立");
    enableTransfer(true);
  };
  dataChannel.onclose = () => {
    appendLog("数据通道已关闭");
    enableTransfer(false);
    for (const resolve of pendingApprovals.values()) {
      resolve(false);
    }
    pendingApprovals.clear();
    sending = false;
    sendQueue.forEach((item) => {
      if (["queued", "hashing", "waiting", "sending"].includes(item.state)) {
        item.state = "paused";
        item.statusText = "连接已断开";
      }
    });
    renderSendQueue();
  };
  if (dataChannel.readyState === "open") {
    appendLog("数据通道已建立");
    enableTransfer(true);
  }
  dataChannel.onmessage = (event) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (message.type === "file-meta") {
        handleIncomingMeta(message);
        return;
      }
      if (message.type === "file-accept" || message.type === "file-reject") {
        handleSendApproval(message);
        return;
      }
      if (message.type === "file-done") {
        receiveDone = true;
        if (activeReceive && receiveMeta && receiveSize >= receiveMeta.size) {
          finalizeReceive();
        }
        return;
      }
      if (message.type === "chat") {
        addChatMessage({
          self: false,
          text: message.text || "",
          ts: message.ts,
          name: message.name,
        });
        return;
      }
      if (message.type === "chat-image") {
        addChatMessage({
          self: false,
          imageUrl: message.dataUrl,
          ts: message.ts,
          name: message.name,
        });
        return;
      }
      return;
    }

    handleIncomingChunk(event.data);
  };
}

socket.on("connect", () => {
  socket.emit("lobby-subscribe", { name: nameInput.value.trim() });
  if (pendingJoin) {
    socket.emit("join", pendingJoin);
    pendingJoin = null;
  }
});

socket.on("lobby", (message) => {
  lobbyRooms = message.rooms || [];
  renderLobby();
});

socket.on("error", (message) => {
  setStatus(message.message || "信令连接出错");
});

socket.on("join-ack", (message) => {
  role = message.role;
  setStatus(`已加入 ${message.code}，角色: ${role}`);
  initPeerConnection();
  if (role === "caller") {
    dataChannel = peer.createDataChannel("file");
    setupDataChannel(dataChannel);
  }
});

socket.on("peer-joined", async (message) => {
  appendLog(`对方已加入：${message.name || "匿名"}`);
  if (role === "caller") {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit("offer", { offer });
  }
});

socket.on("offer", async (message) => {
  await peer.setRemoteDescription(new RTCSessionDescription(message.offer));
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  socket.emit("answer", { answer });
});

socket.on("answer", async (message) => {
  await peer.setRemoteDescription(new RTCSessionDescription(message.answer));
});

socket.on("candidate", async (message) => {
  try {
    await peer.addIceCandidate(message.candidate);
  } catch (err) {
    appendLog("ICE candidate 处理失败");
  }
});

socket.on("peer-left", () => {
  appendLog("对方已离开");
  cleanupPeer();
});

socket.on("disconnect", () => {
  setStatus("信令连接已关闭");
  cleanupPeer();
});

async function loadIceServers() {
  try {
    const res = await fetch("/config");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.iceServers)) {
      iceServers = data.iceServers;
    }
  } catch (err) {
    // ignore config fetch errors
  }
}

function connect() {
  const code = normalizeCode(codeInput.value);
  if (!code) {
    setStatus("请输入配对码");
    return;
  }
  const payload = { code, name: nameInput.value.trim() };
  if (socket.connected) {
    socket.emit("join", payload);
    return;
  }
  pendingJoin = payload;
}

async function enqueueFiles(files) {
  if (!files || !files.length) return;
  Array.from(files).forEach((file) => {
    sendQueue.push({
      id: createId(),
      file,
      name: file.name,
      size: file.size,
      state: "queued",
      statusText: "等待发送",
      metaText: formatBytes(file.size),
      progress: 0,
    });
  });
  renderSendQueue();
  processSendQueue();
}

async function processSendQueue() {
  if (sending || !dataChannel || dataChannel.readyState !== "open") return;
  const item = sendQueue.find((entry) => entry.state === "queued");
  if (!item) return;
  sending = true;
  item.state = "hashing";
  item.statusText = ENABLE_HASH ? "计算校验" : "跳过校验";
  renderSendQueue();
  item.hash = await hashFile(item.file);
  item.state = "waiting";
  item.statusText = "等待确认";
  renderSendQueue();

  dataChannel.send(
    JSON.stringify({
      type: "file-meta",
      id: item.id,
      name: item.name,
      size: item.size,
      mime: item.file.type || "application/octet-stream",
      hash: item.hash,
    })
  );

  const approved = await new Promise((resolve) => {
    pendingApprovals.set(item.id, resolve);
  });

  if (!approved) {
    item.state = "rejected";
    item.statusText = "对方已拒绝";
    sending = false;
    renderSendQueue();
    processSendQueue();
    return;
  }

  await sendFileData(item);
  sending = false;
  processSendQueue();
}

async function sendFileData(item) {
  const file = item.file;
  sendBar.style.width = "0%";
  appendLog(`开始发送: ${file.name} (${formatBytes(file.size)})`);
  let offset = 0;
  const start = performance.now();
  item.state = "sending";
  item.statusText = "发送中";
  renderSendQueue();
  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    dataChannel.send(buffer);
    offset += buffer.byteLength;

    const progress = Math.min(100, Math.round((offset / file.size) * 100));
    sendBar.style.width = `${progress}%`;
    const elapsed = (performance.now() - start) / 1000;
    const speed = elapsed > 0 ? offset / elapsed : 0;
    item.progress = progress;
    item.metaText = `${formatBytes(offset)} / ${formatBytes(file.size)} · ${formatSpeed(speed)}`;
    renderSendQueue();

    if (dataChannel.bufferedAmount > 4 * 1024 * 1024) {
      await waitForBuffer();
    }
  }

  dataChannel.send(JSON.stringify({ type: "file-done", id: item.id }));
  item.state = "done";
  item.statusText = "已发送";
  item.progress = 100;
  item.metaText = `${formatBytes(file.size)} · SHA-256 ${item.hash ? "已发送" : "未提供"}`;
  renderSendQueue();
  appendLog("发送完成");
}

function waitForBuffer() {
  return new Promise((resolve) => {
    if (!dataChannel) {
      resolve();
      return;
    }
    dataChannel.onbufferedamountlow = () => {
      resolve();
    };
    dataChannel.bufferedAmountLowThreshold = 512 * 1024;
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, index)).toFixed(1);
  return `${size} ${units[index]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSec)}/s`;
}

function createId() {
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashArrayBuffer(buffer) {
  if (!ENABLE_HASH) {
    return null;
  }
  if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== "function") {
    return null;
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return bufferToHex(digest);
  } catch (err) {
    return null;
  }
}

async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  return hashArrayBuffer(buffer);
}

async function hashBlob(blob) {
  const buffer = await blob.arrayBuffer();
  return hashArrayBuffer(buffer);
}

function renderLobby() {
  if (!deviceList || !deviceEmpty) return;
  deviceList.textContent = "";
  if (!lobbyRooms.length) {
    deviceEmpty.hidden = false;
    return;
  }
  deviceEmpty.hidden = true;
  lobbyRooms.forEach((room) => {
    const card = document.createElement("div");
    card.className = "device-card";
    const meta = document.createElement("div");
    meta.className = "device-meta";
    const name = document.createElement("div");
    name.className = "device-name";
    name.textContent = room.name || "匿名设备";
    const code = document.createElement("div");
    code.className = "device-code";
    code.textContent = `配对码：${room.code}`;
    meta.appendChild(name);
    meta.appendChild(code);
    const action = document.createElement("button");
    action.textContent = "加入";
    action.addEventListener("click", () => {
      codeInput.value = room.code;
      updateQr(codeInput.value);
      connect();
    });
    card.appendChild(meta);
    card.appendChild(action);
    deviceList.appendChild(card);
  });
}

function buildQueueItem(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "queue-item";
  const row = document.createElement("div");
  row.className = "queue-row";
  const name = document.createElement("div");
  name.className = "queue-name";
  name.textContent = item.name;
  const status = document.createElement("div");
  status.className = "queue-status";
  status.textContent = item.statusText;
  row.appendChild(name);
  row.appendChild(status);
  const meta = document.createElement("div");
  meta.className = "queue-meta";
  meta.textContent = item.metaText || "";
  const progress = document.createElement("div");
  progress.className = "progress";
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.style.width = `${item.progress || 0}%`;
  progress.appendChild(bar);
  wrapper.appendChild(row);
  wrapper.appendChild(meta);
  wrapper.appendChild(progress);
  return wrapper;
}

function renderSendQueue() {
  if (!sendQueueEl) return;
  sendQueueEl.textContent = "";
  sendQueue.forEach((item) => {
    sendQueueEl.appendChild(buildQueueItem(item));
  });
}

function renderReceiveQueue() {
  if (!receiveQueueEl) return;
  receiveQueueEl.textContent = "";
  receiveQueue.forEach((item) => {
    receiveQueueEl.appendChild(buildQueueItem(item));
  });
}

function updateSendReady() {
  const hasFiles = fileInput && fileInput.files && fileInput.files.length > 0;
  sendBtn.disabled = !(
    dataChannel &&
    dataChannel.readyState === "open" &&
    hasFiles
  );
}

function addChatMessage({ self, text, imageUrl, ts, name }) {
  if (!chatList) return;
  const item = document.createElement("div");
  item.className = `chat-item${self ? " self" : ""}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "image";
    bubble.appendChild(img);
  }
  if (text) {
    const p = document.createElement("div");
    p.textContent = text;
    bubble.appendChild(p);
  }
  if (ts || name) {
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    const time = ts ? new Date(ts).toLocaleTimeString() : "";
    meta.textContent = [name, time].filter(Boolean).join(" · ");
    bubble.appendChild(meta);
  }
  item.appendChild(bubble);
  chatList.appendChild(item);
  chatList.scrollTop = chatList.scrollHeight;
}

function sendChatText() {
  if (!dataChannel || dataChannel.readyState !== "open") return;
  const text = chatInput.value.trim();
  if (!text) return;
  const payload = {
    type: "chat",
    text,
    ts: Date.now(),
    name: nameInput.value.trim() || "对方",
  };
  dataChannel.send(JSON.stringify(payload));
  addChatMessage({ self: true, text, ts: payload.ts, name: "我" });
  chatInput.value = "";
}

function sendChatImage(file) {
  if (!file || !dataChannel || dataChannel.readyState !== "open") return;
  if (file.size > 3 * 1024 * 1024) {
    appendLog("图片过大，建议小于 3MB");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const payload = {
      type: "chat-image",
      dataUrl,
      ts: Date.now(),
      name: nameInput.value.trim() || "对方",
    };
    dataChannel.send(JSON.stringify(payload));
    addChatMessage({ self: true, imageUrl: dataUrl, ts: payload.ts, name: "我" });
  };
  reader.readAsDataURL(file);
}

function handleIncomingMeta(message) {
  const entry = {
    id: message.id,
    name: message.name,
    size: message.size,
    hash: message.hash,
    meta: message,
    state: "pending",
    statusText: "等待确认",
    metaText: formatBytes(message.size),
    progress: 0,
  };
  receiveQueue.push(entry);
  renderReceiveQueue();
  if (!pendingReceive) {
    pendingReceive = entry;
    showReceiveModal(entry);
  }
}

function handleSendApproval(message) {
  const resolver = pendingApprovals.get(message.id);
  if (resolver) {
    pendingApprovals.delete(message.id);
    resolver(message.type === "file-accept");
  }
}

function handleIncomingChunk(chunk) {
  if (!activeReceive || !receiveMeta) {
    return;
  }
  receiveBuffer.push(chunk);
  receiveSize += chunk.byteLength;
  const progress = Math.min(100, Math.round((receiveSize / receiveMeta.size) * 100));
  receiveBar.style.width = `${progress}%`;
  const elapsed = (performance.now() - activeReceive.startedAt) / 1000;
  const speed = elapsed > 0 ? receiveSize / elapsed : 0;
  activeReceive.entry.progress = progress;
  activeReceive.entry.statusText = "接收中";
  activeReceive.entry.metaText = `${formatBytes(receiveSize)} / ${formatBytes(
    receiveMeta.size
  )} · ${formatSpeed(speed)}`;
  renderReceiveQueue();
  if (receiveSize >= receiveMeta.size) {
    finalizeReceive();
  }
}

async function finalizeReceive() {
  if (!activeReceive || !receiveMeta) return;
  activeReceive.entry.statusText = "校验中";
  renderReceiveQueue();
  const blob = new Blob(receiveBuffer, { type: receiveMeta.mime || "application/octet-stream" });
  const actualHash = await hashBlob(blob);
  const expectedHash = receiveMeta.hash || "";
  let hashLabel = "未提供";
  let hashMatch = true;
  if (expectedHash && actualHash) {
    hashMatch = actualHash === expectedHash;
    hashLabel = hashMatch ? "匹配" : "不一致";
  } else if (expectedHash && !actualHash) {
    hashMatch = true;
    hashLabel = "未校验";
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = receiveMeta?.name || "file";
  a.click();
  URL.revokeObjectURL(url);
  activeReceive.entry.progress = 100;
  activeReceive.entry.statusText = hashMatch ? "完成" : "校验失败";
  activeReceive.entry.metaText = `${formatBytes(receiveMeta.size)} · SHA-256 ${hashLabel}`;
  renderReceiveQueue();
  appendLog(hashMatch ? "接收完成，已保存到本地" : "接收完成，但校验失败");
  receiveBuffer = [];
  receiveMeta = null;
  receiveSize = 0;
  receiveDone = false;
  receiveBar.style.width = "0%";
  activeReceive = null;
  showNextReceivePrompt();
}

function showReceiveModal(entry) {
  if (!receiveModal) return;
  modalFileName.textContent = entry.name;
  modalFileMeta.textContent = `大小: ${formatBytes(entry.size)}`;
  modalFileHash.textContent = entry.hash ? `SHA-256: ${entry.hash}` : "SHA-256: 未提供";
  receiveModal.classList.remove("hidden");
}

function hideReceiveModal() {
  if (!receiveModal) return;
  receiveModal.classList.add("hidden");
}

function showNextReceivePrompt() {
  const next = receiveQueue.find((item) => item.state === "pending");
  if (next) {
    pendingReceive = next;
    showReceiveModal(next);
  } else {
    pendingReceive = null;
  }
}

function acceptIncoming() {
  if (!pendingReceive || !dataChannel || dataChannel.readyState !== "open") return;
  const entry = pendingReceive;
  entry.state = "accepted";
  entry.statusText = "已同意";
  renderReceiveQueue();
  receiveMeta = entry.meta;
  receiveBuffer = [];
  receiveSize = 0;
  receiveDone = false;
  activeReceive = { entry, startedAt: performance.now() };
  dataChannel.send(JSON.stringify({ type: "file-accept", id: entry.id }));
  pendingReceive = null;
  hideReceiveModal();
}

function rejectIncoming() {
  if (!pendingReceive || !dataChannel || dataChannel.readyState !== "open") return;
  const entry = pendingReceive;
  entry.state = "rejected";
  entry.statusText = "已拒绝";
  renderReceiveQueue();
  dataChannel.send(JSON.stringify({ type: "file-reject", id: entry.id }));
  pendingReceive = null;
  hideReceiveModal();
  showNextReceivePrompt();
}

async function startScan() {
  if (!("BarcodeDetector" in window)) {
    setStatus("当前浏览器不支持扫码");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    scanVideo.srcObject = stream;
    scanArea.hidden = false;

    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const scanLoop = async () => {
      if (scanArea.hidden) return;
      const barcodes = await detector.detect(scanVideo);
      if (barcodes.length) {
        const value = barcodes[0].rawValue || "";
        codeInput.value = normalizeCode(value);
        updateQr(codeInput.value);
        stopScan();
        setStatus("已识别配对码，正在加入...");
        connect();
        return;
      }
      requestAnimationFrame(scanLoop);
    };
    requestAnimationFrame(scanLoop);
  } catch (err) {
    setStatus("无法打开摄像头");
  }
}

function stopScan() {
  scanArea.hidden = true;
  const stream = scanVideo.srcObject;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    scanVideo.srcObject = null;
  }
}

createBtn.addEventListener("click", () => {
  codeInput.value = generateCode();
  setStatus("已生成配对码，等待对方加入");
  updateQr(codeInput.value);
  connect();
});

joinBtn.addEventListener("click", () => {
  connect();
});

scanBtn.addEventListener("click", () => {
  setStatus("扫码已禁用，请手动输入配对码");
});

scanClose.addEventListener("click", () => {
  stopScan();
});

sendBtn.addEventListener("click", () => {
  enqueueFiles(fileInput.files);
  fileInput.value = "";
  updateSendReady();
});

codeInput.addEventListener("input", () => {
  updateQr(codeInput.value);
});

fileInput.addEventListener("change", () => {
  updateSendReady();
});

chatSendBtn.addEventListener("click", () => {
  sendChatText();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendChatText();
  }
});

chatImageBtn.addEventListener("click", () => {
  chatImageInput.click();
});

chatImageInput.addEventListener("change", () => {
  const file = chatImageInput.files[0];
  if (file) {
    sendChatImage(file);
  }
  chatImageInput.value = "";
});

modalAccept.addEventListener("click", () => {
  acceptIncoming();
});

modalReject.addEventListener("click", () => {
  rejectIncoming();
});

let nameUpdateTimer;
nameInput.addEventListener("input", () => {
  if (!socket.connected) return;
  clearTimeout(nameUpdateTimer);
  nameUpdateTimer = setTimeout(() => {
    socket.emit("lobby-update", { name: nameInput.value.trim() });
  }, 200);
});

window.addEventListener("beforeunload", () => {
  socket.emit("leave");
});

loadIceServers();
warnInsecureHost();
