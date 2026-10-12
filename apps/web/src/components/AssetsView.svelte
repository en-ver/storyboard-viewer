<script lang="ts">
  import { tick } from 'svelte';
  import {
    ASSET_KINDS,
    addAsset,
    addVariant,
    assetReferences,
    classifySrc,
    guessKind,
    removeAsset,
    slugify,
    updateAsset,
    updateManifest,
    type Asset,
    type AssetInput,
    type AssetKind,
  } from '@storyboard-viewer/format';
  import { ensureFont, fontFamily } from '../lib/fonts';
  import { audio } from '../lib/audio-editor.svelte';
  import { isContextMenuKey, sep, type MenuItem } from '../lib/menu';
  import { app } from '../lib/state.svelte';
  import { copyText, ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';
  import MediaView from './MediaView.svelte';
  import SuggestInput from './SuggestInput.svelte';

  let kind = $state<AssetKind | null>(null);
  let category = $state<string | null>(null);
  let query = $state('');
  let selectedId = $state<string | null>(null);

  const all = $derived(app.project?.assets.assets ?? []);
  const categoryLabel = $derived(
    new Map((app.project?.manifest.categories ?? []).map((c) => [c.id, c.label])),
  );
  const categories = $derived([...new Set(all.map((a) => a.category ?? 'uncategorized'))]);
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (a) =>
        (!kind || a.kind === kind) &&
        (!category || (a.category ?? 'uncategorized') === category) &&
        (!q ||
          a.name.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          (a.tags ?? []).some((t) => t.toLowerCase().includes(q))),
    );
  });
  const selected = $derived(all.find((a) => a.id === selectedId) ?? null);
  const usedBy = $derived(selected && app.project ? assetReferences(app.project, selected.id) : []);

  const editable = $derived(app.canEdit);
  let fileInput = $state<HTMLInputElement>();
  let replaceInput = $state<HTMLInputElement>();
  let dragging = $state(false);
  let importing = $state(false);
  let linkOpen = $state(false);
  let linkValue = $state('');
  let linkError = $state('');
  let confirmDelete = $state(false);

  $effect(() => {
    void selectedId;
    confirmDelete = false;
  });

  // Load font assets so cards and the detail panel can preview them.
  $effect(() => {
    for (const a of all) if (a.kind === 'font') void ensureFont(a.id, app.mediaUrl(a.src));
  });

  async function importFiles(files: File[]) {
    if (!files.length || !editable) return;
    importing = true;
    try {
      const extra: Partial<AssetInput> = {};
      if (category && category !== 'uncategorized') extra.category = category;
      const ids = await app.importFiles(files, extra);
      if (ids.length === 1) selectedId = ids[0]!;
      if (ids.length)
        app.toast(`Imported ${ids.length} asset${ids.length > 1 ? 's' : ''}`, { kind: 'info' });
    } finally {
      importing = false;
    }
  }

  async function addLink(e: SubmitEvent) {
    e.preventDefault();
    linkError = '';
    const value = linkValue.trim();
    if (!value) return;
    let input: AssetInput;
    try {
      if (/^https?:\/\//i.test(value)) {
        const guessed = guessKind(value);
        if (!guessed)
          throw new Error('Could not tell the kind from the URL (use a file extension)');
        const name =
          decodeURIComponent(new URL(value).pathname.split('/').pop() ?? '') || 'Remote asset';
        input = { name: name.replace(/\.[^.]+$/, ''), kind: guessed, src: value };
      } else {
        input = await app.linkLocalFile(value);
      }
    } catch (err) {
      linkError = (err as Error).message;
      return;
    }
    if (category && category !== 'uncategorized') input.category = category;
    let id = '';
    if (
      app.edit('Link asset', (p) => {
        const r = addAsset(p, input);
        id = r.id;
        return r;
      })
    ) {
      selectedId = id;
      linkOpen = false;
      linkValue = '';
    }
  }

  const patch = (label: string, fields: Record<string, unknown>, key?: string) => {
    if (!selected) return;
    const id = selected.id;
    app.edit(
      label,
      (p) => updateAsset(p, id, fields as Partial<Asset>),
      key ? { coalesce: `${id}:${key}` } : {},
    );
  };

  /** Sets the category by its label (or ID); a new name creates the category. */
  function setCategory(text: string) {
    if (!selected) return;
    const label = text.trim();
    const cats = app.project!.manifest.categories ?? [];
    if (!label) {
      if (selected.category) patch('Change category', { category: null });
      return;
    }
    const lower = label.toLowerCase();
    const hit = cats.find((c) => c.label.toLowerCase() === lower || c.id === lower);
    if (hit) {
      if (hit.id !== selected.category) patch('Change category', { category: hit.id });
      return;
    }
    if (selected.category && !categoryLabel.has(selected.category)) {
      if (selected.category.replace(/_/g, ' ').toLowerCase() === lower) return;
    }
    const id = selected.id;
    const assetKind = selected.kind;
    let cid = slugify(label, 'category').replace(/-/g, '_');
    for (let n = 2; cats.some((c) => c.id === cid); n++)
      cid = `${slugify(label, 'category').replace(/-/g, '_')}_${n}`;
    app.edit('Add category', (p) =>
      updateAsset(
        updateManifest(p, { categories: [...cats, { id: cid, label, kinds: [assetKind] }] }),
        id,
        { category: cid },
      ),
    );
  }

  // ---- context menu (asset cards): use in the selected shot, rename, delete

  async function rename(id: string) {
    selectedId = id;
    await tick();
    const el = document.getElementById('asset-name-input') as HTMLInputElement | null;
    el?.focus();
    el?.select();
  }

  async function deleteAsset(id: string) {
    selectedId = id;
    await tick();
    remove();
    if (confirmDelete) document.getElementById('confirm-delete-asset')?.focus();
  }

  function useInShot(a: Asset) {
    const shot = app.selectedShot;
    if (!shot) return;
    if (a.kind === 'image' || a.kind === 'video') {
      let vid = '';
      if (
        app.edit('Add variant', (p) => {
          const r = addVariant(
            p,
            shot,
            { type: 'image', asset: a.id, name: a.name },
            { activate: true },
          );
          vid = r.id;
          return r;
        })
      ) {
        const s = app.project?.shots[shot];
        if (s) app.chooseVariant(s, vid);
        app.toast(`Added ${a.name} to the shot`, { kind: 'info' });
      }
    } else if (a.kind === 'audio') {
      audio.addCueFrom(a.id, { shot }, 'shot');
      audio.sectionOpen = true;
      app.toast(`Added ${a.name} as a sound on the shot`, { kind: 'info' });
    }
  }

  function assetMenu(e: MouseEvent | KeyboardEvent, a: Asset) {
    const shotEntry = app.shots.find((s) => s.ref.id === app.selectedShot);
    const usable = a.kind === 'image' || a.kind === 'video' || a.kind === 'audio';
    const items: MenuItem[] = [];
    if (editable)
      items.push(
        {
          label: shotEntry
            ? `Use in Shot ${shotEntry.index + 1}${shotEntry.shot.title ? `: ${shotEntry.shot.title}` : ''}`
            : 'Use in shot (select a shot first)',
          icon: a.kind === 'audio' ? 'volume' : 'image',
          command: 'use-in-shot',
          disabled: !shotEntry || !usable,
          onSelect: () => useInShot(a),
        },
        sep(),
        {
          label: 'Rename',
          icon: 'edit',
          command: 'rename-asset',
          onSelect: () => void rename(a.id),
        },
      );
    items.push({
      label: 'Copy asset ID',
      icon: 'copy',
      onSelect: async () => {
        if (await copyText(a.id)) app.toast(`Copied asset ID ${a.id}`, { kind: 'info' });
      },
    });
    if (editable)
      items.push(sep(), {
        label: 'Delete…',
        icon: 'trash',
        danger: true,
        command: 'delete-asset',
        onSelect: () => void deleteAsset(a.id),
      });
    ui.openContextMenu(e, items, `Asset ${a.name}`);
  }

  async function replaceFile(files: FileList | null) {
    const f = files?.[0];
    if (!f || !selected) return;
    const id = selected.id;
    const assetKind = selected.kind;
    try {
      const input = await app.prepareFile(f);
      if (input.kind !== assetKind)
        throw new Error(`Pick a ${assetKind} file to replace this ${assetKind}`);
      const fields: Record<string, unknown> = {
        src: input.src,
        mime: input.mime ?? null,
        size: input.size ?? null,
        sha256: input.sha256 ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        duration: input.duration ?? null,
      };
      app.edit('Replace file', (p) => updateAsset(p, id, fields as Partial<Asset>));
    } catch (err) {
      app.toast((err as Error).message, { kind: 'error' });
    }
  }

  function remove() {
    if (!selected) return;
    const id = selected.id;
    const name = selected.name;
    if (usedBy.length && !confirmDelete) {
      confirmDelete = true;
      return;
    }
    if (app.edit('Delete asset', (p) => removeAsset(p, id, { force: true }))) {
      selectedId = null;
      app.toast(`Deleted ${name}`, {
        kind: 'info',
        action: { label: 'Undo', run: () => app.undo() },
      });
    }
  }

  const count = (pred: (a: Asset) => boolean) => all.filter(pred).length;
  const srcKind = (src: string) => {
    const k = classifySrc(src)?.kind;
    return k === 'embedded'
      ? 'Embedded'
      : k === 'linked'
        ? 'Linked file'
        : k === 'remote'
          ? 'Remote'
          : 'Invalid';
  };
  const fmtBytes = (n: number) =>
    n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
</script>

<div class="assets" class:with-detail={!!selected}>
  <section
    class="library"
    class:dragging
    aria-label="Asset library"
    ondragover={(e) => {
      if (editable && e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        dragging = true;
      }
    }}
    ondragleave={(e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragging = false;
    }}
    ondrop={(e) => {
      e.preventDefault();
      dragging = false;
      void importFiles([...(e.dataTransfer?.files ?? [])]);
    }}
  >
    <div class="filters" data-tour="assets-filters">
      <div class="top">
        <label class="search">
          <Icon name="search" size={14} />
          <span class="visually-hidden">Search assets by name or tag</span>
          <input
            id="asset-search"
            type="search"
            placeholder="Search name or tag"
            bind:value={query}
          />
        </label>
        {#if editable}
          <div class="import">
            <button
              type="button"
              class="btn"
              id="import-assets"
              data-tour="assets-import"
              disabled={importing}
              onclick={() => fileInput?.click()}
            >
              <Icon name="upload" size={14} />
              {importing ? 'Importing…' : 'Import files'}
            </button>
            <button
              type="button"
              class="btn ghost"
              aria-expanded={linkOpen}
              onclick={() => (linkOpen = !linkOpen)}
            >
              <Icon name="link" size={14} /> Link
            </button>
            <input
              bind:this={fileInput}
              id="asset-file-input"
              type="file"
              multiple
              accept="image/*,audio/*,video/*,.woff,.woff2,.ttf,.otf"
              class="visually-hidden"
              aria-label="Import files"
              onchange={(e) => {
                const t = e.target as HTMLInputElement;
                void importFiles([...(t.files ?? [])]).then(() => (t.value = ''));
              }}
            />
          </div>
        {/if}
      </div>
      {#if linkOpen && editable}
        <form class="link-form" onsubmit={addLink}>
          <label for="link-input" class="muted">
            {app.source?.linkPath
              ? 'Link a file without copying it: a path relative to the folder that contains the storyboard (or absolute), or an https:// URL'
              : 'Link a remote file by https:// URL (local files can be linked when the storyboard is opened with sbd serve)'}
          </label>
          <div class="row">
            <input
              id="link-input"
              bind:value={linkValue}
              placeholder={app.source?.linkPath
                ? '../renders/shot-12.mp4 or https://…'
                : 'https://…'}
            />
            <button type="submit" class="btn primary">Add link</button>
          </div>
          {#if linkError}<p class="error" role="alert">{linkError}</p>{/if}
        </form>
      {/if}
      <div class="chips" role="group" aria-label="Filter by kind">
        <button
          type="button"
          class="chip"
          aria-pressed={kind === null}
          onclick={() => (kind = null)}
        >
          All <span class="count">{all.length}</span>
        </button>
        {#each ASSET_KINDS as k (k)}
          {@const n = count((a) => a.kind === k)}
          {#if n}
            <button
              type="button"
              class="chip"
              data-kind={k}
              aria-pressed={kind === k}
              onclick={() => (kind = kind === k ? null : k)}
            >
              {k[0]!.toUpperCase() + k.slice(1)} <span class="count">{n}</span>
            </button>
          {/if}
        {/each}
      </div>
      <div class="chips" role="group" aria-label="Filter by category">
        {#each categories as c (c)}
          <button
            type="button"
            class="chip"
            data-category={c}
            aria-pressed={category === c}
            onclick={() => (category = category === c ? null : c)}
          >
            {categoryLabel.get(c) ?? c.replace(/_/g, ' ')}
            <span class="count">{count((a) => (a.category ?? 'uncategorized') === c)}</span>
          </button>
        {/each}
      </div>
    </div>
    <p class="visually-hidden" aria-live="polite">{filtered.length} assets shown</p>
    {#if filtered.length === 0}
      <p class="muted empty">
        {all.length
          ? 'No assets match.'
          : editable
            ? 'No assets yet. Drop images, audio, video or fonts here.'
            : 'No assets yet.'}
      </p>
    {/if}
    <ul class="grid" data-tour="assets-grid">
      {#each filtered as a (a.id)}
        {@const thumb = a.kind === 'image' ? a.src : a.kind === 'video' ? a.poster : undefined}
        <li>
          <button
            type="button"
            class="card"
            data-asset-id={a.id}
            aria-pressed={selectedId === a.id}
            onclick={() => (selectedId = selectedId === a.id ? null : a.id)}
            oncontextmenu={(e) => assetMenu(e, a)}
            onkeydown={(e) => isContextMenuKey(e) && assetMenu(e, a)}
          >
            <span class="thumb" data-kind={a.kind}>
              {#if thumb && app.mediaUrl(thumb)}
                <img src={app.mediaUrl(thumb)} alt="" loading="lazy" />
              {:else if a.kind === 'audio'}
                <Icon name="volume" size={24} />
              {:else if a.kind === 'video'}
                <Icon name="film" size={24} />
              {:else}
                <span class="font-sample" style:font-family="{fontFamily(a.id)}, var(--font-sans)"
                  >Aa</span
                >
              {/if}
              <span class="kind">{a.kind}{a.duration ? ` · ${a.duration.toFixed(1)}s` : ''}</span>
            </span>
            <span class="name">{a.name}</span>
            <span class="sub">
              {categoryLabel.get(a.category ?? '') ?? a.category ?? 'Uncategorized'}
              {#if a.tags?.length}<span class="tags"> · {a.tags.join(', ')}</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </section>

  {#if selected}
    <aside class="detail" aria-labelledby="asset-detail-title" data-asset-id={selected.id}>
      <header>
        <h2 id="asset-detail-title">{selected.name}</h2>
        <button
          type="button"
          class="btn ghost icon"
          aria-label="Close asset details"
          onclick={() => (selectedId = null)}><Icon name="close" /></button
        >
      </header>
      <div class="preview" class:audio={selected.kind === 'audio'}>
        {#key selected.id}
          <MediaView asset={selected} alt={selected.name} controls />
        {/key}
      </div>
      {#if selected.kind === 'font'}
        <p class="font-preview" style:font-family="{fontFamily(selected.id)}, var(--font-sans)">
          The quick brown fox jumps over the lazy dog. 0123456789
        </p>
      {/if}
      {#if editable}
        <div class="edit">
          <label>
            <span>Name</span>
            <input
              id="asset-name-input"
              value={selected.name}
              onchange={(e) => {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v) patch('Rename asset', { name: v });
              }}
            />
          </label>
          <label>
            <span>Category</span>
            <!-- Free text: pick an existing category or type a new one (it is created). -->
            <SuggestInput
              id="asset-category-input"
              label="Category"
              value={selected.category
                ? (categoryLabel.get(selected.category) ?? selected.category.replace(/_/g, ' '))
                : ''}
              placeholder="Uncategorized"
              suggestions={(app.project?.manifest.categories ?? [])
                .filter((c) => !c.kinds?.length || c.kinds.includes(selected.kind))
                .map((c) => c.label)}
              oncommit={setCategory}
            />
          </label>
          <label>
            <span>Tags</span>
            <input
              value={(selected.tags ?? []).join(', ')}
              placeholder="hero, night"
              onchange={(e) => {
                const tags = (e.target as HTMLInputElement).value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean);
                patch('Edit tags', { tags: tags.length ? tags : null });
              }}
            />
          </label>
          <label>
            <span>Notes</span>
            <textarea
              rows="2"
              value={selected.notes ?? ''}
              onchange={(e) =>
                patch('Edit notes', {
                  notes: (e.target as HTMLTextAreaElement).value.trim() || null,
                })}></textarea>
          </label>
          <div class="pair">
            <label>
              <span>Credit</span>
              <input
                value={selected.credit ?? ''}
                onchange={(e) =>
                  patch('Edit credit', {
                    credit: (e.target as HTMLInputElement).value.trim() || null,
                  })}
              />
            </label>
            <label>
              <span>License</span>
              <input
                value={selected.license ?? ''}
                onchange={(e) =>
                  patch('Edit license', {
                    license: (e.target as HTMLInputElement).value.trim() || null,
                  })}
              />
            </label>
          </div>
        </div>
      {/if}
      <dl>
        <dt>ID</dt>
        <dd class="mono">{selected.id}</dd>
        <dt>Kind</dt>
        <dd>{selected.kind}{selected.mime ? ` (${selected.mime})` : ''}</dd>
        {#if !editable}
          <dt>Category</dt>
          <dd>{categoryLabel.get(selected.category ?? '') ?? selected.category ?? '—'}</dd>
          {#if selected.tags?.length}
            <dt>Tags</dt>
            <dd>{selected.tags.join(', ')}</dd>
          {/if}
        {/if}
        <dt>Source</dt>
        <dd><span>{srcKind(selected.src)}</span> <code class="mono">{selected.src}</code></dd>
        {#if selected.width}
          <dt>Size</dt>
          <dd class="mono">{selected.width} × {selected.height}</dd>
        {/if}
        {#if selected.duration !== undefined}
          <dt>Duration</dt>
          <dd class="mono">{selected.duration.toFixed(2)} s</dd>
        {/if}
        {#if selected.size}
          <dt>File</dt>
          <dd class="mono">{fmtBytes(selected.size)}</dd>
        {/if}
        {#if selected.notes && !editable}
          <dt>Notes</dt>
          <dd>{selected.notes}</dd>
        {/if}
        <dt>Used by</dt>
        <dd>
          {#if usedBy.length}
            <ul class="uses">
              {#each usedBy as u (u)}<li>{u}</li>{/each}
            </ul>
          {:else}
            <span class="muted">Not used yet</span>
          {/if}
        </dd>
      </dl>
      {#if editable}
        <div class="danger-zone">
          {#if confirmDelete}
            <div class="confirm" role="alert">
              <p>
                Used in {usedBy.length} place{usedBy.length > 1 ? 's' : ''}. Deleting also removes
                those variants, layers and cues.
              </p>
              <div class="row">
                <button type="button" class="btn small" onclick={() => (confirmDelete = false)}
                  >Cancel</button
                >
                <button
                  type="button"
                  class="btn small danger"
                  id="confirm-delete-asset"
                  onclick={remove}>Delete anyway</button
                >
              </div>
            </div>
          {:else}
            <button type="button" class="btn small" onclick={() => replaceInput?.click()}>
              <Icon name="refresh" size={14} /> Replace file
            </button>
            <button type="button" class="btn small ghost danger" id="delete-asset" onclick={remove}>
              <Icon name="trash" size={14} /> Delete
            </button>
          {/if}
          <input
            bind:this={replaceInput}
            type="file"
            class="visually-hidden"
            aria-label="Replace file"
            onchange={(e) => {
              const t = e.target as HTMLInputElement;
              void replaceFile(t.files).then(() => (t.value = ''));
            }}
          />
        </div>
      {/if}
    </aside>
  {/if}
</div>

<style>
  .assets {
    display: grid;
    grid-template-columns: 1fr;
    height: 100%;
    min-height: 0;
  }
  .assets.with-detail {
    grid-template-columns: 1fr 360px;
  }
  .library {
    overflow: auto;
    padding: var(--space-5);
    min-width: 0;
  }
  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .library.dragging {
    outline: 2px dashed var(--accent);
    outline-offset: -8px;
    background: var(--accent-soft);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .import {
    display: flex;
    gap: var(--space-2);
  }
  .link-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: 640px;
    font-size: 12px;
  }
  .row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .link-form input,
  .edit input,
  .edit textarea {
    flex: 1;
    font: inherit;
    font-size: 13px;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 5px 8px;
    min-width: 0;
    width: 100%;
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
  .edit :global(.suggest) {
    display: flex;
    width: 100%;
  }
  .edit {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .edit label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }
  .font-preview {
    font-size: 22px;
    line-height: 1.3;
    margin: 0 0 var(--space-4);
  }
  .danger-zone {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .btn.small {
    padding: 3px 10px;
    font-size: 12px;
  }
  .btn.danger {
    color: var(--danger);
  }
  .btn.small.danger:not(.ghost) {
    background: var(--danger);
    border-color: var(--danger);
    color: var(--accent-fg);
  }
  .confirm p {
    margin: 0 0 var(--space-2);
    font-size: 13px;
  }
  .search {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 360px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg-muted);
  }
  .search:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .search input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    font: inherit;
    color: var(--fg);
    padding: 6px 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .empty {
    margin: var(--space-5) 0;
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-4);
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: var(--space-2);
    font: inherit;
    color: inherit;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
  }
  .card:hover {
    border-color: var(--border-strong);
  }
  .card[aria-pressed='true'] {
    border-color: var(--accent);
  }
  .thumb {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 10;
    margin-bottom: var(--space-2);
    background: var(--surface-2);
    border-radius: var(--radius);
    overflow: hidden;
    color: var(--fg-muted);
  }
  .thumb[data-kind='image'] {
    background: repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 0 0 / 16px
      16px;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .kind {
    position: absolute;
    right: 6px;
    bottom: 6px;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--overlay-fg);
    background: var(--overlay-bg);
    border-radius: var(--radius-sm);
    padding: 1px 5px;
  }
  .font-sample {
    font-size: 28px;
    font-weight: 600;
  }
  .name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 12px;
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tags {
    color: var(--fg-muted);
  }
  .detail {
    border-left: 1px solid var(--border);
    background: var(--surface);
    overflow: auto;
    padding: var(--space-4);
  }
  .detail header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .detail h2 {
    font-size: 15px;
    margin: 0;
  }
  .preview {
    background: var(--stage);
    border-radius: var(--radius);
    overflow: hidden;
    aspect-ratio: 16 / 10;
    margin-bottom: var(--space-4);
  }
  .preview.audio {
    aspect-ratio: auto;
    background: none;
  }
  dl {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: var(--space-2) var(--space-3);
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--fg-muted);
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .uses {
    margin: 0;
    padding-left: 16px;
  }
  @media (max-width: 900px) {
    .assets.with-detail {
      grid-template-columns: 1fr;
    }
    .detail {
      border-left: 0;
      border-top: 1px solid var(--border);
    }
  }
  /* phones: two cards a row */
  @media (max-width: 600px) {
    .library {
      padding: var(--space-3);
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: var(--space-3);
    }
  }
</style>
