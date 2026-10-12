# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Build-once Docker image and runtime-only Compose examples for separate localhost viewers,
  with nonroot permissions, private configuration, and manual deployment instructions.
- Documented stale browser refresh after newly host-created folders on macOS with OrbStack
  2.2.3. Create folders before startup or save and pause editing, then restart the affected service.
  Docker Desktop and native Linux refresh remain unverified. No polling fallback is included.

## [0.5.3] — 2026-10-11

### Fixed

- **Works on phones, at least for viewing.** Below 600 px wide: the menus sit on the first row
  of the header and Story / Canvas / Assets on a second, full-width row (they used to overlap);
  menus open across the screen instead of off its right edge; the player bar keeps play, the
  time, the scrubber and icon-only Soundtrack / Animatic buttons (it used to push the page to
  about 550 px wide, so the phone zoomed out); the script uses slimmer margins and indents, so
  dialogue isn't three words a line; vertical (9:16) pictures on the Board and in the animatic
  are about half the screen tall instead of more than a full screen; Shot details open as a
  full-screen sheet; Assets show two cards a row. The app fills the visible height, so the
  player bar is not hidden under the browser's toolbar.
- Phones open the Story tab on the Board (pictures with their script lines) until you pick a
  layout; the Script view hides its shot cards on small screens.

### Added

- **Watch your agent from your phone.** `sbd mcp --serve --host 0.0.0.0` (and `sbd serve
--host 0.0.0.0`) listens on your network: `get_viewer_url` then also returns `network_urls`,
  links that open from a phone on the same Wi-Fi or tailnet, and `sbd serve` prints them. The
  viewer has no sign-in, so only do this on a network you trust (Tailscale is a good fit).

## [0.5.2] — 2026-10-07

### Fixed

- **New versions reach open tabs.** The browser app could keep showing an old version after an
  update, for good: the new version was downloaded but waited for every tab to close, and the app
  never told it to start. Now the app looks for a new version when it opens, when you come back
  to the window and every 30 minutes. With nothing unsaved it reloads into the new version by
  itself; with unsaved changes (or a file opened in the browser, which a reload would close) it
  shows **A new version is ready — Reload**, and Reload saves first. Your work is never thrown
  away. The hosted copy and `sbd serve` always revalidate the page, the service worker and the
  manifest, so a deploy or a rebuild is seen at once (hashed files stay cached).
- **A single image on the Canvas tab fits its frame.** A portrait (9:16) picture showed at its
  own pixel size, cut off by the canvas area; it is now shown whole and as large as fits.
- The first-launch tour offer is a slim bar below the header instead of a card that covered the
  right end of the Canvas toolbar (Flatten, Group).

### Added

- The app's version shows when you hover the logo (and in Help → About).

## [0.5.1] — 2026-10-06

### Fixed

- **Rotate handle at Fit.** Fit now leaves room around the frame for every transform handle, so a
  full-frame selection can be rotated right away; the rotate handle also moves below or beside the
  selection when there is no room above it (zoomed or panned), instead of being cut off.
- **Platform safe zones together.** With TikTok, Reels and Shorts on at once, their labels no
  longer print over each other: each is a small tag in its platform's color, placed side by side
  (or down the button column) so they never overlap. Each platform's zones have their own color,
  shown as a legend next to its toolbar button; readable in every theme.
- The first-launch tour offer sits at the top right below the header instead of over the Play
  button; **No thanks** or **Esc** closes it.
- No faint lines along the frame's edges across the canvas at some zoom levels.

### Changed

- **Rotation for several layers**: the Rotation field works with a multi-selection and turns the
  layers together around the selection's center (one undo step). It shows the shared value, or
  stays blank ("Mixed") when the rotations differ; a number then turns them by that much.
- **Layer list**: drag a row anywhere (not just its grip) to reorder; clicks on the row's hide,
  lock and delete buttons, double-click to rename and **Alt+↑/↓** work as before.

## [0.5.0] — 2026-10-06

### Added

- **Layouts for the canvas.** Start a canvas from a layout that fits the frame, or re-arrange an
  existing one (**Layout**): vertical 9:16 — full bleed, split top / bottom, picture in picture,
  bottom caption band, three stacked frames, talking head + B-roll; 16:9 — full frame, two-up,
  lower third, title card; plus layouts for 1:1 and 4:5. Layouts place named **slots**: drop a
  picture on a slot to fill it (cover, or **Fit in slot**). Empty slots show only while editing.
- **Text layers**: captions, hooks and titles typed right on the frame, with caption styles
  (Bold short-form captions with an outline, Boxed, Lower third, Title, Subtitle), bundled fonts
  (IBM Plex Sans, Montserrat, Courier Prime, IBM Plex Mono, or the storyboard's own font
  assets), size, weight, alignment, color swatches, outline, shadow and box. They look the same
  in the editor, the cards, the animatic, video export and PDF.
- **Platform safe zones** for vertical video: TikTok, Reels and Shorts show (approximately) where
  their buttons, captions and top bars cover the picture, next to the title / action safe areas.
- **Selecting and arranging**: Shift- or Cmd/Ctrl-click and drag a box to select several layers,
  Cmd/Ctrl+A, Esc; move, resize and rotate them together; align (to the selection or the frame),
  distribute, **group / ungroup** (Cmd/Ctrl+G), duplicate (Cmd/Ctrl+D or Alt-drag), Fit / Fill /
  Center, and exact X / Y / W / H / rotation fields.
- **Snap to guides** shows what a drag snapped to (frame edge or center, safe area, platform
  zone, another layer, a slot); hold Cmd/Ctrl to move freely.
- **Zoom** (Cmd/Ctrl+ +/−/0, 100 %, Fit) and panning (scroll, Space-drag) on the canvas.
- **Layer list**: hide, lock and delete (×) on every row, drag rows (or Alt+↑/↓) to reorder,
  group headers; Delete / Backspace removes the selection; everything can be undone.
- **Guided tours** (Help → Guided tours): Getting started, Script & shots, Canvas & layouts,
  Assets, Audio & soundtrack, Working with your AI agent. The first visit offers Getting started
  once. Keyboard: → / ← / Esc.
- **Tooltips** with keyboard shortcuts on icon buttons across the app (also on keyboard focus).
- A one-time hint strip the first time you use the canvas.
- **Save in place for `.sbd` files**: in Chrome and Edge, a `.sbd` opened with **Open .sbd file**
  (or dropped on the start screen, or opened from the installed app) saves — and autosaves — back
  into the same file, and reopens from the recent list. Safari and Firefox download a copy and
  say so.
- MCP tools `list_layouts`, `apply_layout`, `fill_slot`, `add_text_layer`, `add_layer`,
  `update_layer`, `remove_layer` and `update_variant`; `add_variant` accepts text and slot
  layers. The cat-crimes example uses layouts with captions.

### Changed

- **Packed `.sbd` files are editable under `sbd serve` and through the MCP tools.** Every save
  re-packs the file atomically (written next to it, then renamed over it; media stay STOREd),
  and the version from before the first save of a session is kept as `<file>.bak`. The
  "read-only" mode and its "How to edit" notice are gone.
- With the **Animatic** open, the **Soundtrack** (track lanes with cues, playhead, mute / solo /
  volume) shows directly under the animatic's picture.
- Snapping is called **Snap to guides**; the canvas toolbar buttons have labels.
- **Format 0.3** (SPEC §6, §10): layers may have `kind` `text` or `slot`, text fields, a `slot`
  frame on pictures fitted into a slot, and a `group` ID. 0.1 and 0.2 files stay valid; a
  project becomes 0.3.0 only when it uses one of these.

### Fixed

- **Live refresh on Linux**: `sbd serve` missed the second agent (MCP) edit of the same file, so
  the open app did not update. Node's recursive `fs.watch` on Linux watches each file, and those
  watches go stale when a file is replaced by an atomic rename; the server now watches each folder
  instead (macOS and Windows keep the native recursive watch; `SBD_WATCH=native|per-directory`
  overrides).

## [0.4.1] — 2026-10-06

### Added

- **Recent storyboards across ports**: `sbd serve` and `sbd mcp --serve` keep one shared list of
  the storyboards they served in `~/.config/storyboard-viewer/recent.json` (or
  `$XDG_CONFIG_HOME/storyboard-viewer/`, or `$SBD_CONFIG_DIR`), with the title, path, kind, when
  and a small picture. The start screen merges it with the browser's own list (one entry per
  storyboard, at most five), so a storyboard opened on :4442 shows on :4443 too. Opening one goes
  to its running viewer, or starts one on the next free port. Server API: `GET /api/recent`,
  `DELETE /api/recent[?path=]`, `PUT /api/recent/thumbnail`, `POST /api/open` (only paths on the
  list; writes need the app's header and the same origin).
- Span handles work from the keyboard: **Esc** then **Tab** reaches them, **←**/**→** move a
  boundary by a word (**Alt** for a character).
- The Fountain guide can be resized by dragging its edge (or ←/→ on it); the width is remembered.

### Changed

- **Compact shot cards**: existing details, tags and extra picture versions fold into one quiet
  summary row ("7 details · 2 tags · 3 versions") in the Script view card and the Board
  inspector; click or Enter expands them, and the choice holds for the session. The picture,
  sound and title stay visible.
- Span handles are easier to grab: a larger invisible hit area (18 px wide, the line's height plus
  14 px), a resize cursor while hovering and dragging, a slightly bolder bar on hover and a focus
  ring.
- A shot with a sound (or details) but no picture offers **Add image** as a small row under the
  sound instead of a large box; the large drop target stays for completely empty shots.
- **Clearer playback**: the playing line gets a faint wash, the playing shot's words a stronger
  tint and underline, and its words on the playing line a thin accent marker sweeping under them
  in time (a still underline with reduced motion); nothing is marked at rest.
- The Fountain guide pane is narrower by default (232 px instead of 300 px).

## [0.4.0] — 2026-10-06

### Added

- **Shots on any span of text** (format 0.2): a shot can be a few words, a whole line, several
  lines, or one of several shots inside one line (the speaker, "the cops", "the cars"). Select
  words and press Cmd/Ctrl+Enter or the **Make shot** button that appears by the selection: one
  action, no form. Drag the small handles at the ends of the open or hovered shot to change what
  it covers (snaps to words, Alt for single characters, across lines); **Extend shot to
  selection** in the context menu and the Shot menu; **Split shot here** splits at the cursor.
- **Simple shots**: a shot can be just a picture, just a sound, or both. A card shows only what
  the shot has: the picture (or an **Add image** drop target: click or drop a file), its sound,
  its title. Title, details, tags and sound come from the card's **+** menu.
- **Recent storyboards** on the start screen: the last five opened (served by `sbd serve`,
  folders, packed files) with a small picture, where they came from and when; one click reopens
  (folders ask for permission again, packed files open from their saved copy); remove one or
  clear the list. File → **Open another storyboard…** reaches it from a served storyboard.
- **Fountain syntax guide**: Help → Fountain syntax guide opens a cheat sheet in a closable pane
  left of the script (remembered; Esc or × closes it).
- **Screenwriting Tab**: on an empty line Tab cycles Character → Scene heading → Transition →
  Action (Shift+Tab back); after a name or dialogue it starts a parenthetical; on action text it
  makes capitals. It never inserts a tab and never leaves the editor; **Esc then Tab** (or
  Ctrl+M / Shift+Alt+M on a Mac) moves focus on.
- MCP: `add_shot` and `set_lines` take `text` (the exact words) or `start_offset` /
  `end_offset`; new `split_shot` (at a line or inside it); `get_script`, `list_shots` and
  `get_shot` report spans.
- Format: `setShotSpan`, `splitShot` at an offset, span-aware `mergeShots`, `spans.ts` helpers
  (segments, mapping through edits, carving, `locateSpan`), Fountain text positions
  (`textOffsetToSource`, `sourceToTextOffset`).
- The `cat-crimes` sample splits two lines into two shots each.

### Changed

- **Calmer shot marking**: no coloured bands or numbers in the margin. A shot's exact words get
  a light tint and a thin underline in its colour (not the space around them), stronger on hover
  and for the open shot; the open card is joined to its text by a thin leader line. Collapsed
  cards are a small thumbnail and the number (and title, when there is one).
- **Enter, Enter leaves a shot**: a line typed after a blank line below a shot is outside it; one
  Enter (same paragraph) still continues it. Text typed right after the end of a shot's span stays
  outside; typing inside a span grows it.
- The hint line and the toolbar above the script are gone (the editor is the page); "Shot without
  script text" is in the Shot menu and the context menu (and offered while a storyboard is empty).
- Board view and printed sheets show a partial shot's words only ("…Let's rate them.").
- A line split between shots shares its time in the animatic in proportion to the characters
  each shot covers; a cue on the line starts with its first part.
- Moving a shot that shares a line with another shot only changes the shot order (its text cannot
  move without the other shot's).
- `format_version` is `0.2.0` for new storyboards and when the first span is added; 0.1 files
  open and validate unchanged. The JSON Schema IDs are `urn:sbd:schema:0.2:*`.

### Fixed

- A menu whose items are all disabled now keeps focus on its title, so Esc closes it.

## [0.3.0] — 2026-10-06

### Added

- **Menu bar**: File, Edit, View, Shot and Help across the top, with keyboard shortcuts shown
  (WAI-ARIA menubar: F10 to reach it, ←/→ between menus, ↓/Enter to open, Esc to close, type a
  letter to jump). The `⋯` menu is gone: Appearance is under View, saving and exports under File.
  Help → Keyboard shortcuts (also **?**) and About.
- **Context menus** (right-click, Shift+F10 or the Menu key): on script lines (make shot from
  selection/line, add to previous/next shot, remove from shot, split shot here, insert shot
  without lines here, attach audio to line, play from here, copy line ID), on shots (bands,
  cards, Board cards: play, add picture, insert after, duplicate, split, merge, move up/down,
  copy shot ID, delete), on assets (use in the selected shot, rename, copy ID, delete) and on
  Soundtrack tracks.
- **Audio in each shot**: the shot card (and the Board inspector) has an Audio section with the
  shot's lines and their cues, sounds on the whole shot, a compact waveform trim editor and the
  cue's settings (plays on line/shot/story, track, gain and mute, fades, offset, loop). The fast
  way to split one recording keeps working: click a line, P, I / O, A; the next line is selected
  — also when it is in the next shot, whose card opens with focus on that line.
- **Soundtrack panel** (View → Soundtrack or the playback bar): music and sounds under the whole
  story with their trim editor, and all cues on their tracks with mute and solo (while
  previewing), "muted in the storyboard" (saved) and track gain.
- Free-text inputs with suggestions (`SuggestInput`) and side-by-side choices (`Segmented`).

### Changed

- **The Timeline tab is folded into the shots** (tabs are Story, Canvas, Assets; keys 1–3).
  `#tab=timeline` links open the Story tab with the Soundtrack panel.
- **Script highlighting** tints only the words of a shot's lines (no full-width line backgrounds,
  nothing on blank lines), with a thin band in the margin. **No shot numbers in the script
  gutter** (the number is on the card); boundary handles appear when you hover a shot.
- **No dropdowns.** Shot details are free text; preset values (shot size, movement, transition…)
  and values used on other shots are offered as suggestions that pop up when you focus the
  field. The same for Add detail, tags, cue tracks, asset categories (a new name creates the
  category) and project settings (preset, aspect ratio). Fixed choices (PDF layout, paper, video
  quality, frame rate, field types) are shown side by side. "select" fields are now "Suggestions".
- **Cleaner shot cards**: the title is edited in place (no second "Title" field), a smaller
  picture, variants as a thumbnail strip (the picture shown is outlined, the default has a dot;
  no "image" / "Active" labels), Details and Audio sections that fold, compact line controls.
  The Board inspector got the same variant strip with tools for the picture shown.
- Sliders (playback bar, gain, zoom, canvas opacity and filters) use theme colours: no more bright
  white tracks in dark themes.
- The packed-file source label reads ".sbd file" (it clashed with the File menu).

### Fixed

- Moving a shot card with Alt+↑/↓ (or the grip, or the menus) keeps keyboard focus on it, so
  consecutive moves work (QA C4).
- The save status says "Unsaved changes" as soon as you type (it said "Saved" until the typed
  text was committed), and typed text reaches the disk sooner: commit after 0.3 s, autosave
  0.35 s later (about 0.8 s after the last keystroke instead of about 1.2 s; QA B1). With
  autosave on, the Save button no longer flickers in and out while typing.

## [0.2.0] — 2026-10-06

### Added

- **Script editor with shot annotations** (Story tab → Script, the new default): the whole
  script is one plain-text Fountain editor (CodeMirror 6) formatted as a screenplay while you
  type. Shots are highlighted ranges of lines, Genius-style: a coloured gutter band with drag
  handles for the first/last line, and the shot's card beside the script (picture with variant
  carousel, title, details, tags, cues). Make shot from selection (Cmd/Ctrl+Enter), shot without
  lines (Shift+Cmd/Ctrl+Enter), reorder by dragging cards (Alt+↑/↓ from the keyboard). Line IDs
  survive typing; typing is one undo step per burst; agent edits merge while you type.
- **Board view** keeps the classic cards; drag lines between shots (Alt+↑/↓), double-click a line
  to edit it in the script.
- **Themes**: Paper, Darkroom, Neutral Pro, Neutral Pro Light, and Maomao/Jinshi Dark/Light
  (adapted from the MIT-licensed Apothecary Diary VS Code theme), plus System (light/dark pair of
  your choice). ⋯ menu → Appearance; remembered per browser. New type: IBM Plex Sans/Mono and
  Courier Prime (bundled, offline).
- **Optional shot details**: only fields with a value are shown; "Add detail" suggests preset
  fields or creates a new field on the spot. **Tags** on every shot (type + Enter, autocomplete,
  remove) and a tag filter in the Story tab.
- Format: `replaceScriptRange` (free-form edits keeping line IDs), `moveLines`,
  `moveShotWithLines`, `placeLines`; `mergeProjects` merges scripts line by line (diff3) and shot
  line lists as sets.
- MCP: `move_shot` moves the shot's script lines too (`move_lines: false` keeps the old
  order-only behaviour); `add_shot` accepts `tags`; tool descriptions explain optional fields and
  tags.
- Five example storyboards in `examples/` (see `examples/README.md`): a comedy short, a
  documentary, a vertical TikTok-style video, a motion-design launch film and an animated short,
  with generated pictures, Kokoro voices and synthesized music and sound effects.
- README: example storyboards section with an animatic GIF; screenshots show the examples, the
  Script and Board views; Credits section.
- `pnpm screenshots -- --shot <id>` also uses that shot for the canvas screenshot; it now also
  writes `board.webp`.

### Changed

- Reordering shots in the app keeps script order and shot order the same (lines move).
- The per-line editor and the "Add line" composer (type dropdown) were replaced by the script
  editor.
- Agent script edits no longer conflict with a user editing other lines of the script.
- Every UI color comes from theme tokens; print sheets stay black on white.

### Fixed

- Vertical (9:16) storyboards: the animatic frame no longer overflows the window, and the Story
  tab shows portrait frames at a scannable size.

## [0.1.0] — 2026-10-06

First public version.

### Format

- `.sbd` format 0.1.0 ([SPEC.md](SPEC.md), JSON Schemas in `schema/`): folder and packed (zip)
  forms, Fountain script with stable line IDs, shots with image and canvas variants, assets
  (embedded, linked, remote/HLS), timeline cues with trimming, fades and loops.
- Presets: Blank, Film / Short, Documentary, Animation, Motion / Brand, Short-form vertical (9:16).

### App

- Story, Canvas, Timeline and Assets tabs; animatic playback with mixed sound.
- Editing with undo/redo, autosave, live refresh and merging of agent edits with unsaved changes.
- New storyboard flow with preset picker.
- Exports: PDF storyboard sheets (print view), animatic video (MP4/WebM, WebCodecs), Fountain
  script, packed `.sbd`, folder.
- HLS (`.m3u8`) playback via hls.js where the browser has no native support.
- Works offline (installable PWA).

### Command line and agents

- `sbd` commands: `new`, `validate`, `pack`, `unpack`, `import-fountain`, `export-fountain`,
  `import-storyboarder`, `export-pdf`, `clean`, `serve`, `mcp`.
- MCP server with tools to open, inspect and edit storyboards, attach media and timing, validate,
  and get the viewer link; `--serve` runs the viewer in the same process (next free port if 4400
  is taken).
- Copy-paste setup prompt for Claude Code and Codex, `AGENTS.md`, optional agent skill.
