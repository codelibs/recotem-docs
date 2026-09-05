#!/usr/bin/env node
// Pin the site claims that a verification round found had drifted from the
// product, so the same drift cannot come back unnoticed.
//
// `check-anchors.mjs` catches broken links; nothing catches a page that still
// tells you to do the thing the product stopped supporting. Each entry below
// was a real defect: the round that found it added the pin. Keep entries
// narrow -- a fragment of the corrected text, not a whole paragraph -- so an
// unrelated rewording does not fail the build.
//
// Usage: node scripts/check-site-claims.mjs   (source-only; no build needed)

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The trees that track the in-development product. The unversioned tree is
// the *current stable* line (2.0) and is deliberately NOT listed: the split
// health endpoints and the 501 below do not exist in the released 2.0.0.
const NEXT = ['2.1', '2.1/ja']

/** @type {{file: string, must?: string[], mustNot?: string[], why: string}[]} */
const CLAIMS = []

// --- recotem #219: /v1/health/live + /v1/health/ready ----------------------
// A livenessProbe on /v1/health turns one untrained recipe into a
// CrashLoopBackOff that cannot self-heal; a readinessProbe on it takes every
// replica out of the Service at once.
for (const t of NEXT) {
  CLAIMS.push({
    file: `${t}/docs/deployment/kubernetes.md`,
    must: ['path: /v1/health/ready', 'path: /v1/health/live', 'startupProbe:'],
    why: 'k8s example must use the split probe endpoints (recotem #219)',
  })
  CLAIMS.push({
    file: `${t}/docs/serving-api.md`,
    must: ['#### GET /v1/health/live', '#### GET /v1/health/ready'],
    why: 'the two probe endpoints must be documented (recotem #219)',
  })
}

// --- recotem #213: 501 RELATED_NOT_SUPPORTED -------------------------------
// A BPRFM recipe cannot answer the two related verbs.
for (const t of NEXT) {
  CLAIMS.push({
    file: `${t}/docs/serving-api.md`,
    must: ['RELATED_NOT_SUPPORTED', '501'],
    why: 'the related verbs answer 501 on a BPRFM recipe (recotem #213)',
  })
}

// --- recotem #218: cleansing.dedup: none -----------------------------------
// "No deduplication." on its own reads as "repeat rows become weights".
for (const t of NEXT) {
  CLAIMS.push({
    file: `${t}/docs/recipe-reference.md`,
    mustNot: ['| `none` | No deduplication. |', '| `none` | 重複除去なし。 |'],
    why: 'dedup: none must say the matrix stays binary (recotem #218)',
  })
}

let failed = 0
let checked = 0

for (const claim of CLAIMS) {
  const abs = path.join(ROOT, claim.file)
  if (!existsSync(abs)) {
    console.error(`MISSING  ${claim.file}\n    (${claim.why})`)
    failed++
    continue
  }
  const text = readFileSync(abs, 'utf8')
  for (const needle of claim.must ?? []) {
    checked++
    if (!text.includes(needle)) {
      console.error(`ABSENT   ${claim.file}\n    expected: ${needle}\n    (${claim.why})`)
      failed++
    }
  }
  for (const needle of claim.mustNot ?? []) {
    checked++
    if (text.includes(needle)) {
      console.error(`PRESENT  ${claim.file}\n    must not contain: ${needle}\n    (${claim.why})`)
      failed++
    }
  }
}

if (failed) {
  console.error(`\n${failed} claim check(s) failed`)
  process.exit(1)
}
console.log(`site claims checked: ${checked}   all hold`)
