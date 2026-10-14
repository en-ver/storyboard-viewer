<script lang="ts">
  import { app } from '../lib/state.svelte';
  import { workspaceApi, type WorkspaceEntry } from '../lib/workspace';
  import { ui } from '../lib/ui.svelte';
  import Dialog from './Dialog.svelte';

  let { inline = false }: { inline?: boolean } = $props();
  let error = $state('');
  let action = $state<'copy' | 'rename' | null>(null);
  let target = $state<WorkspaceEntry | null>(null);
  let name = $state('');
  let paused = $state(false);

  async function refresh() {
    error = '';
    try {
      await app.refreshWorkspace();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    if (app.workspaceOpen) {
      action = null;
      void refresh();
    }
  });

  function chooseAction(kind: 'copy' | 'rename', entry: WorkspaceEntry) {
    action = kind;
    target = entry;
    name = kind === 'rename' ? entry.name : '';
    paused = false;
  }

  async function submit() {
    if (!name.trim() || !target || !action) return;
    if (action === 'rename' && !paused) return;
    const entry = target;
    const destination = name.trim();
    error = '';
    if (action === 'copy') {
      if (
        await app.workspaceAction(
          () => workspaceApi.copy(app.client, entry.name, destination),
          `Copied to Projects: ${destination}`,
        )
      )
        action = null;
      else error = app.workspaceError ?? '';
    } else {
      const token = app.source?.url?.split('/').at(-1);
      if (!token || app.source?.location !== entry.path) return;
      if (
        await app.workspaceAction(
          () => workspaceApi.rename(app.client, token, destination),
          `Renamed project folder to ${destination}. The storyboard title did not change.`,
        )
      )
        action = null;
      else error = app.workspaceError ?? '';
    }
  }
</script>

{#snippet contents()}
  {#if error || app.workspaceError}
    <p class="error" role="alert">{error || app.workspaceError}</p>
  {/if}
  {#if app.workspace}
    <p id="workspace-current" role="status">
      {#if app.source?.workspace}
        Selected: {app.source.workspace.label} / {app.source.name}
        {#if app.source.readOnly}
          · Read-only. Copy an example to Projects to edit it.{/if}
      {:else}Browser-local storyboard. Workspace projects are separate.{/if}
    </p>
    {#each ['examples', 'projects'] as root}
      {@const entries = root === 'examples' ? app.workspace.examples : app.workspace.projects}
      <section aria-labelledby="workspace-{root}-title" data-workspace-group={root}>
        <h3 id="workspace-{root}-title">{root === 'examples' ? 'Examples' : 'Projects'}</h3>
        <p class="muted">
          {root === 'examples'
            ? 'Original examples are read-only.'
            : 'Projects save on this server.'}
        </p>
        <ul>
          {#each entries as entry (entry.path)}
            <li data-workspace-name={entry.name}>
              <button
                type="button"
                class="btn"
                disabled={app.workspaceBusy}
                aria-current={app.source?.location === entry.path ? 'true' : undefined}
                onclick={() => void app.openWorkspace(entry)}
              >
                {entry.title}
                <span class="muted">{entry.name}{entry.readOnly ? ' · Read-only' : ''}</span>
              </button>
              {#if root === 'examples'}
                <button
                  type="button"
                  class="btn"
                  disabled={app.workspaceBusy}
                  aria-label="Copy {entry.title} to Projects"
                  onclick={() => chooseAction('copy', entry)}>Copy to Projects…</button
                >
              {:else if !entry.readOnly && app.source?.location === entry.path}
                <button
                  type="button"
                  class="btn"
                  disabled={app.workspaceBusy}
                  onclick={() => chooseAction('rename', entry)}>Rename folder…</button
                >
              {/if}
            </li>
          {/each}
        </ul>
        {#if !entries.length}<p class="muted">No {root} yet.</p>{/if}
      </section>
    {/each}
    {#if action}
      <fieldset id="workspace-destination">
        <legend
          >{action === 'copy'
            ? `Copy ${target?.title} to Projects`
            : 'Rename the selected project folder'}</legend
        >
        <label class="field"
          >Project folder name<input
            id="workspace-name"
            bind:value={name}
            required
            placeholder="my-project.sbd"
          /></label
        >
        <p class="muted">
          Names end in .sbd. We add it if needed. Existing names are not replaced.
        </p>
        {#if action === 'rename'}
          <p>
            The storyboard title stays unchanged. Other tabs and MCP sessions must reopen the
            renamed project.
          </p>
          <label class="check"
            ><input type="checkbox" bind:checked={paused} />Other writers are paused, including MCP
            sessions.</label
          >
        {/if}
        <button
          type="button"
          class="btn primary"
          id="workspace-confirm"
          disabled={app.workspaceBusy || !name.trim() || (action === 'rename' && !paused)}
          onclick={() => void submit()}
          >{action === 'copy' ? 'Copy to Projects' : 'Rename folder'}</button
        >
        <button type="button" class="btn" onclick={() => (action = null)}>Cancel</button>
      </fieldset>
    {/if}
    <div class="actions">
      <button
        type="button"
        class="btn primary"
        id="workspace-new"
        disabled={app.workspaceBusy}
        onclick={() => (ui.newOpen = true)}>New in Projects…</button
      >
      <button type="button" class="btn" disabled={app.workspaceBusy} onclick={() => void refresh()}
        >Refresh workspace</button
      >
    </div>
    {#if app.recents.length}
      <section aria-labelledby="workspace-recent-title">
        <h3 id="workspace-recent-title">Recent</h3>
        <ul>
          {#each app.recents as entry (entry.id)}<li>
              <button
                type="button"
                class="btn"
                disabled={app.workspaceBusy}
                onclick={() => void app.reopenRecent(entry)}
                >{entry.title}
                <span class="muted"
                  >{entry.path ? entry.name : `Browser-local · ${entry.name}`}</span
                ></button
              >
            </li>{/each}
        </ul>
      </section>
    {/if}
  {/if}
{/snippet}

{#if inline}
  <section class="workspace" aria-label="Workspace">{@render contents()}</section>
{:else}
  <button
    type="button"
    class="btn ghost tiny"
    id="workspace-selector"
    onclick={() => (app.workspaceOpen = true)}
  >
    {app.source?.workspace ? `${app.source.workspace.label} / ${app.source.name}` : 'Workspace…'}
  </button>
  <Dialog
    bind:open={app.workspaceOpen}
    title="Workspace: Examples and Projects"
    id="workspace-dialog"
    onsubmit={() => void submit()}
  >
    <div class="workspace">{@render contents()}</div>
    {#snippet footer()}<button type="button" class="btn" onclick={() => (app.workspaceOpen = false)}
        >Close</button
      >{/snippet}
  </Dialog>
{/if}

<style>
  .workspace {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    text-align: left;
  }
  h3,
  p {
    margin: 0 0 var(--space-2);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  li > button:first-child {
    flex: 1;
    text-align: left;
    justify-content: flex-start;
  }
  [aria-current='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .error {
    color: var(--danger);
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
  }
</style>
