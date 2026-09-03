#!/usr/bin/env node
// Verify every internal #fragment link in the built site resolves to a real
// element id. VitePress does not validate fragments, so a broken anchor still
// builds, still navigates to the page, and silently fails to scroll.
//
// Usage: yarn docs:build && node scripts/check-anchors.mjs

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.vitepress/dist'
)

const files = globSync('**/*.html', { cwd: DIST })
if (files.length === 0) {
  console.error(`no HTML found in ${DIST} — run \`yarn docs:build\` first`)
  process.exit(2)
}

// id="..." / id='...' on any element.
const ID_RE = /\sid=(?:"([^"]*)"|'([^']*)')/g
// href="..." on anchors.
const HREF_RE = /<a\b[^>]*?\shref=(?:"([^"]*)"|'([^']*)')/gi

const idsByFile = new Map()
const htmlByFile = new Map()

for (const rel of files) {
  const html = readFileSync(path.join(DIST, rel), 'utf8')
  htmlByFile.set(rel, html)
  const ids = new Set()
  for (const m of html.matchAll(ID_RE)) ids.add(m[1] ?? m[2])
  idsByFile.set(rel, ids)
}

function decode(frag) {
  try {
    return decodeURIComponent(frag)
  } catch {
    return frag
  }
}

const broken = []
let checked = 0

for (const rel of files) {
  const html = htmlByFile.get(rel)
  for (const m of html.matchAll(HREF_RE)) {
    const href = m[1] ?? m[2]
    if (!href || !href.includes('#')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue // absolute scheme
    if (href.startsWith('//')) continue

    const hashAt = href.indexOf('#')
    const target = href.slice(0, hashAt)
    const frag = decode(href.slice(hashAt + 1))
    if (!frag) continue

    let targetFile
    if (target === '') {
      targetFile = rel
    } else {
      const abs = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(rel), target))
      targetFile = abs.endsWith('/') ? abs + 'index.html' : abs
    }

    const ids = idsByFile.get(targetFile)
    if (!ids) {
      broken.push({ rel, href, frag, targetFile, why: 'target page not found' })
      continue
    }
    checked++
    if (ids.has(frag)) continue

    // Distinguish the Unicode-composition failure mode from a plain typo.
    const nfcHit = [...ids].some(
      (id) => id.normalize('NFC') === frag.normalize('NFC')
    )
    broken.push({
      rel,
      href,
      frag,
      targetFile,
      why: nfcHit ? 'unicode composition mismatch' : 'no such id',
    })
  }
}

console.log(`pages: ${files.length}   internal fragment links checked: ${checked}`)

if (broken.length === 0) {
  console.log('all anchors resolve')
  process.exit(0)
}

const groups = new Map()
for (const b of broken) {
  if (!groups.has(b.why)) groups.set(b.why, [])
  groups.get(b.why).push(b)
}
for (const [why, list] of groups) {
  console.log(`\n=== ${why} (${list.length}) ===`)
  for (const b of list) console.log(`  ${b.rel}\n    -> ${b.href}`)
}
console.log(`\n${broken.length} broken anchor link(s)`)
process.exit(1)
