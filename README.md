# 🎵 AudioSync

**AudioSync** is a real-time audio synchronization tool designed to create immersive shared listening experiences. It allows you to sync audio across multiple devices over Wi-Fi (like a silent disco) or duplicate your PC's audio to multiple connected Bluetooth speakers simultaneously.

## ✨ Features

### 🌐 Network Speakers Mode (Silent Disco)
- **Multi-Device Sync**: Stream audio from one "Broadcaster" device to multiple "Listener" devices (phones, laptops, tablets) over a local Wi-Fi network.
- **Ultra-Low Latency**: Optimized WebRTC implementation with tuned jitter buffers and Opus codec settings (10ms packet size) for near-instant audio sync.
- **Visualizer**: Real-time frequency visualizer on all connected devices.
- **Admin Control**: Secure room creation with admin controls to designate broadcasters.

### 🎧 Bluetooth Multi-Output Mode
- **Dual Audio Output**: Play audio to multiple output devices connected to a single computer (e.g., connected Bluetooth speaker + wired headphones) simultaneously.
- **Browser-Based**: No complex virtual audio cable software required; runs entirely in the browser using the Web Audio API.

## 🛠️ Technology Stack
- **Frontend**: HTML5, Vanilla JavaScript, CSS3 (Modern Glassmorphism UI).
- **Backend/Signaling**: [Bun](https://bun.sh) (High-performance JavaScript runtime).
- **Protocol**: WebRTC (Data & Audio Streaming), WebSockets (Signaling).

## 🚀 Getting Started

### Prerequisites
- [Bun](https://bun.sh) installed on your system.

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/AudioSync.git
   ```
2. Navigate to the project directory:
   ```bash
   cd AudioSync
   ```
3. Install dependencies (if any):
   ```bash
   bun install
   ```

### Running the Server
Start the local server using Bun:
```bash
bun server.js
```

The terminal will display two URLs:
- **Local**: `http://localhost:3000` (For the host device)
- **Network**: `http://192.168.x.x:3000` (Share this with other devices on your Wi-Fi)

## 📖 Usage

### Using Network Sync
1. Open the app on the **Host** device and select **Network Speakers**.
2. Enter your name and click **Create New Room**.
3. Share the **Room Code** with friends.
4. On **Guest** devices, select **Network Speakers**, enter the **Room Code**, and Join.
5. The Host (Admin) clicks **Start Streaming** or designates a guest as the Broadcaster.

### Using Bluetooth Multi-Output
1. Open the app on your PC.
2. Select **Bluetooth Multi-Output**.
3. Click **Start Audio Source** and select the tab or screen you want to play audio from.
4. The list will show all connected audio devices. Click on the devices you want to duplicate the audio to.
