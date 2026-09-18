/**
 * Video sites downloaded through yt-dlp, each needing nothing beyond a table
 * row: which host it lives on, which of its pages are single videos, and how
 * its badge looks.
 *
 * One table because four places have to agree on it — the downloader that
 * claims the link, the post parser that labels it, the badge that shows it and
 * the link schema that stores it. Adding a row is all it takes to support one
 * more site.
 *
 * Every row was downloaded from signed out with yt-dlp 2026.08.19 before being
 * added. Sites yt-dlp lists but could not download that day are not here.
 *
 * `video` is the rule for "this page is one video" and nothing wider. A
 * profile, channel or search page on the same host is left out on purpose:
 * yt-dlp would take one as an instruction to download everything on it, so
 * those stay links to open, labelled as a listing rather than a video.
 */

export interface VideoSite {
  readonly id: string
  /** The site's own name, as its badge shows it. */
  readonly name: string
  /** Badge colour, taken from the site's logo. */
  readonly hex: string
  /** Badge monogram. */
  readonly mono: string
  /** Hostnames that belong to the site. Anchored; covers subdomains where the site uses them. */
  readonly host: RegExp
  /** Path of a single-video page. */
  readonly video: RegExp
}

/**
 * The txxx network: one player behind many brands. Each brand is a row of its
 * own so a job is labelled with the site it came from and queues under that
 * site's limit, but they all share the same video path.
 */
function txxxSite<const Id extends string>(
  id: Id,
  name: string,
  hex: string,
  mono: string,
  domain: string,
  tube = false
): VideoSite & { readonly id: Id } {
  const tld = tube ? '(?:com|tube)' : 'com'
  return {
    id,
    name,
    hex,
    mono,
    host: new RegExp(`^(?:www\\.)?${domain}\\.${tld}$`, 'i'),
    video: /^\/(?:videos?[/-]|embed\/)\d+/i
  }
}

export const VIDEO_SITES = [
  {
    id: 'xhamster',
    name: 'xHamster',
    hex: '#E8442F',
    mono: 'XH',
    // Language subdomains, and the numbered mirrors the site moves between.
    host: /^(?:[^.]+\.)?(?:xhamster\d*\.(?:com|one|desi)|xhms\.pro|xhday\.com|xhvid\.com)$/i,
    video: /^\/(?:videos\/[^/]*-[\dA-Za-z]+\/?$|movies\/[\dA-Za-z]+\/[^/]*\.html$)/i
  },
  {
    id: 'youporn',
    name: 'YouPorn',
    hex: '#EC567C',
    mono: 'YP',
    host: /^(?:www\.)?youporn\.com$/i,
    video: /^\/(?:watch|embed)\/\d+/i
  },
  {
    id: 'redtube',
    name: 'RedTube',
    hex: '#D6202A',
    mono: 'RT',
    host: /^(?:[a-z]+\.)?redtube\.com(?:\.br)?$/i,
    // Videos sit at the root under a bare number: redtube.com/191397851.
    video: /^\/\d+\/?$/
  },
  {
    id: 'youjizz',
    name: 'YouJizz',
    hex: '#F42E6E',
    mono: 'YJ',
    host: /^(?:[a-z]+\.)?youjizz\.com$/i,
    video: /^\/videos\/(?:[^/#?]*-\d+\.html|embed\/\d+)/i
  },
  {
    id: 'redgifs',
    name: 'RedGifs',
    hex: '#E0252B',
    mono: 'RG',
    host: /^(?:www\.)?redgifs\.com$/i,
    video: /^\/(?:watch|ifr)\/[^/?#.]+/i
  },
  {
    id: 'tnaflix',
    name: 'TNAFlix',
    hex: '#F16822',
    mono: 'TF',
    host: /^(?:www\.|player\.)?tnaflix\.com$/i,
    video: /^\/(?:[^/]+\/[^/]+\/video\d+|video\/\d+)/i
  },
  {
    id: 'empflix',
    name: 'EMPFlix',
    hex: '#3DA4DD',
    mono: 'EF',
    host: /^(?:www\.|player\.)?empflix\.com$/i,
    video: /^\/(?:[^/]+\/[^/]+\/video\d+|videos\/.+-\d+\.html|video\/\d+)/i
  },
  {
    id: 'moviefap',
    name: 'MovieFap',
    hex: '#F19C0E',
    mono: 'MF',
    host: /^(?:www\.)?moviefap\.com$/i,
    video: /^\/videos\/[0-9a-f]+\/[^/]+\.html/i
  },
  txxxSite('txxx', 'Txxx', '#F7931E', 'TX', 'txxx', true),
  txxxSite('hclips', 'HClips', '#EF5B25', 'HC', 'hclips'),
  txxxSite('hdzog', 'HDZog', '#2F9BD8', 'HZ', 'hdzog', true),
  txxxSite('hotmovs', 'HotMovs', '#E53935', 'HM', 'hotmovs', true),
  txxxSite('inporn', 'InPorn', '#8E44AD', 'IP', 'inporn'),
  txxxSite('privatehomeclips', 'PrivateHomeClips', '#D81B60', 'PHC', 'privatehomeclips'),
  txxxSite('tubepornclassic', 'TubePornClassic', '#A1887F', 'TPC', 'tubepornclassic'),
  txxxSite('upornia', 'Upornia', '#DA532C', 'UP', 'upornia', true),
  txxxSite('vjav', 'VJAV', '#C2185B', 'VJ', 'vjav', true),
  txxxSite('vxxx', 'VXXX', '#603CBA', 'VX', 'vxxx'),
  txxxSite('voyeurhit', 'VoyeurHit', '#43A047', 'VH', 'voyeurhit', true),
  {
    id: 'thisvid',
    name: 'ThisVid',
    hex: '#2A6DB5',
    mono: 'TV',
    host: /^(?:www\.)?thisvid\.com$/i,
    video: /^\/(?:videos|embed)\/[A-Za-z0-9-]+/
  },
  {
    id: 'hellporno',
    name: 'HellPorno',
    hex: '#F5A623',
    mono: 'HP',
    host: /^(?:www\.)?hellporno\.(?:com|net)$/i,
    video: /^\/(?:videos|v)\/[^/]+/i
  },
  {
    id: 'zenporn',
    name: 'ZenPorn',
    hex: '#7E57C2',
    mono: 'ZP',
    host: /^(?:www\.)?zenporn\.com$/i,
    video: /^\/video\/\d+/i
  },
  {
    id: 'nuvid',
    name: 'Nuvid',
    hex: '#F7941D',
    mono: 'NV',
    host: /^(?:www\.|m\.)?nuvid\.com$/i,
    video: /^\/video\/\d+/i
  },
  {
    id: 'lovehomeporn',
    name: 'LoveHomePorn',
    hex: '#E91E63',
    mono: 'LHP',
    host: /^(?:www\.)?lovehomeporn\.com$/i,
    video: /^\/video\/\d+/i
  },
  {
    id: 'xxxymovies',
    name: 'XXXYMovies',
    hex: '#B71C1C',
    mono: 'XY',
    host: /^(?:www\.)?xxxymovies\.com$/i,
    video: /^\/videos\/\d+\/[^/]+/i
  },
  {
    id: 'fc2',
    name: 'FC2',
    hex: '#D6001C',
    mono: 'FC2',
    host: /^video\.fc2\.com$/i,
    video: /^\/(?:[^/]+\/)*content\/[^/]+/i
  },
  {
    id: 'twitter',
    name: 'X',
    // X's own mark is black, which disappears on a dark card; the old blue is
    // still what the site is recognised by.
    hex: '#1D9BF0',
    mono: 'X',
    host: /^(?:(?:www|m|mobile)\.)?(?:twitter|x)\.com$/i,
    // One post. `/video/N` picks one video out of a post that has several.
    video: /^\/(?:i\/web|[^/]+)\/status\/\d+(?:\/video\/\d+)?\/?$/i
  }
] as const satisfies readonly VideoSite[]

export type VideoSiteId = (typeof VIDEO_SITES)[number]['id']

export const VIDEO_SITE_IDS = VIDEO_SITES.map((s) => s.id) as unknown as readonly [VideoSiteId, ...VideoSiteId[]]

/** The site a URL's host belongs to, whatever the page. */
export function videoSiteOfHost(hostname: string): VideoSite | undefined {
  return VIDEO_SITES.find((s) => s.host.test(hostname))
}

/** The site whose single-video page this URL is; undefined for any other page. */
export function videoSiteOf(url: string): VideoSite | undefined {
  try {
    const { hostname, pathname } = new URL(url)
    const site = videoSiteOfHost(hostname)
    return site && site.video.test(pathname) ? site : undefined
  } catch {
    return undefined
  }
}
