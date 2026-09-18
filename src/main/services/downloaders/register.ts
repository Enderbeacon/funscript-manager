import { attachmentPlugin } from './attachment'
import { clearPlugins, registerPlugin } from './base'
import { dropboxPlugin } from './clouds/dropbox'
import { gdrivePlugin } from './clouds/gdrive'
import { mediafirePlugin } from './clouds/mediafire'
import { directPlugin } from './direct'
import { gofilePlugin } from './gofile'
import { hanimetvPlugin } from './hanimetv'
import { iwaraPlugin } from './iwara'
import { megaPlugin } from './mega'
import { epornerPlugin } from './page-direct/eporner'
import { hanime1Plugin } from './page-direct/hanime1'
import { rule34videoPlugin } from './page-direct/rule34video'
import { spankbangPlugin } from './page-direct/spankbang'
import { pixeldrainPlugin } from './pixeldrain'
import { videoSitePlugins } from './video-sites'
import { webPlugin } from './web'
import { xnxxPlugin, xvideosPlugin } from './xvideos'
import { ytdlpPlugin } from './ytdlp'

/**
 * The one place downloader plugins are wired up. Order is match order, and
 * the two catch-alls close the list: `web` takes any page nothing above knew,
 * `direct` any file.
 *
 * The page-direct parsers sit above ytdlp on purpose: both claim eporner and
 * rule34video, and the page parser is the main path with yt-dlp as the safety
 * net. That net is reached from inside the parser (it calls yt-dlp
 * when the page will not parse), not by match order.
 *
 * Plugin id is also the per-hoster concurrency key, so each host is a separate
 * plugin rather than one lumped "cloud storage" one — otherwise a Drive job
 * would block a Dropbox job for no reason.
 */
export function registerDownloaderPlugins(): void {
  clearPlugins()
  registerPlugin(attachmentPlugin)
  registerPlugin(pixeldrainPlugin)
  registerPlugin(megaPlugin)
  registerPlugin(gofilePlugin)
  registerPlugin(epornerPlugin)
  registerPlugin(rule34videoPlugin)
  registerPlugin(hanime1Plugin)
  registerPlugin(hanimetvPlugin)
  registerPlugin(spankbangPlugin)
  registerPlugin(gdrivePlugin)
  registerPlugin(dropboxPlugin)
  registerPlugin(mediafirePlugin)
  registerPlugin(iwaraPlugin)
  registerPlugin(xvideosPlugin)
  registerPlugin(xnxxPlugin)
  for (const plugin of videoSitePlugins) registerPlugin(plugin)
  registerPlugin(ytdlpPlugin)
  registerPlugin(webPlugin)
  registerPlugin(directPlugin)
}
