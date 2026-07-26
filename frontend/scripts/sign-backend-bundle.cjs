// electron-builder `afterPack` hook: codesign every Mach-O file inside the
// bundled Python backend.
//
// Why this exists: notarization requires *every* executable and shared library
// inside the .app to carry a valid signature with a secure timestamp, but
// @electron/osx-sign only signs Electron's own binaries plus whatever is listed
// explicitly in `mac.binaries`. Our `extraResources` backend bundle is a full
// standalone CPython tree — the interpreter, libpython, ~100+ extension modules
// (.so) from the stdlib and from wheels. Enumerating those by hand would rot on
// every dependency bump, so we discover them instead.
//
// This runs at `afterPack` (files copied into the .app, before electron-builder
// signs the app itself) because signatures must be applied inside-out: the outer
// signature seals the contents of Resources/, so anything we sign later would
// invalidate it.
//
// No signing identity available (a local `bun run electron:build` with no cert)
// is not an error — we log and skip, producing the same unsigned bundle as before.

const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

/** Where the backend bundle lands inside the .app (see `extraResources`). */
const BUNDLE_SUBPATH = path.join("Contents", "Resources", "backend")

/** codesign accepts many paths per call; batch to keep invocations sane. */
const BATCH_SIZE = 64

/**
 * Resolve the Developer ID identity to sign with.
 *
 * Prefers CSC_NAME (set by CI alongside CSC_KEYCHAIN, and honoured by
 * electron-builder itself so both signing passes agree). Falls back to the first
 * "Developer ID Application" identity visible in the keychain search list, which
 * is what a local build on a developer machine wants.
 *
 * @param {string | undefined} keychain
 * @returns {string | null}
 */
function resolveIdentity(keychain) {
  if (process.env.CSC_NAME) return process.env.CSC_NAME
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return null

  const args = ["find-identity", "-v", "-p", "codesigning"]
  if (keychain) args.push(keychain)

  let out
  try {
    out = execFileSync("security", args, { encoding: "utf8" })
  } catch {
    return null
  }

  // Lines look like: `  1) ABC123… "Developer ID Application: Name (TEAMID)"`
  const match = out
    .split("\n")
    .map((line) => line.match(/"(Developer ID Application: [^"]+)"/))
    .find(Boolean)
  return match ? match[1] : null
}

/**
 * Every Mach-O file under `root`, deepest path first.
 *
 * Extension modules are not marked executable, so the mode bits can't be used as
 * a filter — ask file(1) instead. One `file` invocation per batch of paths keeps
 * this to a couple of processes even for a ~30k-file interpreter tree.
 *
 * @param {string} root
 * @returns {string[]}
 */
function findMachOFiles(root) {
  const all = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      // Symlinks are signed via their target (build_bundle.sh dereferences, so
      // there should be none) and directories recurse.
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) all.push(full)
    }
  }
  walk(root)

  const machO = []
  for (let i = 0; i < all.length; i += BATCH_SIZE) {
    const batch = all.slice(i, i + BATCH_SIZE)
    const out = execFileSync("file", ["--brief", ...batch], { encoding: "utf8" })
    out.split("\n").forEach((line, idx) => {
      if (line.includes("Mach-O") && batch[idx]) machO.push(batch[idx])
    })
  }

  // Deepest first: harmless for flat .so files, correct if a wheel ever ships a
  // nested framework or app bundle of its own.
  return machO.sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length
  )
}

exports.default = async function signBackendBundle(context) {
  if (context.electronPlatformName !== "darwin") return

  const appName = context.packager.appInfo.productFilename
  const bundleDir = path.join(context.appOutDir, `${appName}.app`, BUNDLE_SUBPATH)

  if (!fs.existsSync(bundleDir)) {
    console.log(`[sign-backend] no backend bundle at ${bundleDir} — nothing to sign`)
    return
  }

  const keychain = process.env.CSC_KEYCHAIN
  const identity = resolveIdentity(keychain)
  if (!identity) {
    console.log(
      "[sign-backend] no Developer ID identity found — leaving the backend bundle unsigned"
    )
    return
  }

  const entitlements = path.join(__dirname, "..", "build", "entitlements.mac.plist")
  const files = findMachOFiles(bundleDir)
  console.log(
    `[sign-backend] signing ${files.length} Mach-O files with "${identity}"`
  )

  const baseArgs = [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    "--sign",
    identity,
  ]
  if (keychain) baseArgs.push("--keychain", keychain)

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE)
    execFileSync("codesign", [...baseArgs, ...batch], { stdio: "inherit" })
  }

  // Spot-check the interpreter itself: if this fails, notarization certainly will.
  const python = files.find((f) => /\/bin\/python3?(\.\d+)?$/.test(f))
  if (python) {
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", python], {
      stdio: "inherit",
    })
  }

  console.log("[sign-backend] backend bundle signed")
}
