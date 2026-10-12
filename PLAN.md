# Storyboard Viewer — Plan

Open-source (MIT), offline-first, desktop-first PWA for viewing and editing storyboards stored in the `.sbd` format. Agents edit storyboards through a CLI/MCP server; the app refreshes live. Recommended workflow: open the app in Claude Code / Codex desktop's in-app browser beside the agent.

- App name: **Storyboard Viewer** — served locally by `sbd serve` (domain/hosting deferred)
- File format: **SBD** (`.sbd`) — "Storyboard Document"
- Repo: `projects/storyboard-viewer/`, its own git repo, pnpm workspace

## Goals

- Content-agnostic storyboarding: film, short, documentary, animation, motion design / brand videos.
- **Story tab**: shots in order, script lines beside each shot's image, variant carousel per shot.
- **Canvas tab**: arrange image assets in layers (position, scale, rotate, crop, order, opacity, simple filters). No freehand drawing.
- **Assets tab**: library of images, audio, video, fonts with categories (character, location/background, prop, icon/logo, footage, music, SFX, voiceover, typography, custom).
- **Media timing**: attach audio/video to a line, shot, range, or the whole story; one audio file can be split into segments mapped to different lines. Animatic playback.
- **Fountain compatible**: `script.fountain` stays valid Fountain that opens in normal Fountain apps.
- **Agent-interactable**: JSON Schema, CLI, MCP server, live refresh.
- **Friendly for non-technical users**: plain-language README and a copy-paste setup prompt for Claude Code / Codex.
- **Accessible**: semantic HTML, keyboard navigation, stable ids/ARIA labels so computer-use agents can drive it.

## Non-goals (for now)

Mobile/iOS, accounts/sign-in, sync/remote connections, freehand drawing, video editing, collaboration, MCP App (iframe in Claude), public hosting/domain.

## Stack

| Concern          | Choice                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- |
| UI               | Svelte 5 + TypeScript + Vite (no SvelteKit)                                            |
| Offline          | `vite-plugin-pwa` (Workbox)                                                            |
| Canvas           | Konva (MIT); in-house guided tours and tooltips (0.5.0)                                |
| Zip              | `fflate`                                                                               |
| Fountain         | Small in-house line-oriented parser (`packages/format/src/fountain.ts`), decided in M0 |
| Schema           | JSON Schema (source of truth) → TS types                                               |
| CLI / MCP        | Node, `@modelcontextprotocol/sdk`                                                      |
| Styling          | Plain CSS + custom properties; 8 themes in `apps/web/src/themes.css` (0.2.0)           |
| Script editor    | CodeMirror 6 (`@codemirror/state`, `view`, `commands`), lazy chunk (0.2.0)             |
| Lint/format/test | oxlint, Prettier (+ prettier-plugin-svelte), Vitest, svelte-check; Playwright from M1  |
| Hosting          | Local only: `sbd serve` serves the built PWA + project                                 |

## Repo layout

```
storyboard-viewer/
├── SPEC.md                  # the .sbd format spec (versioned)
├── schema/                  # JSON Schemas (manifest, shot, assets, timeline, ids)
├── examples/                # sample projects: film.sbd/, documentary.sbd/, motion.sbd/
├── packages/
│   ├── format/              # types, validation, Fountain parsing, ID re-anchoring, zip pack/unpack
│   └── cli/                 # `sbd` CLI + MCP server + local HTTP/SSE server
└── apps/
    └── web/                 # Svelte PWA (built output bundled into the CLI for `sbd serve`)
```

## The `.sbd` format

Two interchangeable forms:

- **Packed** `story.sbd` — zip. First entry `mimetype` (uncompressed, `application/vnd.sbd+zip`, EPUB-style). Text/JSON deflated; media STOREd so embedded audio/video can be sliced from the Blob and seeked without decompression.
- **Unpacked** `story.sbd/` — the same tree as a folder. What agents and git work on.

```
mimetype             application/vnd.sbd+zip (packed only)
manifest.json        format_version, title, preset, aspect ratio, fps, custom fields & categories
script.fountain      optional; plain Fountain
ids.json             stable shot/line IDs ↔ script positions
shots/<shot-id>.json fields, variants, canvas layers, duration
assets.json          asset registry
timeline.json        media cues
media/               embedded files
```

### Key decisions

- **Shot is the shared unit.** ID, ordered line IDs, fields (camera, movement, transition, on-screen text, notes, custom), variants (each a canvas composition or single image), active variant, duration.
- **Script stays pure Fountain.** Shot boundaries and line IDs live in `ids.json` (each entry stores the line's ordinal, text hash, and text). When `script.fountain` is edited outside the tools, IDs are re-anchored by diffing: exact matches keep their ID, edited lines match by similarity, the rest get new IDs. Edits through CLI/MCP preserve IDs exactly.
- **Script is optional.** Shots can have zero lines (motion design, B-roll) or only V.O. lines (documentary).
- **Assets** have `id, name, category, tags, kind (image|audio|video|font), variants[], meta` and a `src`:
  - `media/foo.webp` — embedded (relative path inside the package)
  - `file:../renders/foo.mp4` — linked local file, relative to the `.sbd` location; served by `sbd serve`
  - `https://…` — remote file or stream (`.m3u8` via hls.js)
  - Optional `mime`, `duration`, `width/height`, `poster`, `sha256`.
- **Timeline cues**: `{id, asset, in, out, target, offset, gain, track}`
  - `in/out` trim the source (so one audio file → many line segments)
  - `target`: `{line}` | `{shot}` | `{range: [fromLine, toLine]}` | `{global: {start}}` (background music)
  - `track`: free label (`dialogue`, `music`, `sfx`, `video`) for mixing/muting.
- **Browser-safe media** documented in SPEC: MP4 (H.264/AAC, faststart), WebM (VP9/AV1 + Opus), MP3/M4A/Opus/WAV, WebP/AVIF/PNG/JPEG. `sbd validate` warns on non-playable codecs.
- **Presets** (Blank, Film/Short, Documentary, Animation, Motion/Brand) only pre-fill categories and fields.
- `format_version` semver; readers must ignore unknown fields.

## Architecture

### Web app (`apps/web`)

- **Open**: drag-drop / file picker for packed `.sbd`; folder picker (File System Access API, Chromium) for unpacked; "connect to local server" for `sbd serve`.
- **Storage**: working copy in OPFS/IndexedDB; save back to the folder handle or export a packed `.sbd`.
- **Live refresh**: SSE from `sbd serve` (primary). Polling a folder handle as fallback. `FileSystemObserver` is not stable — not relied on.
- **Player**: Web Audio for cue mixing; animatic mode highlights the current line and advances shots.

### CLI + MCP (`packages/cli`)

- `sbd new <name> --preset`, `validate`, `pack`, `unpack`, `import-fountain`, `export-fountain`, `serve`, `mcp`.
- `sbd serve ./story.sbd/` — HTTP with range requests for media (including linked `file:` media), SSE change events, and the built PWA itself (one command, one localhost URL).
- **MCP tools** (initial): `open_storyboard`, `get_storyboard`, `list_shots`, `get_shot`, `add_shot`, `update_shot`, `move_shot`, `set_lines`, `add_asset`, `add_variant`, `set_active_variant`, `add_cue`, `update_cue`, `remove_*`, `validate`. All edits are validated against the schema, written to disk, and emitted as change events.

### Deferred: MCP App

An MCP App (`ui://` resource rendered in Claude's iframe) was researched and deferred. The in-app browser in Claude Code / Codex desktop pointed at `sbd serve` covers the side-by-side use case.

## Milestones

Executed sequentially, one sub-agent per milestone (M0 → M4), each verifying its work before handing off.

### M0 — Spikes

- [x] Fountain parser choice; line-ID re-anchoring prototype on edited scripts
- [x] fflate: STORE media + Blob slicing playback in `<video>`/`<audio>`
- [x] Repo scaffold: git init, pnpm workspace, MIT license, lint/test setup

### M1 — Format + read-only viewer + CLI/MCP

- [x] `SPEC.md` v0.1, JSON Schemas, TS types (hand-written, kept in sync by schema tests)
- [x] `packages/format`: load/validate/pack/unpack, Fountain parse, ID re-anchoring, edit ops, animatic timing, tests
- [x] Minimal example project (`examples/minimal.sbd`, generated by `pnpm example`)
- [x] PWA: open packed/unpacked `.sbd`, Story tab (lines + images + variant carousel), Canvas tab (Konva, read-only), Assets tab (filter by kind/category, search), animatic/audio playback, offline install, IndexedDB working copy
- [x] `sbd` CLI: `new`, `validate`, `pack`, `unpack`, `import-fountain`, `export-fountain`, `serve` (serves app + project, Range, SSE live refresh), `mcp`
- [x] MCP server with read + edit tools (incl. script editing and `--serve`)
- [x] Accessibility pass (keyboard nav, labels, focus, stable ids)
- [x] Playwright e2e against `sbd serve` (incl. live refresh after MCP edits and packed-media slicing)

### M2 — Editing

- [x] Story tab editing: lines, shot fields, reorder/split/merge shots, custom fields
- [x] Canvas tab (Konva): place/arrange asset layers, crop, filters, per-variant compositions, flatten to preview image
- [x] Assets tab: import, categorize, tag, replace, link vs embed
- [x] Timeline editor: assign segments of one audio file to lines (waveform + in/out handles)
- [x] Save to folder handle / export packed; undo/redo

### M3 — Polish, interop, docs

- [x] Fountain import/export round-trip tests; Storyboarder import (`sbd import-storyboarder`); `sbd clean`; hls.js for `.m3u8`
- [x] PDF export (print view in the app + `sbd export-pdf`); animatic export (WebCodecs → MP4/WebM, app only)
- [x] Presets polish (+ Short-form vertical 9:16); New storyboard flow in the app
- [x] README: friendly, non-jargony, screenshots (`pnpm screenshots`), what it is, quick start
- [x] Copy-paste setup prompt for Claude Code / Codex (README + docs/SETUP_PROMPT.md): installs, registers the MCP, creates a storyboard, opens the viewer in the in-app browser
- [x] `AGENTS.md`, `docs/agent-skill/SKILL.md`, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG (0.1.0), GitHub issue/PR templates, CI workflow

### M4 — Sample storyboards (multimedia)

- [x] Variety of examples: funny short film, documentary, short-form TikTok, motion design / brand launch, animation (`examples/*.sbd`, listed in `examples/README.md`)
- [x] Images generated with Codex CLI image gen; multiple variants per key shot; layered canvas compositions (motion, animation)
- [x] Dialogue / V.O. audio generated with Kokoro TTS (the Jeopardy `kokoro_mlx` venv), including one long audio file split into line segments, plus synthesized music/SFX cues
- [x] Each sample validated (also packed as `.sbd`, not committed) and used for README screenshots; animatic GIF in the README

## Open questions

- npm package name for the CLI (`sbd` is likely taken → e.g. `@storyboard-viewer/cli` with `sbd` binary).
- Optional inline `[[@shot id]]` Fountain notes for people editing shot breaks by hand (nice-to-have; `ids.json` remains the source of truth).
- Aspect ratio / safe-area guides per project vs per shot.

## Developer notes

```
pnpm install   # pnpm 8.15.6 (packageManager field); Node >= 20.19 (developed on Node 26)
pnpm build     # format + cli via tsc -> dist/, web via vite -> apps/web/dist, copied into packages/cli/web
pnpm test      # Vitest in every package (unit + CLI/HTTP/MCP integration)
pnpm test:e2e  # Playwright (Chromium) against `sbd serve` on a temp copy of examples/minimal.sbd; needs `pnpm build`
pnpm lint      # oxlint + prettier --check + typecheck (tsc / svelte-check / e2e)
pnpm format    # prettier --write
pnpm dev       # Vite dev server for apps/web (SBD_API=http://localhost:4400 pnpm dev proxies /api to a running sbd serve)
pnpm sbd …     # run the built CLI, e.g. `pnpm sbd serve examples/minimal.sbd --open`
pnpm example   # regenerate examples/minimal.sbd (deterministic; needs `pnpm build`, ffmpeg for the video)
pnpm gen:schemas  # re-embed schema/*.schema.json into packages/format/src/schemas.gen.ts
pnpm screenshots  # README images -> docs/images/*.webp (needs pnpm build; -- --story <dir> --shot <id>)
pnpm fixture:storyboarder  # regenerate the Storyboarder test fixture (ffmpeg for the JPEG)
```

- Packages: `@storyboard-viewer/format` (packages/format; browser-safe entry `.` + Node adapter `./node`), `@storyboard-viewer/cli` (packages/cli, bin `sbd`), `@storyboard-viewer/web` (apps/web, private).
- Workspace packages export a `source` condition pointing at `src/*.ts`. Vite, Vitest and the typecheck configs resolve it, so dev/test/lint work without building first; `tsc` builds and Node at runtime use `dist/`.
- New CLI commands (M3): `import-storyboarder`, `export-pdf`, `clean`. Print view URL: `/?print=1&layout=grid|rows&per=3|6|9|12&paper=letter|a4&lines=0&fields=0&notes=0&title=0&chrome=0` (sheets root `.sheets[data-print-ready="true"][data-pages]`).
- The repository is `https://github.com/swaymun/storyboard-viewer`. The setup prompt in `README.md` and `docs/SETUP_PROMPT.md` must stay identical; `packages/cli/test/docs.test.ts` checks this, that it names the repository, and that `docs/GUIDE.md` lists every `sbd` command.
- Not published. From the repo: `pnpm sbd <command>`, or `pnpm --filter @storyboard-viewer/cli link --global` to get `sbd` on PATH. MCP config for an agent: `{"command": "node", "args": ["<repo>/packages/cli/dist/cli.js", "mcp", "<story.sbd>", "--serve"]}`.
- `sbd serve` endpoints: `/api/health`, `/api/project`, `/api/events` (SSE `change` with `origin` = client ID of the app that saved, else null), `/api/files/<path>` and `/api/linked?src=file:…` (HTTP Range; linked files only when referenced by assets.json), `/api/download` (packed). Writes (need header `x-sbd-client`, same-origin `Origin`): `PUT /api/project` `{changes: {path: text|null}, base: {path: cyrb53|null}}` → 200 `{project, revision, issues, written}` / 409 `{conflicts}` / 422 `{issues}`; `POST /api/media?name=<file>` (raw body) → `{asset, created}`; `POST /api/link {path}` → `{asset}`; shared recent list (0.4.1): `GET /api/recent`, `DELETE /api/recent[?path=]`, `PUT /api/recent/thumbnail {thumbnail}`, `POST /api/open {path}` → `{url}`. Everything else is the PWA (SPA fallback). Running servers register in `$TMPDIR/storyboard-viewer/` so `get_viewer_url` finds them.
- Web app hooks for agents/tests: URL hash `#tab=story|canvas|timeline|assets&view=script|board&shot=<id>`, `?source=local` (skip auto-connect to sbd serve), `data-shot-id` / `data-line-id` / `data-variant-id` / `data-layer-id` / `data-asset-id` / `data-cue-id` / `data-track`, stable ids (`#save-status`, `#file-menu`, `#undo`, `#redo`, `#add-shot`, `#shot-title-input`, `#asset-file-input`, `#mark-in`, `#mark-out`, `#assign-line`…), `window.__sbd` (`app`, `player`, `sources`; debugging only). Keys: Space play/pause, J/K next/previous shot, 1–4 tabs, Cmd/Ctrl+S save, Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z or Ctrl+Y redo, arrows in tabs and carousels. Story: Enter/double-click edits a line, Delete removes it, Alt+↑/↓ moves the focused shot. Canvas (stage focused): arrows nudge (Shift ×10), `[`/`]` z-order, Delete, Cmd/Ctrl+D duplicate. Timeline: P play segment, I/O mark in/out, A assign to the selected line, Esc clear.
- E2E: `playwright.config.ts` starts three servers: `:4471` (`e2e/.tmp/story.sbd`, viewer tests), `:4472` (`e2e/.tmp/edit.sbd`, `e2e/editing.spec.ts`, reset to the example before each test) and `:4473` (`e2e/static.mjs`: `apps/web/dist` as a plain static site, no API, for `e2e/hosted.spec.ts`).
- Hosted mode: `sbd serve` adds `<meta name="sbd-serve">` to the app's index.html; only with it (or in `vite dev`) does the app call `/api` (`servedBySbd()` in `apps/web/src/lib/sources/server.ts`). The hosted copy is `apps/web/dist` on Cloudflare Workers static assets (`wrangler.jsonc`, `pnpm deploy:web`). Bundled examples for "Try an example": `apps/web/public/examples/*.sbd`, packed from the committed `examples/` by `pnpm examples:web` (list in `apps/web/src/lib/examples.ts`), cached by the service worker once opened.
- M0 browser spike page is still served by `pnpm dev` at `/spikes/media-slice.html`; the same check now runs as a Playwright test.

## Decisions log

### M0 (2026-10-06)

- **Fountain: in-house parser, not `fountain-js`.** `fountain-js` 1.2.4 (last release Nov 2023) splits the script on blank lines, strips boneyard with a regex _before_ lexing (shifting positions), keeps global static lexer state and emits tokens without any source positions, so tokens cannot be mapped back to lines. No maintained npm alternative exposes positions either. `packages/format/src/fountain.ts` is a small line-oriented parser that records `startLine/endLine` (0-based), `start/end` (UTF-16 offsets) and `raw` for every element. It handles the title page, scene headings (forced `.`, `#n#` scene numbers), action (forced `!`), characters (`@`, extensions such as `V.O.`, dual `^`), parentheticals, dialogue (two-space continuation), transitions (`TO:` and forced `>`), centered, lyrics, sections, synopses, page breaks, notes `[[…]]` (stand-alone, inline, multi-line) and boneyard `/* */` (inline, multi-line, unterminated). CRLF/CR safe.
- **Line granularity = one physical line.** Each non-blank line is one element: a 3-line action paragraph is 3 `action` elements, and each dialogue line is its own element. Predictable for agents and lets shots split mid-paragraph.
- **Anchorable lines** (they get IDs and an `ordinal`): `scene_heading, action, parenthetical, dialogue, transition, centered, lyrics`. **Character cues are not anchorable**: the cue is exposed as `character`/`extension` on the dialogue/parenthetical elements, so renaming a character never churns line IDs, and V.O. lines are identifiable via `extension`. Sections, synopses, notes, boneyard, page breaks and the title page are not anchorable. M1 may revisit if the UI needs IDs for cues.
- **Line text and hash.** `text` = trimmed line with Fountain markers, inline notes and boneyard removed (emphasis `*`/`_` kept; `stripEmphasis()` for display). `hash` = cyrb53 (53-bit, 14 hex chars) of NFC + whitespace-collapsed text: synchronous, dependency-free, identical in Node and browser. Adding an inline note to a line does not change its hash.
- **Re-anchoring** (`packages/format/src/reanchor.ts`, `reanchorLines` / `reanchorScript`): (1) Myers diff on normalized text: in-order unchanged lines keep IDs (`exact`); (2) identical text elsewhere: `moved` (nearest relative position wins, so duplicate lines resolve sensibly); (3) inside each gap between exact anchors, greedy best-first similarity matching at >= 0.5 (`similar`); (4) global similarity at >= 0.7 for lines that were edited _and_ moved (skipped above 1M candidate pairs); (5) everything else gets a new ID (`l_` + 8 random base36 chars) and unmatched old entries are returned as `removed`. Similarity = max(normalized Levenshtein, word-multiset Dice) on lower-cased text, minus 0.15 when element types differ. Myers has an edit-distance cap (2000) with a graceful fallback. Old `ids.json` entries carry their own text, so the old script itself is not required. `remapLineRefs(shotLineIds, result)` drops references to removed lines; surviving IDs never change, so shots stay valid. A 4000-line script with mixed edits re-anchors in well under a second.
- **Zip** (`packages/format/src/zip.ts`, fflate): `packSbd(tree)` writes `mimetype` first (STORE, no extra field, content at byte 38, EPUB-style magic), then entries sorted by path. Media and fonts by extension (png jpg webp avif gif, mp3 m4a aac ogg opus wav flac weba, mp4 m4v webm mov mkv, woff woff2 ttf otf) are STOREd (fflate `level: 0` = method 0); everything else is DEFLATE level 6. A fixed mtime (1980-01-01) makes output byte-identical for identical input. `readZipIndex(ByteSource)` parses the EOCD and central directory and reads each local header to compute `dataStart/dataEnd` (the local extra field can differ from the central copy). `entryBlob(blob, entry)` returns `blob.slice(dataStart, dataEnd, mime)` for STOREd entries. `checkSbdLayout` validates the layout; `unpackSbd` is strict by default. Paths are validated (no `..`, absolute paths, backslashes or empty segments). **Not supported yet:** ZIP64 (> 4 GiB or > 65535 entries) and CRC verification of sliced media.
- **Blob slicing verified in a browser.** The dev spike page generated a WAV and an H.264 MP4 (MediaRecorder on a canvas), packed them, sliced them out of the `.sbd` Blob, and played and seeked both via `<audio>`/`<video>` in Chromium 152 (Claude desktop browser pane): both passed. Playback was muted (autoplay policy). Not verified in Safari or Firefox, with WebM, or with large files; M1 should turn this into a Playwright test.
- **Tooling.** pnpm 8.15.6 kept (works on Node 26; no global upgrade needed). TypeScript pinned to `~6.0` because `svelte-check` 4.7 does not support TS 7 yet. Libraries build with plain `tsc` (ESM + `.d.ts`); revisit tsdown when the CLI needs to bundle the web app. Prettier chosen over oxfmt for reliable Svelte formatting (`prettier-plugin-svelte`); Prettier also reformatted this file's tables. oxlint with correctness = error, suspicious = warn. Vite 8, Vitest 5, Svelte 5.57, vite-plugin-pwa 2.0 (generateSW, `registerType: autoUpdate`, service worker registered only in production builds).
- **PWA icon.** Only an SVG icon (`sizes: any`) for now; M1 should add 192/512 PNG (and maskable) icons for reliable installability.

### M1 (2026-10-06)

- **Schemas are the source of truth; TS types are hand-written.** `schema/*.schema.json` (2020-12) are embedded into `packages/format/src/schemas.gen.ts` by `scripts/gen-schemas.mjs`; a test fails when the embed is stale and typed fixtures exercising every field must validate, which keeps `types.ts` honest. Generated types (json-schema-to-typescript) were less readable for agents and humans.
- **Validator: `@cfworker/json-schema`, not ajv.** Small, ESM, no `new Function` code generation (works under strict CSP and in service workers), identical in Node and browsers. Errors are post-processed into readable messages (oneOf/anyOf noise collapsed). Variant `type` uses `if/then` instead of `oneOf` for precise errors.
- **Shot order and shot→lines live in `ids.json` `shots`;** `shots/<id>.json` holds everything else. One file to reorder; shot files only change when their content changes.
- **JSON uses snake_case** (`format_version`, `active_variant`, `scale_x`) to match the manifest and be friendly to hand edits; TS types mirror it.
- **Layer model = Konva Image attributes** (x/y origin, width/height, scale, rotation degrees, opacity, crop in source px, array order = z-order). **Filters use CSS filter semantics** (renderer-neutral; Konva mapping is approximate for grayscale/sepia/invert which are on/off there).
- **Linked `file:` paths are relative to the directory containing the `.sbd`** (file or folder) so pack/unpack never changes them.
- **New lines after a hand edit** join the surrounding shot (between two lines of a shot, or after a shot's last line unless a new scene heading starts) and stay unassigned otherwise; see SPEC §5. Cues pointing at deleted lines are a warning (skipped in playback), not an error, so a hand edit never makes a project un-editable.
- **Script edit ops are ID-exact.** `insert_lines`, `update_line`, `remove_lines` map lines by position around the edit (verified by text) instead of similarity; `set_script` uses re-anchoring. Insertions are always new paragraphs (after/before the paragraph of a line) so Fountain block structure stays valid; removing all dialogue of a cue removes the cue line too.
- **Edits are rejected only for new errors.** `ProjectStore.edit` compares issues before/after so a project with an existing problem can still be edited; every edit loads fresh from disk (hand edits are never overwritten) and writes changed files atomically (temp + rename), touching `manifest.modified`.
- **Live refresh = fs.watch (recursive) + 120 ms debounce → SSE.** Native recursive watching on macOS/Windows; on Linux one non-recursive watch per folder instead (Node ≤ 22 emulates `recursive` with per-file inotify watches that go stale when a file is replaced by an atomic rename, so the second agent write to the same file was missed). Same-process edits notify directly and suppress their watcher echo. Folder sources opened in the browser poll every 2 s (no FileSystemObserver).
- **Packed `.sbd` served** straight from the zip: STOREd entries are streamed from file offsets with Range support; DEFLATEd ones are inflated per request. (Read-only until 0.5.0; now saved in place, see 0.5.0.)
- **Player uses media elements, not decoded Web Audio buffers.** Streams long files, works with Range/Blob slices; drift correction at 0.25 s; per-cue gain, fades, loop and per-track mute via `volume`/`muted`. Sample-accurate mixing (Web Audio graph) can come with the timeline editor if needed.
- **Animatic timing rules** (SPEC §9) live in `buildAnimatic` (format package) so the player, exports and agents agree.
- **Working copy** = last opened file kept as packed bytes in IndexedDB ("Reopen …" on the start screen). OPFS not needed yet.
- **MCP extras beyond the M1 list:** `get_script`, `insert_lines`, `update_line`, `remove_lines`, `set_script`, `update_storyboard`, `update_asset`, `remove_asset`, `remove_variant`. `add_shot` accepts `script_text` so an agent can write a shot and its dialogue in one call. `add_asset` embeds (copy into media/, sha256, dims, WAV/ffprobe duration) or links. `sbd mcp --serve` runs the viewer in the same process.
- **Example** `examples/minimal.sbd` (~650 KB) is generated deterministically by `scripts/make-example.mjs` (tiny PNG rasterizer + WAV synth in `scripts/lib`, ffmpeg for a 3 s H.264 clip). It covers image variants, a canvas variant, one long dialogue WAV split into three line cues, an SFX cue with offset, a looping global music cue and a video variant. The packed form is produced by the e2e test, not committed.

### Notes for M2 (editing)

- **Edit path:** call the pure ops in `packages/format/src/ops.ts` on `app.project` (they never mutate; keep previous projects on a stack for undo/redo), then persist through the source. Add a `save(project)` to `ProjectSource`: server → new `POST /api/project` (or per-op endpoints) in `packages/cli/src/server.ts` reusing `ProjectStore.edit` (validation + atomic write + SSE already there; the server currently answers 405 to non-GET); folder → write via the directory handle (`requestPermission({mode:'readwrite'})`, write only changed files from `serializeProject`); zip → keep an in-memory tree + `packSbd` for download/IndexedDB.
- **Live refresh vs. local edits:** after the app saves, the SSE echo reloads the same state; compare `serializeProject` output (or a revision) to avoid clobbering in-progress UI state. `app.reload()` already keeps tab, selection, scroll and user variant choices (choices are dropped when `active_variant` changes underneath).
- **Canvas editor:** `apps/web/src/lib/konva-stage.ts` builds `Konva.Image` nodes whose attrs map 1:1 to layer fields — add a `Transformer`, make nodes draggable, write back `x, y, scale_x, scale_y, rotation` via `updateVariant`. Crop UI = edit `crop`. "Flatten to preview" = `stage.toBlob()` → new image asset + `variant.preview`. `Composition.svelte` is the cheap DOM renderer for cards and must keep matching Konva (CSS filters).
- **Timeline editor:** cues are `{asset, in, out, target, offset, gain, track}`; `buildAnimatic` gives absolute times; waveform needs decoding (`AudioContext.decodeAudioData`) of the asset URL (`app.mediaUrl`). Line cues define line durations, so dragging `out` changes timing.
- **Script editing in the Story tab:** use `updateLine` / `insertScriptLines` / `removeLines` (ID-exact). Splitting/merging shots = `setShotLines` + `addShot`. Custom fields = `updateShot({fields})` + `updateManifest({shot_fields})`.
- **Assets import in the browser:** embed = add bytes to the tree under `media/` (`slugify` for names, `probeImageSize`, `probeWavDuration`), then `addAsset`. Linking needs `sbd serve`.
- **Known gaps:** no ZIP64; no CRC check of sliced media; HLS (`.m3u8`) URLs are passed to media elements as-is (native in Safari only; hls.js not added yet); fonts are listed but not loaded/previewed; folder polling reads every file's metadata each 2 s (fine for small projects); Safari/Firefox not tested (Chromium only, via Playwright and the Claude browser pane).

### M2 (2026-10-06)

- **Edit model.** `app.project` is the working state, `app.base` the last loaded/saved state; dirty = identity `project !== base`. `app.edit(label, op)` applies a pure op from `packages/format` (ops that throw show a toast and change nothing) and pushes the previous project on `History` (`apps/web/src/lib/history.ts`, 100 entries, consecutive edits with the same `coalesce` key within 1.2 s merge, e.g. sliders and typing). Undo labels come from the edit label ("Undo: Move shot").
- **New format ops** (`ops.ts`): `splitShot`, `mergeShots` (lines combined, variants appended with unique IDs, shot cues retargeted, durations summed), `duplicateShot` (no lines, lines stay exclusive), `moveVariant`, `addLayer/updateLayer/moveLayer/duplicateLayer/removeLayer` (null deletes a property), `updateTrack`. `compose.ts` builds Fountain for a typed line (forcing with `.`/`!`/`>`/`@` when needed); the composer uses `insertScriptLines` so existing IDs never change.
- **Saving through `sbd serve` is file-level optimistic concurrency.** The app sends only changed text files (`diffProjectFiles`) plus the cyrb53 of each file as it was in `base`; the server compares against the current (serialized) state, writes via `ProjectStore.edit` (validation: only _new_ errors refuse, atomic writes) and answers 409 with the conflicting paths. On 409 the app pulls, merges and retries once. Changes to other files by an agent never conflict. Media are uploaded immediately (`POST /api/media` → `media/`, reusing `prepareAsset`), so an import that is never saved leaves an orphan file (harmless; `sbd validate` ignores unreferenced media).
- **Echo and agent edits.** The server tags SSE `change` with the saving client's ID; the app ignores its own events and treats any loaded state equal to `base` as an echo. Otherwise: without local edits the new state replaces the project; with unsaved edits `mergeProjects(base, ours, theirs)` merges three-way (objects key by key, `id`-keyed arrays item by item, ours wins on conflicts; script + line IDs as one unit), the undo history is rebased onto the agent's state, and a toast says "Updated by agent" (sticky with a count when something conflicted) with "Use agent’s version". The server's watcher echo suppression now compares size+mtime+inode stamps instead of a 1 s window (an agent write right after an app save used to be swallowed).
- **Write endpoints are guarded** by a required `x-sbd-client` header (forces a CORS preflight the server never approves) and a same-origin `Origin` check, so other websites cannot write to a local storyboard.
- **Autosave** (default on, per browser in localStorage) for server and folder sources, 700 ms after the last edit; File menu toggle. Packed files save on Cmd/Ctrl+S: through a file handle (asks with `showSaveFilePicker` the first time) or as a download; the working copy in IndexedDB is refreshed after each save. Folder saves check each changed file against `base` first (same conflict rule) and write only changed files; the 2 s poll then sees our own write as an echo. A packed `.sbd` served by `sbd serve` stays read-only: "How to edit" explains `sbd unpack`, and "Edit a copy" continues in the browser.
- **Line selection is separate from shot selection** in the Story tab (selecting a shot opens the inspector; a line click must not shift the layout). The timeline selects the owning shot too.
- **Canvas editor** (`apps/web/src/lib/konva-editor.ts`) reconciles Konva nodes by layer ID instead of rebuilding, shows the frame with a dimmed 36 px margin, a Transformer (keep ratio, rotation snaps, locked = no handles), snapping of edges/centers to the frame and other layers, 90 %/80 % safe areas. **Filters are applied as the same CSS filter string** (`cssFilter`) through Konva 10's native `ctx.filter` support, so the Konva view, flattened previews and the DOM `Composition.svelte` match; the DOM renderer now scales blur to canvas pixels (`calc(px * 100cqw / width)`). Safari before `ctx.filter` support falls back to Konva's function filters (no saturate/hue). Crop is numeric (source px) with display size kept; an interactive crop mode was cut. "Flatten to preview" renders `stage.toBlob` at canvas resolution into an image asset (reusing the previous preview asset when only the preview uses it).
- **HTML5 drag sources are `role="button"` spans, not `<button>`s**: Chromium does not start drags from buttons. Drag-and-drop shot reordering always has a keyboard path (Alt+↑/↓, grip arrows, menu).
- **Timeline editor** decodes the source with an `OfflineAudioContext` into 100 peaks/s (`lib/waveform.ts`, cached per URL for the session; not persisted). Segment playback uses a separate `<audio>` element. "Assign to selected line" updates the existing cue of that line from the same file instead of adding duplicates, then selects the next line and starts the next segment at the previous out point. Track mute and gain are saved (`timeline.tracks`); solo is preview-only (player state).
- **Assets**: import = embed (drop/picker); link = local path (server only, `POST /api/link`, relative to the folder containing the `.sbd`) or an https URL. Deleting a used asset asks first and removes the dependent variants/layers/cues (undoable); media files are not deleted from disk. Fonts are previewed via `FontFace`.
- **E2E** runs a second `sbd serve` on its own copy for editing tests; the folder (File System Access) path is tested with an OPFS directory handle (same API as a picked folder), the packed path through "Export .sbd file" (the native save picker cannot be driven headless).

### Notes for M3

- **Exports:** `app.exportPacked()` / `currentTree()` (state.svelte.ts) already build a full package tree including unsaved edits and new media; PDF and animatic exporters can reuse it. Flattened previews (`variant.preview`) are handy for PDF sheets; consider "flatten all" before export. `buildAnimatic` gives the timing.
- **Docs to write:** the save/merge behaviour (autosave, "Updated by agent" notice, conflicts keep yours), keyboard shortcuts (Developer notes above), the timeline assign workflow (select line → P → I → O → A), "packed files are read-only under sbd serve: unpack to edit", linking local files only through `sbd serve`.
- **Gaps / follow-ups:** no interactive crop handles; no multi-select on the canvas; no audio-scrub while dragging handles; waveform peaks not cached across sessions; history rebasing runs `mergeProjects` per entry on each remote change (fine for small projects); imports that are never saved leave media files behind in server mode; replaced/deleted assets keep their old media file (an `sbd gc`/cleanup command would help); the app has only been verified in Chromium (Playwright + Claude browser pane). Fountain round-trip of composed lines is unit-tested only for the composer's own element types.

### M3 (2026-10-06)

- **Short-form vertical preset** (`vertical`: 9:16, 1080×1920, 30 fps; fields beat / on-screen text / framing / transition / sound / notes; categories talent, footage, product, graphics, typography, voice-over, music, sfx). Presets gained an `examples` string for pickers. Film/Short, Documentary, Animation and Motion kept their fields (already sensible); `motion` description no longer claims social video.
- **Fountain round trip** is tested (`fountain-roundtrip.test.ts`): export = the stored script byte for byte; re-import gives the same lines and shot split; reformatting by another app (CRLF, trailing spaces, extra blank lines, title page edits) keeps every line ID and shot mapping; composer output re-parses to the same types. No shot markers are written into exports (ids.json stays the source of truth).
- **Storyboarder import** (`packages/format/src/storyboarder.ts`, pure; CLI reads `images/`). Researched from the wonderunit/storyboarder source (`src/js/models/board.js`, `main-window.js`, test fixtures): boards have `uid`, `url`, `number`, `shot`, `newShot`, `duration` (ms, missing = `defaultBoardTiming`), `dialogue`, `action`, `notes`, `layers{name:{url,opacity}}`, `audio{filename,duration?}`; files live in `images/`. Layer stack bottom→top: shot-generator, reference, fill, tone, pencil, ink, notes. Since 1.6 `board.url` is not a file (pre-1.6 it held the main drawing → mapped to fill); the flattened image is `<url>-posterframe.jpg`. Mapping: board → shot (ID = uid, title "Shot 1A", `new-shot` tag), layers → one canvas variant (white background, notes layer hidden, posterframe = `preview`), action → action lines, dialogue "NAME (EXT): text" → dialogue (no NAME → character `VOICE`), notes → `notes` field, duration = max(board timing, audio length), audio → shot cue on track `audio`. Multi-board shots (`newShot`) are not merged (one shot per board). Verified on a hand-made fixture and on 7 upstream fixtures (all valid). Not handled: Shot Generator 3D data (`sg`), PSD links, scene-level script/notes.
- **`sbd clean`** lists media files no asset references (src, poster, renditions; `unreferencedMedia` in the format package), dry run by default, `--yes` deletes and removes empty media sub-folders; refuses packed files.
- **HLS:** `apps/web/src/lib/hls.ts` (`setMediaSource` / `use:mediaSrc`) used by all media elements; hls.js (light build, Apache-2.0) is a separate lazy chunk loaded only for `.m3u8` when `canPlayType('application/vnd.apple.mpegurl')` is empty. Note: current Chrome (154) plays HLS natively, so hls.js mostly matters for Firefox/older Chromium; the hls.js path was verified by forcing `canPlayType` to '' (MSE `blob:` playback of a public test stream).
- **PDF = the app's print view.** `PrintView.svelte` renders sheets in millimetres (Letter/A4; grid 3/6/9/12 per page landscape, or one row per shot portrait with script beside the image; title page; fields; notes; lines formatted like a script) and marks `data-print-ready` after images/videos decode. In the app: File → Export PDF → preview → browser print (Save as PDF). The CLI (`sbd export-pdf`) starts a temporary server (port 0, no watcher, not registered for `get_viewer_url`) and prints the same URL with **playwright-core** (JS only, no bundled browser) driving an installed Chrome → Edge → Playwright Chromium (`--browser`/`SBD_BROWSER` to choose). Trade-off: identical output to the app and no PDF/layout code in Node, at the cost of needing a Chromium-family browser on the machine (pdf-lib would need its own layout + a canvas compositor and could not embed WebP). Rows layout gets page numbers from CSS `@page` margin boxes; grid pages draw their own footer. Long text in grid cells is clipped with a fade.
- **Animatic export = app only.** `lib/animatic-export.ts`: frames drawn on a canvas (image variants contained/letterboxed, canvas variants composited with the same layer semantics + CSS filters, video variants seeked per frame), captions of the current line (dialogue as "NAME: text"), audio mixed with `OfflineAudioContext` (gains, track mutes, fades, loops, trims; durations from decoded buffers), encoded with WebCodecs through **Mediabunny** (MPL-2.0, unmodified, lazy chunk ~700 KB): MP4 H.264+AAC when encodable, else WebM VP9/VP8+Opus. Progress + cancel in `VideoExportDialog`. mp4-muxer/webm-muxer were rejected because they are deprecated in favour of Mediabunny. A CLI path would need a headless browser with proprietary codecs, so it was left out.
- **New storyboard** (File menu and open screen): preset cards + title; "Create" opens it in the browser as a new `.sbd` (saved with Save), "Create in a folder…" (Chromium) writes `<title>.sbd/` into a picked folder and opens it with autosave. In `sbd serve` mode a note explains it opens outside the live storyboard.
- **File menu additions:** New storyboard…, Export PDF…, Export animatic video…, Export script (Fountain). Shared `Dialog.svelte` for the new dialogs.
- **MCP `--serve` port fallback:** when 4400 (or `--port`) is busy, the viewer takes the next free port (up to +20), so several agent sessions (or an `sbd serve` left running) don't break `open_storyboard`.
- **Setup prompt** uses `npx -y pnpm@8.15.6` (no global installs; corepack is not bundled with Node 25+) and registers the server as `storyboard` with `claude mcp add storyboard --scope user -- node <repo>/packages/cli/dist/cli.js mcp --serve` / `codex mcp add storyboard -- node … mcp --serve` (syntax checked against Claude Code 2.1.288 and codex-cli 0.157.1). Because a new MCP registration only becomes active in a new session, the prompt starts `sbd serve` directly for the first look. Verified by following it in a scratch folder (clone from the local repo, install, build, `sbd new --preset vertical`, `sbd serve`, MCP over stdio from the clone: open → add_shot → get_viewer_url → validate). Both registrations were added under a temporary name, confirmed connected (`claude mcp get`, `codex mcp get`) and removed; `codex mcp add/remove` rewrites `~/.codex/config.toml` formatting, so the original file was restored byte for byte.
- **Screenshots:** `scripts/screenshots.mjs` serves a temp copy with the built CLI, captures with playwright-core at 1280×800 @1.5x, converts PNG → WebP in the browser (no image tools), writes `docs/images/{story-light,story-dark,canvas,timeline,assets,pdf,new-storyboard}.webp` (45–80 KB each).
- **Versions** bumped to 0.1.0 (CHANGELOG). CI: `.github/workflows/ci.yml` (Node 22, pnpm from `packageManager`, build, lint, test, Playwright Chromium e2e). On Linux CI the animatic test may produce WebM (no H.264 encoder); the test accepts both.

### Notes for M4 (sample storyboards)

- **Make samples with the tools:** `sbd new <dir> --preset film|documentary|animation|motion|vertical` (or MCP `open_storyboard {create:true}`), then MCP `add_shot` (with `script_text`), `add_asset` (embed images/audio), `add_variant`, `add_cue`. Validate with `sbd validate`, pack with `sbd pack`, and run `sbd clean` before committing so no orphan media ship.
- **Audio:** one long Kokoro TTS file split per line = one `add_asset` + `add_cue {line_id, in, out, track: "dialogue"}` per line; music = `global_start: 0, loop: true, gain ≈ 0.3–0.4, fade_out`. Prefer MP3/M4A or WAV; images WebP/PNG/JPEG. Keep each sample small (a few MB) since examples are committed.
- **Screenshots:** after adding samples, `pnpm build && pnpm screenshots -- --story examples/<sample>.sbd` (optionally `--shot <id>`), check `docs/images/*.webp`, and update README image alt texts if the content changes. Consider a different sample per image (run the script per story with `--out` to a temp dir and copy the ones you want).
- **Exports to showcase:** `sbd export-pdf examples/<sample>.sbd -o /tmp/x.pdf --per 6` and File → Export animatic video in the app; a short animatic GIF/MP4 for the README would be a nice addition (README has no GIF yet).
- **Repository:** `https://github.com/swaymun/storyboard-viewer`. Suggested GitHub topics: storyboard, storyboarding, animatic, fountain, screenwriting, mcp, model-context-protocol, claude-code, codex, pwa, offline-first, svelte, filmmaking, video-production.
- **Known gaps after M3:** Safari/Firefox untested; Storyboarder multi-board shots not merged and Shot Generator data dropped; animatic export draws canvas-variant video layers as their first frame; no CLI animatic export; PDF grid cells clip very long text; the hls.js path is only reachable in browsers without native HLS.

### M4 (2026-10-06)

- **Five samples** in `examples/` (unpacked folders, committed; `minimal.sbd` untouched for the tests): `midnight-snack.sbd` (film, 8 shots, comedy, 3 voices), `salt-and-light.sbd` (documentary, 8 shots, one 24.8 s narration file split over 6 lines, 2 interviews with `lower_third`, B-roll/archival/title shots without lines), `cat-crimes.sbd` (vertical 9:16, 6 shots, hook + `on_screen_text` + beats), `fernlight-launch.sbd` (motion, 8 shots, 7 canvas compositions from background/product/logo/icon layers with brightness/sepia/blur/hue filters, music bed, short V.O.), `pips-kite.sbd` (animation, 6 shots, character cutouts reused as layers with crops/flips/rotations, an alternate layout and a color-key image variant). All content, brands and characters are fictional. Total ≈ 5.7 MB (packed sizes 0.6–1.6 MB each; 7.0 MB on disk).
- **Built with the real workflow:** `sbd new --preset …`, then an MCP client over stdio calling `open_storyboard`, `update_storyboard` (description + one extra category where a preset had no fit: `frame`, `keyframe`, `lifestyle`), `add_asset`, `add_shot` (Fountain `script_text`), `add_variant` (images or `layers`), `add_cue`, `validate`; then `sbd clean` and `sbd validate` (0 errors, 0 warnings each). The generator scripts were scratch files and are not part of the repo.
- **Images:** `codex exec` (codex-cli 0.157.1, `image_generation` feature, built-in image tool, no API key) with one prompt per image, a style line repeated per storyboard, aspect in the prompt (16:9 → 1672×941, 9:16 portrait, 1:1 cutouts); the tool honours "transparent background" (real alpha), so cutouts needed no keying. 43 images (+1 regenerated), ~30–60 s each, 5 in parallel; one run hung and was retried. Converted with Pillow to WebP: frames ≤1280 px q80, cutouts trimmed to their alpha bbox ≤1024 px q85.
- **Audio:** Kokoro via `kokoro_mlx` in `~/.codex/venvs/jeopardy-kokoro-py312` (Jeopardy project not modified); per-character voices (e.g. `am_puck`, `af_bella`, `bm_lewis`, `bm_george`, `af_heart`, `af_nova`, `af_sky`, `bm_fable`), small pitch shifts via ffmpeg `asetrate`+`atempo`. Three approaches are shown: one take per character split by `in`/`out` (film), one long narration split by `in`/`out` (documentary, motion), one clip per line (vertical, animation). Music and SFX are synthesized with numpy (Karplus-Strong plucks, bells, pads, filtered noise) — no samples. All MP3 (speech 64 kbps mono, music 96 kbps).
- **App fixes found while checking the samples:** the animatic stage sized its frame for 16:9 only, so 9:16 frames overflowed the window (now uses `aspectValue(manifest.aspect_ratio)`); the Story tab gave portrait frames the full column width (one shot per screen) — portrait shots now get a 160–220 px picture column. `pnpm screenshots -- --shot <id>` now also picks that shot for the canvas image when it has a canvas variant.
- **Checked in the browser** (`sbd serve` per sample, Claude desktop browser pane): images and variant carousels load, canvas compositions render (two kite layers were hidden behind Pip and were moved), the animatic advances shots/lines with captions, and dialogue cues start at their line and stop at `out` (in a hidden pane rAF is throttled, so the playhead updates late; media timing itself matched). Animatic video export through the app UI (headless Chromium) for `pips-kite` (40.5 s, H.264+AAC, 3.6 MB) and `fernlight-launch` (25.5 s): frames, captions and audio levels look right. README GIF `docs/images/animatic.gif` (640 px, 4 fps, 2.0 MB) is made from the Pip's Kite export with ffmpeg palettegen. `sbd export-pdf examples/midnight-snack.sbd --per 6` renders a good 3-page PDF but is 10.9 MB (Chrome re-encodes the WebP frames at full size), so no PDF is committed.
- **README screenshots** now come from the samples: Story (light/dark) from Midnight Snack Protocol, Canvas from Pip's Kite (`--shot ready`), Audio (formerly Timeline) and PDF from Salt & Light, Assets from Pip's Kite.

### 0.2.0 — feedback round: themes, optional details/tags, script editor (2026-10-06)

- **Themes.** All colors are custom properties in one file (`apps/web/src/themes.css`), one block
  per `[data-theme]` (attribute selector, not `:root`, so any element can preview a theme: the
  Appearance menu's swatches do). Tokens: chrome (`--bg --surface --surface-2/3 --border(-strong)`),
  text (`--fg --fg-2 --fg-muted`, AA on all surfaces; `--fg-faint` only for icons/disabled),
  accent (`--accent` fills, `--accent-text` when the accent is text, `--accent-fg`, `--accent-soft`,
  `--focus`), status, script (`--paper --paper-fg --sx-*`), `--shot-1..6` annotation hues,
  media overlays, canvas editor colors, elevation. Print uses fixed `--print-*` tokens (always
  black on white; `@page` margin boxes use a constant because they cannot read custom
  properties reliably). `src/lib/themes.test.ts` checks 19 contrast pairs per theme and greps
  components for hard-coded colors. Maomao/Jinshi colors are taken from the Apothecary Diary
  VS Code theme (`colors` for chrome; `tokenColors` for the screenplay: keyword → scene heading,
  function → character, comment → parenthetical, control keyword → transition, string → note,
  constant → section), light variants darkened to pass AA. Neutral Pro got a light counterpart
  (cheap: same token set). Choice in localStorage (`sbd:theme`, `sbd:theme-pair`, try/catch);
  index.html applies it before the first paint; default System → Paper/Darkroom.
- **Typography / look.** IBM Plex Sans + Plex Mono (UI) and Courier Prime (script) bundled with
  Fontsource (latin subsets, precached for offline). Radii 2/3/5 px, hairline borders, underline
  tabs instead of a segmented pill, chips square-ish; shared form controls use `:where()` so
  components can restyle them.
- **Optional details and tags.** Only fields with a value render. "Add detail" is a combobox
  (datalist of unused preset fields); a new name creates a `shot_fields` definition with
  `updateManifest` and the value is saved with `updateShot` (two undo steps: definition, value).
  Tags: `TagEditor` chips, Enter/comma adds, datalist autocomplete from `app.allTags`;
  `app.tagFilter` (any-of) dims shots in the Script view and hides them in the Board.
- **Editor technology: CodeMirror 6** rather than a contenteditable/textarea overlay: mature
  input handling (IME, selection, undo hooks, virtualised rendering for long scripts), MIT,
  modular. Only state/view/commands are used (no language package/lezer grammar of our own):
  line classes come from the in-house Fountain parser run on every change (fast enough; only
  visible lines are decorated), so the editor and the stored format can never disagree about
  element types. The editor chunk (~100 KB gzip) is lazy-loaded with the Script view.
- **Typing → ops.** CodeMirror owns the text while typing; changes are composed and committed
  400 ms after the last keystroke (and synchronously before any other `app.edit`, undo/redo,
  save, merge or "Use agent's version", via `app.registerFlush`) as one `replaceScriptRange`
  covering all changed ranges. `replaceScriptRange` reuses the existing ID-exact local edit
  (lines outside the range keep IDs by position; inside by position when the count is unchanged,
  else by similarity) and places new lines with `remapShots` (SPEC §5). Commits coalesce
  (`script-typing`) into one undo step per burst; Cmd/Ctrl+Z in the editor calls `app.undo()`
  (no CodeMirror history). If the project's script changed underneath an unflushed buffer (should
  not happen), the commit falls back to `setScript` (re-anchoring).
- **Outside changes → editor.** When `app.project.script` differs from the editor text (agent
  edit, undo, merge), a line diff (`diffLines`, exported from reanchor's Myers LCS) is applied as
  minimal changes annotated as remote, so CodeMirror maps the cursor and selection.
- **Merging scripts.** `mergeProjects` used to treat the script as one value (ours wins). Now
  `mergeScripts` does a diff3 over physical lines; each anchorable line keeps the ID it has on
  the side its text came from (duplicates get a new ID); overlapping edits still keep ours and
  report `script.fountain`. Shot line lists merge as sets (base ∩ kept, plus additions from both;
  a line both sides moved stays where ours put it). The existing test for "script edits on both
  sides" was updated to edit the same line (other lines now merge).
- **Annotations.** `lib/script-editor/geometry.ts` (pure) turns the committed project into
  runs of line positions per shot (character cue above the first dialogue line included) and
  marker positions for lineless shots (after the previous shot with lines). A CodeMirror
  `StateField` maps them through edits typed since, and builds line decorations (`data-line-id`,
  `data-shot-id`, tint via `--shot-c`), gutter bands (number, start/end handles) and block widgets
  for lineless shots. Handle drag: pointer → `lineBlockAtHeight` → preview decoration →
  `setShotLines` on release (exclusive: neighbours give up lines; shrinking leaves lines
  unassigned). Keyboard path: Start/End ↑↓ buttons on the open card (`adjustBoundary`).
- **Cards beside the script** are absolutely positioned at their shot's first line
  (`lineBlockAt(...).top` + offset between the editor and the rail), then laid out like comment
  margins: the open card sits at its anchor, cards above are pushed up, cards below pushed down.
  Heights are measured per card. Hidden below 860 px width (the editor stays usable; the card
  content is in the Board view).
- **What "move shot" means.** Before 0.2.0 `moveShot` only changed `ids.shots` order, so script
  order and shot order could diverge. `moveShotWithLines` moves the shot's lines in the script
  to sit before the next shot with lines (else after the previous one) using `moveLines`, which
  cuts the script into units (anchorable lines with their cue; notes/sections as position-only
  units), reorders them and re-serialises with blank lines at seams, repeated cues for split
  dialogue blocks and forced markers (`!`, `.`, `>`) when a line would be re-typed; the result
  is verified line by line or the op throws. The app always uses it; MCP `move_shot` defaults to
  `move_lines: true`. `placeLines` (Board line drag) = membership + text position in one op.
- **Board view** keeps the cards. The per-line inline editor and `LineComposer` were removed
  (the script editor replaces them); the e2e test for them was replaced by Script-view tests.
- **Visual verification** was done with headless Chromium screenshots (Playwright) of every theme
  and tab on scratch copies of the samples. The `cua_repl` browser surface could not be used in
  this session ("Missing required Codex turn metadata").

### 0.3.0 — feedback round: menus, freeform details, audio folded into shots (2026-10-06)

- **UI principles** (also in CONTRIBUTING.md): freeform over forms; **avoid dropdowns** (no
  `<select>`, no `<datalist>`; `ui-principles.test.ts` enforces it); show only what has a value;
  every command lives in the menu bar and in the context menu of what it acts on; keyboard first;
  theme tokens only.
- **Script highlight.** The tint moved from line decorations (full-width background, blank lines
  included) to `Decoration.mark` over the trimmed text of each line (`.sb-text`, with
  `box-decoration-break: clone` for wrapped lines). Line decorations keep `data-line-id` /
  `data-shot-id` and state classes for hooks. The gutter band is 3–4 px without numbers (the
  number is on the card; Fountain has no shot numbers); the band carries a `title`, and the
  start/end handles appear on hover of the shot and for the open shot (bigger hit area via
  `::after`). Unit test: `annotations.test.ts` (marks only on text, none on blank lines).
- **Menus.** One `MenuList` (roving focus, type-ahead, in-place submenus) serves the button menu
  (`Menu`), the `MenuBar` (WAI-ARIA menubar: one tab stop, ←/→ switch menus and keep them open,
  ↓/Enter/Space open, Esc returns focus to the title; F10 focuses it) and the single
  `ContextMenu` (positioned in the viewport, Esc returns focus to where it opened; the Menu key's
  keydown + contextmenu pair is de-duplicated). Menu contents live in `AppMenuBar`; shot
  commands in `lib/shot-actions.ts` (`shotMenuItems`) so cards, context menus and the Shot menu
  match. The Script view registers `ui.scriptCommands` (make shot, shot without lines) for the
  Shot menu. Dialog/panel flags and a promise-based asset picker (`ui.pickAsset`) are in
  `lib/ui.svelte.ts`.
- **Freeform details.** `SuggestInput` is a combobox with its own listbox popup (QA: native
  datalist suggestions go unnoticed): on focus it offers everything, typing filters, ↑/↓/Enter
  pick, blur commits a changed value. "select" fields stay in the format (options become
  suggestions, any text is valid); Settings calls the type "Suggestions". Few fixed choices
  (export dialogs, field type) use `Segmented` (radio group, all options visible).
- **Timeline folded into shots — and why.** The Timeline tab duplicated the script (a second line
  list) and separated a line's sound from the line. Now the shot card's **Audio** section lists
  that shot's lines with their cues and holds a compact waveform trim editor and the cue's
  settings; the **Soundtrack** panel (View menu / playback bar) keeps what belongs to no shot:
  story-wide cues, cues on lines outside shots, and the track lanes with mute (preview), solo,
  saved mute and gain. Editing state lives in `lib/audio-editor.svelte.ts` (not a component), so
  the I / O / A workflow survives the open card changing: after A on a shot's last line the next
  shot's card opens and focus moves to the next line (`focusLine`), with the next segment
  starting at the previous out point. Keys only act while focus is inside an audio editor (no
  more global I/O/P/A that could fire while typing); the waveform container is focusable so
  clicking it keeps the keys working. Judgement: better for the common cases (attach, trim, check
  a shot's sound in context, one less tab), roughly equal for splitting one long take (same keys,
  now crosses shots), slightly worse for a whole-story overview of cue timing, which is why the
  Soundtrack panel keeps the lanes and clicking a shot's cue there opens it in that shot.
  Everything the Timeline did is still reachable; `#tab=timeline` opens the Soundtrack panel.
  The old e2e timeline test moved to `e2e/audio.spec.ts` and was extended.
- **Cards.** Title edited in place in the header, picture ~180 px high, variants as a thumbnail
  strip (shown = outline, default = dot), foldable Details and Audio (state shared across
  cards), compact Starts/Ends nudges. Board inspector: same strip, tools act on the picture shown.
- **Focus after reorder (QA C4).** Moving a focused node in the DOM drops focus to `<body>`. The
  Script view now renders cards in shot order (positions are absolute, so DOM order need not
  follow layout passes), and `moveShotBy` restores focus to the same control (`.select`,
  `.grip`) for a few frames after the edit.
- **Save status (QA B1).** `app.buffered` is set by the script editor while typed text is not an
  edit yet; `app.unsaved = dirty || buffered` drives "Unsaved changes". Commit delay 400 → 300 ms,
  autosave delay 700 → 350 ms: ~0.8 s from the last keystroke to disk (e2e asserts < 1.5 s).
- **Sliders** are styled globally with tokens (`--border-strong` track, `--accent` fill via a
  `--fill` percentage, accent thumb), fixing the white native track in dark themes.
- **Visual check:** `pnpm screenshots` (the `timeline` image became `audio`: a shot's Audio
  section on a cue) run on committed copies of the samples; reviewed with Paper, Darkroom and
  Jinshi Light captures of the Script view, Audio section, menus, context menu, Soundtrack panel
  and Board.

### 0.4.0 — feedback round: shots on any span, calm marking, simple shots, recents (2026-10-06)

- **Span model (format 0.2).** A shot keeps `lines` (every line it touches, so 0.1 readers still
  see something sensible) plus optional `start` / `end` = `{line, offset}` on its first / last
  line, `end` exclusive. Offsets are UTF-16 code units of the line's `text` (markers and inline
  notes removed, emphasis kept) — what agents see in `get_script`, and stable when a line's
  indentation or forcing marker changes. Omitted = whole line, and writers drop offsets that mean
  the whole line, so whole-line shots serialize exactly as in 0.1 (no migration; `format_version`
  becomes 0.2.0 only for new projects or when the first span is added). Considered and rejected:
  storing only offsets without `lines` (breaks 0.1 readers and every line-based helper), raw
  column offsets (break on reformatting), shot markers in the Fountain (the script stays pure).
  The parser now records where each line's text sits in the source (`textStart`, `textMap` when a
  note interrupts it) to convert between offsets and editor positions.
- **Overlap policy: no overlaps, no nesting.** Shots may share a line with disjoint ranges (no
  warning); overlapping text keeps the old `shared-line` warning. `setShotSpan` carves the span
  out of other shots; a shot that loses text in its middle keeps the part _before_ (the rest
  becomes unassigned). The alternatives were worse for the common flow "line in one shot → pick
  'the cops' → pick 'the cars'": keeping the part after as a new shot leaves junk shots like ", ";
  allowing nesting would need stacked marks and ambiguous clicks.
- **Offsets through edits.** One rule everywhere (`mapSpanPos`): text inserted exactly at a span
  boundary stays outside (typing right after a shot's end, or right before its start, does not
  grow it); typing inside grows it; text that replaces part of a span belongs to it; whole-line
  edges (no offset) take text typed at the line's edge up to a line break. Tool and editor edits
  map positions through the exact changes (the editor passes CodeMirror's change list to
  `replaceScriptRange`, so a burst of typing in two places maps exactly; Enter inside a span
  splits it across two lines). `update_line` maps through a word-level diff of the old and new
  line (prefix/suffix alone turned "Honestly, … the trucks" into one change covering every span
  in between). Hand edits, `set_script` and three-way merges map each boundary through its own
  line's word diff, from the side the boundary came from (`remapSpansByText`), then clamp and
  normalize. A span that loses all its text leaves its shot without lines (the shot and its
  pictures stay).
- **Enter, Enter leaves a shot.** `remapShots` places new lines by who owns the _end_ of the line
  above / the _start_ of the line below (character spans aware), and with `paragraph: true`
  (typing in the app) a new line joins the shot above only in the same paragraph. Hand edits keep
  the 0.1 rule (any new line right after a shot joins it) since their intent is unknown.
- **Timing split.** A line covered by several shots shares its duration — the cue length when it
  has a cue, the estimate otherwise — between them in proportion to their characters (unassigned
  characters do not count, so punctuation between shots does not lose time). The line's cue starts
  with its first part and plays across. Minimum shot length stays 1.5 s, except 0.3 s for a shot
  on part of a single line, so pictures follow the voice. (Per-word timing would need word
  timestamps we do not have.)
- **Moving shots that share a line**: `moveShotWithLines` falls back to order only (the text
  cannot move with one shot and stay with another); `placeLines` (Board drag) makes the line whole
  in its new shot.
- **Calm marks.** Gutter bands and handles are gone; marks are a 9 % tint plus a 1.5 px underline
  in the shot colour (hover 16 %, open shot 20 % with a solid underline), only on the words.
  Handles are 2 px bars just outside the open/hovered shot's words (inline widgets with a 12 px
  hit area); dragging snaps to word boundaries (Alt: characters) and may cross lines. The open
  card gets a thin leader from the script's edge to its top, since cards above can push it away
  from its text. Collapsed cards: a 40 px-high thumbnail (sized by the frame's aspect, so 9:16
  stories no longer push the open card far down) and the number.
- **Simple shots.** The card renders sections only when they have content (picture, sound on the
  shot or its lines, details/tags, title); "+" reveals Title, Picture, Sound (the Audio section,
  open) and Details. An empty picture area is a drop target (import + variant in one go).
- **Less chrome.** The hint line and the toolbar row went; Make shot is a small floating button
  next to a selection (and Cmd/Ctrl+Enter, context menu, Shot menu); "Shot without script text"
  lives in the Shot menu, the context menu and the empty state. The Fountain guide replaced the
  link to fountain.io (offline, in our own words).
- **Tab.** Fountain has no tab semantics, so Tab drives element formatting instead (cycle on an
  empty line with an upper-case input mode and a muted hint; parenthetical after a cue/dialogue;
  caps on action). No keyboard trap: CodeMirror's tab-focus mode — Esc then Tab, or Ctrl+M /
  Shift+Alt+M — is documented in the guide, the shortcuts dialog and the editor's label. The old
  bug: the Tab binding returned false on empty/upper-case lines, so the browser moved focus.
- **Recent files.** IndexedDB (`recent` store, keys `r:<id>`, thumbnails under `t:<id>` so
  updating a thumbnail never rewrites a record holding a directory handle), max 5, try/catch
  everywhere. Server entries reopen by URL (storage is per origin, so a server's list shows what
  was opened on that port); folders store their `FileSystemDirectoryHandle` and ask for
  permission on click; packed files keep their bytes (the 0.3 "last file" entry is migrated).
  Headless Chromium crashes when it reads an OPFS directory handle back from IndexedDB, so
  handles of the origin private file system (tests only) are not remembered.
- **Sample.** `cat-crimes` got two split lines through the MCP tools (`split_shot` with `text`),
  reusing its own pictures; the other samples stay whole-line (and valid as 0.1-style shots).
- **Visual check:** headless Chromium captures of the Script view (Paper, Darkroom, Jinshi Light,
  Maomao Dark, Neutral), Board, print view, guide pane and start screen on scratch copies.
  `pnpm screenshots` was run into a temp folder for `cat-crimes`, `salt-and-light` and a copy of the
  committed `midnight-snack`; the README hero (`story-light/dark`) now comes from `cat-crimes`
  (`--shot rate-them`: two shots inside one line, handles on the open one), `audio` from Salt &
  Light, `board` from Midnight Snack; canvas, assets, pdf and new-storyboard did not change.

### 0.4.1 — fix release after the 0.4.0 QA round (2026-10-06)

- **Recent files across ports.** Browser storage is per origin, so every `sbd serve` port had its
  own list. The servers now share `recent.json` in the user's config folder (`$SBD_CONFIG_DIR`,
  else `$XDG_CONFIG_HOME/storyboard-viewer`, else `~/.config/storyboard-viewer`, `%APPDATA%` on
  Windows): path (the key), title, folder/packed, opened-at and a ≤ 28 000-character WebP data
  URI the app sends after it loads (`PUT /api/recent/thumbnail`, validated). At most 10 kept, 5
  shown after merging with the browser's IndexedDB entries (one per path; the shared entry wins,
  with the later time and the browser's picture if it has none). Written atomically (temp file +
  rename), read on every request, failures ignored. Only `sbd serve` and `sbd mcp --serve` record
  (`startServer({ recent: true })`); tests, export servers and the screenshot script do not, and
  the e2e servers, Vitest and `pnpm screenshots` point `SBD_CONFIG_DIR` at temp folders.
- **Reopen mechanism: a viewer per storyboard, not switching.** `POST /api/open {path}` (only
  paths on the shared list, same write protection as other writes) returns this server's URL for
  its own storyboard, the URL of a viewer already running for it (the `$TMPDIR` registry used by
  `get_viewer_url`, checked with `/api/health`), or starts a new server in the same process on the
  next free port after its own and returns that; the page navigates there. Rejected: switching
  the served project in place — an agent's `sbd mcp --serve` and other open tabs would suddenly
  look at a different storyboard than the one they edit, and the store/watcher/SSE wiring is per
  server. The servers it starts close with it. Arbitrary paths (a typed or picked path) are not
  accepted; that keeps `/api/open` from opening any folder on disk.
- **Compact cards.** Details (fields with a value), tags and the variant strip fold into one
  summary row (`7 details · 2 tags · 3 versions`; versions only when more than one) in the
  annotation card and the Board inspector (where it always shows, "Details and tags" when empty,
  since there is no "+" there). One session-wide flag (`sessionStorage`), not per shot: once
  someone wants the details they want them on every card. "+" → Details and tags expands it.
- **Span handles.** Visual stays a 2 px bar; the hit area is an 18 × (1 em + 14 px) pseudo-element
  placed mostly outside the words so clicks on the first/last letter still place the cursor. The
  handles are focusable widgets inside the editor (Esc then Tab reaches them after the text,
  `role="button"` with an aria-label); ←/→ move by a word (`nudgeBoundary`), Alt by a character,
  Esc/Enter return focus. `html.sb-resizing` keeps the resize cursor during a drag.
- **Audio-only shots**: "Add image" becomes a slim row after the sound when the shot has a sound
  or details; the picture-shaped drop target remains for completely empty shots.
- **Playback mark.** The annotation field gets `now: {shot, line, dur, elapsed, paused}` from the
  player whenever the shot, the line or play/pause changes (not per frame): the playing shot's
  marks get `.sb-now-shot` (24 % tint, solid 2 px underline), its marks on the playing line
  `.sb-now` with a CSS-animated accent underline (`background-size` 0 → 100 % over the line's
  animatic time, negative delay for the part already played, `box-decoration-break: slice` so a
  wrapped line has one marker), paused with the player; reduced motion shows the full underline
  still. The line wash and bar only show once playback started (at 0:00 at rest, nothing).
- **Guide pane.** 232 px by default (was 300), 180–480 px by dragging a window-splitter
  (`role="separator"`, ←/→, Home/End, double-click resets), remembered in `sbd:guide-width`.
- **Visual check:** headless Chromium captures (Paper, Darkroom) of the compact card, expanded
  card, handle hover and focus, playback (playing and paused, wrapped line with the guide open) and
  the guide on a scratch copy of `cat-crimes`; `pnpm screenshots` into a temp folder for
  `cat-crimes`, `salt-and-light` and a copy of the committed `midnight-snack`. `story-light/dark`,
  `audio` and `board` changed (folded details and strip) and were replaced; the rest did not change.

### Public release prep (2026-10-06)

- **Hosted copy without `/api` noise.** The app used to probe `/api/health` and `/api/recent` on
  every start (404s in the console on any static host). `sbd serve` now marks the index.html it
  serves; without the marker the app never calls `/api`. Rejected: guessing from the hostname
  (the e2e static server and a local `vite preview` are on localhost too) and a hosted-only build
  flag (the same `dist/` is copied into the CLI).
- **Cloudflare Workers static assets** (`wrangler.jsonc` at the repo root, `apps/web/dist`, SPA
  fallback, no Worker script); `npx wrangler@4`, not a devDependency. `deploy --dry-run` works
  without logging in.
- **Try an example.** Two committed examples (`cat-crimes`, `pips-kite`, 1.8 MiB together) packed
  into `apps/web/public/examples/`; they open like a dropped `.sbd` file (edit in the browser,
  Save asks where). Runtime-cached (StaleWhileRevalidate), not precached, so the first load stays
  small.
- **README** rewritten shorter for non-technical readers; the long how-to moved to `docs/GUIDE.md`
  (with the `sbd` command table, checked by the docs test).

### 0.5.0 — canvas layouts, captions, guided tours, save in place (2026-10-06)

- **Layer model (format 0.3).** One `Layer` type with an optional `kind` (`image` when omitted,
  `text`, `slot`) instead of a union or nested layers, so every 0.1/0.2 layer is unchanged and
  ops keep working on one shape. Text fields are flat (`font_size`, `color`, …) with small
  objects for `stroke`, `shadow`, `box`, so `update_layer` with `null` removes one effect.
  **Slots**: an empty slot is a `kind: "slot"` layer; a filled slot is an _ordinary image
  layer_ (its `x/y/width/height/crop` already place the picture, cover = centered crop) plus
  `slot: {x, y, width, height, fit?, name?}`. Rejected: a slot layer that carries an `asset` and
  is fitted at render time — every older reader would then stretch the picture. Resizing a
  filled slot moves its frame and re-fits the picture (`setSlotFrame`), so it never distorts.
  **Groups** are a shared `group` ID on flat layers, not nested group layers: rendering is
  untouched everywhere (cards, print, video, older readers) and the editor expands a click to
  the group; a group of one dissolves. A project moves to `0.3.0` only when it uses one of these
  (`withLayerVersion`), like spans did for 0.2. Unknown kinds are a warning and are skipped.
- **Layouts and caption styles live in the format package** (`layouts.ts`): fractions of the
  frame, filtered by aspect class (vertical < 0.7, portrait < 0.92, square ≤ 1.08, landscape),
  so the app, MCP (`apply_layout`, `add_text_layer`) and tests place things identically. Applying
  to an existing canvas maps pictures to slots by area (largest first); text stays; placeholder
  text is added only when the canvas has none. Slot layer IDs are the slugged slot names.
- **One text renderer.** `lib/text-render.ts` wraps and draws text with the 2D canvas API; the
  Konva editor draws it through a custom `Shape`, the DOM cards / print view through a
  `<canvas>` per text layer (2× resolution, room for outline and shadow, `data-fonts="loaded"`
  for the print view's readiness), the video export into its frame canvas. Wrapping and glyph
  metrics are therefore identical everywhere (DOM text would wrap differently). Montserrat
  (OFL) was added for the bold caption look; fonts are bundled so PDFs and exports match.
- **Editor interaction is ours, not Konva's dragging.** Nodes are not `draggable`; pointer
  handlers move the whole selection (or the clicked layer's group) by one delta, snap the union
  box (`lib/arrange.ts`, pure and unit-tested) to frame / safe-area / platform / layer / slot
  lines, label the line, and report one `onMove` — Konva's transformer drag proxy would move
  every node with its own drag bound and snap them independently. Alt at the start of a drag
  duplicates (Figma convention); Cmd/Ctrl during a drag moves freely, and a Cmd/Ctrl _click_
  toggles the selection; Alt pressed after the start also frees the drag. A press on a locked
  layer starts a marquee (so a locked background does not block box selection). The view is
  `{zoom, origin}` with "fit" kept until the user zooms or pans; the stage element exposes
  `data-zoom` / `data-origin-*` for tests and computer-use agents; flattening temporarily
  renders at 1:1.
- **Platform safe zones** are fractions of a 1080 × 1920 frame from commonly published guides
  (Meta's Reels guidance: top 14 %, bottom 35 %; TikTok / Shorts creator guides: a right button
  column and a bottom caption block of about 20 %), documented as approximate in
  `lib/safe-zones.ts` and the guide. Shown only on vertical frames.
- **Tours: in-house, not a library.** Evaluated driver.js (MIT, ~5 KB, framework-agnostic) and
  Shepherd.js (now AGPL-3.0 with a commercial license — incompatible with an MIT app); Intro.js
  is AGPL/commercial too; reactour is React-only. driver.js fit the license and size, but its
  steps cannot wait for async view changes (switching tab, opening the animatic) without
  overriding its navigation, it does not move focus into the popover, and its theme is its own
  CSS. A ~250-line Svelte component (`Tour.svelte` + `lib/tours.ts`) does exactly what is needed:
  per-step `prepare()`, waiting for the target, focus management (into the dialog on each step,
  back on close), → / ← / Esc, `prefers-reduced-motion`, theme tokens only. Steps target
  `data-tour="…"` hooks; a unit test checks every target is declared in a component and an e2e
  test walks every tour on the hosted copy with the bundled example. The first-run offer is a
  non-modal corner card, shown once per browser (`sbd:tour-offered` set when shown). E2E tests
  start as a returning user (`storageState` in `playwright.config.ts`).
- **Tooltips**: one shared `role="tooltip"` element driven by an attachment
  (`{@attach tooltip(label, shortcut)}`), shown on hover (delay, warm hand-off) and keyboard
  focus, hoverable, dismissed with Esc, `aria-describedby` while visible; it replaces `title` on
  icon buttons across the app.
- **Save in place.** Under `sbd serve` and MCP, `ProjectStore` writes packed files with
  `writeProjectToPacked`: read the zip, keep media and unknown files, replace the project text
  files, add new media, `packSbd` (media STOREd, mimetype first), write a temp file in the same
  folder and rename it over the original; the first save of a store copies the original to
  `<file>.bak` (one safety copy per session rather than per autosave, which would only hold the
  previous keystroke). Edits of one store are serialized (a packed file is rewritten as a whole).
  Media URLs of packed files are versioned by CRC instead of the file's mtime, so a save does not
  reload every picture. MCP edits packed files the same way (preferred over "unpack first").
  Re-packing rewrites the whole file per save: fine for storyboard-sized files (a few MB to tens
  of MB); very large embedded videos should be linked or the storyboard unpacked.
  In the browser, `showOpenFilePicker` (and dropped files' `getAsFileSystemHandle`, and the PWA
  launch queue) give a `FileSystemFileHandle`; the bytes are copied into memory at open (a
  `File` from a handle becomes unreadable once the file is rewritten), saves write through
  `createWritable`, and autosave is on for these. The handle is kept in the recent list
  (IndexedDB) instead of a copy of the bytes. Without the API (Safari, Firefox) Save downloads a
  copy and says why. The headless e2e uses an origin-private file handle in place of the picker.
- **Soundtrack under the animatic.** With the animatic open, the existing Soundtrack panel is
  rendered inside the stage below the picture (`docked`: tracks first, smaller picture) instead
  of above the playback bar; the Soundtrack button toggles it in both places. No second timeline
  component.
- **Visual check:** headless Chromium captures (Paper, Darkroom) of the Canvas tab on the
  minimal example and on `cat-crimes` (layouts, captions, TikTok zones, text controls), the
  docked soundtrack, the tour popovers; `pnpm screenshots` into a temp folder for `cat-crimes`
  (`--shot twist` for the canvas, `--shot rate-them` for the Story images). `canvas`,
  `story-light` and `story-dark` were replaced.

### 0.5.1 — fix release after the 0.5.0 QA round (2026-10-06)

- **Room for handles.** Fit pads the frame by `FIT_PAD` = rotate-anchor offset (30 px, down from
  Konva's 50) + anchor size (9) + 8 px of air, so a full-frame selection's rotate handle is on the
  stage at Fit. When the view is zoomed or panned so that there is no room above the selection,
  `placeRotater()` tries `rotateAnchorAngle` 0 → 180 → 90 → 270 and keeps the first whose anchor
  lies inside the stage (never while a rotation is in progress); it runs after view changes,
  selection changes, drags and transforms. Rejected: an overflow margin outside the stage (the
  stage fills its host; a margin would only move the clipping) and clamping the anchor (Konva
  computes it from the box).
- **Rotating several layers numerically** uses the same path as the rotate handle: the editor's
  `rotated(ids, deg)` turns each node's origin around the center of the selection's bounding
  box (`rotateAbout` in `lib/arrange.ts`, unit-tested) and returns transformer-style attributes,
  which `transformed()` applies as one undo step ("Rotate layers"). Locked and hidden layers stay.
  Mixed rotations show a blank field with a "Mixed" placeholder; a typed number is then the
  amount to turn by (with a shared rotation it is the new rotation).
- **Platform zone labels** are Konva `Label`s (tag in the platform's color, white text ≥ 4.5:1,
  unit-tested) placed by `placeZoneLabels` (`lib/safe-zones.ts`, pure): each starts in its zone's
  top-left corner (button columns: top-right, turned 90°) and slides along the edge past labels
  already placed, then to the next row / column, so labels never intersect. Kept one label per
  zone rather than merging coincident ones ("TikTok · Reels top bar"): the zones differ in size,
  and a tag in each platform's color says which edge belongs to whom. The platform colors are
  theme-independent `:root` tokens (`--canvas-platform-<id>` and `-fill`), since they are drawn
  over pictures; `--canvas-zone(-line)` were removed. The toolbar buttons carry a matching legend
  square (filled when on). E2E reads the label boxes through `window.Konva.stages`.
- **Tour offer** moved from the bottom-left corner (over Play) to the top right below the header;
  Esc inside it dismisses it. E2E checks it intersects neither the header, `#play-toggle` nor the
  playback bar.
- **Layer rows drag as a whole** with pointer events instead of HTML drag and drop (Chromium does
  not start a drag on the row's name `<button>`): a press that moves 4 px starts the drag, the row
  under the pointer shows the drop line, the click after a drag is swallowed, and presses on the
  row's icon buttons and the rename field are ignored. The grip stays as a visual hint.
- The canvas mask outside the frame is one even-odd shape instead of four rectangles, whose
  shared edges showed as faint lines at fractional zooms. `canvas.webp` was refreshed (new zone
  colors and labels).

### 0.5.3 — phones (2026-10-11)

- **One phone breakpoint, 600 px**, next to the existing 720–1000 px ones; desktop layout is
  untouched. Header: a two-row grid (`brand right` / `tabs tabs`), the source label hidden, only
  the "Updated" note kept on the right. `MenuBar` pops are `position: fixed` 8 px from both
  edges with taller rows. `PlayerBar`: toggle labels in `.lbl` (hidden), compact time, safe-area
  padding; the bar was the element that widened the page to ~552 px. Script editor: 14 px line
  padding, smaller screenplay indents (must come after the base CodeMirror rules in the file).
  `ShotCard` portrait visuals and the inspector's carousel are capped by height (`55vh` / `50vh`
  × frame ratio, `--frame-ratio` from `aspectValue`); the inspector is a full-screen sheet;
  the card's ⋯ menu is always visible (no hover on touch). `#app` is `100dvh` on screen.
  `viewport-fit=cover` for the safe-area insets.
- **Default Story layout** is Board when `(max-width: 600px)` matches and no `story-view`
  preference is stored.
- **Network links.** `startServer` returns `networkUrls` (non-internal IPv4 addresses) when the
  host is `0.0.0.0` or `::`; `get_viewer_url` adds them as `network_urls`, `sbd serve` prints
  them, `sbd mcp` already accepted `--host` (now in its usage line). The write API still has
  only the custom-header and same-origin checks, so this is for trusted networks.
- Checked at 375 × 812 in Chromium (Story Script/Board, Shot details, Canvas, Assets, menus,
  animatic) against a live `sbd serve`; not on a real iPhone/Safari.

### 0.5.2 — fix release: updates reach open tabs (2026-10-07)

- **Root cause of the stuck old version.** `registerType: 'autoUpdate'` together with
  `injectRegister: false`: vite-plugin-pwa only adds `skipWaiting` / `clientsClaim` to the
  generated worker when it injects the registration itself, so the worker waited for a
  `SKIP_WAITING` message, while the `autoUpdate` client code never sends one (it waits for the
  worker to activate on its own). A new worker installed and then waited until every tab and the
  installed app window were closed; a reload does not activate a waiting worker. Reproduced in
  e2e (the update test fails with the old setting).
- **Update flow** (`lib/sw-update.ts`, injected dependencies, unit-tested): `registerType:
'prompt'`; `registration.update()` on load, window focus, `visibilitychange` → visible, `online`
  and every 30 min (bursts rate-limited to one check per 3 s). A waiting worker: `updateAction`
  says `reload` when nothing is unsaved, no save is running and no browser-opened file or folder
  is open (a reload would close it; `sbd serve` reconnects), then `updateSW(true)` and the page
  reloads on `controlling` (or after 4 s if it was not controlled, e.g. after a hard reload);
  otherwise a sticky notice "A new version is ready — Reload" (`update-notice.svelte.ts`, shown
  in `Toasts.svelte`). Reload saves first (`app.save()`) and switches only if nothing is left
  unsaved. A worker activated by another tab reloads this tab only when clean. A tab that turns
  clean switches when it is hidden. Rejected: a worker that skips waiting by itself (would reload
  tabs with unsaved work through the old client code).
- **Caching.** `apps/web/public/_headers` (Cloudflare static assets): `no-cache` for `/`,
  `/index.html`, `/sw.js`, `/registerSW.js`, `/manifest.webmanifest`; `/assets/*` immutable.
  `sbd serve`: only `assets/` is immutable now, everything else (icons, bundled examples
  included) `no-cache`.
- **Version** on the logo's `title` and in Help → About; `window.__sbd.version`.
- **E2E update test** (`e2e/updates.spec.ts`): `e2e/static.mjs --updates` builds a second real
  copy of the app with `SBD_APP_VERSION=<version>-b` and switches between the two builds on the
  same origin (`POST /__e2e/build?use=a|b`). Clean start screen → switches to B by itself; unsaved
  edit → notice, still A with the edit; undo, Reload → B.
- **Single image on the Canvas tab**: `.single` had `height: calc(100% - 24px)` inside the
  stage's grid, whose auto row resolved the percentage against the picture's own height, so a
  720 × 1280 picture was drawn 1256 px tall and cut off by the stage (16:9 overflowed too at
  some window sizes). Now `.stage-host` is a size container and `.single` is
  `min(100cqw − 24px, (100cqh − 24px) × ratio)` wide. Checked every single-image variant of
  cat-crimes, midnight-snack and salt-and-light at three window sizes (Canvas, Story card,
  animatic); e2e checks the 9:16 one.
- **Tour offer** is a slim banner in the page flow below the header (`TourOffer.svelte`) instead
  of a fixed card; e2e checks that it covers no toolbar, control or canvas on Story, Canvas and
  Assets.

## Status

All milestones (M0–M4), the 0.2.0, 0.3.0 and 0.4.0 feedback rounds, the 0.4.1 fix release, 0.5.0 (canvas layouts, captions, tours, save in place) and the 0.5.1, 0.5.2 and 0.5.3 fix releases are complete. Being published: GitHub `swaymun/storyboard-viewer` and a hosted copy of the web app on Cloudflare Workers (`pnpm deploy:web`); no npm package. Known gaps: Safari/Firefox untested; Storyboarder multi-board shots not merged and Shot Generator data dropped; animatic export draws canvas-variant video layers as their first frame; no CLI animatic export; PDF grid cells clip very long text; `sbd export-pdf` output is large for image-heavy storyboards; Kokoro voices were not listened to by a person (timings were checked, quality was not); Script view: shot cards are hidden below 860 px width; phone layout (0.5.3) checked only in Chromium emulation, the editor was only exercised in Chromium; reopening a folder from the recent list was not tested end to end (headless Chromium cannot read stored handles back).
