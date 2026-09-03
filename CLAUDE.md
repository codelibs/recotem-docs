# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
yarn install        # Install dependencies (Node.js >= 18, Yarn v1 required)
yarn docs:dev       # Start dev server with hot-reload at http://localhost:5173
yarn docs:build     # Production build → .vitepress/dist/
yarn docs:preview   # Preview production build locally
yarn docs:check-anchors  # Verify every internal #fragment resolves (run after docs:build)
```

### Heading anchors

VitePress does not validate `#fragment` links: a broken anchor still builds and
still opens the page, it just never scrolls. Run `yarn docs:check-anchors` after
a build when adding or renaming headings.

Heading ids are minted by the `markdown.anchor.slugify` override in
`.vitepress/config.ts`, which is VitePress' own slugify plus a trailing NFC
recomposition — without it, NFKD leaves Japanese voiced kana decomposed (パ as
ハ + U+309A) and every hand-written `#パスルール`-style anchor silently misses.
Keep Markdown sources in NFC; never paste a copied permalink from a site built
before that override.

## Architecture

This is a **VitePress** documentation site for Recotem. It serves the current stable docs plus archived and in-development versions, in English and Japanese, from a single build. Routing, SEO, nav, and sidebars are all configured in `.vitepress/config.ts`.

### Documentation versioning (important)

The site uses an **"unversioned = latest stable"** model. Keep this model when adding or restructuring docs.

| Path | Content | Indexed by search |
|---|---|---|
| `/` | General landing (home) | Yes |
| `docs/`, `guide/`, `learn/` (+ `ja/…`) | **Current stable** — the canonical docs. URLs are **unversioned and stable across releases**. | Yes |
| `2.1/` (+ `2.1/ja/…`) | In-development next version preview | No (`noindex`) |
| `1.0/` (+ `1.0/ja/…`) | Old-version archive | No (`noindex`) |
| `2.0/`, … | Frozen snapshot of a past stable (created at the next release) | No (`noindex`) |

Rules:
- Edit the current stable line at the **unversioned** root (`docs/`, `guide/`, `learn/`). **Keep these URLs stable** — that stability is what SEO relies on.
- Any directory matching `^\d+\.\d+/` (e.g. `1.0/`, `2.0/`, `2.1/`) is automatically `noindex, follow` + self-canonical and excluded from `sitemap.xml` (handled in `transformPageData` / `sitemap.transformItems` — **no per-page frontmatter needed**). Version dirs stay served (the product links to them); they just don't compete in search.
- `learn/` is version-agnostic — keep it **shared/unversioned**; do not copy it into version directories.

### Version lifecycle (at each release, part of `release-recotem`)

1. **Freeze**: copy the current unversioned stable (`docs/ guide/` + `ja/…`) into a new `x.y/` snapshot (e.g. `2.0/`, `2.0/ja/`).
2. **Promote**: replace the unversioned `docs/ guide/` content with the next version's.
3. **Next**: create a fresh `x.y/` preview for the following in-development version.

To seed a new in-dev preview, copy the current stable into `x.y/` and rewrite **absolute internal links** to stay inside it (`](/docs/…)` → `](/x.y/docs/…)`, `](/guide/…)` → `](/x.y/guide/…)`; leave `](/learn/…)` and relative links alone).

### Authoring conventions

- **SEO frontmatter is required** on every content page: a unique `title` and a unique, keyword-aware `description` (title ≤ ~60 chars; description ≤ ~155 chars; in the page's language). `layout: home` pages fall back to site defaults.
- **Internal links**: in the unversioned stable tree use absolute paths (`/docs/…`, `/guide/…`, `/learn/…`). Inside a version directory, links must stay within that version (`/x.y/docs/…`), except `/learn/…` which stays shared.
- **Bilingual**: add the English and Japanese pages together and keep them in sync.

### i18n and routing

- `root` locale serves English; `ja` locale serves Japanese stable at `/ja/`.
- Version directories are **self-contained**: `x.y/` (English) and `x.y/ja/` (Japanese) both live under the version directory (not under `/ja/`).
- **VitePress routes `x.y/ja/…` to the `ja` locale** (`<html lang="ja-JP">`). So a version dir's Japanese sidebar must be registered under **both** the `root` locale (keyed `/x.y/ja/…`) and the `ja` locale, or those pages fall back to the stable sidebar.

### Navigation and sidebar

Nav and sidebars live in `.vitepress/config.ts`. Sidebar helpers (`v1GuideSidebar`, `v1DocsSidebar`, `v2GuideSidebar`, `v2DocsSidebar`, `learnSidebar`) take a language; the v2 helpers also take an optional **version prefix** (e.g. `v2DocsSidebar('en', '/2.1')`). When adding a page, create the `.md` file and register it in the right helper. `.vitepress/theme/VersionSwitcher.vue` lists the selectable versions.

### Not published (excluded from the build)

`srcExclude` drops `specs/**`, `scripts/**`, `src/**` (legacy VuePress source), and `CLAUDE.md` / `README.md`. The obsolete `docs/user/**` (v1-era development docs) is not committed. Do not publish these.

### Images

Screenshots and images are co-located with their markdown files. Shared static assets (favicon, logo) go in `.vitepress/public/` (served as `/filename`).

### Theme

`.vitepress/theme/` extends VitePress DefaultTheme with minimal CSS overrides (brand color `#3eaf7c`, nav logo-only display) plus the `VersionSwitcher` component.
