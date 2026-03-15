// DOM Elements
const views = {
  landing: document.getElementById('landing-view'),
  bluetooth: document.getElementById('bluetooth-view'),
  login: document.getElementById('login-view'),
  room: document.getElementById('room-view')
};
const inputs = {
  username: document.getElementById('username'),
  roomCode: document.getElementById('room-code-input')
};
const buttons = {
  // Mode Select
  modeNetwork: document.getElementById('mode-network'),
  modeBluetooth: document.getElementById('mode-bluetooth'),

  // Nav
  netBack: document.getElementById('net-back-btn'),
  btBack: document.getElementById('bt-back-btn'),

  // Network Mode
  create: document.getElementById('create-btn'),
  join: document.getElementById('join-btn'),
  leave: document.getElementById('leave-btn'),
  startStream: document.getElementById('start-stream-btn'),

  // Bluetooth Mode
  btScan: document.getElementById('bt-scan-btn'),
  btStart: document.getElementById('bt-start-btn')
};
const displays = {
  roomCode: document.getElementById('room-display'),
  deviceCount: document.getElementById('device-count'),
  deviceList: document.getElementById('device-list'),
  broadcasterCtrl: document.getElementById('broadcaster-controls'),
  adminCtrl: document.getElementById('admin-controls'),
  status: document.getElementById('status-text'),

  // BT
  btList: document.getElementById('bt-device-list'),
  btStatus: document.getElementById('bt-status')
};
const canvas = document.getElementById('visualizer');
const ctx = canvas.getContext('2d');
const remoteAudioEl = document.getElementById('remote-audio');

// Config
// Auto-detect signaling server: use env-injected global or derive from current host
const SIGNALING_SERVER_URL = window.__ENV__?.SIGNALING_SERVER_URL || window.location.host;
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
const WS_URL = WS_PROTOCOL + SIGNALING_SERVER_URL + '/ws';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// State
let ws = null;
let myId = null;
let myName = null;
let currentRoom = null;
let isMyAdmin = false;
let isMyBroadcaster = false;
let peers = new Map(); // peerId -> RTCPeerConnection
let localStream = null;
let audioContext = null;
let analyser = null;
let dataArray = null;

// BT State
let btSourceStream = null;
let activeOutputs = new Map(); // deviceId -> AudioElement
const btDefaultContainer = document.getElementById('bt-default-device');

// --- Canvas Resize (match internal resolution to CSS display size) ---
function resizeCanvas() {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(cssWidth * dpr);
  const targetH = Math.round(cssHeight * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
}

// LIVE badge element
const liveBadge = document.getElementById('live-badge');

// --- Initialization ---

function init() {
  resizeCanvas();

  // Navigation
  buttons.modeNetwork.addEventListener('click', () => switchView('login'));
  buttons.modeBluetooth.addEventListener('click', () => switchView('bluetooth'));
  buttons.netBack.addEventListener('click', () => switchView('landing'));
  buttons.btBack.addEventListener('click', () => {
    stopBluetoothMode();
    switchView('landing');
  });

  // Network Actions
  buttons.create.addEventListener('click', () => connect('create'));
  buttons.join.addEventListener('click', () => connect('join'));
  buttons.leave.addEventListener('click', leaveRoom);
  buttons.startStream.addEventListener('click', toggleBroadcast);

  // BT Actions
  buttons.btScan.addEventListener('click', scanOutputDevices);
  buttons.btStart.addEventListener('click', toggleBluetoothSource);

  // Responsive canvas via ResizeObserver + fallback
  if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
    new ResizeObserver(resizeCanvas).observe(canvas.parentElement);
  }
  window.addEventListener('resize', resizeCanvas);

  requestAnimationFrame(drawVisualizer);
}

function switchView(viewName) {
  // Hide all others
  Object.entries(views).forEach(([name, el]) => {
    if (name === viewName) return;

    if (el.classList.contains('active')) {
      el.classList.remove('active');
      setTimeout(() => el.classList.add('hidden'), 300);
    } else {
      el.classList.add('hidden');
    }
  });

  // Show Target
  const target = views[viewName];
  target.classList.remove('hidden');
  requestAnimationFrame(() => {
    target.classList.add('active');
  });
}

// --- Bluetooth / Multi-Output Logic ---

async function scanOutputDevices() {
  displays.btList.innerHTML = '<div class="loader">Scanning...</div>';
  if (btDefaultContainer) btDefaultContainer.innerHTML = '';

  try {
    if (!window.isSecureContext) {
      displays.btList.innerHTML = '<p style="color:red">Error: Application must be running in a secure context (HTTPS) to access media devices.</p>';
      return;
    }

    // Explicitly request mic permission FIRST so BT devices are unhidden
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: false, noiseSuppression: false } 
      });
      stream.getTracks().forEach(t => t.stop());
    } catch (err) {
      displays.btList.innerHTML = '<p style="color:red">Microphone permission denied. Cannot scan devices.</p>';
      return;
    }

    let devices = await navigator.mediaDevices.enumerateDevices();

    const outputs = devices.filter(d => d.kind === 'audiooutput');
    displays.btList.innerHTML = '';

    // Inject Refresh Button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn primary';
    refreshBtn.style.marginBottom = '15px';
    refreshBtn.style.width = '100%';
    refreshBtn.textContent = '↻ Refresh Devices';
    refreshBtn.onclick = scanOutputDevices;
    displays.btList.appendChild(refreshBtn);

    if (outputs.length === 0) {
      displays.btList.innerHTML = '<p>No output devices found.</p>';
      return;
    }

    // Deduplication Logic
    const defaultDevice = outputs.find(d => d.deviceId === 'default');

    const otherDevices = outputs.filter(d => {
      if (d.deviceId === 'default') return false;
      if (!defaultDevice) return true;

      const normLabel = d.label.trim();
      const normDefault = defaultDevice.label.trim();

      // 1. Exact match
      if (normLabel === normDefault) return false;

      // 2. Remove "Default - " OR "Communications - " prefix (case insensitive)
      // Windows creates these virtual assignments for the same physical device
      const cleanDefault = normDefault.replace(/^(Default|Communications) - /i, '').trim();
      const cleanLabel = normLabel.replace(/^(Default|Communications) - /i, '').trim();

      if (cleanLabel === cleanDefault) return false;

      // 3. Substring match (If default label contains this device's name)
      // e.g. Default: "Speakers (Realtek USB)" vs "Speakers (Realtek USB)"
      // Ensure label is long enough to avoid false positives with generic names like "Speakers"
      if (cleanLabel.length > 5 && cleanDefault.includes(cleanLabel)) return false;
      if (cleanDefault.length > 5 && cleanLabel.includes(cleanDefault)) return false;

      return true;
    });

    // Render Default
    if (defaultDevice && btDefaultContainer) {
      const el = createDeviceRow(defaultDevice, true);
      btDefaultContainer.appendChild(el);
    }

    // Render Others
    otherDevices.forEach(device => {
      const el = createDeviceRow(device, false);
      displays.btList.appendChild(el);
    });

  } catch (e) {
    console.error(e);
    displays.btList.innerHTML = `<p style="color:red">Error: ${e.message}</p>`;
  }
}

function createDeviceRow(device, isDefault) {
  const el = document.createElement('div');
  const isActive = activeOutputs.has(device.deviceId) || isDefault;

  el.className = `device-row ${isActive ? 'active' : ''}`;
  el.dataset.id = device.deviceId;

  const checkboxHtml = isDefault
    ? `<div class="custom-checkbox" style="border-color:var(--primary); background:var(--primary); color:white;">✓</div>`
    : `<div class="custom-checkbox"></div>`;

  el.innerHTML = `
        ${checkboxHtml}
        <div class="info">
            <div class="name">${device.label || 'Unknown Speaker'}</div>
            <div class="status">${isDefault ? 'Playing Original (System Default)' : (isActive ? 'Duplicating Audio' : 'Ready to Connect')}</div>
        </div>
        <div class="icon">🔊</div>
    `;

  if (!isDefault) {
    el.addEventListener('click', () => toggleOutputDevice(device, el));
  } else {
    el.style.cursor = 'default';
    el.style.opacity = '0.8';
  }

  return el;
}

// TOGGLE Bluetooth
async function toggleBluetoothSource() {
  if (btSourceStream) {
    // STOP
    btSourceStream.getTracks().forEach(t => t.stop());
    btSourceStream = null;

    buttons.btStart.textContent = "▶ Start Audio Source";
    buttons.btStart.className = "btn primary pulse-anim";
    displays.btStatus.textContent = "Audio Source Stopped.";

    activeOutputs.forEach(audio => {
      audio.pause();
      audio.srcObject = null;
    });
    activeOutputs.clear();

    // Reset UI
    document.querySelectorAll('.device-row.active').forEach(el => {
      if (!el.querySelector('.name').innerText.includes('Default')) {
        el.classList.remove('active');
        el.querySelector('.status').textContent = 'Ready to Connect';
      }
    });

  } else {
    // START
    try {
      if (!window.isSecureContext) {
        alert("Application must be running in a secure context (HTTPS) to access media devices.");
        return;
      }
      btSourceStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" }, // Hint "Entire Screen"
        systemAudio: "include", // Hint Checkbox
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          googAutoGainControl: false,
          mozAutoGainControl: false,
          sampleSize: 16,
          channelCount: 2,
          latency: 0 // Minimal Latency
        }
      });

      // Handle Stop via Chrome UI
      btSourceStream.getVideoTracks()[0].onended = () => {
        if (btSourceStream) toggleBluetoothSource();
      };

      buttons.btStart.textContent = "⏹ Stop Audio Source";
      buttons.btStart.className = "btn danger";
      displays.btStatus.textContent = "Audio Source Active! Include System Audio is ON.";

      activeOutputs.forEach(audio => {
        audio.srcObject = btSourceStream;
        audio.play();
      });

      setupVisualizer(btSourceStream);

    } catch (e) {
      console.error(e);
    }
  }
}

async function toggleOutputDevice(device, rowEl) {
  if (!btSourceStream) {
    alert("Please 'Start Audio Source' first!");
    return;
  }

  if (activeOutputs.has(device.deviceId)) {
    // Disable
    const audio = activeOutputs.get(device.deviceId);
    audio.pause();
    audio.srcObject = null;
    activeOutputs.delete(device.deviceId);

    rowEl.classList.remove('active');
    rowEl.querySelector('.status').textContent = 'Ready to Connect';
  } else {
    // Enable
    try {
      const audio = new Audio();
      // Optimize Audio Element for Latency
      audio.preload = 'auto';
      audio.srcObject = btSourceStream;

      if (audio.setSinkId) {
        await audio.setSinkId(device.deviceId);
      }

      await audio.play();
      activeOutputs.set(device.deviceId, audio);

      rowEl.classList.add('active');
      rowEl.querySelector('.status').textContent = 'Duplicating Audio';
    } catch (e) {
      alert(`Failed: ${e.message}`);
    }
  }
}

function stopBluetoothMode() {
  if (btSourceStream) toggleBluetoothSource();
}

// --- Network / WebSocket Logic ---

function connect(action) {
  myName = inputs.username.value.trim();
  const roomCodeInput = inputs.roomCode.value.trim().toUpperCase();

  if (!myName) {
    alert("Please enter your name first!");
    inputs.username.focus();
    return;
  }

  if (action === 'join' && roomCodeInput.length !== 6) {
    alert("Please enter a valid 6-character Room Code.");
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    if (action === 'create') {
      ws.send(JSON.stringify({ type: 'create', name: myName }));
    } else {
      ws.send(JSON.stringify({ type: 'join', name: myName, roomCode: roomCodeInput }));
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleSignalingMessage(msg);
  };

  ws.onerror = (err) => console.error("WS Error", err);
  ws.onclose = () => {
    console.log("Disconnected");
    showLogin();
  };
}

function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'error':
      alert(msg.message);
      ws.close();
      break;

    case 'joined':
      myId = msg.id;
      currentRoom = msg.roomCode;
      isMyAdmin = msg.isAdmin;
      showRoom(msg.roomCode);
      break;

    case 'room-update':
      updateDeviceList(msg.peers);
      updatePeerConnections(msg.peers);
      break;

    case 'offer':
      handleOffer(msg);
      break;

    case 'answer':
      handleAnswer(msg);
      break;

    case 'candidate':
      handleCandidate(msg);
      break;

    case 'you-are-broadcaster':
      isMyBroadcaster = true;
      updateControls();
      break;

    case 'broadcaster-changed':
      isMyBroadcaster = false;
      // if (localStream) stopBroadcast(); // Keep stream if user wants? No, logic implies one broadcaster.
      // Actually, let's keep it simple.
      updateControls();
      break;
  }
}

function showRoom(code) {
  views.login.classList.remove('active');
  views.room.classList.add('active');
  views.room.classList.remove('hidden');
  displays.roomCode.textContent = code;
  updateControls();
}

function showLogin() {
  views.login.classList.add('active');
  views.room.classList.remove('active');
  views.room.classList.add('hidden');

  if (localStream) stopBroadcast();
  resetPeers();
  if (audioContext) audioContext.close();
  audioContext = null;
  isMyAdmin = false;
  isMyBroadcaster = false;
}

function leaveRoom() {
  if (ws) ws.close();
  showLogin();
}

// Hook for adding connections
let activePeerIds = [];
let broadcasterExists = false;

function updateDeviceList(activePeers) {
  displays.deviceCount.textContent = `(${activePeers.length}/7)`;
  displays.deviceList.innerHTML = '';

  // Update Tracker
  activePeerIds = activePeers.map(p => p.id).filter(id => id !== myId);

  // Check if anyone is currently the broadcaster
  broadcasterExists = activePeers.some(p => p.isBroadcaster);
  updateControls(); // Refresh visibility

  activePeers.forEach(peer => {
    const el = document.createElement('div');
    el.className = `device-card ${peer.isBroadcaster ? 'is-broadcaster' : ''} ${isMyAdmin && !broadcasterExists ? 'selectable' : ''}`;
    if (peer.id === myId) el.classList.add('selected'); // Highlight self

    el.innerHTML = `
            <div class="icon">${getIcon(peer)}</div>
            <div class="name">${peer.name} ${peer.id === myId ? '(You)' : ''}</div>
            <div class="role">${peer.isBroadcaster ? 'Broadcaster' : (peer.isAdmin ? 'Admin' : 'Listener')}</div>
        `;

    // Only allow selection if NO broadcaster exists
    if (isMyAdmin && !broadcasterExists) {
      el.addEventListener('click', () => setBroadcaster(peer.id));
    }

    displays.deviceList.appendChild(el);
  });

  if (isMyBroadcaster && localStream) {
    activePeerIds.forEach(targetId => {
      if (!peers.has(targetId)) initiateConnection(targetId);
    });
  }
}

function getIcon(peer) {
  if (peer.isBroadcaster) return '📡';
  if (peer.isAdmin) return '👑';
  return '🎧';
}

function updateControls() {
  displays.broadcasterCtrl.classList.toggle('hidden', !isMyBroadcaster);

  // Hide Admin Panel if: I am NOT admin OR (I am admin BUT a broadcaster is already selected)
  displays.adminCtrl.classList.toggle('hidden', !isMyAdmin || broadcasterExists);

  // Toggle LIVE badge
  const isLive = localStream !== null;
  if (liveBadge) liveBadge.classList.toggle('hidden', !isLive);

  if (isMyBroadcaster) {
    displays.status.innerHTML = '<span class="status-dot" style="background:var(--accent-primary)"></span> You are the broadcaster. Start streaming audio!';
  } else if (broadcasterExists) {
    displays.status.innerHTML = '<span class="status-dot" style="background:var(--accent-success)"></span> Broadcast is active. Listening...';
  } else {
    displays.status.innerHTML = '<span class="status-dot"></span> Waiting for broadcaster selection...';
  }
}

function setBroadcaster(targetId) {
  ws.send(JSON.stringify({ type: 'set-broadcaster', targetId }));
}

// --- WebRTC Logic ---

function setSDPOpusConfig(sdp) {
  const sdpLines = sdp.split('\r\n');
  const opusIndex = sdpLines.findIndex(l => l.match(/a=rtpmap:\d+ opus\/48000\/2/));

  if (opusIndex !== -1) {
    const payloadType = sdpLines[opusIndex].split(':')[1].split(' ')[0];
    const fmtpLineIndex = sdpLines.findIndex(l => l.match(new RegExp(`a=fmtp:${payloadType}`)));

    // OPTIMIZED FOR LOWEST LATENCY
    // ptime=10 (10ms packets) -> Good balance of low latency and low overhead
    // maxaveragebitrate=510000 -> High quality
    // stereo=1
    const config = 'minptime=10;ptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;dtx=0';

    if (fmtpLineIndex !== -1) {
      sdpLines[fmtpLineIndex] += ';' + config;
    } else {
      sdpLines.splice(opusIndex + 1, 0, `a=fmtp:${payloadType} ${config}`);
    }
  }
  return sdpLines.join('\r\n');
}

function updatePeerConnections(currentPeers) {
  const remoteIds = currentPeers.map(p => p.id).filter(id => id !== myId);
  for (const [id, pc] of peers) {
    if (!remoteIds.includes(id)) {
      pc.close();
      peers.delete(id);
    }
  }
}

function resetPeers() {
  peers.forEach(pc => pc.close());
  peers.clear();
}

// TOGGLE Broadcast
async function toggleBroadcast() {
  if (localStream) {
    stopBroadcast();
    buttons.startStream.textContent = "Start Streaming";
    buttons.startStream.className = "btn primary pulse-anim";
  } else {
    try {
      if (!window.isSecureContext) {
        alert("Application must be running in a secure context (HTTPS) to access media devices.");
        return;
      }
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" },
        systemAudio: "include",
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          googAutoGainControl: false,
          mozAutoGainControl: false,
          latency: 0,
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 16
        }
      });

      localStream.getVideoTracks()[0].onended = () => {
        if (localStream) toggleBroadcast();
      };

      setupVisualizer(localStream);

      if (activePeerIds.length > 0) {
        activePeerIds.forEach(targetId => {
          if (!peers.has(targetId)) initiateConnection(targetId);
        });
      }

      buttons.startStream.textContent = "Stop Streaming";
      buttons.startStream.className = "btn danger";
      displays.status.textContent = "Broadcasting Audio (Ultra Low Latency)...";

    } catch (e) {
      console.error("Error getting media", e);
    }
  }
}

function stopBroadcast() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  resetPeers();
  displays.status.textContent = "Broadcast stopped.";

  // Renounce Broadcaster Role so Admin Panel reappears
  if (isMyBroadcaster) {
    ws.send(JSON.stringify({ type: 'set-broadcaster', targetId: null }));
  }
}

async function initiateConnection(targetId) {
  console.log("Initiating connection to:", targetId);
  const pc = createPeerConnection(targetId);
  peers.set(targetId, pc);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  const offer = await pc.createOffer({
    offerToReceiveAudio: false,
    offerToReceiveVideo: false
  });
  offer.sdp = setSDPOpusConfig(offer.sdp);

  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', targetId: targetId, senderId: myId, sdp: offer }));
}

function createPeerConnection(targetId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) ws.send(JSON.stringify({ type: 'candidate', targetId: targetId, senderId: myId, candidate: event.candidate }));
  };

  pc.onicecandidateerror = (event) => {
    console.error("ICE candidate error:", event);
  };

  pc.ontrack = (event) => {
    if (remoteAudioEl.srcObject !== event.streams[0]) {
      remoteAudioEl.srcObject = event.streams[0];

      // --- ULTRA LOW LATENCY TWEAKS FOR RECEIVER ---
      const receiver = pc.getReceivers().find(r => r.track.kind === 'audio');
      if (receiver && receiver.playoutDelayHint !== undefined) {
        receiver.playoutDelayHint = 0; // The Holy Grail of WebRTC Latency
      }

      // Ensure audio element is eager
      remoteAudioEl.play().catch(e => {
        document.body.onclick = () => { remoteAudioEl.play(); document.body.onclick = null; };
      });

      setupVisualizer(event.streams[0]);
    }
  };
  return pc;
}

async function handleOffer(msg) {
  const pc = createPeerConnection(msg.senderId);
  peers.set(msg.senderId, pc);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));

  const answer = await pc.createAnswer();
  answer.sdp = setSDPOpusConfig(answer.sdp); // Apply optimization to Answer too

  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', targetId: msg.senderId, senderId: myId, sdp: answer }));
}

async function handleAnswer(msg) {
  const pc = peers.get(msg.senderId);
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
}

async function handleCandidate(msg) {
  const pc = peers.get(msg.senderId);
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
}

// --- Visualizer ---

function setupVisualizer(stream) {
  if (audioContext) audioContext.close();
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: 'interactive'
  });
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);
}

function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);

  // Ensure canvas resolution matches display
  resizeCanvas();

  const W = canvas.width;
  const H = canvas.height;

  // FULL clear — eliminates ghosting completely
  ctx.clearRect(0, 0, W, H);

  if (!analyser || !dataArray) {
    // Draw idle state — subtle center line
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    return;
  }

  analyser.getByteFrequencyData(dataArray);

  const barCount = dataArray.length;
  const gap = Math.max(1, W * 0.003);
  const barWidth = (W - gap * barCount) / barCount;
  const maxBarHeight = H * 0.9;
  const cornerRadius = Math.max(1, barWidth / 3);

  for (let i = 0; i < barCount; i++) {
    const normalised = dataArray[i] / 255;
    const barHeight = normalised * maxBarHeight;
    if (barHeight < 1) continue;

    const x = i * (barWidth + gap);
    const y = H - barHeight;

    // Per-bar gradient: Cyan → Purple based on frequency index
    const grad = ctx.createLinearGradient(x, H, x, y);
    const hueStart = 185 + (i / barCount) * 80;   // 185 (cyan) → 265 (purple)
    const lightness = 50 + normalised * 15;        // brighter at higher volume
    grad.addColorStop(0, `hsla(${hueStart}, 85%, ${lightness}%, 0.3)`);
    grad.addColorStop(0.5, `hsla(${hueStart}, 90%, ${lightness}%, 0.7)`);
    grad.addColorStop(1, `hsla(${hueStart}, 95%, ${lightness + 10}%, 1)`);

    ctx.fillStyle = grad;

    // Draw rounded-top bar
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, y + cornerRadius);
    ctx.quadraticCurveTo(x, y, x + cornerRadius, y);
    ctx.lineTo(x + barWidth - cornerRadius, y);
    ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + cornerRadius);
    ctx.lineTo(x + barWidth, H);
    ctx.closePath();
    ctx.fill();

    // Glow on loud bars
    if (normalised > 0.6) {
      ctx.shadowColor = `hsla(${hueStart}, 90%, 60%, ${normalised * 0.4})`;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

init();
