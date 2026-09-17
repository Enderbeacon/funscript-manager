import { z } from 'zod'

/** Parsed EroScripts post. Pure data — no I/O types cross here. */

export const HOSTER_IDS = [
  'pixeldrain',
  'mega',
  'gofile',
  'gdrive',
  'dropbox',
  'mediafire',
  'eporner',
  'hanime1',
  'hanimetv',
  'iwara',
  'pornhub',
  'rule34video',
  'spankbang',
  'xnxx',
  'xvideos',
  'patreon',
  'payhip',
  'attachment',
  'unknown'
] as const

/** Which part of the post a link sat under; drives the default checkbox state. */
export const LinkSectionSchema = z.enum(['video', 'script', 'preview', 'unknown'])

export const ScrapedLinkSchema = z.object({
  url: z.string(),
  hoster: z.enum(HOSTER_IDS),
  section: LinkSectionSchema,
  /** Link text (attachments) or the file name guessed from the URL. */
  label: z.string(),
  /** A forum attachment rather than an external host. */
  isAttachment: z.boolean(),
  /** True for .funscript attachments and script-section links. */
  isScript: z.boolean(),
  /** Whether this host has no automated downloader (patreon, and the like). */
  manualOnly: z.boolean(),
  /**
   * The link is a landing or purchase page, not a file: it can be downloaded,
   * but only after the user pastes the direct link they were given (payhip).
   * Distinct from `manualOnly`, which means no download path at all.
   */
  needsManualLink: z.boolean().default(false),
  /**
   * Can the app fetch this itself? True when a downloader plugin claims the
   * URL, or when the URL is plainly a file the generic downloader can take.
   *
   * Everything else — store pages, Patreon, SLR, an unrecognised landing page —
   * is false, and the UI offers a way to the site instead of a tick box. The
   * test is deliberately "does a plugin claim it" rather than a list of paywalled
   * hosts: paid sites appear faster than any list is maintained, and registering
   * a downloader is already how a new source becomes usable.
   */
  downloadable: z.boolean().default(true),
  /**
   * What the author wrote beside this link in the opening post — "Free 4K link
   * (reuploaded)", "DMM Link (to buy)". Between three mirrors of the same
   * video it is usually the only thing that says which one to take.
   */
  note: z.string().default(''),
  /**
   * Set when the link came from a reply rather than the opening post. Older
   * threads lose their original upload all the time and someone posts a
   * replacement further down, so those links are collected too — but where a
   * link came from is exactly what tells the user whether to trust it, and it
   * has to survive being merged into the same groups as the author's own links.
   */
  fromPost: z
    .object({
      number: z.number().int(),
      author: z.string(),
      /** Reply timestamp; a mirror posted last month beats one from 2021. */
      createdAt: z.string().default(''),
      /** The reply's own words. Replies carry no headings, so this is the only context. */
      excerpt: z.string().default('')
    })
    .nullable()
    .default(null)
})

export const ScrapedPostSchema = z.object({
  postId: z.number().int(),
  postUrl: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  author: z.string(),
  createdAt: z.string(),
  /** Plain text pulled from the details section; empty when it has none. */
  description: z.string(),
  /**
   * First image in the opening post, used as the card's thumbnail. Authors put
   * a poster frame at the top by convention, and it is the only picture of the
   * scene available before anything is downloaded.
   */
  previewImage: z.string().default(''),
  links: z.array(ScrapedLinkSchema)
})

export type ScrapedLink = z.infer<typeof ScrapedLinkSchema>
export type ScrapedPost = z.infer<typeof ScrapedPostSchema>
export type LinkSection = z.infer<typeof LinkSectionSchema>
