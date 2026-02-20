# Video Download Server Setup

## Prerequisites
1. **Node.js** - Download from https://nodejs.org/ (choose LTS version)
2. **FFmpeg** - Install via:
   - Windows: `choco install ffmpeg` or download from https://ffmpeg.org/download.html
   - Mac: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`

## Installation

### Windows
1. Double-click `install-and-run.bat`
2. Server will start automatically

### Mac/Linux
1. Open Terminal in this folder
2. Run: `chmod +x install-and-run.sh`
3. Run: `./install-and-run.sh`

### Manual
```bash
npm install
npm start
