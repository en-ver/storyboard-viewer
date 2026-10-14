---
name: storyboard-viewer
description: Create and edit .sbd storyboards (shots, Fountain script, images, voice-over timing) with the Storyboard Viewer MCP tools, and show the live viewer to the user. Use when the user asks for a storyboard, shot list, animatic, or mentions a .sbd file.
---

# Storyboard Viewer

You edit storyboards through the `storyboard` MCP server (tools such as `open_storyboard`,
`add_shot`, `add_asset`, `add_variant`, `add_cue`, `validate`, `get_viewer_url`). The user watches
the result live in the viewer.

## Authority and source selection

Edit only the storyboard and local media that the user authorizes.
This skill does not authorize deployment, installation, MCP client registration, AI generation, provider uploads, or spending.
It does not authorize a general asset catalog or media pipeline.

For a native server workspace, choose an actual writable unpacked Projects path.
Docker uses `/projects/<name>.sbd` inside the container.
Examples and packed Projects are read-only in workspace mode.
Do not use independent MCP or CLI writes to bypass that policy.
Use an explicitly authorized Copy to Projects or unpacked copy instead.
Copy keeps original rights and source records.

The MCP process has its own selected path. It does not follow the browser's current tab selection.
An unbound stdio `mcp` process can open the actual path with `open_storyboard`.
For an existing viewer, do not add `--serve` or invent a `--project` option.
Read the [README](../../README.md#run-with-docker) for setup, stdio connection, and Docker CLI patterns.
The README owns those commands. This skill owns storyboard editing boundaries.

Use `get_viewer_url` for an existing viewer.
For container discovery, use the real host browser origin and the selected scoped project path.
Do not guess the host port or give the user an internal container URL.
Before filesystem Rename, save browser work and pause cooperating external writers.
Reopen the renamed path in independent MCP sessions.
Physical Rename differs from narrative-title edits.
If deployment configuration pins the old basename, the operator must update it before restart.

## Every time

1. `open_storyboard` (use `create: true` and a `preset` for a new one: film, documentary,
   animation, motion, vertical, blank). Then `list_shots` to learn shot and line IDs.
2. Call `get_viewer_url` and show the viewer: in the Claude or Codex desktop app open the link in
   the in-app browser; otherwise give the user the link.
3. Make edits with the tools (never hand-edit `ids.json`; refer to lines by their `l_…` IDs).
4. Run `validate` after a batch of edits and fix errors.
5. Explain what you changed in one or two plain sentences.

## Recipes

- **Shots with dialogue:** `add_shot { title, script_text: "MAYA\nWe should go.", fields: {...}, tags: [...] }`.
  Fill only the fields that matter (empty ones are hidden); reuse existing tags.
- **Shots inside a line:** a shot can cover just some words, and one line can hold several
  shots: `add_shot { line_ids: [line], text: "the cops" }`, `set_lines { shot_id, line_ids, text }`,
  `split_shot { shot_id, line_id, text }` (or character `start_offset` / `end_offset`).
- **Reorder:** `move_shot { shot_id, index }` moves the shot's script lines too, so the script
  reads in shot order (`move_lines: false` = order only).
- **Picture for a shot:** `add_asset { path }` then `add_variant { shot_id, asset_id }`.
- **Layouts and captions (vertical video):** `list_layouts`, then
  `apply_layout { shot_id, layout: "split", images: [assetA, assetB] }` (split, picture-in-picture,
  caption-band, three-stack, talking-head-broll, full-bleed; two-up, lower-third, title-card for
  16:9) and `add_text_layer { shot_id, text, style: "bold", position: "top" }` (styles bold,
  boxed, lower-third, title, subtitle). Fill an empty slot with `fill_slot { shot_id, slot: "Bottom", asset_id }`;
  change layers with `update_layer` / `remove_layer`. Keep captions out of the bottom fifth and
  the right edge of 9:16 frames (the apps' buttons and captions sit there).
- **One voice-over split across lines:** `add_asset { path: "vo.mp3" }`, then for each line
  `add_cue { asset_id, line_id, in, out, track: "dialogue" }` (seconds inside the recording).
- **Background music:** `add_cue { asset_id, global_start: 0, track: "music", gain: 0.4, loop: true }`.
- **PDF:** use the installed CLI procedure in the [user guide](../GUIDE.md#the-sbd-command).
  CLI export needs an installed browser. The Docker runtime contains none.
  Do not install one without separate authority.

The full editing guide is [AGENTS.md](../../AGENTS.md). The format is in [SPEC.md](../../SPEC.md).
For workspace browser behavior, read the [user guide](../GUIDE.md#server-workspace).
Packed legacy writes create adjacent backups. Prefer an authorized unpacked copy for production edits.
