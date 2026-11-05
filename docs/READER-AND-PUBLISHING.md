# Reading, narration and proposal reviews

FreeDocStore publishes public knowledge bases from GitHub. Readers can listen
with an installed device voice; authors can generate an English recording in
the console and propose its publication. Existing custom-domain support remains free.

## Reader controls

The published **Listen** button starts or pauses narration. The adjacent player
button opens speed, voice, progress, previous/next section, stop, highlighting,
follow-scroll and next-page controls. Device-voice playback uses only voices
reported as local by the browser. If none is installed, the control explains
that a local voice is needed; it never silently chooses a remote speech service.

Reader preferences and remembered positions are stored in the site's browser
storage. Resume is invalidated when the source text changes. Browser speech
provides sentence positions and optional word boundaries; it does not provide a
reliable seconds timeline. Recordings provide time seeking. Auto-continuation
follows the same-origin primary knowledge-base navigation, and a browser may
require another press of Listen after navigation.

Current recordings are preferred when present. The player identifies the running
source and offers a switch to the device voice. Code blocks are excluded from
spoken narration. Tables and note bodies are included by the reader's text walker.

## Extension listening

Open **Listen** in the extension panel and choose **Current page**, **Selected
text**, or **Latest answer**. Speed and local voice choices belong to the
extension and are independent of the site's reader preferences. Previous and
Next move by sentence. Changing tabs, navigating, closing the panel or pressing
Stop ends panel playback.

Starting panel playback stops the page player for the targeted tab. Starting the
page player stops panel playback for that tab and window. The page can only send
the playback-start signal; it cannot read extension settings or invoke privileged
editing tools through that channel.

## Generate and publish a recording

1. Open a knowledge base in the console and load its Markdown page.
2. Expand **Page narration** and press **Generate audio**. The first generation
   downloads about 93 MB of model and voice assets plus the browser runtime.
   Generation runs in a worker on the device. Page text is not sent to a speech
   service. Cancel terminates the worker.
3. Listen to the preview or download the WAV. English narration currently uses
   the `af_heart` voice and supports up to 6,000 spoken characters and a 12 MiB
   mono, 24 kHz, 16-bit PCM recording. Split larger pages before generating.
4. Press **Propose audio publication**. The recording and a source-version
   manifest are uploaded to the public repository through a reviewable proposal.
5. Review the recording and merge the proposal. Rebuild the knowledge base with
   the current reader installer to expose the recording.

The worker uses `kokoro-js` 1.2.1 with Transformers.js 3.8.1 and the Apache-2.0
licensed [Kokoro model](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX).
`apps/editor/web/src/audio/model-manifest.json` pins the model revision, byte sizes
and SHA-256 digests of the model, tokenizer and voice. Downloads and cached model
bytes pass integrity checks before use. The ONNX runtime is served from the
console's own origin. Model assets are loaded only after generation is requested;
they are excluded from the app shell's precache. Storage or quota failures can
require another download. Full offline cold-start support is not claimed.

Automated verification includes actual model generation and decoding in Chromium.
Listening quality, performance on physical phones and other browser engines need
separate device validation.

## Publication metadata

The API checks the source blob against the exact parent commit before creating
any recording blobs. If the page changed after generation, reload and regenerate.
The recording is stored at `docs/audio/fds-audio-<20 hex characters>.wav`, named
from its SHA-256 digest. Each source page has one stable manifest at
`docs/<page>.md.audio.json`, containing:

- `version`: `1`
- `sourcePath`: repository path of the Markdown page
- `sourceSha`: Git blob SHA-1 of the exact UTF-8 source bytes, including frontmatter
- `audioFile`: same-origin `/audio/fds-audio-<digest prefix>.wav`
- `audioSha256`: complete recording digest
- `model`, `modelRevision`, `voice` and `generatedAt`

After the site build, run:

```sh
node _freedocstore/templates/read-aloud/install.mjs site
```

Run from the knowledge-base repository root with Markdown under `docs/`.
The installer matches root, nested and index pages to source, computes
`source-sha`, validates the manifest and recording, copies the verified recording,
and adds `audio-file` and `audio-sha` metadata. Changed source, corrupt recordings
and invalid manifests produce a diagnostic and suppress recorded playback. Local
voice listening remains available. The reader also requires the two SHA values
to match before selecting a recording. No section or word timing is fabricated
for generated recordings.

Newly generated console workflows and the reusable deployment workflow install
the reader. Previously generated independent workflows must add that step or be
regenerated. The installer is idempotent and refuses symbolic-link asset outputs.

## Repository checks and printable reviews

In the console, expand **Repository files, proposals and builds** to select a
source page, review open proposals or inspect recent workflow outcomes. Partial
GitHub failures remain visible with permission and rate-limit guidance. Failed
build-list requests are never represented as an empty successful result. Cloudflare
credentials are checked by the deployment workflow; the console does not mark
that connection verified merely because GitHub or AI is available.

After generating an editing proposal, **Print proposal** opens a review document
with its rationale, current source, proposed source and reviewer sign-off fields.
Use **Print / Save as PDF** in that window. Proposal text is inserted as text and
cannot execute scripts. Proposal application checks the reviewed source version
again before writing, and switching files hides proposals for the previous file.

## Validation commands

```sh
npm test
npm --prefix extension run typecheck
npm --prefix extension run build
npm --prefix extension test
npm --prefix extension run deadcode
pnpm --dir apps/editor build
npm --prefix extension exec -- playwright install chromium
npm run test:browser
AUDIO_MODEL_TEST=1 npm --prefix extension run test:browser -- audio-model.spec.mjs
```

The model test is opt-in because it downloads the pinned model and runs real
inference. CI runs deterministic reader, installed-extension and console checks.
