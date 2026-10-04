# YouTube Music provider for Puros

This repository is the YouTube Music provider plugin for Puros, a macOS music player. It integrates through the public provider API v1 only ([Provider SDK](https://github.com/purosapp/puros-provider-sdk)) and contains no Puros code. Puros keeps the library database, queue, decoding, DSP, output and every view; this provider signs in, maps the catalog, enumerates the library and prepares audio files.

## Install

1. Download `puros-provider-youtube-music-<version>.zip` from [Releases](../../releases).
2. In Puros open **Settings → Accounts → Install provider…** and choose the ZIP.
3. Review the permissions and warnings, then install. Later versions use **Update from file…** on the installed provider.

## Sources used

| Source | Version | Used for |
| --- | --- | --- |
| [SimpMusic](https://github.com/maxrave-dev/SimpMusic) (GPL-3.0) | `244ffc9b9cf76eb7ff5e983d3cddff71de2878bb` (2026-09-26), `core` submodule `0b9ce7b71a8b0e7b5d275351fa1e30611e59683e` | Protocol facts: InnerTube endpoints and bodies, search filter params, library browse IDs, `account/account_menu` check, desktop cookie login (String for requests, Netscape for yt-dlp) |
| [SimpMusic Utils](https://github.com/maxrave-dev/utils) (MIT) | `c6934fccf7f3532fda3e5553748c304870bf71ec` | Exact String and Netscape export formats (`src/background.ts`, `src/popup.ts`) |
| [SimpMusic desktop login guide](https://www.simpmusic.org/blogs/en/how-to-log-in-on-desktop-app) | read 2026-09-29 | User flow: sign in in the browser, export both formats, paste |
| [Music Assistant YouTube Music guide](https://www.music-assistant.io/music-providers/youtube-music/) | read 2026-09-30 | Connect flow: private window, copy the `Cookie` header of a signed-in `/browse` request, close the window; the header is used as-is and never rotated |
| [yt-dlp cookie FAQ](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies) | read 2026-09-30 | Why a session must never be opened in a browser again after the export |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense; release executables GPLv3+) | release `2026.08.19` (source checked at `51bab8a0116f4d8004c315706d809782607d5847`) | Audio download; WEB_REMIX client version/number and the `SAPISID*HASH` scheme; EJS and PO-token behaviour |
| [yt-dlp EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS) | read 2026-09-29 | JavaScript runtime requirements |

No SimpMusic code is copied: the provider is an independent TypeScript implementation of the observed protocol. Response layouts were checked against live, signed-out music.youtube.com responses (trimmed copies are the test fixtures in `src/fixtures/`; they contain no account data or visitor IDs). Signed-in library pages cannot be fetched without an account; their parsers follow the same renderers and are tested with synthetic fixtures of that shape.

## Connecting (the Music Assistant flow)

Google refuses sign-in inside an embedded browser ("This browser or app may not be secure"), even one that presents itself as Chrome, so the provider has no sign-in window. It connects the way Music Assistant does:

1. Open a private (incognito) window, go to music.youtube.com and sign in with your Google account. Puros never sees your password.
2. Open the developer tools, select **Network** and filter for `/browse`.
3. Open **Library → Playlists**. On the `/browse` request that appears, right-click the `Cookie` request header → **Copy value**; in Firefox turn on **Raw** and copy the `Cookie` line (selecting it by hand can copy a value the browser shortened with "…"). It must contain `__Secure-3PAPISID`; without it the request was not signed in.
4. Settings → Accounts → YouTube Music → **Connect with a cookie**: paste it into **Cookie**.
5. Close the private window without signing out, then select **Connect**. Puros sends a real `account/account_menu` request and shows "Connected as" plus the account name. Only then is the session saved, through `host.secrets` (encrypted by the host). A rejected import keeps the previous session.

The pasted header authenticates InnerTube requests unchanged. yt-dlp needs a Netscape cookie file, so the provider writes every cookie of the header into it as a `.youtube.com` cookie (path `/`, secure, 400-day expiry, Chrome's cap): music.youtube.com received each of them, so each is one YouTube accepts. Google, not that date, decides when the session ends.

SimpMusic Utils users can still paste its String export as the cookie and, optionally, its Netscape export into the second field; both must then come from the same session, and the Netscape export becomes yt-dlp's file as before.

Afterwards the library syncs automatically; **Sync library** repeats it. The session is restored after a restart and checked in the background with `account/account_menu`. If YouTube answers a signed request as signed out (or yt-dlp reports the cookies were rotated), the status turns to "Session expired — paste a new cookie" and playback/library stop using it; repeat the steps above. **Disconnect** deletes the secret, the in-memory session and any yt-dlp cookie file.

**Why the session lasts.** Google rotates a signed-in session's cookies while a YouTube tab is open: every YouTube page embeds `accounts.youtube.com/RotateCookiesPage`, which asks for a fresh `__Secure-1PSIDTS`/`__Secure-3PSIDTS` about every ten minutes, and the old values soon stop working. A session that no browser opens again is never rotated, and its cookies keep working until Google ends the session (weeks or months; a password change or "sign out everywhere" ends it at once). So the provider keeps the session frozen, as Music Assistant and yt-dlp do:

- It never calls `RotateCookies` itself. Whether or not the app is running, the stored cookies stay the newest ones Google handed out.
- Cookies YouTube sets anyway are kept: every `Set-Cookie` of a signed InnerTube answer (mostly `*SIDCC`) updates the session in memory at once, and the cookies yt-dlp saves back to its cookie file when it exits are read back before the file is deleted (malformed or cut-off lines are skipped).
- Changes reach `host.secrets` at most every 2 s and on deactivation, through one ordered write queue, so a late write never brings back a session you disconnected. Updates never remove the sign-in cookies (`SAPISID`, `LOGIN_INFO`, `SID`, …); if Google clears them, the next signed-out answer marks the session expired.

The flow has not yet been checked with a real Google account by these tests; how long a session lasts is Google's decision and has to be observed.

**Accounts and channels.** A browser session can hold several Google accounts, each with brand channels. Like SimpMusic, the provider reads music.youtube.com's account switcher (`/getAccountSwitcherEndpoint`) at import, acts as the identity the browser had active, and sends `X-Goog-AuthUser` and, for a channel, `X-Goog-PageId` with every request. Without them YouTube answers for the first account's default identity, whose library can be empty apart from Liked Music. **Switch account or channel** moves to the next identity (verified with `account/account_menu`), and the library syncs for it. The status shows "account/channel N of M". Playback through yt-dlp uses the session's cookies and is not tied to an identity.

Cookies never appear in the UI (the form fields are masked and cleared after submission), in logs, in errors, or in renderer events. yt-dlp receives them as a short-lived Netscape file (`<provider data>/session-tmp/<uuid>.txt`, directory `0700`, file `0600`) that is read back for rotated cookies and deleted when the run ends, fails or is cancelled, on logout, on deactivation, and at the next start if a crash left one behind.

## Catalog, library and home

- Search: songs, albums, artists, featured and community playlists (the filtered shelves SimpMusic uses), with continuation cursors per shelf.
- Albums (`MPREb_…`), artists (`UC…`, including the full discography behind "More"), playlists (`playlistId`, `VL` prefix stripped), tracks (`videoId`), artwork (544 px Google renditions) and artist bios. Links point to music.youtube.com.
- Home: FEmusic_home shelves and their continuations; playlists and mixes open as collections (radio mixes via the watch queue).
- Library (`host-mirror`): library songs, albums and artists, every library playlist plus Liked Music, all pages of each. Any failed page fails the whole sync, so a partial snapshot is never reported complete.
- Tracks keep YouTube's IDs exactly; album pages supply YouTube's own track index. No ISRC, UPC, disc number or duration is invented; unknown values stay empty.

## Playback

1. yt-dlp (bundled `yt-dlp_macos`, with yt-dlp-ejs, and the bundled Deno as its JavaScript runtime) downloads the best audio-only stream for that exact `videoId` with the session's cookies. The format is chosen by yt-dlp's own ranking among the formats YouTube actually offered: `bestaudio` restricted to Opus or AAC over HTTPS, preferring non-DRC variants. No itag, bitrate or Premium tier is assumed. With a Premium account yt-dlp's default clients can reach the 256 kb/s streams; without one, the usual ~128–160 kb/s streams.
2. PO tokens: with a signed-in session yt-dlp's default clients (`web_embedded`, `tv_downgraded`, `web`, plus `web_music` for music URLs) include clients that need no PO token; `web`/`web_music` formats that would need one are skipped by yt-dlp. No PO-token provider plugin is bundled.
3. **Opus plays while it downloads** (`playback.progressive`). yt-dlp writes the WebM in order (`--no-part`); the provider follows it and remuxes it on the fly into an Ogg Opus file in the cache (`src/webmOgg.ts`): every Opus packet is copied unchanged, the OpusHead comes verbatim from the WebM (pre-skip kept), pages are written whole with their CRC, and the last ~120 ms are held back so the final page can carry the WebM `DiscardPadding` as its end-trim granule. Once 2 s of audio are on disk, core gets the file as `growing` with a session; AudioToolbox reads a truncated Ogg up to its last complete page. Progress is reported in 32 KiB "segments" so core's starvation recovery resumes after a few seconds of new audio. When yt-dlp finishes, the stream is closed, the file is decoded end to end and its length checked, then renamed in place to the cache file (readers keep the inode) and the session completes with the final path. A retried download (for example after the stream URL expired) continues the same Ogg stream, skipping packets already written; a failure or cancellation ends the session and deletes the partial file, and core falls back to downloading first. On live YouTube the growing file reaches the player about a second before the whole 9-minute test track is ready; most of the start-up time is yt-dlp itself (start-up and the player JS challenge).
4. AAC and every prefetch use the finished file: DASH AAC M4A is remuxed by the pinned LGPL ffmpeg with `-c:a copy` into a plain M4A, because AudioToolbox honours AAC's edit list (encoder delay and end trim) only in a non-fragmented file, which exists only after the whole download. When no session is given, Opus is remuxed the same way (WebM → Ogg by ffmpeg, then the `DiscardPadding` end trim carried into the final granule). Nothing is ever re-encoded, resampled, normalized or otherwise processed.
5. The file is decoded end to end by the `probe` helper and its length compared with YouTube's before it is registered with `host.cache` and reported `complete`. Failed, cancelled or mismatched downloads leave nothing behind.
6. When `host.cache.canPlayFormat('OPUS')` is false (a Mac whose AudioToolbox cannot decode Ogg Opus), only AAC streams are requested.

Downloads are single-flight per track, at most two at a time, playback before prefetch, with progress events, cancellation, an idle and a total timeout, and up to three attempts for transient failures.

Formats reported: `OPUS` at 48 kHz (the decoder's rate, whatever the header's input rate says) or `AAC` at the stream's rate; `bitDepth` 0, lossy, never Hi-Res. The player labels them 16-bit (display only, like Spotify's Vorbis); the stored `bitDepth` stays 0 so output negotiation never treats the decode as 16-bit PCM. Core shows the real codec, bitrate and rate, and in exclusive mode opens the device at that rate (`NATIVE_RATE`, not `BIT_PERFECT`). Player settings → "Never resample in exclusive mode" turns a missing device rate into an error instead of a resampled path.

## Build and test

Requirements:

- macOS with the Xcode command line tools
- Node.js 22.12 or newer
- cmake (`brew install cmake`), used once to build the pinned ffmpeg

```sh
npm install
npm run typecheck
npm test                 # offline unit tests
npm run package          # runs helper/build.sh, writes release/puros-provider-youtube-music-<version>.zip
```

`npm run build` runs only the helper build. It downloads the pinned yt-dlp `2026.08.19` `yt-dlp_macos` and Deno `2.9.7` release binaries into the build cache, verifies their SHA-256 values (`helper/fetch-helpers.mjs`), joins the Deno slices with `lipo`, installs the SDK's pinned ffmpeg, writes the license notices, and self-checks the result in the same clean environment helpers get at runtime. The app never uses Homebrew, a system Python, or `PATH` for these tools.

## Releases

GitHub Actions builds every push and pull request on macOS. Every push to `main` publishes a release `v<version>-build.<run>` with the compiled `puros-provider-youtube-music-<version>.zip` and its `.sha256`, so the newest build is always on the [latest release](../../releases/latest). Pushing a tag `v<version>` that matches `version` in `provider.manifest.json` publishes the versioned release `v<version>`. When the repository secret `PUROS_PROVIDER_SIGNING_KEY` holds an Ed25519 publisher key (`npx puros-provider keygen --out=<path outside the repo>`), released packages are signed with it; Puros pins that key on first install.

## Licenses of bundled programs

`helper/dist/YTM-HELPER-NOTICES.txt` summarizes them; the texts are shipped next to it:

- yt-dlp: Unlicense (`YT-DLP-LICENSE.txt`). The PyInstaller executable bundles GPLv3+ code and is distributed as a whole under GPLv3+, with yt-dlp-ejs (Unlicense, MIT astring, ISC meriyah) and other components listed in `YT-DLP-THIRD_PARTY_LICENSES.txt`. The notice points to the exact source tarball and its SHA-256. Puros runs it as a separate program.
- Deno: MIT (`DENO-LICENSE.md`).
- ffmpeg: LGPL-2.1-or-later (`FFMPEG-COPYING.LGPLv2.1`, `FFMPEG-BUILD-INFO.json`).

The provider's own code is MIT licensed ([LICENSE](LICENSE)).

Using YouTube Music this way is subject to YouTube's terms; review them before distributing the provider.
