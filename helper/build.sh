#!/bin/zsh

set -euo pipefail

HELPER_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${HELPER_DIR}/dist"
YTDLP_VERSION="2026.08.19"
DENO_VERSION="2.9.7"

# A missing node would otherwise fall through to whatever PATH offers; the build tool is the only PATH use.
if ! command -v node >/dev/null 2>&1; then
  echo "Missing node (needed only to run the build scripts)." >&2
  exit 1
fi

# Pinned, checksum-verified yt-dlp_macos (bundles yt-dlp-ejs) and Deno release binaries.
node "${HELPER_DIR}/fetch-helpers.mjs" "${DIST_DIR}"

# The pinned, self-contained LGPL ffmpeg used for stream-copy remux and length checks.
node "${PUROS_PROVIDER_CLI:?Run through puros-provider build (or npm run build)}" ffmpeg "--install=${DIST_DIR}" >/dev/null

# Self-checks in the same clean environment the host gives helpers.
CHECK_HOME="$(mktemp -d "${TMPDIR:-/tmp}/puros-ytm-check.XXXXXX")"
trap 'rm -rf "${CHECK_HOME}"' EXIT
run_clean() { env -i HOME="${CHECK_HOME}" TMPDIR="${CHECK_HOME}" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 "$@"; }

if [[ "$(run_clean "${DIST_DIR}/yt-dlp" --ignore-config --version)" != "${YTDLP_VERSION}" ]]; then
  echo "Bundled yt-dlp is not ${YTDLP_VERSION}" >&2
  exit 1
fi
if ! run_clean "${DIST_DIR}/deno" --version | grep -q "^deno ${DENO_VERSION} "; then
  echo "Bundled deno is not ${DENO_VERSION}" >&2
  exit 1
fi
# yt-dlp must see its bundled EJS scripts and our Deno, not anything on PATH.
# (`--simulate` without a URL exits non-zero after printing the debug header.)
DEBUG_HEADER="$(run_clean "${DIST_DIR}/yt-dlp" --ignore-config -v --no-js-runtimes --js-runtimes "deno:${DIST_DIR}/deno" --simulate 2>&1 || true)"
if ! grep -q "JS runtimes: deno-${DENO_VERSION}" <<<"${DEBUG_HEADER}"; then
  echo "Bundled yt-dlp does not detect the bundled Deno runtime" >&2
  exit 1
fi
if ! grep -q "yt_dlp_ejs-" <<<"${DEBUG_HEADER}"; then
  echo "Bundled yt-dlp lacks yt-dlp-ejs" >&2
  exit 1
fi
if ! run_clean "${DIST_DIR}/ffmpeg" -version >/dev/null 2>&1; then
  echo "Installed ffmpeg cannot start: ${DIST_DIR}/ffmpeg" >&2
  exit 1
fi
for binary in yt-dlp deno ffmpeg; do
  codesign --verify "${DIST_DIR}/${binary}"
done
