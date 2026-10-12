<script lang="ts">
  // Side panel for the selected shot (Board view): title, duration, pictures (variants as a
  // thumbnail strip; tools act on the picture shown), details (free text, only fields with a
  // value), tags and the shot's audio. Inputs commit on change.
  import { tooltip } from '../lib/tooltip';
  import {
    addVariant,
    aspectValue,
    moveVariant,
    removeVariant,
    setActiveVariant,
    updateShot,
    updateVariant,
    type Shot,
    type ShotRef,
  } from '@storyboard-viewer/format';
  import { app } from '../lib/state.svelte';
  import { player } from '../lib/player.svelte';
  import { addImageToShot } from '../lib/shot-actions';
  import Icon from './Icon.svelte';
  import ShotAudio from './ShotAudio.svelte';
  import ShotFields from './ShotFields.svelte';
  import ShotSummary from './ShotSummary.svelte';
  import { ui } from '../lib/ui.svelte';
  import TagEditor from './TagEditor.svelte';
  import VariantCarousel from './VariantCarousel.svelte';

  let { entry }: { entry: { ref: ShotRef; shot: Shot; index: number } } = $props();
  const shot = $derived(entry.shot);
  const id = $derived(entry.shot.id);
  const derivedDuration = $derived.by(() => {
    const t = player.animatic.shots.find((s) => s.id === id);
    return t ? (t.end - t.start).toFixed(1) : '';
  });

  const shown = $derived(app.shownVariant(shot));
  const shownIndex = $derived((shot.variants ?? []).findIndex((v) => v.id === shown?.id));
  const isDefault = $derived(
    !!shown && (shot.active_variant ?? shot.variants?.[0]?.id) === shown.id,
  );
  let upload = $state<HTMLInputElement>();

  function addImageVariant(assetId: string) {
    const asset = app.assets.get(assetId);
    let vid = '';
    if (
      app.edit('Add variant', (p) => {
        const r = addVariant(
          p,
          id,
          { type: 'image', asset: assetId, name: asset?.name ?? 'Image' },
          { activate: true },
        );
        vid = r.id;
        return r;
      })
    )
      app.chooseVariant(app.project!.shots[id]!, vid);
  }

  function addCanvas() {
    let vid = '';
    if (
      app.edit('Add canvas variant', (p) => {
        const r = addVariant(
          p,
          id,
          { type: 'canvas', name: 'Layout', layers: [] },
          { activate: true },
        );
        vid = r.id;
        return r;
      })
    ) {
      app.chooseVariant(app.project!.shots[id]!, vid);
      app.setTab('canvas');
    }
  }

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    const ids = await app.importFiles([...files]);
    for (const a of ids) addImageVariant(a);
  }

  function openOnCanvas(vid: string) {
    app.chooseVariant(shot, vid);
    app.setTab('canvas');
  }
</script>

<aside class="inspector" aria-labelledby="inspector-title" data-inspector={id}>
  <header>
    <h2 id="inspector-title">
      <span class="num mono">{entry.index + 1}</span> Shot details
    </h2>
    <button
      type="button"
      class="btn ghost icon"
      aria-label="Close shot details"
      onclick={() => app.selectShot(null)}><Icon name="close" /></button
    >
  </header>

  <div class="form">
    <label class="title">
      <span class="visually-hidden">Title</span>
      <input
        id="shot-title-input"
        value={shot.title ?? ''}
        placeholder="Untitled shot"
        onchange={(e) =>
          app.edit('Rename shot', (p) =>
            updateShot(p, id, { title: (e.target as HTMLInputElement).value.trim() || null }),
          )}
      />
    </label>
    <label class="duration">
      <span>Duration</span>
      <input
        id="shot-duration-input"
        type="number"
        min="0.1"
        step="0.1"
        value={shot.duration ?? ''}
        placeholder={derivedDuration}
        title="Empty = automatic ({derivedDuration} s)"
        onchange={(e) => {
          const v = (e.target as HTMLInputElement).value;
          app.edit('Set duration', (p) =>
            updateShot(p, id, { duration: v === '' ? null : Number(v) }),
          );
        }}
      />
      <span class="unit">s</span>
    </label>
  </div>

  <section
    class="variants"
    aria-label="Pictures"
    style:--frame-ratio={aspectValue(app.project?.manifest.aspect_ratio)}
  >
    <VariantCarousel {shot} label="Shot {entry.index + 1}" strip={ui.shotMore} />
    {#if shown}
      <div class="v-tools" data-variant-id={shown.id}>
        <input
          class="v-name"
          aria-label="Variant name"
          value={shown.name ?? ''}
          placeholder={shown.id}
          onchange={(e) =>
            app.edit('Rename variant', (p) =>
              updateVariant(p, id, shown.id, {
                name: (e.target as HTMLInputElement).value.trim() || null,
              } as never),
            )}
        />
        <button
          type="button"
          class="btn ghost tiny"
          aria-pressed={isDefault}
          {@attach tooltip(isDefault ? 'Shown by default' : 'Show this picture by default')}
          disabled={isDefault}
          onclick={() => app.edit('Set active variant', (p) => setActiveVariant(p, id, shown.id))}
          >{isDefault ? 'Default' : 'Make default'}</button
        >
        <button
          type="button"
          class="btn ghost icon"
          aria-label="Open {shown.name ?? shown.id} on the canvas"
          {@attach tooltip('Open on canvas')}
          onclick={() => openOnCanvas(shown.id)}><Icon name="layers" size={14} /></button
        >
        <button
          type="button"
          class="btn ghost icon"
          aria-label="Move {shown.name ?? shown.id} earlier"
          disabled={shownIndex <= 0}
          onclick={() =>
            app.edit('Reorder variants', (p) => moveVariant(p, id, shown.id, shownIndex - 1))}
          ><Icon name="prev" size={14} /></button
        >
        <button
          type="button"
          class="btn ghost icon"
          aria-label="Move {shown.name ?? shown.id} later"
          disabled={shownIndex >= (shot.variants?.length ?? 0) - 1}
          onclick={() =>
            app.edit('Reorder variants', (p) => moveVariant(p, id, shown.id, shownIndex + 1))}
          ><Icon name="next" size={14} /></button
        >
        <button
          type="button"
          class="btn ghost icon"
          aria-label="Delete {shown.name ?? shown.id}"
          onclick={() => app.edit('Delete variant', (p) => removeVariant(p, id, shown.id))}
          ><Icon name="trash" size={14} /></button
        >
      </div>
    {/if}
    <div class="add">
      <span class="muted">Add</span>
      <button type="button" class="btn ghost tiny" onclick={() => void addImageToShot(id)}>
        <Icon name="image" size={13} /> From assets
      </button>
      <button type="button" class="btn ghost tiny" onclick={() => upload?.click()}>
        <Icon name="upload" size={13} /> Upload
      </button>
      <button type="button" class="btn ghost tiny" onclick={addCanvas}>
        <Icon name="layers" size={13} /> Canvas
      </button>
      <input
        bind:this={upload}
        type="file"
        accept="image/*,video/*"
        multiple
        class="visually-hidden"
        aria-label="Upload images as variants"
        onchange={(e) => void onUpload((e.target as HTMLInputElement).files)}
      />
    </div>
  </section>

  <ShotSummary
    {shot}
    label="Shot {entry.index + 1}"
    controls="inspector-more"
    empty="Details and tags"
  />
  {#if ui.shotMore}
    <div class="more" id="inspector-more">
      <section aria-labelledby="details-title">
        <h3 id="details-title" class="eyebrow">Details</h3>
        <ShotFields {shot} label="Shot {entry.index + 1}" />
      </section>

      <section aria-labelledby="tags-title">
        <h3 id="tags-title" class="eyebrow">Tags</h3>
        <TagEditor {shot} label="Shot {entry.index + 1}" />
      </section>
    </div>
  {/if}

  <section aria-labelledby="audio-title">
    <h3 id="audio-title" class="eyebrow">Audio</h3>
    <ShotAudio {entry} label="Shot {entry.index + 1}" collapsible={false} />
  </section>
</aside>

<style>
  .inspector {
    position: sticky;
    top: 0;
    align-self: start;
    max-height: 100%;
    height: calc(100vh - 52px - 49px);
    overflow: auto;
    background: var(--surface);
    border-left: 1px solid var(--border);
    padding: var(--space-3) var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    font-size: 13px;
    margin: 0;
    color: var(--fg-2);
  }
  .num {
    color: var(--accent-text);
    margin-right: 4px;
  }
  h3 {
    margin: 0 0 4px;
  }
  .form {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .title input {
    width: 100%;
    font-weight: 600;
  }
  .duration {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .duration input {
    width: 72px;
  }
  .unit {
    color: var(--fg-muted);
  }
  .btn.icon {
    width: 26px;
    height: 26px;
    padding: 5px;
    flex: none;
  }
  .more {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .variants {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .v-tools {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .v-name {
    flex: 1;
    min-width: 0;
    padding: 2px 6px !important;
    font-size: 12.5px !important;
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    font-size: 12px;
  }
  .add .muted {
    margin-right: 4px;
  }
  .btn.tiny {
    padding: 2px 6px;
    font-size: 12px;
    gap: 4px;
  }
  .btn.tiny[aria-pressed='true'] {
    color: var(--accent-text);
  }
  .btn:disabled {
    opacity: 0.45;
  }
  .btn.tiny[aria-pressed='true']:disabled {
    opacity: 1;
  }
  @media (max-width: 1000px) {
    .inspector {
      position: fixed;
      top: 53px;
      right: 0;
      bottom: 49px;
      height: auto;
      width: min(360px, 92vw);
      z-index: 20;
      box-shadow: -8px 0 24px var(--shadow-color);
    }
  }
  /* phones: a full-screen sheet over the app (the × in its header closes it) */
  @media (max-width: 600px) {
    .inspector {
      inset: 0;
      width: 100%;
      z-index: 30;
      border-left: 0;
      box-shadow: none;
      padding: var(--space-3) var(--space-3) max(var(--space-5), env(safe-area-inset-bottom));
    }
    /* a vertical picture at full width would fill the screen: about half of it instead */
    .variants > :global(.carousel) {
      width: min(100%, calc(50vh * var(--frame-ratio, 1.7778)));
      align-self: center;
    }
  }
</style>
