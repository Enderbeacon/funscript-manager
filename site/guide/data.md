# Your data and FAQ

## Where things are stored

**Beside each video**, in `<video file name>.meta.json`: its tags, authors, studios, playlists, rating, script versions, subtitles and sources. This file is the source of truth.

**In each library folder**, in `.fsmgr-cache`: an index and thumbnails. It is a cache. Delete it and the app rebuilds it from the files above on the next scan.

**In the app's data folder** (shown on the **About** page): settings, the definitions of tags and other names (parents, aliases, descriptions, covers), saved filters, the download queue and site sign-ins.

## FAQ

### Can I move or rename files outside the app?

Yes. A moved or renamed video is recognised by its content and keeps its information, as long as the `.meta.json` file is still there or was moved with it. Renaming inside the app, with **Rename**, also renames its scripts and subtitles.

### Is anything uploaded?

No. The app talks to the forum and the download sources you use, and checks GitHub for updates. Your library stays on your computer.

### Do I need an EroScripts account?

Only for restricted posts. Your password is typed into the forum's own sign-in page and never passes through the app.

### How do updates work?

The **About** page shows the current version and any update. The app checks for updates on its own and asks before installing. You can switch between the stable and beta channels there.

### Something went wrong

Report it on [GitHub Issues](https://github.com/Enderbeacon/funscript-manager/issues). Include what you did and what you expected to happen.
