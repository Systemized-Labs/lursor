#!/usr/bin/env bash
# Bump the release version across every file that carries it.
#
# Four files have to agree or the `gate` job in .github/workflows/release.yml
# fails the release before anything builds:
#
#   frontend/package.json    "version": "X.Y.Z"
#   backend/pyproject.toml   version = "X.Y.Z"        (the [project] one)
#   backend/app/__init__.py  __version__ = "X.Y.Z"
#   backend/uv.lock          version = "X.Y.Z"        (under [[package]] lursor-backend)
#
# Editing them by hand is how the drift keeps happening — uv.lock in particular
# has a `version =` line for every one of hundreds of packages, so a careless
# edit hits the wrong one. This script reads all four with the *same* extraction
# the gate uses, writes all four, then re-reads them and refuses to leave the
# tree in a state the gate would reject.
#
# Usage:
#   ./scripts/bump-version.sh patch          0.1.16 -> 0.1.17
#   ./scripts/bump-version.sh minor          0.1.16 -> 0.2.0
#   ./scripts/bump-version.sh major          0.1.16 -> 1.0.0
#   ./scripts/bump-version.sh 0.2.0-rc.1     explicit version
#   ./scripts/bump-version.sh --check        report the four, change nothing
#   ./scripts/bump-version.sh patch --dry-run
#
# Flags:
#   --check      print what each file says and exit non-zero if they disagree
#   --dry-run    show what would change, write nothing
#   --force      bump even if the four currently disagree (repairs drift)
#
# Does not commit, tag, or push. Merging the bump to main is the release
# trigger; see docs/DISTRIBUTION.md.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PKG_FILE="$ROOT_DIR/frontend/package.json"
PYPROJECT_FILE="$ROOT_DIR/backend/pyproject.toml"
INIT_FILE="$ROOT_DIR/backend/app/__init__.py"
LOCK_FILE="$ROOT_DIR/backend/uv.lock"

BUMP=""
DRY_RUN=0
FORCE=0
CHECK_ONLY=0

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *)
      [ -z "$BUMP" ] || die "unexpected extra argument: $1"
      BUMP="$1"
      ;;
  esac
  shift
done

for f in "$PKG_FILE" "$PYPROJECT_FILE" "$INIT_FILE" "$LOCK_FILE"; do
  [ -f "$f" ] || die "missing $f — run this from a full checkout"
done

# --- read ------------------------------------------------------------------
# Deliberately the same extraction as the release gate, so "this script says
# they agree" and "the gate says they agree" cannot diverge.

read_pkg() {
  # No jq dependency: node is already required to build the frontend.
  node -p "require('$PKG_FILE').version" 2>/dev/null || true
}
read_pyproject() {
  sed -n 's/^version = "\(.*\)"/\1/p' "$PYPROJECT_FILE" | head -1
}
read_init() {
  sed -n 's/^__version__ = "\(.*\)"/\1/p' "$INIT_FILE" | head -1
}
read_lock() {
  awk -F'"' '/^name = "lursor-backend"$/{f=1;next} f && /^version = /{print $2; exit}' "$LOCK_FILE"
}

PKG="$(read_pkg)"
PYPROJECT="$(read_pyproject)"
INIT="$(read_init)"
LOCK="$(read_lock)"

report() {
  printf '  %-26s %s\n' "frontend/package.json" "${PKG:-<unreadable>}"
  printf '  %-26s %s\n' "backend/pyproject.toml" "${PYPROJECT:-<unreadable>}"
  printf '  %-26s %s\n' "backend/app/__init__.py" "${INIT:-<unreadable>}"
  printf '  %-26s %s\n' "backend/uv.lock" "${LOCK:-<unreadable>}"
}

DRIFTED=0
[ -n "$PKG" ] && [ -n "$PYPROJECT" ] && [ -n "$INIT" ] && [ -n "$LOCK" ] || DRIFTED=1
[ "$PYPROJECT" = "$PKG" ] && [ "$INIT" = "$PKG" ] && [ "$LOCK" = "$PKG" ] || DRIFTED=1

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Current versions:"
  report
  if [ "$DRIFTED" -eq 1 ]; then
    echo
    echo "error: the four disagree — the release gate would fail." >&2
    echo "Repair with: ./scripts/bump-version.sh <version> --force" >&2
    exit 1
  fi
  echo
  echo "all four agree on $PKG"
  exit 0
fi

[ -n "$BUMP" ] || die "say what to bump: patch | minor | major | <explicit version> (or --check)"

if [ "$DRIFTED" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
  echo "The four version files already disagree:" >&2
  report >&2
  echo >&2
  die "refusing to bump from an inconsistent state. Pass --force with an explicit version to repair, e.g. ./scripts/bump-version.sh $PKG --force"
fi

# --- compute the new version ----------------------------------------------

case "$BUMP" in
  major|minor|patch)
    # Bumping a pre-release ("0.2.0-rc.1") is ambiguous — is patch 0.2.0 or
    # 0.2.1? Make the caller say which rather than guessing.
    case "$PKG" in
      *[!0-9.]*|"") die "current version '$PKG' is not plain X.Y.Z — pass the new version explicitly" ;;
    esac
    OLD_IFS="$IFS"; IFS='.'
    # shellcheck disable=SC2086
    set -- $PKG
    IFS="$OLD_IFS"
    [ $# -eq 3 ] || die "current version '$PKG' is not X.Y.Z — pass the new version explicitly"
    MAJOR="$1"; MINOR="$2"; PATCH="$3"
    case "$BUMP" in
      major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
      minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
      patch) PATCH=$((PATCH + 1)) ;;
    esac
    NEW="$MAJOR.$MINOR.$PATCH"
    ;;
  *)
    NEW="${BUMP#v}"
    # electron-builder, uv and the install.sh asset names all assume semver.
    printf '%s' "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
      || die "'$BUMP' is not a semver version (X.Y.Z or X.Y.Z-pre)"
    ;;
esac

if [ "$NEW" = "$PKG" ] && [ "$DRIFTED" -eq 0 ]; then
  die "already at $NEW — nothing to do"
fi

echo "Current versions:"
report
echo
echo "Bumping to $NEW"
echo

# A tag that already exists means the release for it happened (publish tags
# last, at the end of a successful build), so reusing the number would push a
# commit that `gate` resolves to an existing tag and silently declines to build.
#
# Exempt the case where NEW is the version frontend/package.json already names:
# that is a drift repair, not a bump, and its tag existing is expected — the
# release went out and only the other three files fell behind. Blocking it would
# refuse the repair this script most needs to be able to do.
if [ "$NEW" != "$PKG" ] && git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$ROOT_DIR" rev-parse -q --verify "refs/tags/v$NEW" >/dev/null 2>&1; then
    die "tag v$NEW already exists locally — that version has been released; pick a higher one"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: no files written."
  exit 0
fi

# --- write -----------------------------------------------------------------
# Each rewrite is anchored so it can only hit the intended line: package.json's
# top-level "version" key (not a dependency's), pyproject's first `version =`
# (the [project] one, not a dependency constraint), and the `version =` that
# directly follows `name = "lursor-backend"` in the lock.
#
# All four are rendered to temp files *before* any of them is installed. A
# rewrite that fails half way would otherwise leave the tree in exactly the
# drifted state this script exists to prevent — and --force repairs run from a
# tree that is already drifted, so "it failed, just re-run it" is not a way out.

TMPDIR_BUMP="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUMP"' EXIT

tmp_pkg="$TMPDIR_BUMP/package.json"
node -e '
  const fs = require("fs");
  const file = process.argv[1], next = process.argv[2], out = process.argv[3];
  const src = fs.readFileSync(file, "utf8");
  const re = /^(\s*"version"\s*:\s*")[^"]*(",?[ \t]*)$/m;
  // Test for the line separately from replacing it: a --force repair may be
  // rewriting a file that is already correct, where a compare-before-and-after
  // check would read "unchanged" as "nothing matched" and abort a repair that
  // was fine.
  if (!re.test(src)) { console.error("no top-level \"version\" line matched"); process.exit(1); }
  // Rewrite in place rather than JSON.stringify-ing the whole object: that
  // would reformat the file and lose key order.
  const replaced = src.replace(re, `$1${next}$2`);
  if (JSON.parse(replaced).version !== next) { console.error("post-write parse disagreed"); process.exit(1); }
  fs.writeFileSync(out, replaced);
' "$PKG_FILE" "$NEW" "$tmp_pkg" || die "could not rewrite frontend/package.json"

tmp_py="$TMPDIR_BUMP/pyproject.toml"
awk -v new="$NEW" '
  !done && /^version = "/ { sub(/"[^"]*"$/, "\"" new "\""); done = 1 }
  { print }
  END { if (!done) exit 1 }
' "$PYPROJECT_FILE" > "$tmp_py" || die "no [project] version line in backend/pyproject.toml"

tmp_init="$TMPDIR_BUMP/__init__.py"
awk -v new="$NEW" '
  !done && /^__version__ = "/ { sub(/"[^"]*"$/, "\"" new "\""); done = 1 }
  { print }
  END { if (!done) exit 1 }
' "$INIT_FILE" > "$tmp_init" || die "no __version__ line in backend/app/__init__.py"

tmp_lock="$TMPDIR_BUMP/uv.lock"
awk -v new="$NEW" '
  /^name = "lursor-backend"$/ { inpkg = 1; print; next }
  inpkg && !done && /^version = "/ { sub(/"[^"]*"$/, "\"" new "\""); done = 1; inpkg = 0 }
  { print }
  END { if (!done) exit 1 }
' "$LOCK_FILE" > "$tmp_lock" || die "no lursor-backend version block in backend/uv.lock"

# Copy into the existing file rather than mv-ing over it: mktemp makes 0600
# files, and moving one into place would quietly strip the group/other read bit
# off a tracked source file.
install_file() {
  cat "$2" > "$1" || die "could not write $1"
}

install_file "$PKG_FILE" "$tmp_pkg"
install_file "$PYPROJECT_FILE" "$tmp_py"
install_file "$INIT_FILE" "$tmp_init"
install_file "$LOCK_FILE" "$tmp_lock"

# --- verify ----------------------------------------------------------------
# Re-read from disk. An edit that silently matched nothing, or matched the
# wrong line, has to fail here rather than at the release gate.

PKG="$(read_pkg)"
PYPROJECT="$(read_pyproject)"
INIT="$(read_init)"
LOCK="$(read_lock)"

FAIL=0
for pair in "frontend/package.json:$PKG" "backend/pyproject.toml:$PYPROJECT" "backend/app/__init__.py:$INIT" "backend/uv.lock:$LOCK"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [ "$value" != "$NEW" ]; then
    printf 'error: %s is "%s" after the write, expected "%s"\n' "$name" "$value" "$NEW" >&2
    FAIL=1
  fi
done
[ "$FAIL" -eq 0 ] || die "the bump did not land cleanly — inspect \`git diff\` before doing anything else"

echo "Updated:"
report
echo
echo "all four agree on $NEW"

# One changed line per file. More than that means something matched too widely.
if git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo
  echo "Diff summary:"
  git -C "$ROOT_DIR" diff --stat -- \
    frontend/package.json backend/pyproject.toml backend/app/__init__.py backend/uv.lock \
    | sed 's/^/  /'
fi

cat <<EOF

Next:
  git diff                       # expect exactly one changed line per file
  git commit -am "chore: bump version to $NEW"
  # merging to main is the release trigger; publish creates v$NEW. See docs/DISTRIBUTION.md.
EOF
