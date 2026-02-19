# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
yarn install        # Install dependencies (Node.js >= 18, Yarn v1 required)
yarn docs:dev       # Start dev server with hot-reload at http://localhost:5173
yarn docs:build     # Production build → .vitepress/dist/
yarn docs:preview   # Preview production build locally
```

## Architecture

This is a **VitePress** documentation site for Recotem, supporting two versions (v1, v2) and two languages (English, Japanese) in a single build.

### Content layout

| Path | Content |
|---|---|
| `index.md`, `guide/`, `docs/` | v2 English |
| `ja/` | v2 Japanese (`guide/`, `docs/`) |
| `1.0/` | v1 English and Japanese (`guide/`, `docs/`, `ja/`) |

v1 content under `1.0/` is archived and should generally not be changed.

### i18n and routing

VitePress locales are configured in `.vitepress/config.ts`:
- `root` locale serves English (v2 at `/`, v1 at `/1.0/`)
- `ja` locale serves Japanese v2 at `/ja/`
- v1 Japanese (`/1.0/ja/`) lives under the root locale, not the `ja` locale — this is intentional

### Navigation and sidebar

All nav items and sidebar entries are defined in `.vitepress/config.ts` using four helper functions (`v1GuideSidebar`, `v1DocsSidebar`, `v2GuideSidebar`, `v2DocsSidebar`). When adding a new page, register it in the appropriate sidebar helper and create the corresponding `.md` file.

### Images

Screenshots and images are co-located with their markdown files. Shared static assets (favicon, logo) go in `.vitepress/public/` (served as `/filename`).

### Theme

`.vitepress/theme/` extends VitePress DefaultTheme with minimal CSS overrides (brand color `#3eaf7c`, nav logo-only display).
