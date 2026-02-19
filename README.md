# Recotem Documentation

Source repository for the [Recotem](https://github.com/codelibs/recotem) documentation site, built with [VitePress](https://vitepress.dev/).

## Live Site

| Version | English | Japanese |
|---------|---------|----------|
| v2 (latest) | https://recotem.org/ | https://recotem.org/ja/ |
| v1 | https://recotem.org/1.0/ | https://recotem.org/1.0/ja/ |

## Project Structure

```
recotem-docs/
├── .vitepress/
│   ├── config.ts          # Site configuration (nav, sidebar, i18n)
│   ├── theme/             # Custom theme (brand colors, styles)
│   └── public/            # Static assets (favicon, logos)
│
├── index.md               # v2 English home
├── guide/                 # v2 English guide
├── docs/                  # v2 English docs
├── ja/                    # v2 Japanese (guide/, docs/)
│
├── 1.0/                   # v1 content
│   ├── index.md           # v1 English home
│   ├── guide/             # v1 English guide
│   ├── docs/              # v1 English docs
│   └── ja/                # v1 Japanese (guide/, docs/)
│
├── package.json
└── yarn.lock
```

All versions and languages are built together as a single VitePress project.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Yarn](https://classic.yarnpkg.com/) v1

## Getting Started

```sh
# Install dependencies
yarn install

# Start local dev server (all versions, hot-reload)
yarn docs:dev
```

The dev server serves all versions at once. Visit:

- `http://localhost:5173/` - v2 English
- `http://localhost:5173/ja/` - v2 Japanese
- `http://localhost:5173/1.0/` - v1 English
- `http://localhost:5173/1.0/ja/` - v1 Japanese

## Build & Preview

```sh
# Production build
yarn docs:build

# Preview the production build locally
yarn docs:preview
```

The build output goes to `.vitepress/dist/`. Deploy the contents of this directory to your web server's root.

## Editing Content

- **v2 pages** are in the root (`guide/`, `docs/`, `ja/`). Edit these for the latest version.
- **v1 pages** are in `1.0/`. These are the archived v1 docs and generally should not change.
- **Configuration** (navigation, sidebar, i18n) is in `.vitepress/config.ts`.
- **Images** used in guide/docs pages are co-located with their markdown files. Shared static assets (favicon, logos) are in `.vitepress/public/`.
