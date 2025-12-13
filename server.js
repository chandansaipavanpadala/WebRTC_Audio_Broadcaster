import { join } from "path";

// State
const rooms = new Map(); // roomCode -> Set<ws>
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
    port: 3000,
    hostname: "0.0.0.0", // Listen on all interfaces
    async fetch(req, server) {
        const url = new URL(req.url);
        const clientIP = server.requestIP(req)?.address || "abc";

        // IP Filtering: Enable to restrict to LAN only
        if (!isLocalNetwork(clientIP)) {
            // Optional: Strict Mode
            console.log(`Blocked external connection from ${clientIP}`);
            // return new Response("Access Denied: Local Network Only", { status: 403 });
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
            // Wait for 'join' message
        },
        message(ws, message) {
            try {
                const data = JSON.parse(message);
                handleMessage(ws, data);
            } catch (e) {
                console.error("WS Parse Error", e);
            }
        },
        close(ws) {
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
            handleSignaling(ws, data);
            break;
        case 'set-broadcaster':
            handleSetBroadcaster(ws, data);
            break;
    }
}

function handleCreate(ws, { name }) {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    joinRoom(ws, roomCode, name, true); // true = isAdmin
}

function handleJoin(ws, { roomCode, name }) {
    if (!rooms.has(roomCode)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
    }
    const room = rooms.get(roomCode);
    if (room.size >= 7) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full (Max 7)' }));
        return;
    }
    joinRoom(ws, roomCode, name, false);
}

function joinRoom(ws, roomCode, name, isAdmin) {
    handleLeave(ws); // Ensure left previous room

    if (!rooms.has(roomCode)) {
        rooms.set(roomCode, new Set());
    }
    const room = rooms.get(roomCode);
    room.add(ws);

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
    if (roomCode && rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        room.delete(ws);
        if (room.size === 0) {
            rooms.delete(roomCode);
        } else {
            broadcastRoomUpdate(roomCode);
        }
    }
    ws.data.roomCode = null;
}

function broadcastRoomUpdate(roomCode) {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);
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

function handleSignaling(ws, data) {
    const { targetId } = data;
    const roomCode = ws.data.roomCode;
    if (!roomCode || !rooms.has(roomCode)) return;

    const room = rooms.get(roomCode);
    // Find target
    for (const client of room) {
        if (client.data.id === targetId) {
            // Forward the message with senderId
            client.send(JSON.stringify({
                ...data,
                senderId: ws.data.id
            }));
            break;
        }
    }
}

function handleSetBroadcaster(ws, { targetId }) {
    if (!ws.data.isAdmin) return;

    const roomCode = ws.data.roomCode;
    const room = rooms.get(roomCode);

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
console.log(`---------------------------------------------`);
console.log(`Local:   http://localhost:${server.port}`);
const localIPs = getLocalIPs();
localIPs.forEach(ip => {
    console.log(`Network: http://${ip}:${server.port}`);
});
console.log(`---------------------------------------------`);
console.log(`Share the Network URL with devices on your Wi-Fi.`);
if (localIPs.length === 0) {
    console.log(`⚠️  Warning: No local network IP found using os.networkInterfaces(). Check your connection.`);
}