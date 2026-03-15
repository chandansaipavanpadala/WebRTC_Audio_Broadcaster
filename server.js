import { join } from "path";

// 1. SELF-PING LOGIC (Keep Render Awake)
const RENDER_URL = "https://webrtc-audio-broadcaster.onrender.com"; // Replace with your actual URL

setInterval(async () => {
  try {
    const res = await fetch(RENDER_URL);
    console.log(`[Self-Ping] Status: ${res.status} at ${new Date().toISOString()}`);
  } catch (e) {
    console.error("[Self-Ping] Failed:", e.message);
  }
}, 600000); // 10 minutes

// ─── Environment Configuration ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const LAN_ONLY = process.env.LAN_ONLY === 'true';

// ─── Room Store Abstraction ──────────────────────────────────────────────────
// Currently uses an in-memory Map. To persist rooms across server restarts
// or scale horizontally, swap this with a Redis-backed implementation:
//
//   import { createClient } from 'redis';
//   import { createAdapter } from '@socket.io/redis-adapter';
//
// Or implement a RedisRoomStore class with the same interface below.
// ─────────────────────────────────────────────────────────────────────────────

class RoomStore {
  constructor() {
    this.rooms = new Map(); // roomCode -> Set<ws>
  }

  has(roomCode) {
    return this.rooms.has(roomCode);
  }

  get(roomCode) {
    return this.rooms.get(roomCode);
  }

  create(roomCode) {
    if (!this.rooms.has(roomCode)) {
      this.rooms.set(roomCode, new Set());
    }
    return this.rooms.get(roomCode);
  }

  addClient(roomCode, ws) {
    const room = this.create(roomCode);
    room.add(ws);
    return room;
  }

  removeClient(roomCode, ws) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) {
      this.rooms.delete(roomCode);
    }
  }

  getSize(roomCode) {
    const room = this.rooms.get(roomCode);
    return room ? room.size : 0;
  }

  delete(roomCode) {
    this.rooms.delete(roomCode);
  }
}

const roomStore = new RoomStore();
// ws.data = { roomCode, name, id, isBroadcaster }

// --- Network Utilities ---
import { networkInterfaces } from "os";

function getLocalIPs() {
    const nets = networkInterfaces();
    const results = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
            if (net.family === 'IPv4' && !net.internal) {
                results.push(net.address);
            }
        }
    }
    return results;
}

function isLocalNetwork(ip) {
    // Handle IPv6 mapped IPv4
    if (ip.startsWith('::ffff:')) {
        ip = ip.substr(7);
    }

    // Localhost
    if (ip === '127.0.0.1' || ip === '::1') return true;

    // Private ranges
    // 10.0.0.0 - 10.255.255.255
    // 172.16.0.0 - 172.31.255.255
    // 192.168.0.0 - 192.168.255.255
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;

    return false;
}

const getMmimeType = (filename) => {
    const ext = filename.split('.').pop();
    const map = {
        html: 'text/html',
        js: 'text/javascript',
        css: 'text/css',
        png: 'image/png',
        jpg: 'image/jpeg',
        ico: 'image/x-icon',
    };
    return map[ext] || 'text/plain';
};

const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req, server) {
        const url = new URL(req.url);
        const clientIP = server.requestIP(req)?.address || "abc";

        // IP Filtering: Controlled via LAN_ONLY env variable
        if (LAN_ONLY && !isLocalNetwork(clientIP)) {
            console.log(`Blocked external connection from ${clientIP}`);
            return new Response("Access Denied: Local Network Only", { status: 403 });
        }

        // Serve Static Files
        let filePath = url.pathname;
        if (filePath === "/") filePath = "/index.html";

        // Prevent directory traversal
        if (filePath.includes("..")) return new Response("Forbidden", { status: 403 });

        try {
            const file = Bun.file(join(import.meta.dir, filePath));
            if (await file.exists()) {
                return new Response(file, {
                    headers: { "Content-Type": getMmimeType(filePath) },
                });
            }
        } catch (e) {
            console.error("File error:", e);
        }

        // Upgrade Websocket
        if (url.pathname === "/ws") {
            const success = server.upgrade(req, {
                data: {
                    id: crypto.randomUUID(),
                    roomCode: null,
                    name: null,
                }
            });
            if (success) return undefined;
        }

        return new Response("Not Found", { status: 404 });
    },
    websocket: {
        open(ws) {
            ws.subscribe("audio-broadcast"); // Join the common room for signaling
            // Wait for 'join' message
        },
        message(ws, message) {
            try {
                const data = JSON.parse(message);
                
                // Broadcast signaling (Offers, Answers, ICE) to everyone ELSE in the room
                // This allows multiple listeners to receive the broadcaster's signal natively
                if (['offer', 'answer', 'candidate'].includes(data.type)) {
                    ws.publish("audio-broadcast", typeof message === 'string' ? message : new TextDecoder().decode(message));
                    return;
                }

                handleMessage(ws, data);
            } catch (e) {
                console.error("WS Parse Error", e);
            }
        },
        close(ws) {
            ws.unsubscribe("audio-broadcast");
            handleLeave(ws);
        }
    }
});

function handleMessage(ws, data) {
    switch (data.type) {
        case 'join':
            handleJoin(ws, data);
            break;
        case 'create':
            handleCreate(ws, data);
            break;
        case 'offer':
        case 'answer':
        case 'candidate':
            // Handled via native ws.publish("audio-broadcast") above
            break;
        case 'set-broadcaster':
            handleSetBroadcaster(ws, data);
            break;
    }
}

function handleCreate(ws, { name }) {
    // Generate a collision-resistant 6-char room code
    let roomCode;
    do {
        roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (roomStore.has(roomCode));
    joinRoom(ws, roomCode, name, true); // true = isAdmin
}

function handleJoin(ws, { roomCode, name }) {
    if (!roomStore.has(roomCode)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
    }
    if (roomStore.getSize(roomCode) >= 7) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full (Max 7)' }));
        return;
    }
    joinRoom(ws, roomCode, name, false);
}

function joinRoom(ws, roomCode, name, isAdmin) {
    handleLeave(ws); // Ensure left previous room

    roomStore.addClient(roomCode, ws);

    ws.data.roomCode = roomCode;
    ws.data.name = name;
    ws.data.isAdmin = isAdmin;

    ws.send(JSON.stringify({
        type: 'joined',
        roomCode,
        id: ws.data.id,
        isAdmin
    }));

    broadcastRoomUpdate(roomCode);
}

function handleLeave(ws) {
    const { roomCode } = ws.data;
    if (roomCode && roomStore.has(roomCode)) {
        roomStore.removeClient(roomCode, ws);
        if (roomStore.has(roomCode)) {
            broadcastRoomUpdate(roomCode);
        }
    }
    ws.data.roomCode = null;
}

function broadcastRoomUpdate(roomCode) {
    if (!roomStore.has(roomCode)) return;
    const room = roomStore.get(roomCode);
    const peers = Array.from(room).map(c => ({
        id: c.data.id,
        name: c.data.name,
        isAdmin: c.data.isAdmin,
        isBroadcaster: c.data.isBroadcaster || false
    }));

    room.forEach(client => {
        client.send(JSON.stringify({
            type: 'room-update',
            peers
        }));
    });
}

// handleSignaling loop replaced by native ws.publish broadcasting

function handleSetBroadcaster(ws, { targetId }) {
    if (!ws.data.isAdmin) return;

    const roomCode = ws.data.roomCode;
    if (!roomStore.has(roomCode)) return;
    const room = roomStore.get(roomCode);

    room.forEach(client => {
        client.data.isBroadcaster = (client.data.id === targetId);
    });

    broadcastRoomUpdate(roomCode);

    // Notify the chosen broadcaster
    room.forEach(client => {
        if (client.data.id === targetId) {
            client.send(JSON.stringify({ type: 'you-are-broadcaster' }));
        } else {
            client.send(JSON.stringify({ type: 'broadcaster-changed', broadcasterId: targetId }));
        }
    });
}

console.log(`\n🎵 AudioSync Server Running!`);
console.log(`─────────────────────────────────────────────`);
console.log(`Mode:    ${LAN_ONLY ? '🔒 LAN Only' : '🌐 Public (open to all)'}`);
console.log(`Local:   http://localhost:${server.port}`);
const localIPs = getLocalIPs();
localIPs.forEach(ip => {
    console.log(`Network: http://${ip}:${server.port}`);
});
console.log(`─────────────────────────────────────────────`);
console.log(`Share the Network URL with devices on your Wi-Fi.`);
if (localIPs.length === 0) {
    console.log(`⚠️  Warning: No local network IP found. Check your connection.`);
}
console.log(`\n💡 For production: set PORT, HOST, and LAN_ONLY env vars.`);
console.log(`   HTTPS is REQUIRED for WebRTC/mic access in production.\n`);