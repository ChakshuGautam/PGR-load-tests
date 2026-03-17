import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'DIGIT Load Tests',
  description: 'k6 load tests for the DIGIT PGR complaint lifecycle',
  base: '/PGR-load-tests/',
  themeConfig: {
    nav: [
      { text: 'Architecture', link: '/architecture' },
      { text: 'Running Tests', link: '/running-tests' },
      { text: 'Setup', link: '/setup' },
      { text: 'Findings', link: '/findings' },
    ],
    sidebar: [
      {
        text: 'Documentation',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Running Tests', link: '/running-tests' },
          { text: 'Setup', link: '/setup' },
          { text: 'Findings', link: '/findings' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/ChakshuGautam/PGR-load-tests' },
    ],
  },
})
