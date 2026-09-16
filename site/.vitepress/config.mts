import { defineConfig } from 'vitepress'

const REPOSITORY = 'https://github.com/Enderbeacon/funscript-manager'

export default defineConfig({
  title: 'Funscript Manager',
  description: 'A Windows media manager for funscript-driven content.',
  // Served from the repository's GitHub Pages path.
  base: '/funscript-manager/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/funscript-manager/mark.svg' }],
    ['meta', { name: 'theme-color', content: '#4c6fff' }]
  ],
  themeConfig: {
    logo: '/mark.svg',
    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '/guide/' },
      { text: 'Download', link: `${REPOSITORY}/releases/latest` }
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Start here',
          items: [{ text: 'Getting started', link: '/guide/' }]
        },
        {
          text: 'Your library',
          items: [
            { text: 'Libraries and scripts', link: '/guide/library' },
            { text: 'Tags, filters and playlists', link: '/guide/organising' }
          ]
        },
        {
          text: 'Getting content',
          items: [{ text: 'Forum posts and downloads', link: '/guide/posts' }]
        },
        {
          text: 'Playing',
          items: [
            { text: 'Video players and the queue', link: '/guide/playback' },
            { text: 'Devices and the script player', link: '/guide/devices' }
          ]
        },
        {
          text: 'Reference',
          items: [{ text: 'Your data and FAQ', link: '/guide/data' }]
        }
      ]
    },
    socialLinks: [{ icon: 'github', link: REPOSITORY }],
    editLink: {
      pattern: `${REPOSITORY}/edit/main/site/:path`,
      text: 'Edit this page on GitHub'
    },
    search: { provider: 'local' },
    footer: {
      message: 'Released under the GNU AGPL v3.0 or later.',
      copyright: 'Copyright © Enderbeacon'
    }
  }
})
