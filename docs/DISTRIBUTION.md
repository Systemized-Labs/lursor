# Distributing Lursor

How a release gets built, signed, published, and delivered. For how the desktop
app is wired internally see [ELECTRON.md](./ELECTRON.md); for the end-user view
see [INSTALL.md](./INSTALL.md).

## Channels

| Channel | Platform | Notes |
| --- | --- | --- |
| `curl … install.sh \| sh` | macOS arm64, Linux x64 | Primary. Verifies a published SHA-256 before installing. |
| Homebrew cask | macOS arm64 | **Not live.** Tap repo doesn't exist and `HOMEBREW_TAP_TOKEN` isn't set, so the bump step is skipped every release. Blocked on signing regardless — see below. |
| Direct download | macOS arm64, Linux x64 | DMG / AppImage / deb straight off the GitHub Release. |
| In-app auto-update | Linux AppImage, signed macOS | `electron-updater` against the same Release. `.deb` is not self-updating. |
| `curl … update.sh \| sh` | macOS arm64, Linux x64 | Version-aware wrapper around install.sh. Also what the app falls back to while macOS builds are unsigned. |

**Platform scope.** macOS is Apple Silicon only and Linux is x64 only. The frozen
backend is an architecture-specific CPython tree, so every extra arch is a full
extra build; Intel macOS was dropped because Apple has ended x86_64, GitHub
retires its last Intel runner in Aug 2027, and Homebrew demotes Intel to tier 3
in Sept 2026. Windows is not built at all yet.

## One-time setup

### 1. Apple signing (required for macOS)

Everything downstream of "the app opens without a fight" depends on this:
macOS 15 removed the Control-click Gatekeeper bypass, Homebrew dropped
`--no-quarantine` in 4.7, and Squirrel.Mac refuses to install an update to an
unsigned app. An unsigned build still *builds* — it just can't be delivered well.

1. Enroll in the Apple Developer Program ($99/yr). Notarization itself is free.
2. Create a **Developer ID Application** certificate (Apple Developer → Certificates),
   install it, then export it from Keychain Access as a `.p12` with a password.
3. Create an **App Store Connect API key** (Users and Access → Integrations) with
   the *Developer* role. Download the `.p8` — it is only offered once — and note
   the Key ID and Issuer ID. This is preferred over an Apple ID + app-specific
   password because it doesn't expire and doesn't involve 2FA in CI.

Then add these repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERT_P12` | `base64 -i DeveloperID.p12 \| pbcopy` |
| `APPLE_CERT_PASSWORD` | the password used when exporting the `.p12` |
| `APPLE_API_KEY_P8` | `base64 -i AuthKey_XXXX.p8 \| pbcopy` |
| `APPLE_API_KEY_ID` | e.g. `T9GPZ92M7K` |
| `APPLE_API_ISSUER` | the issuer UUID from App Store Connect |
| `APPLE_TEAM_ID` | 10-character team ID |

The release workflow imports the cert into a throwaway keychain and exports
`CSC_KEYCHAIN` + `CSC_NAME`, which both electron-builder and our `afterPack` hook
sign out of. With the secrets absent, both signing and notarization are skipped
and the build still produces installable (unsigned) artifacts.

### 2. Homebrew tap (not set up — macOS)

**Do not advertise this channel until all three steps below are done.** As of
now none of them are: `JonathanConn/homebrew-lursor` returns 404, and the repo
has no secrets at all, so the `homebrew` job's bump step is gated off by
`if: env.HOMEBREW_TAP_TOKEN != ''` and **skips on every release while the job
still reports success**. A green `homebrew` job means nothing until step 2 lands.

The official `homebrew/cask` is not an option yet: self-submission needs 90 forks,
90 watchers, or 225 stars, and from 2026-09-01 every cask there must be signed and
notarized. Own tap in the meantime:

1. **Sign and notarize first** (step 1 above). Homebrew dropped
   `--no-quarantine` in 4.7 and macOS 15 removed the Control-click bypass, so a
   cask installing an unsigned app produces a bundle the user cannot open —
   strictly worse than `install.sh`, which clears the quarantine flag itself.
2. Create a **public** repo `JonathanConn/homebrew-lursor` with a `Casks/` directory.
3. Create a fine-grained PAT with `contents: write` on that repo, and add it to
   *this* repo as the secret `HOMEBREW_TAP_TOKEN`.

Each tagged release then renders `packaging/homebrew/lursor.rb.template` and
pushes it to `Casks/lursor.rb`. Never hand-edit the tap copy.

Users would then run:

```bash
brew tap JonathanConn/lursor
brew install --cask lursor
```

Note there is no `--trust` flag: it does not exist in Homebrew 6.0.13
(`brew tap --trust` → `Error: invalid option: --trust`). Verify against the
`brew tap` help of the day before documenting one.

## Cutting a release

```bash
# 1. Bump the version (this is what names every artifact).
#    frontend/package.json -> "version": "0.2.0"
git commit -am "release: v0.2.0"

# 2. Tag and push. The tag drives the whole pipeline.
git tag v0.2.0
git push origin main --tags
```

The `release` workflow then runs `build` per platform:

1. Freezes the backend (`backend/scripts/build_bundle.sh`) — a standalone CPython
   with dependencies installed **from `uv.lock`**, so the bundle matches what was
   tested rather than a fresh resolve.
2. Builds the renderer.
3. On macOS: signs every Mach-O file in the backend bundle (`afterPack` — ~85 of
   them, a minute or so), signs the app, then notarizes and staples the DMG/ZIP.
   Notarizing a ~400 MB image is the slow part; budget several minutes. Apple
   allows 75 notarizations/day.
4. Uploads everything (installers, `latest-*.yml` update feeds, blockmaps) as a
   workflow artifact. **The build jobs never publish** — they only produce files.

Then a single `publish` job assembles the release: it downloads every platform's
artifacts, checks the set against the list of assets a release must contain,
generates one `SHA256SUMS.txt` over all of them, and creates **one** published
release, marked `--latest`. Finally `homebrew` would bump the cask — currently a
no-op, see above.

One writer, running only after every platform succeeded, is what guarantees a
release is either complete or absent. When the build jobs each published for
themselves, v0.1.0 produced *three* duplicate drafts with the assets split
between them — electron-builder creates the release lazily per upload, so
concurrent uploads (even within a single job) each made their own. A build that
fails on one platform would likewise have left a half-populated release that
looked installable. Do not move publishing back into the matrix.

**A tag push ships.** The release is published immediately, with no manual step —
so tag only when you intend to release. The asset check above is the gate, and it
runs on every release rather than relying on someone remembering to look.

This used to be a draft requiring `gh release edit <tag> --draft=false`, and that
step was missed repeatedly: v0.1.1, v0.1.3, and v0.1.4 all sat drafted and
unreleased, v0.1.4 for hours after a fully green build. A draft is invisible to
every delivery path, and each one fails in a way that looks like a different bug:

- `install.sh` — the anonymous `releases/latest` API returns the previous
  version, or 404s if there is no published release at all. Looks like a broken
  installer.
- `update.sh` and `electron-updater` — `releases/latest` skips drafts, so they
  resolve the last *published* version, find it already installed, and report
  "already up to date". A fix can sit undelivered for days while every user is
  told they are current; the sidebar-logo fix in v0.1.1 looked like it had failed
  to install.

If a fix does not appear to land, still check `gh release list` for a stuck draft
first — and check that the newest release is tagged `Latest`. Flipping a release
out of draft does *not* make GitHub re-evaluate which one is latest, so a release
published by hand can be live yet still not served by `releases/latest`. The
workflow now passes `--latest` explicitly for this reason.

`workflow_dispatch` runs the build jobs without publishing — use it to test a
pipeline change without burning a version number. This holds even when you
dispatch against a tag: `publish` and `homebrew` are gated on
`github.event_name == 'push'`, not merely on the ref. They were previously
ref-gated only, so dispatching a tag re-ran publishing and created a second
release for it — the cause of the duplicate v0.1.4 drafts.

Re-running a failed `publish` job is safe: it re-uploads assets with `--clobber`
and publishes the existing release rather than failing on "already exists".

### Verify after publishing

```bash
# macOS: the download should pass Gatekeeper and carry a stapled ticket.
spctl --assess --type execute -vv /Applications/Lursor.app
xcrun stapler validate ~/Downloads/Lursor-0.2.0-mac-arm64.dmg

# The installer path end to end (checksum verification included).
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install.sh | sh

# Auto-update feed exists for both platforms.
gh release view v0.2.0 --json assets --jq '.assets[].name'
#   expect: .dmg, .zip, latest-mac.yml, .AppImage, .deb, latest-linux.yml, SHA256SUMS.txt

# Exactly one release for the tag — more than one means publishing raced again.
gh api repos/JonathanConn/lursor/releases --jq '[.[]|select(.tag_name=="v0.2.0")]|length'
```

## Auto-update mechanics

`frontend/electron/main.cjs` initialises `electron-updater` only once the backend
is healthy, so a slow update check never delays startup. It downloads in the
background and prompts before restarting, because restarting kills any running
agents. Declining defers the install to the next quit.

It self-disables where it cannot work: unpackaged dev runs, and Linux installs
that aren't AppImage (a `.deb` is owned by dpkg — `apt` or a fresh download is the
upgrade path there). The macOS `zip` target must stay in the build config;
Squirrel.Mac needs it to generate `latest-mac.yml`.

### The unsigned-macOS fallback

Squirrel.Mac validates the code signature before swapping the bundle, so an
unsigned build downloads several hundred megabytes and then fails at the last
step — with nothing but a log line to show for it, which is indistinguishable
from "no updates" to the person using it.

So on macOS the app runs `spctl --assess` against its own bundle before choosing
a mechanism: approved → `electron-updater` as above; rejected → `scripts/update.sh`.
The fallback polls the Releases API, offers the update in a dialog, and on accept
writes a launcher into a `mkdtemp` directory, opens it in Terminal (somewhere for
the download to show progress, since the app is about to exit), and quits. The
script waits on the app's pid, hands off to `install.sh` with the version pinned,
and reopens Lursor.

**This is a stopgap.** `spctl` is the same question Squirrel asks, so the
fallback disappears on its own the first time a signed, notarized build ships —
no code change, no flag to remember. Deleting the fallback afterwards is
optional; leaving it costs one `spctl` call per launch and keeps locally built
installs updatable.

`update.sh` is also the manual update path on both platforms — it reads the
installed version (macOS: the bundle's `Info.plist`; Linux: the
`~/.lursor/.install-version` stamp `install.sh` leaves behind, since an AppImage
has no readable version short of unpacking its squashfs), compares against the
latest release, and only then calls `install.sh`.

## Known gaps

- **Apple signing** — no certs, so no repo secrets, so builds ship unsigned.
  `install.sh` clears the quarantine flag to compensate, and in-app updates fall
  back to `scripts/update.sh`. This one blocks Homebrew too.
- **Homebrew** — tap repo and token both missing; see the setup section. Not
  advertised in the README or INSTALL.md until it works.
- **Windows** — no installer, no signing story. The Electron main process already
  branches on `win32` for the interpreter path, so the bundle script is the
  missing piece.
- **Linux arm64** — would need another runner and another frozen interpreter.
- **`.deb` upgrades** — no apt repo, so no in-place upgrade path.
- **Playwright Chromium** — still downloaded lazily (~150 MB) the first time an
  agent uses visual QA. Pre-fetching it in CI would add that much to every
  download.
- **`git` is an external requirement** — the installer warns when it's missing
  rather than bundling it.
