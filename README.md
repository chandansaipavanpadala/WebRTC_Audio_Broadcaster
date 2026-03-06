# AudioSync

AudioSync is a real-time audio synchronization application designed to facilitate shared listening experiences. It enables the synchronization of audio across multiple devices over a local Wi-Fi network or the duplication of a central system's audio output to multiple connected external speakers.

## Features

### Network Speakers Mode
- **Multi-Device Synchronization**: Broadcast audio from a single source device to multiple client devices (smartphones, laptops, and tablets) over a local network.
- **Ultra-Low Latency**: Utilizes an optimized WebRTC implementation with customized jitter buffers and Opus codec configurations (10ms packet size) to ensure near-instantaneous audio synchronization.
- **Audio Visualization**: Includes a real-time frequency visualizer active on all connected client devices.
- **Access Control**: Supports secure room creation with administrative controls for designating source broadcasters.

### Multi-Output Mode
- **Simultaneous Output**: Route audio to multiple hardware output devices connected to a single host computer (e.g., streaming to a Bluetooth speaker and wired headphones concurrently).
- **Web-Native Execution**: Operates entirely within the browser utilizing the Web Audio API, eliminating the need for third-party virtual audio routing software.

## Technology Stack
- **Frontend**: HTML5, Vanilla JavaScript, CSS3
- **Backend & Signaling**: [Bun](https://bun.sh) runtime
- **Communication Protocols**: WebRTC (Data & Audio Transmission), WebSockets (Signaling)

## Getting Started

### Prerequisites
- Ensure [Bun](https://bun.sh) is installed on your host system.

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/chandansaipavanpadala/AudioSync.git
   ```
2. Navigate to the project directory:
   ```bash
   cd AudioSync
   ```
3. Install the required dependencies:
   ```bash
   bun install
   ```

### Running the Server
Initialize the local server using Bun:
```bash
bun server.js
```

Upon execution, the terminal will provide two access URLs:
- **Localhost**: `http://localhost:3000` (For access on the host machine)
- **Network IP**: `http://192.168.x.x:3000` (For access by client devices on the same local network)

## Usage Instructions

### Network Synchronization
1. Access the application on the host device and select **Network Speakers**.
2. Input a designated username and select **Create New Room**.
3. Distribute the generated **Room Code** to prospective client users.
4. On client devices, select **Network Speakers**, input the provided **Room Code**, and select **Join**.
5. The designated administrator can initiate playback by selecting **Start Streaming** or assign broadcasting privileges to a joined client.

### Multi-Output Routing
1. Access the application on the host system.
2. Select **Bluetooth Multi-Output**.
3. Select **Start Audio Source** and authorize the browser to capture the desired audio stream (tab or system audio).
4. The interface will populate a list of available hardware audio devices. Select the desired destination devices to initiate duplicated audio routing.
