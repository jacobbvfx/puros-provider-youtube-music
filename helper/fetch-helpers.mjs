// Installs the pinned, checksum-verified yt-dlp and Deno release binaries into
// helper/dist. Nothing comes from Homebrew, a system Python or PATH: the same
// pins always yield the same bytes. Usage: node fetch-helpers.mjs <dist-dir>
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

export const YTDLP_VERSION = '2026.08.19'
export const DENO_VERSION = '2.9.7'

// SHA-256 values recorded on 2026-09-29 from the GitHub release asset digests;
// yt-dlp_macos also matches the release's SHA2-256SUMS.
const PINS = {
  ytdlp: {
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos`,
    sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
  },
  ytdlpSource: {
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp.tar.gz`,
    sha256: '072aad4f2a7604e92155f61a275a4752dc64046c8f6d90df3710525d94cd37c1',
  },
  ytdlpLicense: {
    url: `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${YTDLP_VERSION}/LICENSE`,
    sha256: '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c',
  },
  ytdlpThirdParty: {
    url: `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${YTDLP_VERSION}/THIRD_PARTY_LICENSES.txt`,
    sha256: '472aefe951c7db35e1657c1d13fd337140511ed6f2b329205105ad441c5a02b7',
  },
  denoLicense: {
    url: `https://raw.githubusercontent.com/denoland/deno/v${DENO_VERSION}/LICENSE.md`,
    sha256: 'f62497fffecc0852960c8d3e6934b9db86d16396e9b604072e923892cae3a588',
  },
  deno: {
    arm64: {
      url: `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-aarch64-apple-darwin.zip`,
      sha256: '5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c',
    },
    x86_64: {
      url: `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-apple-darwin.zip`,
      sha256: '95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a',
    },
  },
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} failed: ${(result.stderr || '').trim().slice(-1000)}`)
  return result.stdout
}

function cacheRoot() {
  return path.join(process.env.PUROS_BUILD_CACHE ? path.resolve(process.env.PUROS_BUILD_CACHE) : path.join(os.homedir(), 'Library', 'Caches', 'puros-build'), 'youtube-music')
}

/** Download once into the build cache; a cached file is reused only while its hash still matches. */
function fetchPinned({ url, sha256: expected }) {
  const target = path.join(cacheRoot(), expected.slice(0, 16), path.basename(new URL(url).pathname))
  if (fs.existsSync(target) && sha256(target) === expected) return target
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const partial = `${target}.${process.pid}.partial`
  console.log(`Downloading ${url}`)
  run('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2', '--output', partial, url])
  const actual = sha256(partial)
  if (actual !== expected) {
    fs.rmSync(partial, { force: true })
    throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`)
  }
  fs.renameSync(partial, target)
  return target
}

function requestedArchitectures() {
  // Same switch as the pinned ffmpeg build, so every packaged binary shares its slices.
  const archs = (process.env.PUROS_FFMPEG_ARCHS ?? 'arm64 x86_64').split(/[\s,]+/).filter(Boolean)
  if (archs.length === 0 || archs.some((arch) => !['arm64', 'x86_64'].includes(arch))) throw new Error(`Unsupported architectures: ${archs.join(' ')}`)
  return [...new Set(archs)].sort()
}

export function installHelpers(distDirectory) {
  if (process.platform !== 'darwin') throw new Error('The YouTube Music helpers are macOS-only')
  fs.mkdirSync(distDirectory, { recursive: true })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ytm-helpers-'))
  try {
    const ytdlp = path.join(distDirectory, 'yt-dlp')
    fs.copyFileSync(fetchPinned(PINS.ytdlp), ytdlp)
    fs.chmodSync(ytdlp, 0o755)

    const slices = requestedArchitectures().map((arch) => {
      const extracted = path.join(work, arch)
      fs.mkdirSync(extracted)
      run('/usr/bin/unzip', ['-q', '-o', fetchPinned(PINS.deno[arch]), 'deno', '-d', extracted])
      return path.join(extracted, 'deno')
    })
    const deno = path.join(distDirectory, 'deno')
    fs.rmSync(deno, { force: true })
    if (slices.length === 1) fs.copyFileSync(slices[0], deno)
    // lipo keeps each slice's own Deno Land code signature.
    else run('/usr/bin/lipo', ['-create', ...slices, '-output', deno])
    fs.chmodSync(deno, 0o755)

    const notices = [
      'Puros YouTube Music provider — bundled third-party programs',
      '',
      `yt-dlp ${YTDLP_VERSION} (helper/dist/yt-dlp): the official PyInstaller "yt-dlp_macos" release, unmodified.`,
      `  ${PINS.ytdlp.url}`,
      `  sha256 ${PINS.ytdlp.sha256}`,
      '  yt-dlp itself is released under the Unlicense (YT-DLP-LICENSE.txt). The PyInstaller-bundled executable',
      '  includes GPLv3+ licensed code, so the executable as a whole is distributed under the GPLv3+; it also',
      '  bundles yt-dlp-ejs (Unlicense, with MIT astring and ISC meriyah). All component notices and license texts:',
      '  YT-DLP-THIRD_PARTY_LICENSES.txt. Complete corresponding source for this release:',
      `  ${PINS.ytdlpSource.url}`,
      `  sha256 ${PINS.ytdlpSource.sha256}`,
      '  Puros runs it as a separate program and does not link to it.',
      '',
      `Deno ${DENO_VERSION} (helper/dist/deno): official release binaries, slices joined with lipo, otherwise unmodified.`,
      `  ${PINS.deno.arm64.url}`,
      `  ${PINS.deno.x86_64.url}`,
      '  MIT License (DENO-LICENSE.md). yt-dlp uses it only to run YouTube player challenges without file or network permissions.',
      '',
      'ffmpeg (helper/dist/ffmpeg): the pinned LGPL-2.1+ build from scripts/build-ffmpeg.mjs;',
      '  see FFMPEG-COPYING.LGPLv2.1 and FFMPEG-BUILD-INFO.json.',
      '',
    ]
    fs.writeFileSync(path.join(distDirectory, 'YTM-HELPER-NOTICES.txt'), notices.join('\n'))
    fs.copyFileSync(fetchPinned(PINS.ytdlpLicense), path.join(distDirectory, 'YT-DLP-LICENSE.txt'))
    fs.copyFileSync(fetchPinned(PINS.ytdlpThirdParty), path.join(distDirectory, 'YT-DLP-THIRD_PARTY_LICENSES.txt'))
    fs.copyFileSync(fetchPinned(PINS.denoLicense), path.join(distDirectory, 'DENO-LICENSE.md'))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const destination = process.argv[2]
  if (!destination) throw new Error('Usage: node fetch-helpers.mjs <dist-dir>')
  installHelpers(path.resolve(destination))
}
