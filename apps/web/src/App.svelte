<script lang="ts">
  import { onMount } from 'svelte';
  import AppMenuBar from './components/AppMenuBar.svelte';
  import AssetPicker from './components/AssetPicker.svelte';
  import AssetsView from './components/AssetsView.svelte';
  import CanvasView from './components/CanvasView.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import FountainGuide from './components/FountainGuide.svelte';
  import HelpDialogs from './components/HelpDialogs.svelte';
  import IssuesButton from './components/IssuesButton.svelte';
  import NewStoryboardDialog from './components/NewStoryboardDialog.svelte';
  import OpenScreen from './components/OpenScreen.svelte';
  import PdfExportDialog from './components/PdfExportDialog.svelte';
  import PlayerBar from './components/PlayerBar.svelte';
  import SaveControls from './components/SaveControls.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import SoundtrackPanel from './components/SoundtrackPanel.svelte';
  import StoryView from './components/StoryView.svelte';
  import PrintView from './components/PrintView.svelte';
  import Toasts from './components/Toasts.svelte';
  import Tour from './components/Tour.svelte';
  import TourOffer from './components/TourOffer.svelte';
  import { tour } from './lib/tour.svelte';
  import VideoExportDialog from './components/VideoExportDialog.svelte';
  import { player } from './lib/player.svelte';
  import { app, TABS, type Tab } from './lib/state.svelte';
  import { ui } from './lib/ui.svelte';

  let updatedNote = $state('');
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    void app.init().then(() => {
      // first launch: offer the Getting started tour once (never in print / PDF export)
      if (!app.print) tour.maybeOffer();
    });
  });

  // Old links to the Timeline tab open the Soundtrack panel (the Timeline was folded into shots).
  $effect(() => {
    if (app.legacyTimeline) {
      ui.soundtrackOpen = true;
      app.legacyTimeline = false;
    }
  });

  const pickerOpen = $derived(!!ui.picker);

  // Announce live refreshes (visible pill + polite live region).
  $effect(() => {
    if (!app.lastUpdate) return;
    updatedNote = 'Updated';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (updatedNote = ''), 2500);
  });

  function onTabKey(e: KeyboardEvent, i: number) {
    const keys: Record<string, number> = {
      ArrowRight: (i + 1) % TABS.length,
      ArrowLeft: (i - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    app.setTab(TABS[next]!.id);
    document.getElementById(`tab-${TABS[next]!.id}`)?.focus();
  }

  function isTyping(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  }

  function onKeydown(e: KeyboardEvent) {
    if (!app.project || app.print) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 's') {
      e.preventDefault();
      void app.save();
      return;
    }
    // Undo/redo: inputs keep their own text undo.
    if (mod && !e.altKey && (key === 'z' || key === 'y') && !isTyping(e.target)) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) app.redo();
      else app.undo();
      return;
    }
    if (e.key === 'F10' && !e.shiftKey && !mod && !e.altKey) {
      // F10: to the menu bar (like desktop apps)
      e.preventDefault();
      document.getElementById('file-menu')?.focus();
      return;
    }
    if (e.defaultPrevented || mod || e.altKey || isTyping(e.target)) return;
    const onButton = (e.target as HTMLElement | null)?.closest('button, a, [role="tab"]');
    if (e.key === ' ' && !onButton) {
      e.preventDefault();
      player.toggle();
    } else if (e.key === 'j' || e.key === 'k') {
      const ids = app.shots.map((s) => s.ref.id);
      const i = app.selectedShot ? ids.indexOf(app.selectedShot) : -1;
      const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'j' ? 1 : -1)))];
      if (next) app.selectShot(next, { scroll: true });
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= TABS.length) {
      app.setTab(TABS[Number(e.key) - 1]!.id as Tab);
    } else if (e.key === '?') {
      ui.shortcutsOpen = true;
    }
  }

  function closeProject() {
    if (app.dirty && !confirm('Close without saving your changes?')) return;
    player.reset();
    app.close();
  }

  const sourceLabel = $derived(
    app.source?.kind === 'server'
      ? app.source.readOnly
        ? 'Local server · read-only'
        : 'Live · sbd serve'
      : app.source?.kind === 'folder'
        ? 'Folder'
        : app.source?.kind === 'zip'
          ? '.sbd file'
          : '',
  );
</script>

<svelte:window onkeydown={onKeydown} />

<a class="skip" href="#main">Skip to content</a>

{#if app.print && app.project}
  <PrintView
    options={app.print}
    chrome={app.printChrome}
    onOptions={() => (ui.pdfOpen = true)}
    onClose={() => app.closePrint()}
  />
{:else}
  <div class="shell">
    <header class="top">
      <div class="brand">
        <!-- the version on hover (also Help → About), to tell which build is running -->
        <span class="logo" id="app-logo" title="Storyboard Viewer {__APP_VERSION__}">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2.5" fill="var(--accent)" />
            <rect x="6" y="8" width="5" height="4" rx="1" fill="var(--surface)" />
            <rect x="13" y="8" width="5" height="4" rx="1" fill="var(--surface)" opacity=".7" />
            <rect x="6" y="13.5" width="12" height="2" rx="1" fill="var(--surface)" opacity=".7" />
          </svg>
        </span>
        {#if app.project}
          <h1 id="project-title" title={app.source?.location}>{app.project.manifest.title}</h1>
          <span class="source" data-tour="source" title={app.source?.location}>{sourceLabel}</span>
          <AppMenuBar onClose={app.source?.kind !== 'server' ? closeProject : undefined} />
        {:else}
          <h1>Storyboard Viewer</h1>
        {/if}
      </div>
      {#if app.project}
        <div class="tabs" role="tablist" aria-label="Views" data-tour="tabs">
          {#each TABS as tab, i (tab.id)}
            <button
              type="button"
              role="tab"
              id="tab-{tab.id}"
              aria-selected={app.tab === tab.id}
              aria-controls="panel"
              aria-keyshortcuts={String(i + 1)}
              tabindex={app.tab === tab.id ? 0 : -1}
              onclick={() => app.setTab(tab.id)}
              onkeydown={(e) => onTabKey(e, i)}>{tab.label}</button
            >
          {/each}
        </div>
        <div class="right">
          <span class="updated" role="status" aria-live="polite">
            {#if updatedNote}<span class="pill">{updatedNote}</span>{/if}
          </span>
          <IssuesButton />
          <SaveControls />
        </div>
      {/if}
    </header>
    <TourOffer />

    <div class="body">
      {#if ui.guideOpen && app.project}
        <FountainGuide />
      {/if}
      <main id="main" tabindex="-1" class:fill={app.tab !== 'story'}>
        {#if app.status === 'loading' && !app.project}
          <p class="loading muted" role="status">Loading…</p>
        {:else if app.project}
          <div id="panel" role="tabpanel" aria-labelledby="tab-{app.tab}" class="panel">
            {#if app.tab === 'story'}
              <StoryView />
            {:else if app.tab === 'canvas'}
              <CanvasView />
            {:else}
              <AssetsView />
            {/if}
          </div>
        {:else}
          <OpenScreen onNew={() => (ui.newOpen = true)} />
        {/if}
      </main>
    </div>

    {#if app.project}
      <!-- with the animatic open, the soundtrack shows under its picture (PlayerBar) -->
      {#if ui.soundtrackOpen && !player.stageOpen}<SoundtrackPanel />{/if}
      <PlayerBar />
    {/if}
  </div>
{/if}

<Toasts />
<Tour />
<ContextMenu />
<HelpDialogs />
<NewStoryboardDialog bind:open={ui.newOpen} />
{#if app.project}
  <SettingsDialog bind:open={ui.settingsOpen} />
  <PdfExportDialog bind:open={ui.pdfOpen} />
  <VideoExportDialog bind:open={ui.videoOpen} />
  {#if ui.picker}
    <AssetPicker
      bind:open={
        () => pickerOpen,
        // closing without a pick (Esc, ×): after onPick had its chance to resolve
        (v) => !v && queueMicrotask(() => ui.picker && ui.resolvePicker(null))
      }
      kinds={ui.picker?.kinds ?? ['image']}
      title={ui.picker?.title}
      onPick={(id) => ui.resolvePicker(id)}
    />
  {/if}
{/if}

<style>
  .skip {
    position: absolute;
    left: -9999px;
    top: 8px;
    z-index: 100;
    background: var(--surface);
    padding: 8px 12px;
    border-radius: var(--radius);
  }
  .skip:focus {
    left: 8px;
  }
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .body > main {
    flex: 1;
    min-width: 0;
  }
  .top {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--space-4);
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    min-height: 52px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .logo {
    display: grid;
    flex: none;
  }
  .brand :global(.menubar) {
    margin-left: var(--space-2);
  }
  h1 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source {
    flex: none;
    font-size: 11px;
    color: var(--fg-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0 6px;
    white-space: nowrap;
  }
  .tabs {
    display: flex;
    gap: var(--space-1);
    align-self: stretch;
  }
  [role='tab'] {
    font: inherit;
    font-weight: 500;
    color: var(--fg-muted);
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 4px 12px 2px;
    cursor: pointer;
  }
  [role='tab']:hover {
    color: var(--fg);
  }
  [role='tab'][aria-selected='true'] {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
  }
  .pill {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-text);
    background: var(--accent-soft);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
  }
  main {
    overflow: auto;
    min-height: 0;
    outline: none;
  }
  main.fill {
    overflow: hidden;
  }
  .panel {
    height: 100%;
  }
  .loading {
    text-align: center;
    margin-top: 20vh;
  }
  @media (max-width: 720px) {
    .top {
      grid-template-columns: 1fr auto;
    }
    .right {
      display: none;
    }
  }
  /* phones: menus on the first row, the view tabs on a full-width second row; the title gives
     way to the menus and the source label is dropped (its location is still on the title) */
  @media (max-width: 600px) {
    .top {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: 'brand right' 'tabs tabs';
      column-gap: var(--space-2);
      row-gap: 0;
      padding: 0 var(--space-3);
      min-height: 0;
    }
    .brand {
      grid-area: brand;
      min-height: 44px;
    }
    .brand :global(.menubar) {
      margin-left: 0;
    }
    .source {
      display: none;
    }
    .tabs {
      grid-area: tabs;
      margin: 0 calc(-1 * var(--space-3));
      padding: 0 var(--space-1);
      border-top: 1px solid var(--border);
    }
    [role='tab'] {
      flex: 1;
      min-height: 40px;
      padding: 4px 6px 2px;
    }
    /* only the live "Updated" note: issues and saving stay in the menus */
    .right {
      display: flex;
      grid-area: right;
    }
    .right > :global(:not(.updated)) {
      display: none;
    }
  }
</style>
