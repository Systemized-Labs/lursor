# Distributing Lursor

How a release gets built, signed, published, and delivered. For how the desktop
app is wired internally see [ELECTRON.md](./ELECTRON.md); for the end-user view
see [INSTALL.md](./INSTALL.md).

## Channels

| Channel | Platform | Notes |
| --- | --- | --- |
| `curl … install.sh \| sh` | macOS arm64, Linux x64 | Primary. Verifies a published SHA-256 before installing. |
| Homebrew cask | macOS arm64 | Own tap (`JonathanConn/homebrew-lursor`), bumped automatically per release. |
| Direct download | macOS arm64, Linux x64 | DMG / AppImage / deb straight off the GitHub Release. |
| In-app auto-update | macOS, Linux AppImage | `electron-updater` against the same Release. `.deb` is not self-updating. |

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

### 2. Homebrew tap (optional, macOS)

The official `homebrew/cask` is not an option yet: self-submission needs 90 forks,
90 watchers, or 225 stars, and from 2026-09-01 every cask there must be signed and
notarized. Own tap in the meantime:

1. Create a **public** repo `JonathanConn/homebrew-lursor` with a `Casks/` directory.
2. Create a fine-grained PAT with `contents: write` on that repo, and add it to
   *this* repo as the secret `HOMEBREW_TAP_TOKEN`.
3. Each tagged release renders `packaging/homebrew/lursor.rb.template` and pushes
   it to `Casks/lursor.rb`. Never hand-edit the tap copy.

Users then run:

```bash
brew tap --trust JonathanConn/lursor     # Homebrew 6.0+ requires trusting third-party taps
brew install --cask lursor
```

## Cutting a release

```bash
# 1. Bump the version (this is what names every artifact).
#    frontend/package.json -> "version": "0.2.0"
git commit -am "release: v0.2.0"

# 2. Tag and push. The tag drives the whole pipeline.
git tag v0.2.0
git push origin main --tags
```

The `release` workflow then, per platform:

1. Freezes the backend (`backend/scripts/build_bundle.sh`) — a standalone CPython
   with dependencies installed **from `uv.lock`**, so the bundle matches what was
   tested rather than a fresh resolve.
2. Builds the renderer.
3. On macOS: signs every Mach-O file in the backend bundle (`afterPack` — ~85 of
   them, a minute or so), signs the app, then notarizes and staples the DMG/ZIP.
   Notarizing a ~400 MB image is the slow part; budget several minutes. Apple
   allows 75 notarizations/day.
4. Uploads artifacts to the Release plus a `SHA256SUMS-<os>-<arch>.txt`.
5. Bumps the Homebrew cask.

`workflow_dispatch` runs the same build without publishing — use it to test a
pipeline change without burning a version number.

### Verify after publishing

```bash
# macOS: the download should pass Gatekeeper and carry a stapled ticket.
spctl --assess --type execute -vv /Applications/Lursor.app
xcrun stapler validate ~/Downloads/Lursor-0.2.0-mac-arm64.dmg

# The installer path end to end (checksum verification included).
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install.sh | sh

# Auto-update feed exists for both platforms.
gh release view v0.2.0 --json assets --jq '.assets[].name'
#   expect: .dmg, .zip, latest-mac.yml, .AppImage, .deb, latest-linux.yml, SHA256SUMS-*
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

## Known gaps

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
