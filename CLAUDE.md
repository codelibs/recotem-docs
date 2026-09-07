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

## Documentation policy

**Documentation is managed as documentation.** Nothing in this repository reads
a `.md` file and asserts on what it says — no claim pins, no product-surface
diff, no prose checks of any kind. When the product changes, fix the page; when
a page is wrong, fix the page. Do not add a script or a CI step that would go
red on a wording change.

The checks that remain are functional: `docs:build` fails on a dead internal
link, and `docs:check-anchors` fails on a `#fragment` that resolves to no
heading id. Both are about whether the site *works*, not about what it says.

`scripts/check-site-claims.mjs` and `scripts/check_product_surface.py` used to
do the prose checking. They were removed, along with `product-surface.yml`,
because every open pull request conflicted in the claims file — each one
appended to the same list — which is the cost this policy exists to avoid. The
same rule holds in the product repo; see its `CLAUDE.md`.

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
| `2.1/` (+ `2.1/ja/…`) | In-development next version preview. At 2.1's release its content is promoted to the root and **the directory stays**, as the permanent archive of 2.1. | No (`noindex`) |
| `1.0/` (+ `1.0/ja/…`) | Archive of a released version | No (`noindex`) |
| `2.0/`, … | Archive of a released version — the permanent target for `https://recotem.org/x.y/docs/…` links baked into that release | No (`noindex`) |

Rules:
- Edit the current stable line at the **unversioned** root (`docs/`, `guide/`, `learn/`). **Keep these URLs stable** — that stability is what SEO relies on.
- Any directory matching `^\d+\.\d+/` (e.g. `1.0/`, `2.0/`, `2.1/`) is automatically `noindex, follow` + self-canonical and excluded from `sitemap.xml` (handled in `transformPageData` / `sitemap.transformItems` — **no per-page frontmatter needed**). Version dirs stay served (the product links to them); they just don't compete in search.
- `learn/` is version-agnostic — keep it **shared/unversioned**; do not copy it into version directories.

### Version lifecycle (at each release, part of `release-recotem`)

A version directory is created **once**, when that version's development starts,
and is **never deleted**. It is the preview while the version is in development
and the archive after it ships; the promote copies its content to the root
rather than moving it.

1. **Promote**: replace the unversioned `docs/ guide/` (+ `ja/…`) content with the
   releasing version's `x.y/` content, rewriting the promoted copy's absolute
   `/x.y/…` links back to the root.
2. **Keep**: leave `x.y/` in place — it is now the permanent archive of that
   release. The only edit it needs is its landing page: the "in-development
   preview" banner in `x.y/index.md` and `x.y/ja/index.md` becomes an archived-
   version notice pointing at the root.
3. **Next**: create a fresh `x.(y+1)/` preview for the following in-development
   version.

**Why `x.y/` is not deleted at promote.** The product bakes versioned
documentation URLs into shipped source — `DataSourceError` messages, the
`recotem schema` JSON Schema, the `/v1/metrics` HELP text, `README.md`. Those
URLs name the version being released, so deleting `x.y/` as part of shipping
`x.y.0` would break them for that version's entire support window — the exact
period during which they are read. The cost is that the current stable's content
is served at two paths; both are `noindex` + self-canonical below the root, so
neither competes in search.

The version switcher lists the unversioned root as the latest version. A version
directory whose content is currently promoted to the root is reachable but is
**not** listed separately; it starts appearing in the switcher at the next
release, when the root moves on.

**Transitional note (2.0).** `2.0/` does not exist: 2.0 shipped before this
model, so its content lives only at the unversioned root. The 2.1.0 release must
therefore *additionally* freeze the outgoing root into `2.0/` — once. From 2.1
onward no freeze step is needed, because every version directory already exists
from its preview phase.

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
