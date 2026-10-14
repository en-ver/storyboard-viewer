<script lang="ts">
  import { tooltip } from '../lib/tooltip';
  import { EXAMPLES } from '../lib/examples';
  import { app } from '../lib/state.svelte';
  import { timeAgo, type RecentEntry } from '../lib/sources/cache';
  import { canPickFolder } from '../lib/sources/local';
  import { servedBySbd } from '../lib/sources/server';
  import Icon from './Icon.svelte';
  import WorkspaceSelector from './WorkspaceSelector.svelte';

  let { onNew }: { onNew: () => void } = $props();

  const served = servedBySbd();
  const SETUP_URL = 'https://github.com/swaymun/storyboard-viewer#use-it-with-your-ai-agent';

  let dragging = $state(false);
  let input = $state<HTMLInputElement>();

  async function ondrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const item = e.dataTransfer?.items[0] as
      | (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
      | undefined;
    const file = e.dataTransfer?.files[0];
    // Chromium: a dropped file comes with a handle, so Save writes back into it
    const handle = await item?.getAsFileSystemHandle?.().catch(() => null);
    if (file)
      void app.openFile(file, handle?.kind === 'file' ? (handle as FileSystemFileHandle) : null);
  }

  /** Object URLs for the thumbnails, revoked when the list changes. */
  const thumbs = $derived.by(() => {
    const m = new Map<string, string>();
    for (const r of app.recents) if (r.thumb) m.set(r.id, URL.createObjectURL(r.thumb));
    return m;
  });
  /** Thumbnail source: a browser-stored picture, else the shared list's data URI. */
  const thumbSrc = (r: RecentEntry) => thumbs.get(r.id) ?? r.thumbUrl;
  $effect(() => {
    const t = thumbs;
    return () => {
      for (const u of t.values()) URL.revokeObjectURL(u);
    };
  });

  const icon = (r: RecentEntry) =>
    r.kind === 'server'
      ? 'link'
      : r.kind === 'folder' || (r.kind === 'served' && r.location.startsWith('Folder'))
        ? 'folder'
        : 'file';
</script>

<section class="open" aria-labelledby="open-title">
  {#if app.workspace}<WorkspaceSelector inline />{/if}
  <div
    class="drop"
    class:dragging
    role="region"
    aria-label="Drop a .sbd file here"
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    {ondrop}
  >
    <h2 id="open-title">
      {app.workspace ? 'Open a browser-local storyboard' : 'Open a storyboard'}
    </h2>
    <p class="muted">Drop a <code>.sbd</code> file here, or choose one.</p>
    <div class="actions">
      <button
        type="button"
        id="open-file"
        class="btn primary"
        onclick={() => void app.pickFile(() => input?.click())}
      >
        <Icon name="file" /> Open .sbd file
      </button>
      <button type="button" id="new-storyboard" class="btn" onclick={onNew}>
        <Icon name="plus" /> New storyboard
      </button>
      {#if canPickFolder}
        <button type="button" id="open-folder" class="btn" onclick={() => app.openFolder()}>
          <Icon name="folder" /> Open folder
        </button>
      {/if}
    </div>
    <input
      bind:this={input}
      id="file-input"
      class="visually-hidden"
      type="file"
      accept=".sbd,application/vnd.sbd+zip,application/zip"
      aria-label="Choose a .sbd file"
      onchange={(e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) void app.openFile(f);
      }}
    />
    {#if app.error}
      <p class="error" role="alert">{app.error}</p>
    {/if}
  </div>

  {#if app.recents.length && !app.workspace}
    <section class="recent" aria-labelledby="recent-title" id="recent-list">
      <header>
        <h3 id="recent-title">Recent</h3>
        <button
          type="button"
          class="btn ghost tiny"
          id="clear-recent"
          onclick={() => void app.clearRecents()}>Clear list</button
        >
      </header>
      <ul>
        {#each app.recents as r (r.id)}
          <li data-recent={r.id}>
            <button
              type="button"
              class="item"
              aria-label="Open {r.title} ({r.location}, opened {timeAgo(r.openedAt)})"
              title={r.path ?? r.location}
              onclick={() => void app.reopenRecent(r)}
            >
              <span class="thumb" aria-hidden="true">
                {#if thumbSrc(r)}
                  <img src={thumbSrc(r)} alt="" />
                {:else}
                  <Icon name="board" size={16} />
                {/if}
              </span>
              <span class="text">
                <span class="title">{r.title}</span>
                <span class="where muted"
                  ><Icon name={icon(r)} size={11} />
                  {r.location}{r.kind !== 'server' && r.kind !== 'served' && r.name !== r.title
                    ? ` · ${r.name}`
                    : ''}</span
                >
              </span>
              <span class="when muted">{timeAgo(r.openedAt)}</span>
            </button>
            <button
              type="button"
              class="btn ghost icon remove"
              aria-label="Remove {r.title} from the list"
              {@attach tooltip('Remove from the list')}
              onclick={() => void app.forgetRecent(r.id)}><Icon name="close" size={12} /></button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if !app.workspace}
    <section class="examples" aria-labelledby="examples-title" id="examples">
      <h3 id="examples-title">Try an example</h3>
      <div class="example-list">
        {#each EXAMPLES as e (e.file)}
          <button
            type="button"
            class="btn"
            data-example={e.file}
            onclick={() => void app.openExample(e)}
          >
            <Icon name="film" />
            {e.title} <span class="muted">· {e.kind}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}
  <div class="tip">
    <h3>Working with an agent?</h3>
    {#if served}
      <p class="muted">
        Run <code>sbd serve my-story.sbd</code> and open the printed localhost link. The page updates
        by itself whenever the storyboard changes.
      </p>
    {:else}
      <p class="muted">
        Install Storyboard Viewer on your computer and your AI agent (Claude Code or Codex) builds
        the storyboard while you watch. Files you open here stay on your computer.
        <a href={SETUP_URL} target="_blank" rel="noopener">How to set it up</a>
      </p>
    {/if}
  </div>
</section>

<style>
  .open {
    max-width: 640px;
    margin: 8vh auto 0;
    padding: 0 var(--space-5) var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .drop {
    text-align: center;
    padding: var(--space-6);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    transition: border-color 150ms var(--ease);
  }
  .drop.dragging {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  h2 {
    margin: 0 0 var(--space-2);
    font-size: 18px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
  .error {
    color: var(--danger);
    margin: var(--space-4) 0 0;
  }
  .recent header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-1);
  }
  h3 {
    font-size: 13px;
    margin: 0 0 var(--space-1);
  }
  .recent h3 {
    margin: 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  li {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 6px;
  }
  li + li {
    border-top: 1px solid var(--border);
  }
  .item {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 8px 10px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .item:hover .title {
    color: var(--accent-text);
  }
  .thumb {
    flex: none;
    display: grid;
    place-items: center;
    width: 64px;
    height: 36px;
    overflow: hidden;
    color: var(--fg-muted);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    flex: none;
    font-size: 12px;
  }
  .remove {
    width: 24px;
    height: 24px;
    padding: 5px;
    opacity: 0.6;
  }
  .remove:hover,
  .remove:focus-visible {
    opacity: 1;
  }
  .tip p {
    margin: 0;
  }
  .example-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
