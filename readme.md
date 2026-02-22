# Video & Stream Downloader

A Chromium extension + local Node.js backend that detects direct video files and stream manifests (HLS/DASH), lets users pick quality/audio/subtitles, and downloads through FFmpeg.

## What It Does

- Detects media requests from active pages (`.m3u8`, `.mpd`, direct video files).
- Enriches YouTube detections using in-page player response data (watch, shorts, live, youtu.be).
- Recovers missed manifests via browser performance entries.
- Deduplicates captures into one logical downloadable item per video.
- Resolves stream quality ladders (browser-side parsing first, backend fallback).
- Downloads and muxes streams through local FFmpeg with progress updates via WebSocket.
- Stores download history and user preferences (quality/audio/subtitle/theme/panel mode).

## How It Works

1. Capture Layer (`background.js`)
- Uses `chrome.webRequest` to capture stream and video requests.
- Captures request headers (`Referer`, `Origin`, `Cookie`, `User-Agent`) for protected CDN playback/download requests.
- Tracks per-tab stream state for popup rendering.

2. Enrichment Layer (`background.js`)
- YouTube extraction runs in MAIN world and reads player response streaming data.
- Performance API manifest recovery adds candidate URLs that request listeners may miss.

3. UI Layer (`popup.html`, `popup.js`)
- Displays deduplicated items.
- Requests qualities/audio/subtitles per stream.
- Prevents weak fallback responses from replacing already richer quality lists.

4. Download Layer (`server.js`)
- Exposes endpoints for quality probing and downloads.
- Uses `ffmpeg`/`ffprobe` to map streams, mux outputs, and emit progress.
- Supports cancellation and open-folder/open-file actions.

## Project Structure

- `manifest.json` - MV3 extension manifest and permissions.
- `background.js` - capture, enrichment, quality orchestration, messaging.
- `popup.html` / `popup.js` - popup/sidepanel UI and download controls.
- `server.js` - local Express + WebSocket + FFmpeg backend.
- `history.html` / `history.js` - download history UI.
- `settings.html` / `settings.js` - preferences and server folder settings.

## Requirements

- Node.js 18+
- FFmpeg and FFprobe available in system `PATH`
- Chromium-based browser with developer mode enabled (Chrome/Edge/Brave/Arc)

## Setup

1. Install backend dependencies

```bash
npm install
```

2. Start local backend

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

Windows helper:

- Run `installAndRun.bat` to install and start with nodemon.

3. Load extension

- Open `chrome://extensions`
- Enable Developer mode
- Click Load unpacked
- Select this project folder

## Usage

1. Start backend (`npm start`).
2. Open a page with playable video/stream and play it for a few seconds.
3. Open extension popup (or side panel if enabled in settings).
4. Click Scan Page.
5. Select quality/audio/subtitle and click Download.
6. Monitor progress in popup; output is saved in configured download folder.

## Backend Endpoints

- `GET /health`
- `GET /server-info`
- `GET /download-dir`
- `POST /download-dir`
- `GET /open-folder`
- `GET /open-file/:filename`
- `GET /play/:filename`
- `GET /downloads`
- `GET /active-downloads`
- `POST /qualities`
- `POST /download`
- `POST /cancel`

## Notes and Limitations

- Multi-resolution selection requires access to a master playlist. If source exposes only a media playlist, only one quality is available.
- Some sites use DRM/protected delivery that cannot be downloaded with this flow.
- Quality probing is best-effort and depends on request context/headers and token validity.

## Legal

Use this project only for content you are authorized to download. You are responsible for compliance with copyright, platform terms, and local laws.
