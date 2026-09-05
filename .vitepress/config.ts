import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import type { DefaultTheme, HeadConfig } from 'vitepress'

// ---------------------------------------------------------------------------
// SEO helpers (canonical, hreflang, Open Graph / Twitter, JSON-LD)
// ---------------------------------------------------------------------------

const SITE = 'https://recotem.org'
const SITE_NAME = 'Recotem'
const GITHUB_REPO = 'https://github.com/codelibs/recotem'
const SITE_DESC_EN =
  'Recipe-driven recommender training and serving on irspack. One YAML recipe = one model = one recommendation API — self-hosted, hot-swap, no database.'
const SITE_DESC_JA =
  'irspack ベースのレシピ駆動レコメンダーの学習・配信。1つのYAMLレシピ = 1モデル = 1レコメンドAPI。セルフホストでホットスワップ対応、データベース不要。'
const OG_IMAGE = `${SITE}/og-image.png`

// ---------------------------------------------------------------------------
// Google Tag Manager (production builds only, matching the pre-VitePress
// vuepress-plugin-google-tag-manager behavior)
// ---------------------------------------------------------------------------

const GTM_ID = 'GTM-5QR8QHV'
const IS_PROD = process.env.NODE_ENV === 'production'
const GTM_NOSCRIPT = `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`

// Map a VitePress page relativePath (e.g. "ja/docs/security.md") to its served
// URL, matching the default (cleanUrls: false) scheme so canonical / hreflang /
// og:url all agree with the generated sitemap.
function pathToUrl(rel: string): string {
  let p = '/' + rel.replace(/\.md$/, '')
  p = p.replace(/\/index$/, '/')
  if (!p.endsWith('/')) p += '.html'
  return p
}

// EN counterpart of a /ja/... URL.
function stripJa(url: string): string {
  return url.replace(/^\/ja(\/|$)/, '/')
}

function orgNode() {
  return {
    '@type': 'Organization',
    '@id': `${SITE}/#organization`,
    name: 'CodeLibs, Inc.',
    url: 'https://codelibs.co',
    logo: `${SITE}/recotem-logo.png`,
  }
}

function homeJsonLd(isJa: boolean) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      orgNode(),
      {
        '@type': 'WebSite',
        '@id': `${SITE}/#website`,
        url: SITE,
        name: SITE_NAME,
        inLanguage: isJa ? 'ja-JP' : 'en-US',
        publisher: { '@id': `${SITE}/#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Docker',
        url: SITE,
        downloadUrl: 'https://pypi.org/project/recotem/',
        sameAs: [GITHUB_REPO],
        description: isJa ? SITE_DESC_JA : SITE_DESC_EN,
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        author: { '@id': `${SITE}/#organization` },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    ],
  }
}

function articleJsonLd(o: {
  title: string
  desc: string
  url: string
  isJa: boolean
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: o.title,
    description: o.desc,
    inLanguage: o.isJa ? 'ja-JP' : 'en-US',
    url: o.url,
    image: OG_IMAGE,
    author: orgNode(),
    publisher: orgNode(),
  }
}

// ---------------------------------------------------------------------------
// Version directories
// ---------------------------------------------------------------------------

// `1.0/`, `2.0/`, `2.1/`, … — archives and in-development previews. They stay
// served (the product links to them) but are kept out of every discovery
// surface: `noindex` + self-canonical in `transformPageData`, dropped from
// `sitemap.xml`, and excluded from the local search index. One regex so those
// three cannot drift apart.
const VERSION_DIR_RE = /^\d+\.\d+\//

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

function v2GuideSidebar(lang: 'en' | 'ja', version = ''): DefaultTheme.SidebarItem[] {
  const prefix = `${version}${lang === 'ja' ? '/ja/guide' : '/guide'}`
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
        { text: lang === 'ja' ? 'レシピの基本' : 'Recipe Basics', link: `${prefix}/recipe-basics` },
      ],
    },
    {
      text: advanced,
      collapsed: false,
      items: [
        { text: 'CLI', link: `${prefix}/cli` },
        { text: lang === 'ja' ? '定期実行' : 'Batch & Scheduling', link: `${prefix}/batch` },
      ],
    },
  ]
}

function v2DocsSidebar(lang: 'en' | 'ja', version = ''): DefaultTheme.SidebarItem[] {
  const prefix = `${version}${lang === 'ja' ? '/ja/docs' : '/docs'}`
  const conceptsTitle = lang === 'ja' ? 'コンセプト' : 'Concepts'
  const recipeTitle = lang === 'ja' ? 'レシピ' : 'Recipe'
  const dataSourcesTitle = lang === 'ja' ? 'データソース' : 'Data Sources'
  const deploymentTitle = lang === 'ja' ? 'デプロイ' : 'Deployment'
  const opsTitle = lang === 'ja' ? '運用' : 'Operations'
  return [
    {
      text: conceptsTitle,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? 'アーキテクチャ' : 'Architecture', link: `${prefix}/` },
      ],
    },
    {
      text: recipeTitle,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? 'レシピ リファレンス' : 'Recipe Reference', link: `${prefix}/recipe-reference` },
      ],
    },
    {
      text: dataSourcesTitle,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? '概要' : 'Overview', link: `${prefix}/data-sources/` },
        { text: 'CSV / Parquet', link: `${prefix}/data-sources/csv` },
        { text: 'BigQuery', link: `${prefix}/data-sources/bigquery` },
        { text: 'SQL', link: `${prefix}/data-sources/sql` },
        { text: lang === 'ja' ? 'プラグイン' : 'Plugins', link: `${prefix}/data-sources/plugins` },
      ],
    },
    {
      text: deploymentTitle,
      collapsed: false,
      items: [
        { text: 'Docker', link: `${prefix}/deployment/docker` },
        { text: 'Kubernetes', link: `${prefix}/deployment/kubernetes` },
        { text: lang === 'ja' ? 'cron / systemd' : 'cron / systemd', link: `${prefix}/deployment/cron-systemd` },
      ],
    },
    {
      text: opsTitle,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? '予測API' : 'Serving API', link: `${prefix}/serving-api` },
        { text: lang === 'ja' ? '運用ガイド' : 'Operations', link: `${prefix}/operations` },
        { text: lang === 'ja' ? 'セキュリティ' : 'Security', link: `${prefix}/security` },
        { text: lang === 'ja' ? '環境変数' : 'Environment Variables', link: `${prefix}/environment-variables` },
        { text: lang === 'ja' ? '終了コード' : 'Exit Codes', link: `${prefix}/exit-codes` },
        { text: lang === 'ja' ? 'プラグイン作成' : 'Plugin Authoring', link: `${prefix}/plugin-authoring` },
      ],
    },
  ]
}

function learnSidebar(lang: 'en' | 'ja'): DefaultTheme.SidebarItem[] {
  const prefix = lang === 'ja' ? '/ja/learn' : '/learn'
  const useCases = lang === 'ja' ? 'ユースケース' : 'Use cases'
  const compare = lang === 'ja' ? '比較' : 'Compare'
  const basics = lang === 'ja' ? '基礎知識' : 'Basics'
  const overview = lang === 'ja' ? '概要' : 'Overview'
  return [
    {
      text: basics,
      collapsed: false,
      items: [
        { text: overview, link: `${prefix}/` },
        { text: lang === 'ja' ? 'レコメンドエンジンとは' : 'What Is a Recommendation Engine?', link: `${prefix}/basics/what-is-a-recommendation-engine` },
        { text: lang === 'ja' ? '協調フィルタリングとは' : 'Collaborative Filtering', link: `${prefix}/basics/collaborative-filtering` },
      ],
    },
    {
      text: useCases,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? 'GA4 × BigQuery' : 'GA4 + BigQuery', link: `${prefix}/use-cases/ga4-bigquery` },
        { text: lang === 'ja' ? '購買ログ' : 'Purchase Logs', link: `${prefix}/use-cases/purchase-logs` },
        { text: lang === 'ja' ? 'SQL データベース' : 'SQL Database', link: `${prefix}/use-cases/sql-database` },
        { text: lang === 'ja' ? 'レコメンド API' : 'Recommendation API', link: `${prefix}/use-cases/recommendation-api` },
        { text: lang === 'ja' ? 'EC サイトのレコメンド' : 'E-commerce Recommendations', link: `${prefix}/use-cases/ecommerce` },
      ],
    },
    {
      text: compare,
      collapsed: false,
      items: [
        { text: lang === 'ja' ? '自作・SaaS・OSS 比較' : 'Build vs Buy', link: `${prefix}/compare/build-vs-buy` },
        { text: lang === 'ja' ? 'AWS Personalize の代替' : 'AWS Personalize Alternative', link: `${prefix}/compare/aws-personalize-alternative` },
        { text: lang === 'ja' ? 'Python ライブラリ比較' : 'vs Python Libraries', link: `${prefix}/compare/python-libraries` },
        { text: lang === 'ja' ? 'OSS 比較' : 'Open-Source Compared', link: `${prefix}/compare/open-source` },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Published page inventory (language switcher)
// ---------------------------------------------------------------------------

// The default theme's language flyout assumes the locale is a single prefix at
// the front of the path. Here the language sits *inside* each version directory
// (`2.1/ja/docs/…`), so `.vitepress/theme/langs.ts` derives the counterpart from
// the directory layout instead — and needs to know which pages exist, because a
// few archived 1.0 pages were never translated. The exclusions mirror
// `srcExclude` below plus the directories VitePress never renders as pages, so
// the list only ever names pages the build actually writes.
const NON_PAGE_DIRS = new Set([
  'node_modules',
  'public',
  'scripts',
  'specs',
  'src',
])
const NON_PAGE_FILES = new Set(['CLAUDE.md', 'README.md'])

function collectPageIds(dir: string, prefix = ''): string[] {
  const ids: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const id = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || NON_PAGE_DIRS.has(entry.name)) continue
      ids.push(...collectPageIds(join(dir, entry.name), id))
    } else if (entry.name.endsWith('.md') && !NON_PAGE_FILES.has(id)) {
      ids.push(id)
    }
  }
  return ids
}

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PAGE_IDS = collectPageIds(SRC_ROOT)

interface RecotemThemeConfig extends DefaultTheme.Config {
  /** Every published page id (VitePress `relativePath`). */
  pageIds: string[]
}

// ---------------------------------------------------------------------------
// Heading slugs (Japanese anchors)
// ---------------------------------------------------------------------------

// VitePress' default slugify runs NFKD and then strips only U+0300–U+036F, the
// Latin combining block. NFKD also decomposes Japanese voiced kana — パ becomes
// ハ + U+309A, デ becomes テ + U+3099 — and those marks survive the strip. The
// heading id therefore ends up in decomposed form while `[…](#パスルール)`, and
// every other hand-written anchor, is composed. The two are visually identical
// but unequal, so the link opens the page and never scrolls. VitePress does not
// validate fragments, so nothing fails the build (see scripts/check-anchors.mjs).
//
// Recomposing with NFC after the strip fixes exactly that: canonical
// composition is restored, while NFKD's compatibility folding (full-width → ASCII,
// ｱ → ア) and Latin accent stripping (é → e) are unaffected, since NFC does not
// reverse compatibility mappings and the accents are already gone by then.
//
// Copied from vitepress 1.6.4 (dist/node/chunk-*.js, `slugify`), which inlines
// @mdit-vue/shared — that package is bundled rather than a resolvable dependency,
// so it cannot be imported and wrapped.
const rControl = /[\u0000-\u001f]/g
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const rCombining = /[\u0300-\u036f]/g

function slugify(str: string): string {
  return str
    .normalize('NFKD')
    .replace(rCombining, '')
    .replace(rControl, '')
    .replace(rSpecial, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
    .normalize('NFC')
}

// ---------------------------------------------------------------------------
// Main config
// ---------------------------------------------------------------------------

export default defineConfig({
  title: 'Recotem',

  markdown: {
    // Heading ids. The default theme's outline reads ids back off the DOM, so
    // this is the only place the slug is minted.
    anchor: { slugify },
  },

  // Ignore localhost links (used in installation docs) and
  // allow the build to proceed with relative-path warnings
  ignoreDeadLinks: [
    /^https?:\/\/localhost/,
  ],

  head: [
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['link', { rel: 'icon', href: '/favicon.png' }],
    ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    ...(IS_PROD
      ? ([
          [
            'script',
            {},
            `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');`,
          ],
        ] as HeadConfig[])
      : []),
  ],

  sitemap: {
    hostname: 'https://recotem.org',
    // Keep version-pinned directories (1.0/, 2.0/, 2.1/, …) and internal root
    // docs out of the sitemap. Those versions are noindexed (see
    // transformPageData) but still served; the current stable is the
    // unversioned root tree. CLAUDE.md / README.md must not be indexed.
    transformItems: (items) =>
      items.filter((i) => {
        const u = i.url.replace(/^\//, '')
        return (
          !VERSION_DIR_RE.test(u) && u !== 'CLAUDE.html' && u !== 'README.html'
        )
      }),
  },

  // Inject the GTM <noscript> fallback immediately after <body>, as recommended
  // by Google (production builds only).
  transformHtml(code) {
    if (!IS_PROD) return
    return code.replace('<body>', `<body>${GTM_NOSCRIPT}`)
  },

  // Design/spec docs and asset scripts live in the repo but must not be
  // published as site pages.
  srcExclude: ['specs/**', 'scripts/**', 'src/**', 'CLAUDE.md', 'README.md'],

  // Per-page SEO: canonical + EN/JA hreflang alternates + Open Graph /
  // Twitter cards + JSON-LD, generated for every page from its relativePath.
  transformPageData(pageData) {
    const rel = pageData.relativePath
    const url = pathToUrl(rel)
    const head = (pageData.frontmatter.head ??= [])

    // Version-pinned directories (1.0/, 2.0/, 2.1/, …): kept accessible (the
    // product links to them; the current stable lives unversioned at the root)
    // but removed from search via noindex; self-canonical, no bilingual pairing.
    if (VERSION_DIR_RE.test(rel)) {
      head.push(['meta', { name: 'robots', content: 'noindex, follow' }])
      head.push(['link', { rel: 'canonical', href: SITE + url }])
      return
    }

    const isJa = rel.startsWith('ja/')
    const isHome = rel === 'index.md' || rel === 'ja/index.md'
    const enUrl = isJa ? stripJa(url) : url
    const jaUrl = isJa ? url : '/ja' + url
    const desc =
      (pageData.frontmatter.description as string) ||
      (isJa ? SITE_DESC_JA : SITE_DESC_EN)
    const title = pageData.title ? `${pageData.title} | ${SITE_NAME}` : SITE_NAME

    head.push(
      ['link', { rel: 'canonical', href: SITE + url }],
      ['link', { rel: 'alternate', hreflang: 'en', href: SITE + enUrl }],
      ['link', { rel: 'alternate', hreflang: 'ja', href: SITE + jaUrl }],
      ['link', { rel: 'alternate', hreflang: 'x-default', href: SITE + enUrl }],
      ['meta', { property: 'og:site_name', content: SITE_NAME }],
      ['meta', { property: 'og:type', content: isHome ? 'website' : 'article' }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: desc }],
      ['meta', { property: 'og:url', content: SITE + url }],
      ['meta', { property: 'og:image', content: OG_IMAGE }],
      ['meta', { property: 'og:locale', content: isJa ? 'ja_JP' : 'en_US' }],
      ['meta', { property: 'og:locale:alternate', content: isJa ? 'en_US' : 'ja_JP' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: desc }],
      ['meta', { name: 'twitter:image', content: OG_IMAGE }],
      [
        'script',
        { type: 'application/ld+json' },
        JSON.stringify(
          isHome
            ? homeJsonLd(isJa)
            : articleJsonLd({
                title: pageData.title || SITE_NAME,
                desc,
                url: SITE + url,
                isJa,
              }),
        ),
      ],
    )
  },

  // i18n – v2 pages only; v1 lives under root locale at /1.0/
  locales: {
    root: {
      lang: 'en-US',
      label: 'English',
      description: SITE_DESC_EN,
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/' },
          { text: 'Docs', link: '/docs/' },
          { text: 'Learn', link: '/learn/' },
          { text: 'Forum', link: 'https://discuss.codelibs.org/c/recotemen/' },
          { text: 'Commercial Support', link: 'https://codelibs.co/' },
        ],
        sidebar: {
          // v2 EN
          '/guide/': v2GuideSidebar('en'),
          '/docs/': v2DocsSidebar('en'),
          '/learn/': learnSidebar('en'),
          // v1 EN
          '/1.0/guide/': v1GuideSidebar('en'),
          '/1.0/docs/': v1DocsSidebar('en'),
          // v1 JA (still under root locale)
          '/1.0/ja/guide/': v1GuideSidebar('ja'),
          '/1.0/ja/docs/': v1DocsSidebar('ja'),
          // v2.1 preview (in development) — under root locale like the archives
          '/2.1/guide/': v2GuideSidebar('en', '/2.1'),
          '/2.1/docs/': v2DocsSidebar('en', '/2.1'),
          '/2.1/ja/guide/': v2GuideSidebar('ja', '/2.1'),
          '/2.1/ja/docs/': v2DocsSidebar('ja', '/2.1'),
        },
      },
    },
    ja: {
      lang: 'ja-JP',
      label: '日本語',
      description: SITE_DESC_JA,
      themeConfig: {
        nav: [
          { text: 'ガイド', link: '/ja/guide/' },
          { text: 'ドキュメント', link: '/ja/docs/' },
          { text: '学習', link: '/ja/learn/' },
          { text: 'フォーラム', link: 'https://discuss.codelibs.org/c/recotemja/' },
          { text: '商用サポート', link: 'https://codelibs.co/ja/' },
        ],
        sidebar: {
          '/ja/guide/': v2GuideSidebar('ja'),
          '/ja/docs/': v2DocsSidebar('ja'),
          '/ja/learn/': learnSidebar('ja'),
          // v2.1 preview ja pages resolve to the ja locale, so register their
          // version-scoped sidebars here too.
          '/2.1/ja/guide/': v2GuideSidebar('ja', '/2.1'),
          '/2.1/ja/docs/': v2DocsSidebar('ja', '/2.1'),
        },
      },
    },
  },

  // Swap the default theme's language-switcher composable for the layout-aware
  // one. Both translation components and the nav overflow menu import it, so
  // aliasing the module fixes all three call sites at once. See
  // .vitepress/theme/langs.ts for why `locales` cannot express this layout.
  vite: {
    resolve: {
      alias: [
        {
          find: /^.*\/composables\/langs$/,
          replacement: fileURLToPath(
            new URL('./theme/langs.ts', import.meta.url),
          ),
        },
      ],
    },
  },

  themeConfig: {
    logo: '/recotem-header.png',
    pageIds: PAGE_IDS,
    search: {
      provider: 'local',
      options: {
        // Index only the current stable tree. Version directories (1.0/, 2.1/,
        // …) are excluded here for the same reason `transformPageData` gives
        // them `noindex` and `sitemap.transformItems` drops them: they are
        // archives and previews, not the canonical docs, and mixing three
        // copies of "Recipe Reference" into one result list makes the search
        // worse than no search. Returning '' from `_render` keeps a page out
        // of the index. Uses the same `/^\d+\.\d+\//` shape as those two rules
        // so the three cannot drift apart.
        _render(src, env, md) {
          if (VERSION_DIR_RE.test(env.relativePath ?? '')) return ''
          return md.render(src, env)
        },
        detailedView: true,
        miniSearch: {
          options: {
            // MiniSearch's default tokenizer splits on whitespace and
            // punctuation, which returns exactly one token for a Japanese
            // sentence — so the JA half of the site would be unsearchable.
            // Emit character bigrams for CJK runs, and split
            // `RECOTEM_SIGNING_KEYS` / `item-metadata` / `split.scheme` into
            // their parts as well as keeping the whole name, so both the full
            // identifier and any component of it find the page.
            //
            // Must stay a self-contained expression: VitePress serialises
            // these functions into the client bundle (`_vp-fn_`) and rebuilds
            // them with `new Function`, so it cannot close over anything
            // defined outside.
            tokenize: (text: string): string[] => {
              const CJK =
                /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/
              const out: string[] = []
              for (const chunk of text.split(/[^\p{L}\p{N}_.-]+/u)) {
                if (!chunk) continue
                out.push(chunk)
                if (/[_.-]/.test(chunk)) {
                  for (const part of chunk.split(/[_.-]+/)) {
                    if (part) out.push(part)
                  }
                }
                if (CJK.test(chunk)) {
                  for (let i = 0; i < chunk.length - 1; i++) {
                    out.push(chunk.slice(i, i + 2))
                  }
                }
              }
              return out
            },
          },
          searchOptions: {
            fuzzy: 0.2,
            prefix: true,
            boost: { title: 4, text: 2, titles: 1 },
          },
        },
        locales: {
          ja: {
            translations: {
              button: {
                buttonText: '検索',
                buttonAriaLabel: 'ドキュメントを検索',
              },
              modal: {
                displayDetails: '詳細を表示',
                resetButtonTitle: '検索をリセット',
                backButtonTitle: '閉じる',
                noResultsText: '見つかりませんでした:',
                footer: {
                  selectText: '選択',
                  selectKeyAriaLabel: 'Enter',
                  navigateText: '移動',
                  navigateUpKeyAriaLabel: '上矢印',
                  navigateDownKeyAriaLabel: '下矢印',
                  closeText: '閉じる',
                  closeKeyAriaLabel: 'Esc',
                },
              },
            },
          },
        },
      },
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/codelibs/recotem' },
    ],
    footer: {
      message: 'Sponsored by <a href="https://codelibs.co">Codelibs, inc</a>',
    },
  } as RecotemThemeConfig,
})
