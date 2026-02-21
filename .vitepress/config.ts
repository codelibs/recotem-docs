import { defineConfig } from 'vitepress'
import type { DefaultTheme } from 'vitepress'

// ---------------------------------------------------------------------------
// Sidebar helpers
// ---------------------------------------------------------------------------

function v1GuideSidebar(lang: 'en' | 'ja'): DefaultTheme.SidebarItem[] {
  const prefix = lang === 'ja' ? '/1.0/ja/guide' : '/1.0/guide'
  const basics = lang === 'ja' ? '基礎編' : 'Basics'
  const advanced = lang === 'ja' ? '進んだ使い方' : 'Advanced'
  return [
    {
      text: basics,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? '概要' : 'Overview', link: `${prefix}/` },
        { text: lang === 'ja' ? 'インストール' : 'Installation', link: `${prefix}/installation` },
        { text: lang === 'ja' ? 'チュートリアル' : 'Tutorial', link: `${prefix}/tutorial/` },
      ],
    },
    {
      text: advanced,
      collapsed: false,
      items: [
        { text: 'CLI', link: `${prefix}/cli` },
        { text: lang === 'ja' ? 'バッチ実行' : 'Batch', link: `${prefix}/batch` },
      ],
    },
  ]
}

function v1DocsSidebar(lang: 'en' | 'ja'): DefaultTheme.SidebarItem[] {
  const prefix = lang === 'ja' ? '/1.0/ja/docs' : '/1.0/docs'
  const containerTitle = lang === 'ja' ? 'Dockerコンテナ' : 'Docker Container'
  const userTitle = lang === 'ja' ? 'ユーザーページ' : "User's page"
  return [
    {
      text: containerTitle,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? '各コンテナの役割' : 'Role of Containers', link: `${prefix}/` },
        { text: lang === 'ja' ? 'イメージのビルド' : 'Building the Image', link: `${prefix}/build` },
      ],
    },
    {
      text: userTitle,
      collapsed: false,
      items: [
        { text: 'Project Selection', link: `${prefix}/user/project-list/` },
        { text: 'Project Top', link: `${prefix}/user/project/` },
        { text: 'Data Management', link: `${prefix}/user/data-list/` },
        { text: 'Data Detail', link: `${prefix}/user/data-detail/` },
        { text: 'Tuning Configuration', link: `${prefix}/user/start-tuning/` },
        { text: 'Tuning (with data)', link: `${prefix}/user/start-tuning-with-data/` },
        { text: 'Tuning (with upload)', link: `${prefix}/user/first-tuning/` },
        { text: 'Tuning Job List', link: `${prefix}/user/tuning-job-list/` },
        { text: 'Tuning Job Detail', link: `${prefix}/user/tuning-job-detail/` },
        { text: 'Model Detail', link: `${prefix}/user/trained-model-detail/` },
        { text: 'Model Management', link: `${prefix}/user/trained-model-list/` },
        { text: 'Start Training', link: `${prefix}/user/start-training/` },
      ],
    },
  ]
}

function v2GuideSidebar(lang: 'en' | 'ja'): DefaultTheme.SidebarItem[] {
  const prefix = lang === 'ja' ? '/ja/guide' : '/guide'
  const basics = lang === 'ja' ? '基礎編' : 'Basics'
  const advanced = lang === 'ja' ? '進んだ使い方' : 'Advanced'
  return [
    {
      text: basics,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? '概要' : 'Overview', link: `${prefix}/` },
        { text: lang === 'ja' ? 'インストール' : 'Installation', link: `${prefix}/installation` },
        { text: lang === 'ja' ? 'チュートリアル' : 'Tutorial', link: `${prefix}/tutorial/` },
      ],
    },
    {
      text: advanced,
      collapsed: false,
      items: [
        { text: 'CLI', link: `${prefix}/cli` },
        { text: lang === 'ja' ? 'バッチ実行' : 'Batch', link: `${prefix}/batch` },
      ],
    },
  ]
}

function v2DocsSidebar(lang: 'en' | 'ja'): DefaultTheme.SidebarItem[] {
  const prefix = lang === 'ja' ? '/ja/docs' : '/docs'
  const containerTitle = lang === 'ja' ? 'Dockerコンテナ' : 'Docker Container'
  const userTitle = lang === 'ja' ? 'ユーザーページ' : "User's page"
  return [
    {
      text: containerTitle,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? '各コンテナの役割' : 'Role of Containers', link: `${prefix}/` },
      ],
    },
    {
      text: userTitle,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? 'プロジェクト選択' : 'Project Selection', link: `${prefix}/user/project-list/` },
        { text: lang === 'ja' ? 'ダッシュボード' : 'Dashboard', link: `${prefix}/user/dashboard/` },
        { text: lang === 'ja' ? 'データ管理' : 'Data Management', link: `${prefix}/user/data-list/` },
        { text: lang === 'ja' ? 'データ詳細' : 'Data Detail', link: `${prefix}/user/data-detail/` },
        { text: lang === 'ja' ? 'チューニング設定' : 'Tuning Configuration', link: `${prefix}/user/start-tuning/` },
        { text: lang === 'ja' ? 'チューニングジョブ一覧' : 'Tuning Job List', link: `${prefix}/user/tuning-job-list/` },
        { text: lang === 'ja' ? 'チューニングジョブ詳細' : 'Tuning Job Detail', link: `${prefix}/user/tuning-job-detail/` },
        { text: lang === 'ja' ? 'モデル設定' : 'Model Configuration', link: `${prefix}/user/model-config/` },
        { text: lang === 'ja' ? 'モデル学習' : 'Start Training', link: `${prefix}/user/start-training/` },
        { text: lang === 'ja' ? 'モデル一覧' : 'Model List', link: `${prefix}/user/trained-model-list/` },
        { text: lang === 'ja' ? 'モデル詳細' : 'Model Detail', link: `${prefix}/user/trained-model-detail/` },
        { text: lang === 'ja' ? 'モデル比較' : 'Model Comparison', link: `${prefix}/user/model-comparison/` },
        { text: lang === 'ja' ? 'デプロイメントスロット' : 'Deployment Slots', link: `${prefix}/user/deployment-slots/` },
        { text: lang === 'ja' ? 'APIキー管理' : 'API Keys', link: `${prefix}/user/api-keys/` },
        { text: lang === 'ja' ? 'A/Bテスト' : 'A/B Tests', link: `${prefix}/user/ab-tests/` },
        { text: lang === 'ja' ? '定期再学習' : 'Scheduled Retraining', link: `${prefix}/user/retraining/` },
        { text: lang === 'ja' ? 'ユーザー管理' : 'User Management', link: `${prefix}/user/user-management/` },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Main config
// ---------------------------------------------------------------------------

export default defineConfig({
  title: 'Recotem',

  // Ignore localhost links (used in installation docs) and
  // allow the build to proceed with relative-path warnings
  ignoreDeadLinks: [
    /^https?:\/\/localhost/,
  ],

  head: [
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['link', { rel: 'icon', href: '/favicon.png' }],
    ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  ],

  sitemap: { hostname: 'https://recotem.org' },

  // i18n – v2 pages only; v1 lives under root locale at /1.0/
  locales: {
    root: {
      lang: 'en-US',
      label: 'English',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/' },
          { text: 'Docs', link: '/docs/' },
          { text: 'Forum', link: 'https://discuss.codelibs.org/c/recotemen/' },
          { text: 'Commercial Support', link: 'https://codelibs.co/' },
        ],
        sidebar: {
          // v2 EN
          '/guide/': v2GuideSidebar('en'),
          '/docs/': v2DocsSidebar('en'),
          // v1 EN
          '/1.0/guide/': v1GuideSidebar('en'),
          '/1.0/docs/': v1DocsSidebar('en'),
          // v1 JA (still under root locale)
          '/1.0/ja/guide/': v1GuideSidebar('ja'),
          '/1.0/ja/docs/': v1DocsSidebar('ja'),
        },
      },
    },
    ja: {
      lang: 'ja-JP',
      label: '日本語',
      themeConfig: {
        nav: [
          { text: 'ガイド', link: '/ja/guide/' },
          { text: 'ドキュメント', link: '/ja/docs/' },
          { text: 'フォーラム', link: 'https://discuss.codelibs.org/c/recotemja/' },
          { text: '商用サポート', link: 'https://codelibs.co/ja/' },
        ],
        sidebar: {
          '/ja/guide/': v2GuideSidebar('ja'),
          '/ja/docs/': v2DocsSidebar('ja'),
        },
      },
    },
  },

  themeConfig: {
    logo: '/recotem-header.png',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/codelibs/recotem' },
    ],
    footer: {
      message: 'Sponsored by <a href="https://codelibs.co">Codelibs, inc</a>',
    },
  },
})
