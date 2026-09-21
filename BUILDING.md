# Building Tracely installers

`npm run dist:win` and `npm run dist:mac` each produce an installer in
`release/`. Both run `fetch-models` → `electron-vite build` →
`electron-builder`, and `afterPack` gates every build on
`verify-packaged-ml.mjs` (ML closure unpacked, weights + the target platform's
native binary present, this build's server host and no relay host, and — on a
native build — a real offline embedding).

## Native build (the normal case)

On the target OS, just run the script for that OS:

```bash
npm run dist:win     # on Windows  → release/Tracely Setup <ver>.exe   (x64)
npm run dist:mac     # on macOS    → release/Tracely-<ver>-arm64.dmg
```

A native `npm install` only fetches the current platform's optional binaries
(sharp), and `onnxruntime-node` ships every platform's binary in one package —
so nothing foreign is present to leak into the asar, and the guard's offline
embed test runs for real.

## Cross-building both installers from one machine

To build the *other* platform's installer you must (a) provide that platform's
native binaries and (b) remove this platform's, or the guard fails the build —
correctly — on a foreign onnxruntime binding. Local cross-builds stay unsigned
by design: on a machine that *does* have a Developer ID installed,
`CSC_IDENTITY_AUTO_DISCOVERY=false` is what keeps a local build byte-comparable
with CI's. Signed installers come from CI — see "Code signing" below.

**Windows installer from macOS** (x64, matching the released arch):

```bash
npm ci                                                        # pristine, hoisted layout
npm i --no-save --force @img/sharp-win32-x64 @img/sharp-libvips-win32-x64
rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
       node_modules/@img/sharp-darwin-arm64 node_modules/@img/sharp-libvips-darwin-arm64
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --x64
```

**macOS dmg from an Apple-Silicon mac** (arm64):

```bash
npm ci
rm -rf node_modules/onnxruntime-node/bin/napi-v6/win32 \
       node_modules/@img/sharp-win32-x64 node_modules/@img/sharp-libvips-win32-x64
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64
```

The offline embed test is skipped with a loud `SKIP` line when host ≠ target (a
win32 `.node` cannot execute on darwin); exercise it with a native build of the
same commit. Intel-mac (`--mac --x64`) needs the `darwin-x64` onnxruntime and
sharp binaries, which an arm64 machine does not install by default.

## macOS installers are built in CI, not by hand

`.github/workflows/mac-installers.yml` builds both Mac arches and attaches them
to a release. It runs automatically when a release is published, and can be run
manually against an existing tag from the Actions tab.

This exists for two reasons. Intel (`--mac --x64`) cannot be produced on an
Apple-Silicon machine without the darwin-x64 onnxruntime and sharp binaries, so
in practice it was never built and Intel users had no download. And the dmg was
otherwise hand-carried into each release, so it was routinely missing while the
website's Mac button pointed at it.

The job needs the production Supabase values as repository secrets:

    RELEASE_SUPABASE_URL
    RELEASE_SUPABASE_ANON_KEY

There is no fallback to the staging secrets. A build labelled "release" that
quietly pointed at staging is the failure `scripts/env.mjs` already refuses, so
the workflow stops with an explicit error instead. Both dmgs are unsigned until
the signing secrets exist — see the next section.

`RELEASE_API_URL` is optional. Without it the build uses the default server,
`https://api.jointracely.com`, which is production — so unlike the Supabase
pair, a missing value produces the right build. (`RELEASE_RELAY_URL` and
`RELEASE_RELAY_TOKEN` are no longer read; the app talks to the Tracely server,
not the relay.)

## Code signing

The configuration is fully wired and dormant. It switches on when — and only
when — the secrets below exist. There is no code change at that point.

macOS (`mac-installers.yml`):

    MACOS_CERTIFICATE             base64 of the Developer ID Application .p12
    MACOS_CERTIFICATE_PWD         the .p12 export password
    APPLE_ID                      Apple ID used for notarization
    APPLE_APP_SPECIFIC_PASSWORD   appleid.apple.com -> App-Specific Passwords
    APPLE_TEAM_ID                 10-character Team ID

`MACOS_CERTIFICATE` alone produces a signed but un-notarized dmg, which
Gatekeeper still blocks; the workflow prints a `::warning::` in that state. All
five are needed for a download that opens without a dialog.

Windows (`preview.yml`, and the release path once it moves onto a Windows
runner — electron-builder's Azure signing shells out to PowerShell, so a build
cross-compiled from macOS silently does not sign):

    WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD    OV .pfx (fallback route)
    AZURE_TENANT_ID / AZURE_CLIENT_ID /
    AZURE_CLIENT_SECRET                    Azure Artifact Signing (preferred)

The Azure route also needs a `win.azureSignOptions` block, which cannot be
written before the signing account exists.

Produce the certificate base64 as a single line:

    base64 < DeveloperID.p12 | tr -d '\n' | pbcopy

**Never write `CSC_LINK: ${{ secrets.MACOS_CERTIFICATE }}` into a step's `env:`.**
An absent secret becomes the empty string, electron-builder treats that as a
configured certificate path, and the build dies with `<projectDir> not a file` —
before the identity lookup, so `CSC_IDENTITY_AUTO_DISCOVERY=false` does not
protect you. That is why the signing environment is assembled by a guarded step
into `$GITHUB_ENV` instead.

Once signed builds are verified end to end, three things change together:
`forceCodeSigning: true` (so a silently-unsigned regression fails instead of
warning), `zip` alongside `dmg` in `mac.target` (macOS auto-update needs it and
cannot use it before signing), and re-enabling the Windows update signature
check in `src/main/updater.ts`. Note that moving from ad-hoc to a real Developer
ID changes the app's signing identity, which invalidates existing macOS TCC
grants — every current Mac user is re-prompted for Screen Recording and
Accessibility, which Screen Watch depends on.

## Why `electron-builder.yml` has one top-level `files:` and no platform block

A platform-scoped `files:` containing only negations makes electron-builder
reset the base list to `**/*`, silently dropping every top-level exclude —
which shipped the dev docs and `.env` into the asar. The per-platform binary
split is therefore done by the `npm`/`rm` steps above, not by config.
