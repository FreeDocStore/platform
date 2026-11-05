# Published-page reader

The standalone reader is built from `src/page.js` and `src/reader.js`.
Run `npm --prefix extension ci` and `npm run reader:build` from the repository
root. Commit the generated `read-aloud.js`; publishing repositories install it
without a JavaScript build toolchain. CI checks that the bundle matches its source.

`node templates/read-aloud/install.mjs <built-site-directory>` copies the bundle
and adds a deferred same-origin script to HTML articles, including nested Zensical
output. Installation is idempotent; error pages and symbolic links are skipped.
The reusable deploy workflow and newly generated console workflows install it
after the build. Existing independently generated KB workflows require updating.

The bundle supplies the local-voice player, rate/voice selection, progress,
sentence/word highlighting, remembered position and next-page continuation.
It also plays published WAV, MP3 and Opus recordings when their source version
matches. The console generates English WAV narration locally, previews it and
proposes publication through GitHub. The extension can read pages, selected text
and assistant answers, and coordinates playback with the published player.

The player chooses local browser voices and does not call a synthesis service.
Playback requires browser speech support and an installed local voice. Page
preferences stay in the site's browser storage. The installer tests cover output
and repeat installation. Chromium interaction checks exercise reader playback
and the installed extension. See [the reader guide](../../docs/READER-AND-PUBLISHING.md)
for model downloads, recording limits and the publication metadata contract.
