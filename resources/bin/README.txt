Put mpv.exe here. It is not tracked in git; electron-builder copies this
folder into the packaged app's resources.

yt-dlp and ffmpeg do not go here: the app downloads them into its user data
folder on first run.
