# Funscript Manager

A Windows desktop media manager for funscript-driven content. It keeps videos
and audio together with their companion files (multi-version, multi-axis
funscripts and subtitles), pulls metadata and downloads from EroScripts posts,
and plays video in sync with a device — through its built-in script player or
MultiFunPlayer.

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
- **Languages** — English, Chinese (Simplified), Japanese, German, French.

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

Optional binaries (`mpv.exe`, `ffmpeg.exe`, `yt-dlp.exe`) can be placed in
`resources/bin/`; they are bundled with the packaged app.

## Releasing

A tag is the whole process. `.github/workflows/release.yml` builds it, packs
an installer, a portable zip and a delta package with
[Velopack](https://velopack.io), and publishes them as a GitHub release; the
app finds them from there.

1. Write `release-notes/<version>.md` — the app shows this text when it offers
   the update, and the workflow refuses a release without it.
2. Commit, then push a tag: `v1.2.0` releases on the stable channel,
   `v1.2.0-beta.1` on the beta channel (beta users also receive stable
   releases when those are newer).

Anything a release changes about stored data has to keep an older build safe,
since the app offers going back to one: run `npm run check:data-compat` after
changing a persisted shape.

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
```

## Third-party code

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
