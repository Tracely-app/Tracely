#!/usr/bin/env node
/**
 * Publish a built installer to dl.jointracely.com.
 *
 * This replaces electron-builder's own upload step. electron-builder uploads to
 * a handful of providers, and `generic` — the one that needs no credentials on
 * the CLIENT side, and therefore the only one a private repo can use — is
 * download-only. So electron-builder builds with `--publish never` and this
 * script moves the bytes.
 *
 * WHY THE HOST MOVED AT ALL. The repo is private. electron-updater ships inside
 * the app with no credentials and fetched release assets over GitHub's PUBLIC
 * API; the moment the repo went private every installed copy would have stopped
 * updating, silently — electron-updater logs a 404 and carries on, so the first
 * symptom would have been users stuck on an old build with nothing anywhere
 * saying so. There is no token we could ship instead: anything that can read a
 * private repo's releases can read its source.
 *
 * WHAT STILL GOES TO GITHUB. Everything except the bytes users fetch. The tag,
 * the release object, the notes and a copy of the artifacts all still land
 * there — `gh` is authenticated, so private changes nothing about that — and
 * publishing the release is still what triggers mac-installers.yml. GitHub
 * remains the record; dl.jointracely.com is the only thing an installed app
 * talks to.
 *
 * ORDERING IS LOAD-BEARING. The installer is uploaded BEFORE the .yml that
 * names it, because the .yml is the switch: electron-updater polls it, and the
 * instant it advertises a version it tries to download the file beside it. A
 * .yml that lands first opens a window — minutes wide, on a 126MB installer —
 * in which every client in the world sees an update it cannot fetch.
 *
 * Usage:
 *   node scripts/publish-dl.mjs                                  # release/, channel latest
 *   node scripts/publish-dl.mjs --dir release-preview --channel preview
 *   node scripts/publish-dl.mjs --dry-run
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const DL_BASE = 'https://dl.jointracely.com'
const SSH_USER = 'tracelydl'
const SSH_HOST = '45.56.92.67'
const REMOTE_DIR = '/srv/tracely/releases'

// How many builds of each channel survive a prune, per file extension — so
// `latest: 10` keeps the last ten .exe AND the last ten of each .dmg.
//
// Previews are why this exists. There have been 242 of them at 126MB each; kept
// forever they fill the disk inside a year and take the API server down with
// them, since it is the same box. Stable releases are cheap by comparison and
// worth keeping for a rollback.
const KEEP = { latest: 10, preview: 3 }

const die = (msg) => {
  console.error(`\n${msg}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const DRY_RUN = argv.includes('--dry-run')
// --no-feed: upload installers and repoint the stable links, publish no .yml.
//
// This is the Mac path. mac-installers.yml builds two dmgs and no latest.yml —
// electron-builder writes latest-mac.yml there, which is deliberately never
// published (see below) — so the Mac job has bytes to deliver and nothing to
// announce. Without this it would have to invent a feed to satisfy a check that
// exists for Windows.
const NO_FEED = argv.includes('--no-feed')
const CHANNEL = arg('channel', 'latest')
const OUT_DIR = join(ROOT, arg('dir', 'release'))

if (!KEEP[CHANNEL]) die(`Unknown channel "${CHANNEL}" — expected latest or preview.`)
if (!existsSync(OUT_DIR)) die(`No build output at ${OUT_DIR}. Build before publishing.`)

/**
 * The upload key.
 *
 * A dedicated ed25519 key for the `tracelydl` user, which owns nothing but
 * /srv/tracely/releases. It is not root, it cannot read the API server's .env,
 * and it cannot reach the database — so a leaked release key costs us a
 * defaced download page, not the keys to the product. In CI it arrives as the
 * DL_SSH_KEY secret; locally it lives at ~/.ssh/tracely-dl.
 */
const KEY = process.env.TRACELY_DL_KEY || join(homedir(), '.ssh', 'tracely-dl')
if (!existsSync(KEY))
  die(
    `No upload key at ${KEY}.\n\n` +
      `  Set TRACELY_DL_KEY to its path, or put it at ~/.ssh/tracely-dl.\n` +
      `  DEPLOY.md "Release hosting" says where to get one.`
  )

// The host key is pinned rather than trusted on first use. This runs on CI
// runners that have never seen the box before, where StrictHostKeyChecking=no
// would hand the upload to whatever machine answers on that address. The key is
// public information; the point is that it is fixed.
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAt3IHVD/eNc2ev6st1Fg5hPKbw9lIjcWElMd4iha+fj'
const KNOWN_HOSTS = join(OUT_DIR, '.dl-known-hosts')
writeFileSync(KNOWN_HOSTS, `${SSH_HOST} ${HOST_KEY}\n`)

const SSH_ARGS = [
  '-i', KEY,
  '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=30',
  '-o', 'BatchMode=yes'
]
// scp rather than rsync, and not for a subtle reason: rsync does not exist on
// GitHub's Windows runners, which is where every preview is built. Git for
// Windows ships ssh and scp and no rsync, so a publish step built on rsync
// works on a Mac and dies in CI. Nothing here needs delta transfer either — it
// is a handful of files into a flat directory, and -z on an already-compressed
// NSIS installer buys nothing.

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts })
const remote = (script) => sh('ssh', [...SSH_ARGS, `${SSH_USER}@${SSH_HOST}`, script])

/* ------------------------------------------------------------------ *
 * 1. What was built
 * ------------------------------------------------------------------ */

const YML = `${CHANNEL}.yml`
const ymlPath = join(OUT_DIR, YML)
if (!NO_FEED && !existsSync(ymlPath))
  die(
    `${OUT_DIR}/${YML} does not exist.\n\n` +
      `  electron-builder writes it from the \`publish:\` block in\n` +
      `  electron-builder.yml, even under --publish never. If it is missing,\n` +
      `  that block is missing or the channel is wrong — and nothing would have\n` +
      `  told the updater this build exists.`
  )

// latest-mac.yml is deliberately NOT published. Mac auto-update needs a signed
// app and a .zip target and there is neither yet (see the mac: block in
// electron-builder.yml); uploading it would have every installed Mac copy find
// an update it cannot verify or apply. Mac is download-only until signing.
const INSTALLER = /\.(exe|dmg|zip)$/
const files = readdirSync(OUT_DIR)
  .filter((f) => INSTALLER.test(f) || f.endsWith('.blockmap'))
  .map((f) => join(OUT_DIR, f))

if (!files.some((f) => INSTALLER.test(f))) die(`Nothing to publish — no .exe/.dmg/.zip in ${OUT_DIR}.`)

const ymlText = NO_FEED ? '' : readFileSync(ymlPath, 'utf8')
const version = NO_FEED
  ? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  : ymlText.match(/^version:\s*(\S+)/m)?.[1]
if (!version) die(`Could not read a version out of ${YML}.`)
// With no feed there is nothing declaring which files matter, so every
// installer in the directory is the answer.
const named = NO_FEED
  ? files.filter((f) => INSTALLER.test(f)).map((f) => basename(f))
  : [...ymlText.matchAll(/^\s*-?\s*url:\s*(\S+)/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))

// Every file the .yml points at has to be in this upload. A .yml naming a file
// that is not there is the same outage as publishing it too early, except
// permanent — and it is easy to create by pointing --dir at a stale output
// directory from a previous version.
const uploading = new Set(files.map((f) => basename(f)))
const missing = named.filter((n) => !uploading.has(n))
if (missing.length) die(`${YML} names files that are not in ${OUT_DIR}: ${missing.join(', ')}`)

console.log(`\nPublishing v${version} to ${DL_BASE}  (channel: ${CHANNEL})\n`)
for (const f of files) console.log(`  ${basename(f).padEnd(46)} ${(statSync(f).size / 1048576).toFixed(1)}MB`)
console.log(NO_FEED ? '  (no update feed — installers only)\n' : `  ${YML.padEnd(46)} uploaded last\n`)

if (DRY_RUN) {
  console.log('DRY RUN — nothing was uploaded.\n')
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * 2. Installers first, then the .yml
 * ------------------------------------------------------------------ */

console.log('1/4  Uploading installers')
sh('scp', [...SSH_ARGS, ...files, `${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/`], { stdio: 'inherit' })

if (NO_FEED) {
  console.log('\n2/4  No update feed to upload')
} else {
  console.log('\n2/4  Uploading the update feed')
  sh('scp', [...SSH_ARGS, ymlPath, `${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/`])
}

/* ------------------------------------------------------------------ *
 * 3. Stable download links, then prune
 * ------------------------------------------------------------------ */

// Only a real release moves the website's buttons. A preview that repointed
// them would put an unreviewed build behind "Download for Windows".
if (CHANNEL === 'latest') {
  console.log('\n3/4  Repointing the stable download links')
  const links = [
    ['Tracely-Setup.exe', files.find((f) => f.endsWith('.exe'))],
    ['Tracely-arm64.dmg', files.find((f) => f.endsWith('arm64.dmg'))],
    ['Tracely-x64.dmg', files.find((f) => f.endsWith('.dmg') && !f.endsWith('arm64.dmg'))]
  ].filter(([, target]) => target)

  for (const [link, target] of links) {
    // -n so an existing symlink is replaced rather than followed — without it
    // the new link is created INSIDE whatever directory the old one resolves
    // to, and the old one keeps pointing at the previous release forever.
    remote(`ln -sfn ../${basename(target)} ${REMOTE_DIR}/download/${link}`)
    console.log(`     /download/${link}  ->  ${basename(target)}`)
  }
  if (links.length < 3)
    console.log(
      `     (${3 - links.length} link(s) left alone — this build did not produce them.\n` +
        `      Mac installers come from .github/workflows/mac-installers.yml and\n` +
        `      publish themselves minutes after the Windows release.)`
    )
} else {
  console.log('\n3/4  Stable download links left alone (preview channel)')
}

console.log('\n4/4  Pruning old builds')
const SEP = '---'
const listing = remote(
  `cd ${REMOTE_DIR} && ls -1t *.exe *.dmg *.zip 2>/dev/null; echo ${SEP};` +
    ` cat latest.yml preview.yml 2>/dev/null; echo ${SEP};` +
    ` for l in download/*; do [ -L "$l" ] && readlink "$l"; done 2>/dev/null; true`
)
const [newestFirst, feeds, links] = listing.split(SEP).map((s) => s.trim().split('\n').filter(Boolean))

// Anything a live .yml or a live symlink names survives, however old it is — so
// a prune can never delete what users are currently being offered.
const pinned = new Set([
  ...[...feeds.join('\n').matchAll(/^\s*-?\s*url:\s*(\S+)/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, '')),
  ...links.map((l) => basename(l))
])

const seen = {}
const doomed = newestFirst.filter((name) => {
  if (pinned.has(name)) return false
  // "Tracely-Preview-Setup-…" and "…-preview.242…" both mark a preview; stable
  // artifacts contain neither.
  const channel = /preview/i.test(name) ? 'preview' : 'latest'
  const bucket = `${channel}${name.slice(name.lastIndexOf('.'))}`
  seen[bucket] = (seen[bucket] ?? 0) + 1
  return seen[bucket] > KEEP[channel]
})

if (doomed.length) {
  // .blockmap is removed with its installer; it is useless on its own and is
  // never named by a .yml, so it would otherwise accumulate forever.
  remote(`cd ${REMOTE_DIR} && rm -f -- ${doomed.flatMap((d) => [d, `${d}.blockmap`]).join(' ')}`)
  for (const d of doomed) console.log(`     dropped ${d}`)
} else {
  console.log('     nothing old enough to drop')
}
console.log(remote(`df -h ${REMOTE_DIR} | tail -1 | awk '{print "     disk: "$4" free ("$5" used)"}'`).trimEnd())

/* ------------------------------------------------------------------ *
 * 4. Prove it from the outside
 * ------------------------------------------------------------------ */

console.log('\nVerifying over HTTPS')
if (!NO_FEED) {
  const feed = await fetch(`${DL_BASE}/${YML}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) })
  if (!feed.ok) die(`${DL_BASE}/${YML} returned ${feed.status}. The build is up but nobody will be offered it.`)
  const liveVersion = (await feed.text()).match(/^version:\s*(\S+)/m)?.[1]
  if (liveVersion !== version) die(`${YML} is live but says ${liveVersion}, not ${version}.`)
  console.log(`  ${YML.padEnd(46)} ${liveVersion}`)
}

for (const name of named) {
  const head = await fetch(`${DL_BASE}/${name}`, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
  if (!head.ok) die(`${DL_BASE}/${name} returned ${head.status}.`)
  const local = statSync(join(OUT_DIR, name)).size
  const served = Number(head.headers.get('content-length'))
  if (served !== local) die(`${name} is ${served} bytes on the server and ${local} locally — the upload was truncated.`)
  console.log(`  ${name.padEnd(46)} ${(served / 1048576).toFixed(1)}MB`)
}

console.log(
  NO_FEED
    ? `\nPublished. v${version}'s installers are live at ${DL_BASE}; no feed was changed.\n`
    : `\nPublished. ${DL_BASE}/${YML} now offers v${version}.\n`
)
