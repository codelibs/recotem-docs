import { computed } from 'vue'
import { useData } from 'vitepress'

// Replacement for the default theme's `useLangs`, aliased over the built-in in
// .vitepress/config.ts. It feeds the language flyout in the nav bar, the nav
// screen, and the overflow menu.
//
// VitePress builds the flyout's target by swapping one locale prefix at the
// *front* of the page path: from `2.1/docs/security.md` under the root locale
// it emits `/ja/2.1/docs/security.html`. This site nests the language *inside*
// each version directory instead (`2.1/ja/docs/security.md`), so that target
// has never existed — every English page under `1.0/` and `2.1/` pointed 日本語
// at a 404. The reverse direction is wrong rather than dead: `2.1/ja/…` routes
// to the `ja` locale, and stripping `/ja/` off the front of the *relative* path
// lands "English" on the stable Japanese page.
//
// The layout cannot be expressed through `locales`. The built-in derives the
// counterpart from `relativePath.slice(currentLocaleLink.length - 1)`, so
// version directories would need locale entries of their own — and every
// locale whose label differs from the current one is listed, so a `2.1/ja`
// entry adds a duplicate 日本語 row to the stable flyout while a `2.1` entry
// adds a second "English" row to the 2.1 one. Overriding the composable keeps
// the flyout at one row per language.
//
// `currentLang` is left byte-for-byte as upstream computes it: the nav title
// and the 404 page read its `link` as the active locale's root, and that
// meaning is unchanged here. Only `localeLinks` is rebuilt.

const VERSION_DIR = /^(\d+\.\d+)\//

interface PagePath {
  /** Version directory without slashes (`'2.1'`), or `''` for current stable. */
  version: string
  /** Language directory inside the version (`'ja'`), or `''` for English. */
  lang: string
  /** Path below the version + language directories, e.g. `docs/security.md`. */
  inner: string
}

function splitPath(rel: string): PagePath {
  const m = VERSION_DIR.exec(rel)
  const version = m ? m[1] : ''
  const rest = m ? rel.slice(m[0].length) : rel
  const isJa = rest.startsWith('ja/')
  return { version, lang: isJa ? 'ja' : '', inner: isJa ? rest.slice(3) : rest }
}

function joinPath(p: PagePath): string {
  return [p.version, p.lang, p.inner].filter(Boolean).join('/')
}

/** Served URL of a page id, matching VitePress' own (cleanUrls: false) scheme. */
function pageUrl(rel: string, addExt: boolean): string {
  return (
    '/' +
    rel.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, addExt ? '.html' : '')
  )
}

let published: Set<string> | undefined

function isPublished(pageIds: string[] | undefined, id: string): boolean {
  published ??= new Set(pageIds ?? [])
  return published.has(id)
}

/**
 * The other language's copy of *rel*, or the closest page that exists.
 *
 * Four pages in the `1.0/` archive were never translated, so the counterpart is
 * checked against the published inventory (`themeConfig.pageIds`, built in
 * .vitepress/config.ts) and falls back to that version's home in the target
 * language rather than emitting a link to a file the build never wrote.
 */
function counterpartLink(
  targetLang: string,
  rel: string,
  pageIds: string[] | undefined,
  addExt: boolean,
  fallback: string
): string {
  if (!rel) return fallback
  const here = splitPath(rel)
  const there: PagePath = { ...here, lang: targetLang }
  const wanted = joinPath(there)
  if (isPublished(pageIds, wanted)) return pageUrl(wanted, addExt)
  const home = joinPath({ ...there, inner: 'index.md' })
  if (isPublished(pageIds, home)) return pageUrl(home, addExt)
  return fallback
}

export function useLangs({ correspondingLink = false } = {}) {
  const { site, localeIndex, page, theme, hash } = useData()

  const currentLang = computed(() => ({
    label: site.value.locales[localeIndex.value]?.label,
    link:
      site.value.locales[localeIndex.value]?.link ||
      (localeIndex.value === 'root' ? '/' : `/${localeIndex.value}/`)
  }))

  const localeLinks = computed(() =>
    Object.entries(site.value.locales).flatMap(([key, value]) => {
      if (currentLang.value.label === value.label) return []
      const localeRoot = value.link || (key === 'root' ? '/' : `/${key}/`)
      const link =
        theme.value.i18nRouting !== false && correspondingLink
          ? counterpartLink(
              key === 'root' ? '' : key,
              page.value.relativePath,
              (theme.value as { pageIds?: string[] }).pageIds,
              !site.value.cleanUrls,
              localeRoot
            )
          : localeRoot
      return { text: value.label, link: link + hash.value }
    })
  )

  return { localeLinks, currentLang }
}
