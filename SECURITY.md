# Security

Storyboard Viewer has no sign-in or network MCP endpoint.
Local files stay local unless you explicitly use linked remote media or another external service.
Browser media uploads go to the selected local server, not an AI provider.

## Local HTTP server

`sbd serve` and `sbd mcp --serve` start an HTTP viewer.
They listen on `127.0.0.1` by default.
The Docker wrapper listens inside the container on `0.0.0.0`.
Both Compose files publish only to host `127.0.0.1`.
Do not expose this unauthenticated service to an untrusted network.

HTTP mutations require the `x-sbd-client` header. If `Origin` is present, its host and port must match `Host`; requests without `Origin` are allowed.
The server does not grant cross-origin permission for that custom header.
These guards block browser writes from other sites. They are not user authentication.
Anyone with local process access and the necessary filesystem permissions can run independent tools.

Project edits are validated before saves.
Atomic replacement writes a temporary file, then renames it.
This protects a single write, not all cooperating processes from each other.

## Workspace filesystem policy

Native workspace mode pins separate existing Projects and Examples roots.
Only supported immediate-child `.sbd` entries can be selected.
Each loaded project has a scoped URL and a lifetime token.
The token does not identify a user or grant general filesystem access.
A retired token cannot select another project.

Examples and packed Projects are read-only at the server API.
The backend rejects model saves, media uploads, links, and file additions for those stores.
The frontend hides or disables their mutation controls.
This policy also applies without Docker. It is not only an image permission rule.

Unpacked Projects remain writable within their owning directory.
The server checks real paths, existing destination parents, root identity, and project identity.
It rejects escaping symlinks and linked media outside the owning project.
Legacy `serve <path>` retains its separate linked-file behavior.
Do not assume that a legacy listener supplies workspace containment.

Filesystem checks occur at points in time.
They are not a kernel sandbox or cross-process lock.
Save browser work and pause cooperating external writers before filesystem operations or Rename.
Rename drains admitted server writes and retires the old route.
Independent MCP sessions must reopen the renamed path.

## Docker and independent CLI processes

The runtime uses nonzero UID/GID, a read-only root filesystem, dropped capabilities, and no new privileges.
Only the Projects, configuration, and temporary binds are writable.
Startup does not change host ownership, permissions, or existing production layout.
Do not mount credentials, your home directory, repository metadata, or the Docker socket.

Image Examples and original license files are immutable.
Copy to Projects preserves original bytes and rights while creating writable destination files.
The example provenance revision is separate from the application's published revision.
The template and CLI instructions are in the [README](README.md#run-with-docker).

Independent CLI and MCP processes do not inherit a workspace store's access policy.
They run with their own filesystem permissions and selected paths.
Legacy packed edits write beside the original and keep a first-save `<file>.bak`.
Do not use these processes to bypass read-only workspace policy on production originals.
Use an explicitly authorized writable copy instead.

MCP uses stdio, not a network endpoint.
A viewer link discovered inside a container is not proof of a reachable host URL.
Use the real host origin and selected project's scoped path.
Client registration, remote services, browser installation, generation, credits, and bandwidth use need separate authority.

## Reporting a vulnerability

Report vulnerabilities privately through a GitHub security advisory or the maintainer's profile contact.
Include reproduction steps.
Do not publish credentials or private project material in a report.
