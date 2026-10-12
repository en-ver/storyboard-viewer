# AGENTS.md — working with Storyboard Viewer

Guide for AI agents (Claude Code, Codex, others) that create or edit `.sbd` storyboards, and for
agents working on this repository. The format itself is specified in [SPEC.md](SPEC.md).

## The short version

1. Use the **MCP tools** of the `storyboard` server (`sbd mcp --serve`). Fall back to the `sbd`
   CLI for things the tools don't do (PDF export, packing, imports, cleanup).
2. `open_storyboard` first (with `create: true` + `preset` for a new one), then `list_shots`.
3. Make changes with the edit tools. Each edit is validated and saved at once; the viewer
   refreshes by itself.
4. Always give the user the viewer link from `get_viewer_url`. In the Claude or Codex desktop app,
   open it in the **in-app browser** so the user sees the storyboard next to the chat.
   If the user is on a phone, the localhost link won't open there: give them one of
   `network_urls` (present when the server runs with `--host 0.0.0.0`; otherwise tell them to add
   that flag to the `sbd mcp --serve` command).
5. Call `validate` after a batch of edits and fix errors before you say you are done.
6. Talk to the user in plain words. Many users are not technical.

## Invariants (do not break these)

- **Never hand-edit `ids.json`.** It maps stable line IDs to script lines and holds the shot
  order. Use `set_lines`, `move_shot`, `insert_lines`, `update_line`, `remove_lines`, `set_script`.
- **Prefer the tools over editing files.** The tools keep IDs stable, validate, write atomically
  and notify the viewer. If you must edit JSON by hand, edit one file at a time and run
  `sbd validate` afterwards.
- **Line IDs (`l_…`) are permanent** for a line's lifetime when edited through the tools. Refer to
  lines by ID, not by text or position.
- **`script.fountain` stays plain Fountain.** No shot markers inside it.
- **Shots never overlap.** A shot covers whole lines or (format 0.2) any span of text; giving text
  to a shot takes it out of other shots.
- **Do not delete media the user may want.** Use `sbd clean <folder>` (dry run) and ask before
  `sbd clean --yes`.
- **Packed `.sbd` files can be edited too** (since 0.5.0): every edit re-packs the file in place
  (temp file + rename, media kept STOREd), and the version from before your first edit is kept
  as `story.sbd.bak`. For many edits or git, an unpacked folder (`sbd unpack`) is still nicer.
- **IDs** match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. Readable IDs (`opening`, `maya-portrait`)
  are welcome.
- Unknown fields must be preserved; never "clean up" fields you don't recognise.

## Typical workflows

**New storyboard from an idea**

1. `open_storyboard { path: "~/Storyboards/cat-mondays.sbd", create: true, preset: "vertical", title: "Cat vs Monday" }`
2. `add_shot` for each beat, with `script_text` (Fountain) and `fields` (field IDs from
   `get_storyboard`, e.g. `beat`, `on_screen_text`, `camera`). Fields are optional: set only
   the ones that matter for that shot (the viewer hides empty fields). Add `tags` (e.g.
   `["act-1", "night"]`); the viewer shows them on each shot and can filter by tag, so reuse
   the same tags across shots. A field the preset does not have can be added for every shot with
   `update_storyboard { shot_fields }` (then it gets a label in the viewer).
3. `get_viewer_url` → give the link / open it in the in-app browser.

Presets: `film`, `documentary`, `animation`, `motion` (brand/motion design), `vertical`
(9:16 TikTok/Reels/Shorts), `blank`. They only pre-fill fields and categories.

**Images**

- `add_asset { path, category }` embeds a file into `media/` (use `mode: "link"` for big videos).
- `add_variant { shot_id, asset_id, name }` adds a visual and makes it the active one (pass
  `activate: false` to keep the current one); `set_active_variant` switches. Keep earlier versions
  as extra variants rather than deleting them.
- Canvas compositions: `add_variant { shot_id, layers: [...] }`. Layers are drawn in array
  order (first = bottom) with Konva-style attributes (`x`, `y`, `width`, `height`, `scale_x`,
  `rotation`, `opacity`, `crop`, `filters` with CSS filter semantics). Coordinates are canvas
  pixels of the storyboard's frame (`get_storyboard` → aspect; usually 1920×1080 or 1080×1920).

**Layouts, captions and layers (format 0.3)**

- `list_layouts` → the layouts that fit this storyboard's frame and the caption styles.
  Vertical 9:16: `full-bleed`, `split`, `picture-in-picture`, `caption-band`, `three-stack`,
  `talking-head-broll`; 16:9: `full-frame`, `two-up`, `lower-third`, `title-card`; 1:1 / 4:5:
  `full-frame`, `two-up`, `stacked`, `caption`, `title-card`.
- `apply_layout { shot_id, layout, images?: [asset IDs in slot order], variant_id?, name? }`
  makes a new canvas variant (shown at once) with named **slots**; with `variant_id` of a canvas
  it moves that canvas's pictures into the slots (largest first) and keeps its text; with an
  image variant, that image goes into the first slot of a new canvas. Slot layer IDs are the
  slot names in lower case (`top`, `bottom`, `main`, `inset`, `b-roll`…).
- `fill_slot { shot_id, slot: "Bottom" | layer ID, asset_id, fit?: "cover" | "contain" }` puts
  a picture into a slot (cover = fill and crop, the default). Empty slots are placeholders the
  user sees while editing; they are not drawn in cards, the animatic, PDFs or videos.
- `add_text_layer { shot_id, text, style?, position?, … }`: captions, hooks, titles. Styles:
  `bold` (heavy white with a black outline: short-form captions), `boxed`, `lower-third`,
  `title`, `subtitle`. Positions: `top`, `middle`, `bottom` (on 9:16 above the TikTok / Reels /
  Shorts buttons and captions), `lower-third`; or `x`, `y`, `width` in canvas px. Any text field
  overrides the style. Keep important text out of the top ~7–14 %, the bottom ~20–35 % and the
  right ~13 % of vertical frames.
- `add_layer { shot_id, layer, index? }`, `update_layer { shot_id, layer_id, changes, index? }`
  (null removes a value; `index` restacks, 0 = bottom), `remove_layer { shot_id, layer_ids }`,
  `update_variant { shot_id, variant_id, name?, background?, layers? }`. Without `variant_id`
  the layer tools work on the shot's active variant (it must be a canvas).
- Layer fields: every layer has `id`, `name`, `x`, `y`, `rotation`, `scale_x`, `scale_y`,
  `opacity`, `visible`, `locked`, and optionally `group` (layers sharing a group ID move together
  in the editor). Image layers: `asset`, `width`, `height`, `crop`, `filters`, `slot` (the frame
  it was fitted into: `{x, y, width, height, fit?, name?}`). Text layers: `kind: "text"`,
  `text`, `width` (wrap width), `font` (`Montserrat`, `IBM Plex Sans`, `Courier Prime`,
  `IBM Plex Mono`) or `font_asset`, `font_size`, `font_weight`, `italic`, `uppercase`, `color`,
  `align`, `line_height`, `stroke {color, width}`, `shadow {color, blur, offset_x, offset_y}`,
  `box {color, padding, radius}`, `style`. Empty slots: `kind: "slot"`, `name`, `x`, `y`,
  `width`, `height`, `fit`.

**Audio: one recording split across lines**

1. `add_asset { path: "vo.mp3", category: "voiceover" }` → `asset_id` (duration is detected).
2. `get_script` (or `list_shots`) to get the line IDs in order.
3. For each line: `add_cue { asset_id, line_id, in, out, track: "dialogue" }` where `in`/`out` are
   seconds in the recording. Line cues also set how long each line lasts in the animatic.
4. Music under everything: `add_cue { asset_id, global_start: 0, track: "music", gain: 0.4, loop: true, fade_out: 2 }`.
   Sound effect on a shot: `add_cue { asset_id, shot_id, offset: 0.5, track: "sfx" }`.

If you don't know the timings, estimate from the text (about 2.6 words per second), tell the user,
and suggest they fine-tune in the shot's **Audio** section in the viewer (click a line → P play →
I / O mark → A assign; it moves on to the next line by itself).

**Shots on part of a line (format 0.2)**

A shot can cover any span of the script: a few words, a sentence inside a dialogue line, or
several shots in one line (one dialogue line "I was running from the cops, the cars…" can have a
shot of the speaker, one of "the cops" and one of "the cars"). Use the exact words:

- `add_shot { line_ids: [line], text: "the cops" }` — a new shot on exactly those words (the
  words leave the shot that had them; that shot keeps the part before them).
- `set_lines { shot_id, line_ids: [line], text: "the cars" }` — move a shot onto those words.
  Instead of `text` you may pass `start_offset` / `end_offset` (characters in the first / last
  line's text, end exclusive); `text` may cross lines with `\n`; `occurrence: 2` picks the second
  match. Without `text` / offsets, `set_lines` covers whole lines.
- `split_shot { shot_id, line_id, text: "Let's rate them." }` (or `offset`) — the text from there
  on becomes a new shot right after it (fields copied, pictures not: add one with `add_variant`).
- `get_script` lists, for a line split between shots, `shots: [{ shot, from, to }]`; `list_shots`
  and `get_shot` show a shot's `span` (`start`, `end`, `text`).
- Offsets follow edits: `update_line`, `insert_lines`, `set_script` and the user's typing keep
  each shot on its words. Prefer `text` over offsets (you see the words; offsets count characters
  of the line's text without Fountain markers).
- Timing: a line split between shots shares its duration (or its audio cue's) between them by the
  number of characters.

**Script**

- Add lines: `insert_lines { text, after_line | before_line | shot }` (Fountain text; a new
  paragraph). Change one line: `update_line`. Replace everything: `set_script` (IDs are
  re-anchored, most survive).
- Character cues are not lines: renaming a character never changes line IDs.
- **Shot order = script order.** `move_shot` moves the shot's script lines along with it (every
  line keeps its ID; a split dialogue block gets its character cue repeated), so the script reads
  in shot order. Pass `move_lines: false` only when you deliberately want the order of shots to
  differ from the script. Shots without lines (B-roll, titles, motion beats) only change order.
- The user may be typing in the script while you edit. Your edits are merged line by line with
  theirs (a line both of you changed keeps the user's version), so prefer small, targeted
  edits (`update_line`, `insert_lines`) over `set_script` while the viewer is open.

## CLI commands agents may run

Run from the repository folder as `node packages/cli/dist/cli.js <command>` (or `pnpm sbd …`):

| Command                                                       | Use                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `validate <path> [--json]`                                    | Check a storyboard (exit code 1 on errors)                       |
| `export-pdf <path> [-o out.pdf] [--layout rows] [--per 6\|9]` | Storyboard sheets PDF (needs Chrome/Edge or Playwright Chromium) |
| `pack <folder>` / `unpack <file.sbd>`                         | Share as one file / make editable                                |
| `import-fountain <file>` / `export-fountain <path>`           | Fountain in/out                                                  |
| `import-storyboarder <scene.storyboarder>`                    | Convert a Storyboarder scene                                     |
| `clean <folder> [--yes]`                                      | Unused media (dry run unless `--yes`)                            |
| `serve <path>`                                                | Viewer without MCP (if `get_viewer_url` finds none)              |

The animatic video export exists only in the app (File → Export animatic video).

## Viewer hooks (for computer-use and tests)

- URL hash: `#tab=story|canvas|assets&view=script|board&shot=<shot-id>` (`#tab=timeline` from
  before 0.3.0 opens the Story tab with the Soundtrack panel); print view:
  `?print=1&layout=grid|rows&per=6&paper=letter|a4`.
- Elements carry `data-shot-id`, `data-line-id`, `data-variant-id`, `data-layer-id`,
  `data-asset-id`, `data-cue-id`; stable ids such as `#save-status`, `#add-shot` (Board),
  `#view-script` / `#view-board`, `#play-toggle`, `#animatic-toggle`, `#soundtrack-toggle`.
- **Menu bar** (`role="menubar"`): `#file-menu`, `#edit-menu`, `#view-menu`, `#shot-menu`,
  `#help-menu`; an open menu is `#<id>-list` (`role="menu"`). F10 focuses it; ←/→ between menus,
  ↓/Enter opens, Esc closes. Many items have `data-command` (`save`, `undo`, `make-shot`,
  `toggle-soundtrack`, `move-shot-up`, …). Appearance is under View; Save automatically and the
  exports under File.
- **Context menus**: right-click or Shift+F10 / the Menu key on the script (acting on the
  selection, or the line at the cursor), a shot card, an asset, or a track in the Soundtrack
  panel. The open menu is
  `[data-context-menu] [role="menu"]`; items carry `data-command` (`make-shot`, `extend-shot`,
  `add-to-previous-shot`, `add-to-next-shot`, `remove-from-shot`, `split-shot-here`,
  `insert-lineless-shot`, `attach-audio`, `play-from-line`, `copy-line-id`, `play-shot`,
  `add-picture`, `duplicate-shot`, `move-shot-up`/`-down`, `delete-shot`, `copy-shot-id`,
  `use-in-shot`, `rename-asset`, `delete-asset`). Esc closes and returns focus.
- **Script view** (default Story layout): the editor is `#script-editor` (CodeMirror,
  `role="textbox"`), with no gutter and no toolbar. Each rendered script line is a `.cm-line` with
  `data-line-id` (anchorable lines) and `data-shot-id` (the first shot on that line;
  `data-shot-ids` lists all when a line is split between shots), plus element classes
  `cm-fx-scene_heading`, `cm-fx-character`, `cm-fx-dialogue`, … (only lines in or near the visible
  area are rendered). A shot's words are marks `.sb-text[data-shot-id]` (`.sb-active` for the open
  shot, `.sb-hover`); the open or hovered shot has drag handles
  `.sb-handle.start/.end[data-handle-shot=<id>]` at the ends of its text (the drag preview is
  `.sb-preview-text`; focusable: Esc then Tab reaches them, ←/→ move a boundary by a word, Alt+←/→
  by a character, Esc/Enter return to the text). During playback the playing line is
  `.cm-line.sb-playing`, the playing shot's marks carry `.sb-now-shot` and its words on the
  playing line `.sb-now` (`.sb-paused` while paused). Shots without script text: `[data-lineless][data-shot-id]`. Cards beside the
  script: `article[data-annotation=<shot-id>]` (`aria-current="true"` when open; `.select`
  opens/closes it, `.grip` reorders, Alt+↑/↓ keeps focus on the moved card; title input
  `[data-annotation-title]` only when the shot has a title or one is being added; `#add-to-<id>`
  is the card's "+" menu with `data-command` `add-title`, `add-picture`, `add-sound`,
  `add-details`; `[data-add-picture=<id>]` is the "Add image" drop target of a shot without a
  picture, a small row (`.slim`) when the shot already has a sound or details). Existing details,
  tags and the variant strip start folded: `[data-shot-summary=<shot-id>]` ("7 details · 2 tags ·
  3 versions", `aria-expanded`) expands them in the card and in the Board inspector
  (`[data-inspector=<id>]`); the choice is kept for the session in `sessionStorage`
  `sbd:shot-more`. Click it before looking for `[data-field]`, `[data-tag]` or the strip's
  "Variant N" buttons. A non-empty selection shows the floating `#make-shot` button (Cmd/Ctrl+Enter);
  `#add-lineless-shot` appears only while the storyboard has no shots (otherwise Shot menu →
  `lineless-shot`, Shift+Cmd/Ctrl+Enter). Typing is committed ~0.3 s after the last keystroke and
  saved ~0.35 s later; `#save-status` reads "Unsaved changes" as soon as you type.
- **Script keys**: Tab is handled by the editor (never inserts a tab, never moves focus): on an
  empty line it cycles Character → Scene heading → Transition → Action (hint `.sb-element-hint`),
  after a name or dialogue it starts a parenthetical. Esc then Tab (or Ctrl+M / Shift+Alt+M on a
  Mac) moves focus out. Enter twice after a shot starts outside it.
- **Fountain guide**: Help → `toggle-guide` shows `#fountain-guide` (left pane, closed with
  `#guide-close` or Esc inside it); remembered in `localStorage` `sbd:guide-open`. Its right edge
  `#guide-resize` (`role="separator"`) resizes it by dragging or ←/→ (width in `sbd:guide-width`).
- **Start screen** (`?source=local`, or File → `open-other` under `sbd serve`): recent storyboards
  `#recent-list li[data-recent=<kind>:<key>]` (`served:<absolute path>`, `server:<url>`,
  `folder:<name>`, `zip:<name>`) with an Open button and a Remove button each, `#clear-recent`;
  at most 5, one per storyboard path. `served:` entries come from the list that every
  `sbd serve` / `sbd mcp --serve` shares in the user's config folder
  (`~/.config/storyboard-viewer/recent.json`, `$XDG_CONFIG_HOME/storyboard-viewer/`, or
  `$SBD_CONFIG_DIR` — set it in tests), so they show on every port; opening one asks the server
  (`POST /api/open`) for a viewer: the running one, or a new server on the next free port. The
  others are this origin's IndexedDB (`storyboard-viewer` → `recent`).
- Shot details: rows `[data-field=<field-id>]`; values, "Add detail" and tags are free-text
  comboboxes whose suggestions are `[role="listbox"] [data-suggestion]` (no `<select>`); tags
  `[data-tag]`, tag filter buttons `[data-filter-tag]`.
- **Audio** (in the open card and the Board inspector): `[data-audio-section=<shot-id>]`
  (`.sec-head` expands it in cards), its lines `[data-audio-line=<line-id>]` (`aria-pressed` =
  selected) with cue badges `[data-cue-id]`, `#audio-source[data-source-id]` (opens the asset
  picker), waveform `[data-waveform]`, `#preview-segment` (P), `#mark-in` / `#mark-out` (I / O),
  `#assign-line` (A), `#add-shot-sound`; the selected cue's details `.cue-panel[data-cue-id]`
  with `#delete-cue`. Keys I / O / P / A / ↑ / ↓ / Delete / Esc work while focus is inside.
- **Soundtrack panel** `#soundtrack` (View → Soundtrack or `#soundtrack-toggle`; with the
  animatic `#animatic` open it sits inside it, under the picture): story-wide
  cues `.story-cues [data-cue-id]`, `#add-story-sound`, `#add-story-cue` (add the marked
  segment), lanes `.lane[data-track]` with buttons "Mute <track>" (preview), "Solo track
  <track>", "Mute track <track>" (saved) and a gain slider.
- **Canvas tab**: the Konva stage `.stage[data-variant-id]` (`role="application"`, focusable; its
  `data-zoom`, `data-origin-x`, `data-origin-y` give the frame's screen position: screen =
  stage box + origin + canvas px × zoom). Toolbar: `#new-canvas`, `#apply-layout`, `#add-layer`
  (image), `#add-text`, `#toggle-guides`, `[data-platform="tiktok|reels|shorts"]` (vertical
  frames), `#toggle-snap`, `#zoom-out`, `#zoom-100` (`#zoom-level`), `#zoom-in`, `#zoom-fit`.
  Layout picker `#layout-picker [data-layout=<id>]` (`blank` for an empty canvas). Layer list
  `#layer-list li[data-layer-row=<id>]` with `button.name[data-layer-id]`, hide / lock and
  `[data-delete-layer=<id>]`; group headers `[data-group-id]`. Selection panel: `[data-align=left|hcenter|right|top|vcenter|bottom]`,
  `[data-distribute=x|y]`, `#align-to` (radio: selection / frame), `#group-layers`,
  `#ungroup-layers`, `#duplicate-layers`, `#delete-layers`, fields labelled X, Y, W, H,
  Rotation °; text: `#text-content`, `[data-caption-style]`, `[data-font]`, `[data-text-color]`,
  `[data-text-align]`, `#text-outline`, `#text-shadow`, `#text-box`; inline editor
  `#text-editor`. `#snap-status` (live region) says what a drag snapped to. The one-time hint
  strip is `#canvas-hint` (`localStorage` `sbd:canvas-hint-done`); view toggles are remembered
  in `sbd:canvas-guides`, `sbd:canvas-snap`, `sbd:canvas-platforms`.
- **Guided tours**: Help → `[data-command="tours"]` → `tour-<id>` (`getting-started`, `script`,
  `canvas`, `assets`, `audio`, `agent`). The popover is `#tour` (`data-tour-id`,
  `data-tour-step`, `data-target-found`), with `#tour-next` / `#tour-back`; → / ← / Esc work.
  Steps point at `[data-tour="…"]` hooks. The first-run offer `#tour-offer` shows once per
  browser (`localStorage` `sbd:tour-offered`).
- **Tooltips**: icon buttons show their label and shortcut in a shared `#sbd-tooltip`
  (`role="tooltip"`, on hover and keyboard focus, Esc hides it).
- Theme: `data-theme` on `<html>` (`paper`, `darkroom`, `neutral`, `neutral-light`,
  `maomao-dark`, `maomao-light`, `jinshi-dark`, `jinshi-light`); View → Appearance; stored in
  `localStorage` `sbd:theme` (`system` or a theme ID) and `sbd:theme-pair`.
- `window.__sbd` exposes app state for debugging (not a stable API).

## Working on this repository

- `pnpm install && pnpm build`, then `pnpm test`, `pnpm lint`, `pnpm test:e2e` must pass.
- Layout: `packages/format` (format logic, browser-safe), `packages/cli` (CLI, HTTP server, MCP),
  `apps/web` (Svelte 5 PWA), `schema/` (JSON Schemas, source of truth), `e2e/` (Playwright).
- Edit ops are pure functions in `packages/format/src/ops.ts`; the app, the server and the MCP
  tools all use them. Add tests next to the change. See [CONTRIBUTING.md](CONTRIBUTING.md).
- Decisions and milestone notes live in [PLAN.md](PLAN.md).
