#!/usr/bin/env node
// Renames the unpackaged dev Electron.app bundle so the macOS dock tooltip and
// menu read "Lursor" instead of "Electron".
//
// In dev we launch the generic node_modules Electron binary, whose Info.plist
// carries CFBundleName/CFBundleDisplayName = "Electron". The OS dock tooltip
// reads those keys directly and app.setName() cannot override them at runtime,
// so we patch the plist here. Runs on postinstall, so it re-applies whenever
// electron is (re)installed. Packaged builds get their name from
// electron-builder's productName and never touch this file.

const fs = require("node:fs")
const path = require("node:path")

const PRODUCT_NAME = "Lursor"

// Discover the Electron.app bundle dynamically rather than hardcoding a path.
function findInfoPlist() {
  let electronDist
  try {
    // electron's package entry points into its dist directory.
    electronDist = path.dirname(require.resolve("electron"))
  } catch {
    return null
  }
  const plist = path.join(
    electronDist,
    "dist",
    "Electron.app",
    "Contents",
    "Info.plist"
  )
  return fs.existsSync(plist) ? plist : null
}

function patch() {
  // macOS-only: the dock-tooltip problem this fixes does not exist elsewhere.
  if (process.platform !== "darwin") return

  const plist = findInfoPlist()
  if (!plist) return

  let contents = fs.readFileSync(plist, "utf8")
  const before = contents

  // Replace the string value that follows each targeted key.
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    const re = new RegExp(
      `(<key>${key}</key>\\s*<string>)[^<]*(</string>)`
    )
    contents = contents.replace(re, `$1${PRODUCT_NAME}$2`)
  }

  if (contents !== before) {
    fs.writeFileSync(plist, contents)
    console.log(`[patch-dev-name] set dev Electron app name to "${PRODUCT_NAME}"`)
  }
}

patch()
