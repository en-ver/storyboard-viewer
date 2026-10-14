<script lang="ts">
  import { PRESETS, PRESET_IDS, type PresetId } from '@storyboard-viewer/format';
  import { canPickFolder } from '../lib/sources/local';
  import { app } from '../lib/state.svelte';
  import { workspaceApi } from '../lib/workspace';
  import Dialog from './Dialog.svelte';

  let { open = $bindable(false) }: { open: boolean } = $props();

  let title = $state('My storyboard');
  let preset = $state<PresetId>('film');
  let name = $state('');
  let error = $state('');
  $effect(() => {
    if (open) {
      preset = app.workspace ? 'blank' : 'film';
      error = '';
    }
  });
  let busy = $state(false);

  const ORDER: PresetId[] = ['film', 'vertical', 'documentary', 'animation', 'motion', 'blank'];
  const presets = $derived(
    ORDER.filter((id) => (app.workspace?.presets ?? PRESET_IDS).includes(id)).map(
      (id) => PRESETS[id],
    ),
  );

  async function create(where: 'browser' | 'folder') {
    if (!title.trim() || busy) return;
    busy = true;
    error = '';
    try {
      if (app.workspace) {
        if (!name.trim()) {
          error = 'Enter a project folder name.';
          return;
        }
        if (
          await app.workspaceAction(
            () => workspaceApi.create(app.client, name.trim(), title.trim(), preset),
            `Created in Projects: ${name.trim()}`,
          )
        )
          open = false;
        else error = app.workspaceError ?? '';
      } else {
        if (!(await app.finishBeforeSwitch())) return;
        if (await app.createNew({ title: title.trim(), preset }, where)) open = false;
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title="New storyboard"
  id="new-dialog"
  width={720}
  onsubmit={() => create('browser')}
>
  {#if app.workspace}
    <label class="field"
      >Project folder name<input
        id="new-name"
        bind:value={name}
        required
        placeholder="my-project.sbd"
      /></label
    >
    <p class="muted note">
      Saved in Projects on this server. Names end in .sbd. We add it if needed.
    </p>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <label class="field">
    Title
    <!-- svelte-ignore a11y_autofocus -->
    <input id="new-title" bind:value={title} required autofocus />
  </label>
  <fieldset>
    <legend>What are you making?</legend>
    <div class="presets" role="radiogroup" aria-label="Preset">
      {#each presets as p (p.id)}
        <label class="preset" class:selected={preset === p.id} data-preset={p.id}>
          <input type="radio" name="preset" value={p.id} bind:group={preset} />
          <span class="frame" style:aspect-ratio={p.aspect_ratio.replace(':', ' / ')}></span>
          <span class="text">
            <strong>{p.label}</strong>
            <span class="muted">{p.examples}</span>
            <span class="meta">{p.aspect_ratio} · {p.fps} fps</span>
          </span>
        </label>
      {/each}
    </div>
  </fieldset>
  {#if app.source?.kind === 'server' && !app.workspace}
    <p class="note warn" role="note">
      This opens the new storyboard in this tab, separate from the live <code>sbd serve</code>
      storyboard. To make one your agent can edit, ask your agent, or run
      <code>sbd new my-story.sbd --preset {preset}</code>.
    </p>
  {/if}
  <p class="muted note">
    Presets only fill in starting fields and categories. You can change everything later in Project
    settings.
  </p>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
    {#if canPickFolder && !app.workspace}
      <button
        type="button"
        class="btn"
        id="new-in-folder"
        disabled={busy}
        title="Pick a folder; the storyboard is saved there as you work"
        onclick={() => create('folder')}>Create in a folder…</button
      >
    {/if}
    <button type="submit" class="btn primary" id="new-create" disabled={busy || app.workspaceBusy}
      >{app.workspace ? 'Create in Projects' : 'Create'}</button
    >
  {/snippet}
</Dialog>

<style>
  .presets {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-2);
  }
  .preset {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    background: var(--surface);
  }
  .preset:hover {
    border-color: var(--border-strong);
  }
  .preset.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .preset:has(input:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .preset input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .frame {
    flex: none;
    width: 34px;
    max-height: 40px;
    margin-top: 2px;
    border: 2px solid var(--fg-muted);
    border-radius: 3px;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    line-height: 1.35;
  }
  .text strong {
    font-size: 13px;
    color: var(--fg);
  }
  .meta {
    color: var(--fg-muted);
    font-size: 11px;
  }
  .note {
    margin: 0;
    font-size: 12px;
  }
  .warn {
    color: var(--fg-2);
    background: var(--accent-soft);
    border-radius: var(--radius);
    padding: var(--space-2) var(--space-3);
  }
</style>
