<div align="center">

<img src="site/public/mark.svg" width="96" height="96" alt="">

# Funscript Manager

**From forum post to synced playback, in one app.**

Manage your library, download from forum, watch the video and drive your
device from the same window.

[![Latest release](https://img.shields.io/github/v/release/Enderbeacon/funscript-manager?label=download&logo=github&color=4c6fff)](https://github.com/Enderbeacon/funscript-manager/releases/latest) [![Downloads](https://img.shields.io/github/downloads/Enderbeacon/funscript-manager/total?color=4c6fff)](https://github.com/Enderbeacon/funscript-manager/releases) ![Windows 10 and 11](https://img.shields.io/badge/Windows-10%20%7C%2011-555555?logo=windows) [![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0-2ea043)](LICENSE)

[**Download**](https://github.com/Enderbeacon/funscript-manager/releases/latest) · [**Guide**](https://enderbeacon.github.io/funscript-manager/) · [**Report a problem**](https://github.com/Enderbeacon/funscript-manager/issues)

</div>

## Features

- **Libraries** — folders are scanned and watched; scripts and subtitles next
  to a media file are grouped into versions and axes automatically.
- **Metadata** — tags, authors, studios, ratings and playlists, with a filter
  sidebar and a nested condition builder.
- **Forum posts** — paste an EroScripts link to see its scripts and video
  sources, pick what to download, and have the post's metadata filed with the
  result. Existing entries can be matched back to the post they came from.
- **Downloads** — a resumable queue for pixeldrain, mega, gofile, Google Drive,
  Dropbox, MediaFire, several video sites and plain direct links; yt-dlp and
  ffmpeg are installed and updated by the app.
- **Playback** — a built-in video player, or mpv, MPC-HC and HereSphere as
  external players. Scripts drive TCode devices over serial, TCP, UDP or
  WebSocket, or The Handy, from the built-in script player; MultiFunPlayer is
  supported as an alternative route.
- **Languages** — English, Chinese, Japanese, German, French.

## Design

- **Sidecars are the source of truth.** Every media file gets a
  `<file name>.meta.json` next to it. The per-library `index.db` (SQLite) is a
  cache that can be deleted at any time and is rebuilt from the sidecars.
- **Typed IPC.** Every renderer → main call is declared once in
  `src/shared/ipc/contract.ts` with Zod schemas and validated on both sides.
- **Codes, not messages.** The main process throws error codes; the renderer
  translates them.

## Development

Windows, with a current Node.js LTS.

```bash
npm install           # install dependencies and rebuild native modules
npm run dev           # start the app in development mode
npm run dev:watch     # the same, restarting on changes
npm run sandbox       # start a first-run copy on an empty user data folder
npm run typecheck     # type-check main and renderer
npm run build         # build into out/
npm run check:*       # protocol and data-compatibility checks (see scripts/)
npm run release       # build and pack an installable release into release/velopack
```

An optional `mpv.exe` can be placed in `resources/bin/`; it is bundled with
the packaged app. yt-dlp and ffmpeg are not bundled — the app downloads them.

## Layout

```
src/
├── main/            Main process: libraries, database, downloads, playback
│   ├── ipc/         IPC handler registration
│   ├── services/
│   └── workers/     Fingerprint and heatmap worker threads
├── preload/         Channel allow-list bridge, no logic
├── renderer/        React UI
├── script-player/   Built-in script player (see its README)
└── shared/          Zod schemas and the IPC contract
resources/
└── mfp-plugin/      MultiFunPlayer control plugin
scripts/             Protocol and behaviour checks run with Node
site/                Project website and user guide
```

## License

Copyright (C) 2026 Enderbeacon

Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).

## Third-party code

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
