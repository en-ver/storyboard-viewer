<script lang="ts">
  import { addShot, moveShotWithLines, unassignedLines } from '@storyboard-viewer/format';
  import { app } from '../lib/state.svelte';
  import { player } from '../lib/player.svelte';
  import Icon from './Icon.svelte';
  import ScriptLines from './ScriptLines.svelte';
  import ShotCard from './ShotCard.svelte';
  import ShotInspector from './ShotInspector.svelte';

  const loose = $derived(app.project ? unassignedLines(app.project) : []);
  // The script editor (CodeMirror) is a separate chunk, loaded when the Script view is shown.
  const scriptView = import('./ScriptView.svelte');
  const visible = $derived(app.shots.filter((s) => app.matchesFilter(s.shot)));
  const board = $derived(app.storyView === 'board');
  const inspected = $derived(
    board && app.canEdit && app.selectedShot
      ? app.shots.find((s) => s.ref.id === app.selectedShot)
      : undefined,
  );

  let dragging = $state<string | null>(null);
  let dropAt = $state<number | null>(null);
  let announcement = $state('');

  // Follow the playhead while playing.
  $effect(() => {
    const id = player.shotId;
    if (player.playing && id) {
      document
        .querySelector(`[data-shot-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  function onDragStart(e: DragEvent, id: string) {
    dragging = id;
    e.dataTransfer?.setData('application/x-sbd-shot', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    const card = document.querySelector<HTMLElement>(`article[data-shot-id="${CSS.escape(id)}"]`);
    if (card) e.dataTransfer?.setDragImage(card, 24, 24);
  }

  function onDragOver(e: DragEvent, index: number) {
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = e.clientY < r.top + r.height / 2 ? index : index + 1;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const id = dragging;
    const at = dropAt;
    dragging = null;
    dropAt = null;
    if (!id || at === null) return;
    const from = app.shots.findIndex((s) => s.ref.id === id);
    const to = at > from ? at - 1 : at;
    if (to === from) return;
    if (app.edit('Move shot', (p) => moveShotWithLines(p, id, { index: to })))
      announcement = `Moved shot to position ${to + 1} of ${app.shots.length}`;
  }

  function toggleTag(t: string) {
    const cur = app.tagFilter;
    app.setTagFilter(cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  }

  function addAtEnd() {
    let id = '';
    if (
      app.edit('Add shot', (p) => {
        const r = addShot(p, {});
        id = r.id;
        return r;
      })
    )
      app.selectShot(id, { scroll: true });
  }
</script>

<div class="story-top">
  <div class="view-toggle" role="radiogroup" aria-label="Story layout">
    <button
      type="button"
      role="radio"
      id="view-script"
      aria-checked={!board}
      onclick={() => app.setStoryView('script')}><Icon name="script" size={14} />Script</button
    >
    <button
      type="button"
      role="radio"
      id="view-board"
      aria-checked={board}
      onclick={() => app.setStoryView('board')}><Icon name="board" size={14} />Board</button
    >
  </div>
  {#if app.allTags.length}
    <div class="tag-filter" role="group" aria-label="Filter shots by tag">
      <Icon name="filter" size={13} />
      {#each app.allTags as t (t)}
        <button
          type="button"
          class="chip"
          data-filter-tag={t}
          aria-pressed={app.tagFilter.includes(t)}
          onclick={() => toggleTag(t)}>#{t}</button
        >
      {/each}
      {#if app.tagFilter.length}
        <button type="button" class="btn ghost tiny" onclick={() => app.setTagFilter([])}
          >Clear</button
        >
        <span class="muted count" role="status">{visible.length} of {app.shots.length} shots</span>
      {/if}
    </div>
  {/if}
</div>

{#if !board}
  <div class="script-wrap">
    {#await scriptView}
      <p class="muted loading-editor" role="status">Loading the script editor…</p>
    {:then m}
      <m.default />
    {:catch e}
      <p class="error" role="alert">The script editor could not load: {e.message}</p>
    {/await}
  </div>
{:else}
  <div class="story-layout" class:with-inspector={!!inspected}>
    <section class="story" aria-label="Story">
      {#if app.shots.length === 0}
        <div class="empty">
          <h2>No shots yet</h2>
          <p class="muted">
            {#if app.canEdit}
              Add a shot below, or ask your agent to add shots (MCP tool <code>add_shot</code>).
            {:else}
              Ask your agent to add shots (MCP tool <code>add_shot</code>), or run
              <code>sbd import-fountain script.fountain</code>.
            {/if}
          </p>
        </div>
      {/if}
      <ol class="shots" data-tour="board" ondragend={() => ((dragging = null), (dropAt = null))}>
        {#each app.shots as { ref, shot, index } (ref.id)}
          {#if app.matchesFilter(shot)}
            <li
              class:drop-before={dropAt === index}
              class:drop-after={dropAt === index + 1 && index === app.shots.length - 1}
              class:dragging={dragging === ref.id}
              ondragover={(e) => onDragOver(e, index)}
              ondrop={onDrop}
            >
              <ShotCard
                {shot}
                {ref}
                {index}
                ondragstartshot={onDragStart}
                onmoved={(m) => (announcement = m)}
              />
            </li>
          {/if}
        {/each}
      </ol>
      <p class="visually-hidden" aria-live="polite">{announcement}</p>
      {#if app.canEdit}
        <button type="button" class="add-shot" id="add-shot" onclick={addAtEnd}>
          <Icon name="plus" size={14} /> Add shot
        </button>
      {/if}
      {#if loose.length}
        <section class="loose" aria-labelledby="loose-title">
          <h2 id="loose-title">
            Lines not in a shot <span class="mono muted">{loose.length}</span>
          </h2>
          <ScriptLines lineIds={loose} label="Lines not in a shot" />
        </section>
      {/if}
    </section>
    {#if inspected}
      <ShotInspector entry={inspected} />
    {/if}
  </div>
{/if}

<style>
  .story-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    max-width: 1280px;
    margin: 0 auto;
    padding: var(--space-3) var(--space-5) 0;
  }
  .view-toggle {
    display: inline-flex;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .view-toggle button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--fg-muted);
    background: var(--surface);
    border: 0;
    cursor: pointer;
  }
  .view-toggle button + button {
    border-left: 1px solid var(--border-strong);
  }
  .view-toggle button[aria-checked='true'] {
    color: var(--fg);
    background: var(--surface-3);
  }
  .tag-filter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    color: var(--fg-muted);
  }
  .tag-filter .count {
    font-size: 12px;
  }
  .btn.tiny {
    padding: 1px 6px;
    font-size: 12px;
  }
  .loading-editor {
    padding: var(--space-5);
  }
  .error {
    color: var(--danger);
  }
  .script-wrap {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 var(--space-5) var(--space-6);
  }
  .story-layout {
    display: grid;
    grid-template-columns: 1fr;
    min-height: 100%;
  }
  .story-layout.with-inspector {
    grid-template-columns: minmax(0, 1fr) 340px;
  }
  .story {
    width: 100%;
    max-width: 1120px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-5) 120px;
    min-width: 0;
  }
  .shots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .shots li {
    position: relative;
  }
  .shots li.dragging {
    opacity: 0.45;
  }
  .drop-before::before,
  .drop-after::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  .drop-before::before {
    top: calc(-1 * var(--space-2) - 2px);
  }
  .drop-after::after {
    bottom: calc(-1 * var(--space-2) - 2px);
  }
  .add-shot {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    margin-top: var(--space-4);
    padding: var(--space-3);
    font: inherit;
    font-weight: 500;
    color: var(--fg-muted);
    background: transparent;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    cursor: pointer;
  }
  .add-shot:hover {
    color: var(--fg);
    background: var(--surface);
  }
  .loose {
    margin-top: var(--space-5);
    padding: var(--space-4);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
  }
  .loose h2,
  .empty h2 {
    font-size: 14px;
    margin: 0 0 var(--space-3);
  }
  .empty {
    text-align: center;
    padding: var(--space-6);
  }
  @media (max-width: 1000px) {
    .story-layout.with-inspector {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 600px) {
    .story-top {
      padding: var(--space-3) var(--space-3) 0;
    }
    .script-wrap {
      padding: 0 var(--space-3) var(--space-5);
    }
    .story {
      padding: var(--space-3) var(--space-3) 96px;
    }
  }
</style>
