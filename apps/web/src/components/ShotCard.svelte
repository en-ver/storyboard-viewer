<script lang="ts">
  import { tooltip } from '../lib/tooltip';
  import { aspectValue, type Shot, type ShotRef } from '@storyboard-viewer/format';
  import { isContextMenuKey } from '../lib/menu';
  import { moveShotBy, shotMenuItems } from '../lib/shot-actions';
  import { app } from '../lib/state.svelte';
  import { ui } from '../lib/ui.svelte';
  import { formatTime, player } from '../lib/player.svelte';
  import Icon from './Icon.svelte';
  import Menu from './Menu.svelte';
  import ScriptLines from './ScriptLines.svelte';
  import TagEditor from './TagEditor.svelte';
  import VariantCarousel from './VariantCarousel.svelte';

  let {
    shot,
    ref,
    index,
    ondragstartshot,
    onmoved,
  }: {
    shot: Shot;
    ref: ShotRef;
    index: number;
    ondragstartshot?: (e: DragEvent, id: string) => void;
    onmoved?: (message: string) => void;
  } = $props();

  const number = $derived(String(index + 1).padStart(2, '0'));
  const portrait = $derived(aspectValue(app.project?.manifest.aspect_ratio) < 1);
  const label = $derived(`Shot ${index + 1}${shot.title ? `: ${shot.title}` : ''}`);
  const timing = $derived(player.animatic.shots.find((s) => s.id === shot.id));
  const fields = $derived.by(() => {
    const defs = app.project?.manifest.shot_fields ?? [];
    const values = shot.fields ?? {};
    const out: Array<{ id: string; label: string; value: string }> = [];
    const fmt = (v: unknown) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
    for (const d of defs) {
      const v = values[d.id];
      if (v !== undefined && v !== null && v !== '')
        out.push({ id: d.id, label: d.label, value: fmt(v) });
    }
    for (const [k, v] of Object.entries(values)) {
      if (!defs.some((d) => d.id === k) && v !== null && v !== '') {
        out.push({ id: k, label: k.replace(/_/g, ' '), value: fmt(v) });
      }
    }
    return out;
  });
  const selected = $derived(app.selectedShot === shot.id);
  const playing = $derived(player.shotId === shot.id && (player.playing || player.time > 0));

  function move(delta: number) {
    const msg = moveShotBy(shot.id, delta);
    if (msg) onmoved?.(msg);
  }

  const items = $derived(shotMenuItems(shot.id, { onMoved: (m) => onmoved?.(m) }));

  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (isContextMenuKey(e) && !t.closest('input, textarea, [data-line-id]')) {
      ui.openContextMenu(e, items, `Actions for ${label}`);
      return;
    }
    if (!app.canEdit || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    e.preventDefault();
    move(e.key === 'ArrowUp' ? -1 : 1);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article
  class="shot"
  class:selected
  class:playing
  id="shot-{shot.id}"
  data-shot-id={shot.id}
  aria-labelledby="shot-title-{shot.id}"
  aria-current={selected ? 'true' : undefined}
  {onkeydown}
  oncontextmenu={(e) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    ui.openContextMenu(e, items, `Actions for ${label}`);
  }}
>
  <header>
    {#if app.canEdit}
      <!-- A span, not a <button>: Chromium does not start HTML5 drags from buttons. -->
      <span
        role="button"
        tabindex="0"
        class="grip"
        draggable="true"
        aria-label="Reorder {label}"
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        {@attach tooltip('Drag to reorder', 'or Alt+↑/↓')}
        ondragstart={(e) => ondragstartshot?.(e, shot.id)}
        onkeydown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            move(e.key === 'ArrowUp' ? -1 : 1);
          }
        }}><Icon name="grip" size={14} /></span
      >
    {/if}
    <button
      type="button"
      class="select"
      aria-pressed={selected}
      onclick={() => app.selectShot(selected ? null : shot.id)}
    >
      <span class="num mono" aria-hidden="true">{number}</span>
      <h3 id="shot-title-{shot.id}">
        <span class="visually-hidden">Shot {index + 1}{shot.title ? ':' : ''}</span>
        {shot.title ?? ''}
      </h3>
    </button>
    <span class="meta mono" title="Shot ID">{shot.id}</span>
    {#if timing}
      <span class="meta mono" title="Duration{shot.duration ? '' : ' (derived)'}">
        {(timing.end - timing.start).toFixed(1)}s{shot.duration ? '' : '*'}
      </span>
    {/if}
    <button
      type="button"
      class="btn ghost icon"
      aria-label="Play from {label}"
      onclick={() => player.playShot(shot.id)}><Icon name="play" size={14} /></button
    >
    {#if app.canEdit}
      <span class="hover-tools">
        <Menu label="Actions for {label}" {items} small />
      </span>
    {/if}
  </header>
  <div class="body" class:portrait>
    <div class="visual">
      <VariantCarousel {shot} {label} />
    </div>
    <div class="text">
      {#if ref.lines.length || app.canEdit}
        {#if !ref.lines.length}<p class="muted no-lines">No script lines</p>{/if}
        <ScriptLines lineIds={ref.lines} shotId={shot.id} label="Script lines of {label}" />
      {:else}
        <p class="muted no-lines">No script lines</p>
      {/if}
      {#if shot.tags?.length || app.canEdit}
        <TagEditor {shot} {label} compact />
      {/if}
      {#if fields.length}
        <dl class="fields">
          {#each fields as f (f.id)}
            <div data-field={f.id}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          {/each}
        </dl>
      {/if}
      {#if timing && player.time > 0 && playing}
        <p class="muted mono">at {formatTime(timing.start)}</p>
      {/if}
    </div>
  </div>
</article>

<style>
  .shot {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    transition: border-color 150ms var(--ease);
    scroll-margin: var(--space-6);
  }
  .shot.selected {
    border-color: var(--accent);
  }
  .shot.playing {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }
  .grip {
    display: grid;
    place-items: center;
    width: 20px;
    height: 24px;
    margin: 0 -8px 0 -10px;
    padding: 0;
    color: var(--fg-muted);
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: grab;
    opacity: 0;
    transition: opacity 150ms var(--ease);
  }
  .grip:active {
    cursor: grabbing;
  }
  .hover-tools {
    opacity: 0;
    transition: opacity 150ms var(--ease);
  }
  .shot:hover .grip,
  .shot:hover .hover-tools,
  .shot.selected .grip,
  .shot.selected .hover-tools,
  .grip:focus-visible,
  .hover-tools:focus-within {
    opacity: 1;
  }
  .select {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .num {
    font-size: 13px;
    font-weight: 600;
    color: var(--accent-text);
  }
  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--fg-muted);
    font-size: 11px;
  }
  .body {
    display: grid;
    grid-template-columns: 6fr minmax(240px, 5fr);
    gap: var(--space-5);
    align-items: start;
  }
  /* Script on the left, picture on the right. */
  .body > .visual {
    order: 2;
  }
  /* Vertical (9:16) frames: keep the picture about as tall as a 16:9 one so shots stay scannable. */
  .body.portrait {
    grid-template-columns: 1fr minmax(160px, 220px);
  }
  @media (max-width: 760px) {
    .body,
    .body.portrait {
      grid-template-columns: 1fr;
    }
    .body > .visual {
      order: 0;
    }
    /* stacked vertical frames: about half a phone screen tall, so the shot's text stays near */
    .body.portrait > .visual {
      width: min(100%, calc(55vh * 9 / 16));
      justify-self: center;
    }
  }
  @media (max-width: 600px) {
    .shot {
      padding: var(--space-3);
    }
    /* touch screens have no hover: keep the shot's tools reachable (the drag grip needs a mouse) */
    .hover-tools {
      opacity: 1;
    }
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .text :global(.script) {
    margin-top: calc(-1 * var(--space-2));
  }
  .no-lines {
    margin: 0;
    font-size: 13px;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: var(--space-2) var(--space-4);
    margin: 0;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .fields div {
    min-width: 0;
  }
  dt {
    font-size: 11px;
    font-weight: 500;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  dd {
    margin: 0;
    font-size: 13px;
    color: var(--fg-2);
    overflow-wrap: anywhere;
  }
</style>
