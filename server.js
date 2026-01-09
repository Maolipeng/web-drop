const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, new Set());
  }
  return rooms.get(code);
}

function removeFromRoom(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(ws.roomCode);
  }
}

function getLobbyList() {
  const list = [];
  for (const [code, room] of rooms.entries()) {
    if (room.size === 1) {
      const [client] = room;
      list.push({ code, name: client.displayName || "Anonymous" });
    }
  }
  return list;
}

function broadcastLobby() {
  io.emit("lobby", { rooms: getLobbyList() });
}

io.on("connection", (socket) => {
  socket.on("lobby-subscribe", ({ name }) => {
    socket.displayName = String(name || "Anonymous").slice(0, 40);
    socket.emit("lobby", { rooms: getLobbyList() });
  });

  socket.on("lobby-update", ({ name }) => {
    socket.displayName = String(name || "Anonymous").slice(0, 40);
    broadcastLobby();
  });

  socket.on("join", ({ code, name }) => {
    const normalized = normalizeCode(code);
    if (!normalized) {
      socket.emit("error", { message: "Code required" });
      return;
    }

    const room = getRoom(normalized);
    if (room.size >= 2) {
      socket.emit("error", { message: "Room full" });
      return;
    }

    socket.roomCode = normalized;
    socket.displayName = String(name || "Anonymous").slice(0, 40);
    room.add(socket);
    socket.join(normalized);

    const role = room.size === 1 ? "caller" : "callee";
    socket.emit("join-ack", { role, code: normalized });

    if (room.size === 2) {
      socket.to(normalized).emit("peer-joined", { name: socket.displayName });
    }
    broadcastLobby();
  });

  socket.on("offer", (payload) => {
    if (!socket.roomCode) {
      socket.emit("error", { message: "Join a room first" });
      return;
    }
    socket.to(socket.roomCode).emit("offer", payload);
  });

  socket.on("answer", (payload) => {
    if (!socket.roomCode) {
      socket.emit("error", { message: "Join a room first" });
      return;
    }
    socket.to(socket.roomCode).emit("answer", payload);
  });

  socket.on("candidate", (payload) => {
    if (!socket.roomCode) {
      socket.emit("error", { message: "Join a room first" });
      return;
    }
    socket.to(socket.roomCode).emit("candidate", payload);
  });

  socket.on("leave", () => {
    if (!socket.roomCode) return;
    socket.to(socket.roomCode).emit("peer-left");
    removeFromRoom(socket);
    broadcastLobby();
  });

  socket.on("disconnect", () => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit("peer-left");
    }
    removeFromRoom(socket);
    broadcastLobby();
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/config", (_req, res) => {
  const iceServers = [];
  const stunUrls = String(process.env.STUN_URLS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls });
  }

  const turnUrls = String(process.env.TURN_URLS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || "",
    });
  }

  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed)) {
        res.json({ iceServers: parsed });
        return;
      }
    } catch (err) {
      res.status(400).json({ error: "Invalid ICE_SERVERS_JSON" });
      return;
    }
  }

  res.json({ iceServers });
});

app.get("/qr", async (req, res) => {
  const code = normalizeCode(req.query.code || "");
  if (!code) {
    res.status(400).send("code required");
    return;
  }
  try {
    const dataUrl = await QRCode.toDataURL(code, { margin: 1, width: 240 });
    const base64 = dataUrl.split(",")[1];
    const buffer = Buffer.from(base64, "base64");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    res.status(500).send("qr failed");
  }
});

const port = process.env.PORT || 3030;
server.listen(port, () => {
  console.log(`web-drop listening on http://localhost:${port}`);
});
