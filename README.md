<div align="center">

<img src="apps/web/public/icon.svg" width="72" height="72" alt="" />

# Storyboard Viewer

**Plan your video shot by shot. Your AI agent does the busywork, and you watch every change
appear live.**

[![License: MIT](https://img.shields.io/badge/license-MIT-b86b00.svg)](LICENSE)
[![CI](https://github.com/swaymun/storyboard-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/swaymun/storyboard-viewer/actions/workflows/ci.yml)
![Works offline](https://img.shields.io/badge/works-offline-3d434e.svg)

### [Open the app in your browser][app] · [Set it up with your AI agent](#use-it-with-your-ai-agent)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/story-dark.webp" />
  <img src="docs/images/story-light.webp" alt="Storyboard Viewer: the script, with each shot marked on its words (two shots inside one line), and the open shot's picture beside it" width="900" />
</picture>

</div>

## What it is

Storyboard Viewer is a free storyboard app for any kind of video: short films, documentaries,
animation, brand videos and vertical TikTok / Reels / Shorts. You write the script, mark which
words go with which shot, and add pictures, voice-over and music. Tell your AI agent (Claude Code
or Codex) what you want and it builds the storyboard for you while you watch. No account, no
cloud: your storyboards are ordinary files on your computer.

- **Watch your agent work.** Its changes show up in the viewer within a second.
- **Script first.** Write like in a screenwriting app; select some words and press **Make shot**.
- **Pictures and sound per shot.** Alternate versions, voice clips per line, and a canvas with
  ready-made layouts (split screen, picture-in-picture, caption band…), captions in a few styles,
  and TikTok / Reels / Shorts safe zones for vertical video.
- **Play it as an animatic.** Press Space to play the story with voice, music and effects.
- **Export.** PDF storyboard sheets, an MP4 animatic, the script, or one `.sbd` file to share.
- **Import.** [Fountain](https://fountain.io) scripts and
  [Storyboarder](https://wonderunit.com/storyboarder/) scenes.
- **Works offline,** with eight light and dark themes, full keyboard support, and short guided
  tours (Help → Guided tours).
- **Saves where it came from:** folders, `sbd serve` and (in Chrome and Edge) `.sbd` files save
  back into the same place.

|                                                                             |                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ![Story tab, Script view](docs/images/story-light.webp)                     | ![Story tab, Board view](docs/images/board.webp)                              |
| **Script** — write the script; shots are marked on their words.             | **Board** — the classic storyboard: one card per shot, script beside picture. |
| ![Canvas tab](docs/images/canvas.webp)                                      | ![Assets tab](docs/images/assets.webp)                                        |
| **Canvas** — layouts with slots, captions, safe zones; align, group, zoom.  | **Assets** — all images, sounds, videos and fonts, sorted into categories.    |
| ![A shot's Audio section](docs/images/audio.webp)                           | ![PDF export](docs/images/pdf.webp)                                           |
| **Audio** — each shot's sound; cut one recording into pieces, one per line. | **Print / PDF** — storyboard sheets with 3, 6, 9 or 12 shots per page.        |

## Try it now

**[Open the app in your browser][app]**: nothing to install. Click **Try an example**, open a
`.sbd` file or folder, or start a new storyboard.

- Your files stay on your computer. Nothing is uploaded.
- After the first visit it works offline. In Chrome or Edge you can install it as an app (the
  install icon in the address bar).
- To let your AI agent edit storyboards while you watch, set it up on your computer (next
  section).

## Use it with your AI agent

You need [Claude Code](https://claude.com/claude-code) or
[Codex](https://developers.openai.com/codex) (desktop app or terminal).

1. **Copy** the prompt below (use the copy button in the top-right corner of the box).
2. **Paste** it into a new chat with your agent and send it.
3. **Approve** the commands it asks to run. It installs everything, makes your first storyboard
   and opens it for you.

```text
Please set up Storyboard Viewer for me. I may not be technical, so explain what you are doing in
plain, friendly words and ask before doing anything unusual.

Storyboard Viewer is a free, open-source storyboard app that runs on this computer. You (the
agent) edit storyboards through its MCP server, and I watch the changes appear in the viewer.
Repository: https://github.com/swaymun/storyboard-viewer

1. Check the tools. Run `node --version` and `git --version`.
   - Node.js must be version 20.19 or newer. If it is missing or older, help me install the LTS
     version from https://nodejs.org (or with Homebrew / winget / my package manager if I have
     one), then check again.
   - If git is missing, help me install it (on a Mac: `xcode-select --install`).
2. Pick a folder. Use ~/storyboard-viewer unless I say otherwise. If that folder already contains
   the project, use it and run `git pull` instead of cloning.
   Otherwise clone the repository address above: `git clone <repository> ~/storyboard-viewer`
3. Install and build (inside that folder). Use the pnpm version the project expects, without
   installing anything globally:
   `npx -y pnpm@8.15.6 install` then `npx -y pnpm@8.15.6 build`
   Then check the command line works: `node packages/cli/dist/cli.js --version`
4. Connect yourself to Storyboard Viewer (an MCP server named "storyboard"). Use the full,
   absolute path of the folder from step 2 in place of <REPO>:
   - If you are Claude Code:
     `claude mcp add storyboard --scope user -- node <REPO>/packages/cli/dist/cli.js mcp --serve`
   - If you are Codex:
     `codex mcp add storyboard -- node <REPO>/packages/cli/dist/cli.js mcp --serve`
   If the command's options look different, check `claude mcp add --help` or
   `codex mcp add --help` and adapt. If a server called "storyboard" already exists, ask me
   before replacing it.
5. Create my first storyboard. Ask me what I want to make (for example a short film, a
   documentary, an animation, a brand/motion video, or a vertical TikTok/Reels video) and its
   title, then create it in ~/Storyboards (make the folder if needed):
   `node <REPO>/packages/cli/dist/cli.js new ~/Storyboards/<short-name>.sbd --preset <preset> --title "<Title>"`
   Presets: film, documentary, animation, motion, vertical, blank.
6. Show me the viewer. The MCP connection from step 4 only becomes active in a new session, so
   for now start the viewer directly (keep it running in the background):
   `node <REPO>/packages/cli/dist/cli.js serve ~/Storyboards/<short-name>.sbd`
   It prints a link like http://localhost:4400/.
   - If you are running inside the Claude desktop app or the Codex desktop app and you can open
     pages in the in-app browser, open that link there so I can see the storyboard side by side
     with our chat.
   - Otherwise, give me the link and tell me to open it in Chrome, Edge or Safari.
7. Finish by telling me, in a few short sentences:
   - where Storyboard Viewer is installed and where my storyboard is saved;
   - that next time I can start a new chat and simply ask, for example: "Open my storyboard
     ~/Storyboards/<short-name>.sbd and show it to me", and you will use the storyboard tools and
     give me the viewer link (from get_viewer_url);
   - three example things I can ask for next, such as "Add five shots for the opening scene".
```

What each step does is explained in [docs/SETUP_PROMPT.md](docs/SETUP_PROMPT.md).

**Tip:** in the Claude or Codex desktop app, ask your agent to open the viewer in the in-app
browser. The storyboard then sits next to your chat and refreshes as the agent works.

Then just say what you want, in your own words:

- "Make a 30-second TikTok storyboard about a cat who hates Mondays. Six shots, punchy captions."
- "Turn this script into a storyboard, one shot per paragraph." _(paste it, or point to a file)_
- "Attach `~/Downloads/vo.mp3` and split it across the lines of shots 1 to 4."
- "Add quiet background music under the whole story, with a fade-out at the end."
- "Make shot 3 a split screen with the two reaction photos and a bold caption on top."
- "Check the storyboard for problems, fix what you can, and export a PDF with six shots per page."

The agent can't _draw_ by itself, but it can place pictures you give it (or ones made with an
image tool) into shots, arrange layers on the canvas and keep everything in order.

## Run with Docker

Choose one standalone configuration. Source developers use the repository's
`docker-compose.yml`. Consumers copy `docker-compose.template.yml` into their own
deployment directory as `docker-compose.yml` and select a published image.
The consumer file needs neither a source checkout nor a Dockerfile.

Docker and Compose must be installed and running. Compose v5.1.2 is the verified support
floor for these instructions. This does not establish that earlier versions cannot work.
The viewer has no sign-in. Keep the port bound to `127.0.0.1`.

Each file starts exactly one `viewer`. Give every checkout, production, or task a unique
`--project-name` and an unused host port. Use the same name, directory, and environment
for subsequent commands. Do not combine the files or start the template from the source root.

### Source development

Run these commands from the intended checkout root. The developer file builds the root
Dockerfile for the Docker engine's native architecture. It uses `storyboard-viewer:dev`
and `pull_policy: build`. If that tag belongs to another task, stop before replacing it.
The default host port is 4410. No published image or AMD64 emulation is needed.

Prepare an existing valid unpacked storyboard at `.dev/storyboard.sbd`, plus existing
`.dev/config` and `.dev/tmp` directories. These are ignored local development inputs.
Do not mount repository examples or production originals for a trial. Copy only an input
that you are authorized to edit.

For a deliberately empty disposable fixture, use the built CLI's `new` command.
First install the frozen dependencies and build with the repository's pinned pnpm 8.15.6.
Check permissions using the guidance below before startup. Then run:

```sh
npx -y pnpm@8.15.6 install --frozen-lockfile
npx -y pnpm@8.15.6 build
mkdir -p .dev/config .dev/tmp
node packages/cli/dist/cli.js new .dev/storyboard.sbd --preset blank --title "Docker trial"
node packages/cli/dist/cli.js validate .dev/storyboard.sbd
export SBD_PROJECT=storyboard-dev-my-task
export SBD_PORT=4410
docker compose --project-name "$SBD_PROJECT" config
docker compose --project-name "$SBD_PROJECT" up -d --build
docker compose --project-name "$SBD_PROJECT" ps
```

Plain `docker compose` discovers
`docker-compose.yml`. An explicit `--file docker-compose.yml` selects the same file.
Remove or resolve conflicting local Compose files or selection variables before using automatic discovery.
Open `http://localhost:4410/`, or the host port you selected.

Docker installs dependencies and builds the app into the image, not at container startup.
The runtime has no browser or ffmpeg executable. CLI PDF export is not included.
Ordinary `pnpm test` checks both files without Docker. To opt in to structured Compose
configuration checks, run `SBD_COMPOSE_TESTS=1 node --test scripts/test/compose.test.mjs`.
This check does not build, pull, or start an image. The existing packaging baseline runs
separately through `pnpm test:image`.

### Consumer deployment

Use an existing production or task directory. Obtain the template from the reviewed repository
revision you intend to use, then copy it there as `docker-compose.yml`.
No source clone is required if you already have the verified template.
Keep the production's canonical unpacked `.sbd` in its existing semantic location.
The default `./storyboard.sbd` binding is an example, not a required production layout.
If the canonical folder is elsewhere inside that production, change only its relative bind source.

If `docker-compose.yml` already exists, stop before copying. Review that file and authorize
any replacement separately. From your chosen deployment directory, copy the verified template
and prepare its private state directories:

```sh
TEMPLATE='/path/to/verified/docker-compose.template.yml'
test ! -e docker-compose.yml && test ! -L docker-compose.yml && cp "$TEMPLATE" ./docker-compose.yml
mkdir -p config tmp
```

Use equivalent relative production-owned state paths if needed. All three bindings use
`create_host_path: false`. Docker does not create missing input directories.
Make sure that the selected canonical unpacked storyboard already exists and is valid.
Do not use a packed `.sbd` file for this binding.

Select a full published image reference, preferably the immutable root digest of its OCI image index.
An image index groups images for different platforms under one reference.
The consumer file requires `SBD_IMAGE` and has no forced platform, build, base-file, or environment-file dependency.
Docker selects the matching Linux image for its server architecture, not the macOS/Darwin host label.

Before deployment, read the selected image's registry metadata and the Docker server's architecture:

```sh
docker info --format '{{.OSType}}/{{.Architecture}}'
docker buildx imagetools inspect 'ghcr.io/<owner>/<repository>@sha256:<digest>'
```

Use lowercase owner and repository names. Linux `x86_64`/`amd64` matches `linux/amd64`.
Linux `aarch64`/`arm64` matches `linux/arm64`, including the ARM64/v8 variant.
Make sure that the index contains a matching runnable image and both variants identify the same source commit.
If the architecture or matching image is unsupported or uncertain, stop before deployment.
Prefer one root index digest, not a platform-specific child digest.

Apple Silicon uses the ARM64 image natively. Ordinary deployment needs no AMD64 emulation or `platform` override.
An intentional foreign-platform override requires separate authorization and working emulation before startup.
These instructions do not install an emulator.

From the deployment directory, set your selected reference and a unique project name:

```sh
export SBD_IMAGE='ghcr.io/<owner>/<repository>@sha256:<digest>'
export SBD_PROJECT=storyboard-my-production
export SBD_PORT=4400
docker compose --project-name "$SBD_PROJECT" config
docker compose --project-name "$SBD_PROJECT" pull viewer
docker compose --project-name "$SBD_PROJECT" up -d --no-build --pull never
docker compose --project-name "$SBD_PROJECT" ps
```

Replace the placeholders with the actual published identity. Make sure that the resolved paths,
identity, and port match your production before starting. Open `http://localhost:4400/`,
or the host port you selected. The template uses `pull_policy: missing` for ordinary startup.
The explicit pull above obtains the chosen image before the no-pull startup.

Alternatively, replace the template's entire `image:` value with the selected literal reference.
Then `SBD_IMAGE` is unnecessary. Never embed authentication tokens in YAML, an image reference,
or retained environment files. Do not mount your home, repository metadata, credentials,
or the Docker socket. Mount only intended inputs. Preserve relative linked-media paths,
and add only specifically needed read-only mounts.

### Published images (GHCR)

The `Publish Docker image` workflow targets `linux/amd64` and `linux/arm64` in one OCI image index
on GitHub Container Registry (GHCR). Both variants use the same checked-out source commit.
The image name comes from the executing repository's owner and name, not a fixed upstream namespace.
`Owner/Repository` becomes `ghcr.io/owner/repository`.
OCI labels identify that repository and the exact source revision.
Generic references are `ghcr.io/<owner>/<repository>:<tag>` or `ghcr.io/<owner>/<repository>@sha256:<digest>`.
Make sure that the selected publication contains both runnable platforms before deployment.
Workflow configuration alone does not prove successful builds or runtime support.

Before Buildx, the workflow installs ARM64 emulation through pinned QEMU setup and a pinned binfmt installer image.
The installer runs privileged containers only on the ephemeral GitHub-hosted runner.
It does not install QEMU or change binfmt on your computer.
Both unchanged Dockerfile stages select each target platform, with the pinned Node 24 base indexes.
Each platform installs its own frozen dependencies and runs the existing dependency-graph, packaging, and license checks.
Dependencies are not copied between architectures. Native source development remains separate.

Every trusted branch push can publish and consume GitHub Actions runner time, including
pushes in a fork. Pull requests, tag events, and branch-deletion pushes do not publish.
Manual dispatch uses the selected branch and requires the workflow on the default branch.
An authorized nondefault branch push can publish before merge. Adding the workflow locally
does not publish anything.

Publications use `branch-<normalized-branch>` and `sha-<full-40-character-commit>` tags.
Normalization replaces runs outside `[a-zA-Z0-9._-]` with `-`, preserves case, and limits
the suffix after `branch-` to 121 characters. Different names can collide, including
`feature/foo` and `feature-foo`, or names truncated to the same suffix.
Only the current default branch also gets `latest`, through the case-sensitive
`{{is_default_branch}}` helper. A nondefault branch named `latest` gets `branch-latest`.
There are no package-version or release tags.
Branch and SHA tags are mutable names. A digest identifies fixed image content.

Public images permit anonymous pulls. Private pulls require an account with package-read access. Establish authentication separately
before pulling. The publishing job's `GITHUB_TOKEN` does not authenticate your local Docker client.
Fork owners can need to enable Actions. Organization policy or existing-package permissions
can block publication. New packages default to private.
Authentication, package visibility, and account permissions are separate administrative choices.

### Permissions, state, and updates

The default container identity is `1000:1000`. All three host directories must be writable
by the chosen nonzero identity. Startup does not change host ownership or permissions.
Do not select UID 0. The interpolation permits overrides but does not enforce nonzero values.
Do not use `chmod 777` or broad ownership changes to bypass errors.

On native Linux, use your nonzero host IDs when that user owns the three directories:

```sh
export SBD_UID="$(id -u)"
export SBD_GID="$(id -g)"
```

Check that `SBD_UID` is not 0. Keep these values for every Compose command.
Prepare permissions only on directories you own and are authorized to change.
macOS engine permission mapping differs from native Linux. Do not infer Linux behavior
from OrbStack results.

The container root is read-only. The image remains build-once, with immutable application
files under `/app`. The three writable binds have separate purposes:

- `/storyboard.sbd` stores browser and MCP edits in the host storyboard.
- `/config/recent.json` stores the shared recent list, through `SBD_CONFIG_DIR=/config`.
- `/tmp` provides disk-backed upload staging and `HOME=/tmp`. Viewer discovery uses
  `/tmp/storyboard-viewer/serve-<path-hash>.json`, not `/config`.

Keep adequate disk space for media staging. These binds survive container recreation.
The files in the temporary bind are runtime state, not production deliverables.
Do not share configuration or temporary directories between independent deployments.

Before an update, save browser work and pause all writers. For source development, rebuild
and recreate from the selected checkout:

```sh
docker compose --project-name "$SBD_PROJECT" up -d --build --force-recreate
```

For consumers, select the new digest or tag, explicitly pull it, then recreate:

```sh
docker compose --project-name "$SBD_PROJECT" pull viewer
docker compose --project-name "$SBD_PROJECT" up -d --no-build --pull never --force-recreate
```

If `image:` is literal, edit that same value before pulling.
With `pull_policy: missing`, a cached mutable tag such as `latest` is not an update check.
Explicitly pull it before recreating. Publication or pulling alone does not change a running viewer.
Restart keeps the current image. Startup from a present image needs no package downloads.
Remote linked media is not covered by this offline behavior.

Use `docker compose --project-name "$SBD_PROJECT" stop` to stop this viewer.
Use `down` to remove this project's containers and network after confirming ownership.
Do not add volume deletion or image-pruning options. Neither command deletes the host binds.
Do not remove input, configuration, or temporary directories as part of container cleanup.

An MCP client can use standard input/output through the running service:

```sh
docker compose --project-name "$SBD_PROJECT" exec -T viewer node /app/dist/cli.js mcp /storyboard.sbd
```

Do not add `--serve`: the service already runs the viewer.
This is not a network MCP endpoint or automatic agent registration.
Container discovery URLs are not host viewer URLs.

### Host folder changes and live refresh

A bind mount exposes a host folder inside the container.
Live refresh needs filesystem events, notifications that tell the viewer files changed.

On macOS with OrbStack 2.2.3, newly host-created subfolders were visible but produced no parent
watch events. The browser stayed stale after media replacements inside those folders.
This occurred under both temporary storage (`/var/folders/...`) and `$HOME`.
Moving the folder under `$HOME` did not fix it.

Edits and atomic replacements in already-watched directories generally worked.
Browser saves and MCP operations also worked. Refresh between separate MCP and viewer
processes still depends on filesystem events. This is a refresh limitation, not unsupported MCP.

Create needed subfolders before starting the viewer. If you add host subfolders after startup,
save all browser work and pause editing. Then restart only the affected service:

```sh
docker compose --project-name "$SBD_PROJECT" restart viewer
```

Restart registers existing directories. No image rebuild or restart of other viewers is needed.
It does not fix event delivery for later host-created folders.
No polling fallback is included. Docker Desktop and native Linux refresh behavior remain unverified.

See the [Node.js filesystem caveats](https://nodejs.org/docs/latest-v24.x/api/fs.html#caveats)
and the [OrbStack 2.2.3 report](https://github.com/orbstack/orbstack/issues/2561#issuecomment-5403565713).
Node.js warns about Docker and other virtualization, so this risk is not necessarily exclusive to OrbStack.

## Example storyboards

Five ready-made storyboards with pictures, voices, music and sound effects live in
[`examples/`](examples/README.md). Two of them are under **Try an example** in the
[browser app][app].

<p align="center">
  <img src="docs/images/animatic.gif" alt="Animatic of the Pip's Kite example: a little robot tries to fly a kite while an owl gives advice, with captions" width="640" />
</p>

| Example                                                       | Kind                         |
| ------------------------------------------------------------- | ---------------------------- |
| [Midnight Snack Protocol](examples/midnight-snack.sbd)        | Comedy short                 |
| [Salt & Light](examples/salt-and-light.sbd)                   | Documentary                  |
| [Rating My Cat's 3 A.M. Crimes](examples/cat-crimes.sbd)      | TikTok / Reels / Shorts      |
| [Fernlight Halo — Launch Film](examples/fernlight-launch.sbd) | Motion design / brand launch |
| [Pip's Kite](examples/pips-kite.sbd)                          | Animation                    |

Everything in them is made up; all pictures and sounds were generated for this project.

## Tips and shortcuts

| Key                                   | What it does                              |
| ------------------------------------- | ----------------------------------------- |
| **Space**                             | Play / pause the animatic                 |
| **J** / **K**                         | Next / previous shot                      |
| **1** **2** **3**                     | Story, Canvas, Assets tab                 |
| **Cmd/Ctrl+Enter**                    | Make a shot from the selected words       |
| **Cmd/Ctrl+Z** / **Shift+Cmd/Ctrl+Z** | Undo / redo                               |
| **Cmd/Ctrl+S**                        | Save                                      |
| Right-click or **Shift+F10**          | Commands for a script line, shot or asset |
| **?**                                 | All keyboard shortcuts                    |

The [user guide](docs/GUIDE.md) explains everything else: the script editor, shots, the canvas
(layouts, captions, safe zones, shortcuts), audio, saving, the recent list, themes and the `sbd`
command.

## The .sbd file, in plain words

A storyboard is a **folder whose name ends in `.sbd`**, full of plain files: the script (a
normal screenplay file), one small file per shot, and a `media/` folder with the pictures and
sounds. Because it is just files, it works well with backups, cloud folders and git, and agents
can read it.

To share a storyboard as **one file**, use File → Export .sbd file (or `sbd pack`). That file is
a zip, and the app opens it directly. The full format is in [SPEC.md](SPEC.md); agents should
read [AGENTS.md](AGENTS.md).

## For developers

Requirements: [Node.js](https://nodejs.org) 20.19 or newer, git, and pnpm 8 (or
`npx pnpm@8.15.6` in place of `pnpm`).

```sh
git clone https://github.com/swaymun/storyboard-viewer.git
cd storyboard-viewer
pnpm install && pnpm build

pnpm sbd new ~/Storyboards/my-film.sbd --preset film --title "My Film"
pnpm sbd serve ~/Storyboards/my-film.sbd --open      # the viewer, with live refresh

# connect your agent (use the absolute path of your clone)
claude mcp add storyboard --scope user -- node /path/to/storyboard-viewer/packages/cli/dist/cli.js mcp --serve
codex mcp add storyboard -- node /path/to/storyboard-viewer/packages/cli/dist/cli.js mcp --serve
```

All `sbd` commands and the MCP setup for other clients are in the
[user guide](docs/GUIDE.md#the-sbd-command). Tests, code layout and deploying the browser app
are in [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## FAQ

**Do I need an AI agent?**
No. Use the [browser app][app], or `pnpm sbd serve <storyboard>`, and edit everything by hand.
The agent just makes the big jobs faster.

**Where are my storyboards stored?**
Wherever you (or your agent) create them, for example `~/Storyboards/my-film.sbd`. Nothing is
uploaded anywhere, also not from the browser app.

**Does it work offline?**
Yes. After setup (or the first visit to the browser app) nothing needs the internet.

**Which browsers work?**
Chrome and Edge are fully supported, including the in-app browsers of the Claude and Codex
desktop apps. Safari and Firefox should work for viewing and playback but are not tested yet.
Opening a folder in the browser app needs Chrome or Edge.

**My agent says it has no storyboard tools.**
The connection becomes active in a new chat. Start a new session, or check with
`claude mcp list` / `codex mcp list`.

**How do I update?**
Ask your agent "Update Storyboard Viewer", or run `git pull && pnpm install && pnpm build` in the
project folder. The browser app updates itself: when a new version is out it reloads on its own,
or, if you have unsaved changes or a file open, shows "A new version is ready" with a **Reload**
button (which saves first). Hover the logo, or see Help → About, for the version you run.

More answers (packed files, safety) are in the [user guide](docs/GUIDE.md#more-questions).
Found a bug or have an idea? [Open an issue](https://github.com/swaymun/storyboard-viewer/issues).
Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Credits

- The Maomao and Jinshi themes are adapted from
  [Apothecary Diary](https://github.com/montemurro19/apothecary-diary-theme), a VS Code theme by
  Matheus Montemurro, used under the MIT License (Copyright (c) 2025 Matheus Montemurro; the full
  notice is in [`apps/web/src/themes.css`](apps/web/src/themes.css)). It is a fan-made, unofficial
  work inspired by the anime; names and characters belong to their respective owners.
- Fonts: [IBM Plex Sans and Mono](https://github.com/IBM/plex),
  [Courier Prime](https://quoteunquoteapps.com/courierprime/) and
  [Montserrat](https://github.com/JulietaUla/Montserrat) (SIL Open Font License), bundled via
  Fontsource.
- Built with [Svelte](https://svelte.dev), [Konva](https://konvajs.org) (MIT),
  [CodeMirror](https://codemirror.net) (MIT), [fflate](https://github.com/101arrowz/fflate)
  (MIT), [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0),
  [Mediabunny](https://mediabunny.dev) (MPL-2.0, unmodified, for video export), the
  [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT) and
  [Playwright](https://playwright.dev) (Apache-2.0, for `sbd export-pdf`). Fountain is a
  plain-text screenplay format by [fountain.io](https://fountain.io). Storyboarder is by
  [Wonder Unit](https://wonderunit.com).

## License

[MIT](LICENSE)

[app]: https://storyboard-viewer.saimun-shahee.workers.dev
