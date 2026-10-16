# Docker and MCP deployment

Run a persistent viewer on your own computer with the root `Dockerfile` and `docker-compose.yml`.
The container serves the built browser app from `/app/apps/web/dist`.
It starts without a storyboard, an AI agent, or an MCP connection.
You do not need Node.js, pnpm, or a build on the host.
Docker builds the app inside the image.

This setup is local-only, not a remote server or a collaboration service.
The browser, Docker, storyboard files, and agent client run on the same computer.
The optional MCP connection uses the application's built-in native CLI over standard input and output.
MCP is the protocol that gives an agent access to storyboard tools.
The persistent viewer is a static frontend, not the native CLI's HTTP API server.

## Requirements

Use Docker Desktop on macOS, Windows, or supported Linux systems.
On Linux, Docker Engine with the Compose plugin is another option.
Use a current Docker release and modern Compose v2 or newer that supports `bind.create_host_path`.
The commands below use `docker compose`, not the legacy `docker-compose` command.
Your account must have permission to use Docker.
Docker access grants substantial control over the host.

Keep a local checkout of this repository, including the root Dockerfile and Compose file.
Run the deployment commands from that checkout's root directory.
The initial build needs internet access for the base image and dependencies.
Use Chrome or Edge for browser access to unpacked storyboard folders.
Do not rely on an embedded browser that lacks the required file access features.

## Choose storage and configuration

A bind mount exposes a selected host directory inside a container.
This setup mounts your directory at `/projects` with read and write access.
Choose an existing directory containing storyboards, including nested directories if needed.
Mount only files that you want the agent to access.
The mount does not select or open a storyboard in the browser.

The optional `.env` file supplies Compose interpolation values.
Copy the example if you need values other than the defaults.
Do not overwrite an existing `.env` file.
On macOS or Linux, use:

```sh
cp .env.example .env
```

In Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and uncomment the values you need.
The example explains every variable and its default.
For `STORYBOARD_DIR`, choose your directory or create the default `./storyboard` before startup.
For a new default directory on macOS or Linux, use:

```sh
mkdir -p ./storyboard
```

In Windows PowerShell, use:

```powershell
New-Item -ItemType Directory -Force ./storyboard
```

Relative paths resolve from the Compose project directory.
On Windows, use forward slashes, such as `C:/Storyboards`, in `.env`.
Quote values that contain spaces, for example `STORYBOARD_DIR="C:/My Storyboards"`.
With Docker Desktop, allow Docker to share the selected drive or directory when required.

The default Compose project name is `storyboard-viewer`.
`COMPOSE_PROJECT_NAME` overrides the top-level name in the Compose file.
The command-line `--project-name` option takes precedence over both.
Exported shell variables take precedence over matching `.env` values.
For separate installations, choose distinct project names, container names, ports, and configuration volumes.
Changing only the project name does not change the explicit container or volume names.

### Linux Engine permissions

The image runs as `node`, with UID and GID `1000:1000`.
A UID identifies a user and a GID identifies a group.
Linux bind mounts use host filesystem permissions for these numeric identities.
Your browser account and UID 1000 both need read and write access.
Directories also need search permission to reach their contents.
Replacing a file requires write permission on its parent directory.

If your host account uses another UID, arrange a shared group or an access control list (ACL).
An ACL grants access to specific users without changing file ownership.
For a new, empty `./storyboard` directory, the following example grants access to both users.
Run it as the directory owner, with your system's `setfacl` utility available:

```sh
setfacl -m "u:$(id -u):rwx,u:1000:rwx,m::rwx" ./storyboard
setfacl -d -m "u:$(id -u):rwx,u:1000:rwx,m::rwx" ./storyboard
```

The second command sets default ACLs for new files and subdirectories.
New ordinary files inherit read and write access, subject to their creation mode.
For existing storyboards, arrange access ACLs on their selected files and directories too.
Default ACLs do not change existing children.
Make sure that new files from both the host and container remain readable and writable by both identities.
Tools that force restrictive modes or replace files from elsewhere can require further permission preparation.

A shared-group arrangement must likewise cover existing content and new files from both users.
Use directory group inheritance and a suitable creation mask or default ACL.
Ask the host administrator to prepare the selected directory if needed.
Do not use `chmod 777`, run the application as root, or recursively change ownership of personal files.
Do not override the Compose runtime UID as a shortcut.
The `/config` volume starts with ownership for UID 1000, so another UID needs separate volume preparation.

## Build and start

Build the image from the repository root:

```sh
docker compose build
```

Start the persistent viewer:

```sh
docker compose up -d --build
```

Use `up -d --build` for the initial deployment, even if an older local image already exists.
An older image that listens only on container `127.0.0.1` cannot receive this Compose bridge traffic.
The current Dockerfile listens on `0.0.0.0:4400` inside the container.
Compose publishes it only on host `127.0.0.1`, with host port 4400 by default.
It does not use host networking or expose a LAN port.

Open `http://localhost:4400/` manually in Chrome or Edge.
If you change `STORYBOARD_PORT`, use that port in the URL.
No agent session or selected project is necessary to keep this page available.
The container does not open a browser automatically.

## Open the same storyboard in the browser

Use the browser app's folder picker to select an unpacked `.sbd` folder on the host.
Choose the same folder that the agent accesses under `/projects`.
For example, host `<chosen-directory>/my-film.sbd` maps to `/projects/my-film.sbd`.
A nested host folder maps to the corresponding nested path under `/projects`.
The browser receives access only after you grant permission in its picker.

Localhost supplies the secure context required for browser filesystem access.
The browser's File System Access API permits access to the selected folder.
Chrome and Edge support this folder workflow.
Safari, Firefox, and embedded browsers without this capability do not provide the same shared-folder workflow.
The browser cannot infer the host directory from the container mount.

The folder source polls for external file changes, then reloads and merges them with local edits.
Polling is not an instant notification from MCP.
A packed `.sbd` file uses a browser-held working copy instead.
Even when the browser can save that file in place, it does not provide the same shared-folder polling contract.
Use an unpacked folder for agent and browser edits to the same files.

Static mode cannot resolve linked local files outside the storyboard's embedded media.
Mounting more host directories does not grant the browser access to arbitrary filesystem paths.
Embed required media in the storyboard, or use a separately configured native server workflow for linked local files.
That native server is not part of this static deployment.

## Connect an agent through MCP

Keep the container running before the agent connects.
Configure your MCP client to start the following process.
Adapt the JSON wrapper to your client's configuration format:

```json
{
  "mcpServers": {
    "storyboard": {
      "command": "docker",
      "args": ["exec", "-i", "storyboard-viewer", "node", "/app/packages/cli/dist/cli.js", "mcp"]
    }
  }
}
```

This runs the compiled native CLI in the same container as the static viewer.
`-i` keeps standard input open for the MCP protocol.
Do not add `-t` or allocate a TTY, an interactive terminal.
Do not add `--serve`, because the static viewer already runs independently.
The agent client needs access to the Docker executable and daemon.

If you change `STORYBOARD_CONTAINER_NAME`, replace `storyboard-viewer` in the JSON arguments.
MCP client JSON does not automatically interpolate the Compose `.env` file.
Follow your client's procedure to activate the connection, often through a new agent session.
No skill registration or additional MCP implementation is required.

Each fresh MCP process must explicitly open the intended storyboard.
For example, call `open_storyboard` with `{"path":"/projects/my-film.sbd"}` for the matching host folder.
It cannot discover the human's browser selection or automatically reconnect to it.
For a nested storyboard, use its full path below `/projects`.

Give the human the stable configured localhost URL for this deployment.
The native `get_viewer_url` tool looks for an API-backed viewer through a registry and `/api/health`.
It cannot discover this static server or identify its selected browser folder.
A null result does not mean that the static viewer stopped.
Do not start another viewer merely to obtain a URL from that tool.

## Persistence, startup, and updates

Storyboard files remain in the selected host directory.
The named volume mounted at `/config` stores native CLI configuration, including applicable native recent-storyboard records.
Its default name is `storyboard-viewer_config`, configurable through `STORYBOARD_CONFIG_VOLUME`.
It is not a backup of the storyboard directory.
Keep independent backups of valuable files.

The static browser stores its recent list and related state separately in IndexedDB, a browser-local database.
Browser state belongs to that browser profile and origin, including the URL's port.
Folder permissions can require renewed approval.
The `/config` volume does not synchronize browser selection or preserve browser storage.

Stop the application deliberately with:

```sh
docker compose stop
```

Resume the existing container with:

```sh
docker compose start
```

Both commands preserve the host files and named volume.
`restart: unless-stopped` restarts the container after an unexpected exit or daemon restart, unless you deliberately stopped it.
A manual stop remains effective across Docker daemon restarts until you start the container again.
The policy does not start Docker itself.
Configure Docker Desktop startup at login or Linux Docker daemon startup yourself if you want automatic availability.
Docker must run before it can start the application.

`docker compose down` removes the container and network but normally keeps the named volume.
Do not use `docker compose down -v` unless you intend to delete the configuration volume and its data.
This does not delete host storyboard files, but it loses the native configuration stored in that volume.
After `down`, use `up -d --build` rather than `start` to recreate the container.

After updating the checkout, rebuild and recreate with `docker compose up -d --build`.
Keep the same host directory and volume name to retain their data.
Changing `.env` alone does not change an existing container.
Recreation applies the deployment values, so review them before running `up`.
This guide does not change Docker startup settings or deploy updates automatically.
