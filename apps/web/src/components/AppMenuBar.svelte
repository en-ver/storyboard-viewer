<script lang="ts">
  // The app's menus: File, Edit, View, Shot, Help (with keyboard shortcuts shown). Commands come
  // from the app state, the player, the Script view (while shown) and the shared shot actions.
  import { copyText, ui } from '../lib/ui.svelte';
  import { app, TABS } from '../lib/state.svelte';
  import { player } from '../lib/player.svelte';
  import { canPickFolder } from '../lib/sources/local';
  import { shotMenuItems } from '../lib/shot-actions';
  import { THEMES, theme } from '../lib/theme.svelte';
  import { MOD, sep, type BarMenu, type MenuItem } from '../lib/menu';
  import MenuBar from './MenuBar.svelte';
  import WorkspaceSelector from './WorkspaceSelector.svelte';
  import { tour } from '../lib/tour.svelte';
  import { TOURS } from '../lib/tours';

  let { onClose }: { onClose?: () => void } = $props();

  const saveLabel = $derived(
    app.saveMode === 'download'
      ? 'Download .sbd'
      : app.saveMode === 'file' && app.source?.kind === 'zip' && !app.source.inPlace
        ? 'Save .sbd…'
        : 'Save',
  );

  const themeLabel = (id: string) => THEMES.find((t) => t.id === id)?.label ?? id;
  const pairItems = (kind: 'light' | 'dark'): MenuItem[] =>
    THEMES.filter((t) => t.kind === kind).map((t) => ({
      label: t.label,
      swatch: t.id,
      radio: true,
      checked: (kind === 'light' ? theme.light : theme.dark) === t.id,
      onSelect: () => theme.setPair(kind, t.id),
    }));
  const appearance = $derived<MenuItem[]>([
    {
      label: 'System',
      detail: `${themeLabel(theme.light)} / ${themeLabel(theme.dark)}`,
      radio: true,
      checked: theme.choice === 'system',
      onSelect: () => theme.set('system'),
    },
    sep(),
    ...THEMES.map((t) => ({
      label: t.label,
      swatch: t.id,
      radio: true,
      checked: theme.choice === t.id,
      onSelect: () => theme.set(t.id),
    })),
    sep(),
    { label: 'System light theme', detail: themeLabel(theme.light), submenu: pairItems('light') },
    { label: 'System dark theme', detail: themeLabel(theme.dark), submenu: pairItems('dark') },
  ]);

  const file = $derived<MenuItem[]>([
    {
      label: app.workspace ? 'New in Projects…' : 'New storyboard…',
      icon: 'plus',
      onSelect: () => (ui.newOpen = true),
    },
    ...(app.workspace
      ? [
          {
            label: 'Open workspace storyboard…',
            icon: 'folder' as const,
            command: 'open-other',
            onSelect: () => (app.workspaceOpen = true),
          },
          { label: 'Recent workspace storyboards…', onSelect: () => (app.workspaceOpen = true) },
          {
            label: 'Open browser-local file…',
            onSelect: async () => {
              if (await app.finishBeforeSwitch())
                location.assign(`${location.pathname}?source=local`);
            },
          },
        ]
      : []),
    ...(app.saveMode !== 'none'
      ? [
          {
            label: saveLabel,
            icon: 'save' as const,
            shortcut: `${MOD}S`,
            command: 'save',
            onSelect: () => void app.save(),
          },
        ]
      : []),
    ...(app.canAutosave
      ? [
          {
            label: 'Save automatically',
            checked: app.autosave,
            onSelect: () => app.setAutosave(!app.autosave),
          },
        ]
      : []),
    sep(),
    { label: 'Export PDF…', icon: 'file', onSelect: () => (ui.pdfOpen = true) },
    { label: 'Export animatic video…', icon: 'film', onSelect: () => (ui.videoOpen = true) },
    {
      label: 'Export script (Fountain)',
      icon: 'download',
      onSelect: () => app.exportFountainFile(),
    },
    { label: 'Export .sbd file', icon: 'download', onSelect: () => void app.exportPacked() },
    ...(canPickFolder
      ? [
          {
            label: 'Export as folder…',
            icon: 'folder' as const,
            onSelect: () => void app.exportFolder(),
          },
        ]
      : []),
    sep(),
    {
      label: 'Project settings…',
      icon: 'settings',
      disabled: !app.canEdit,
      onSelect: () => (ui.settingsOpen = true),
    },
    ...(onClose ? [{ label: 'Close storyboard', icon: 'close' as const, onSelect: onClose }] : []),
    ...(app.source?.kind === 'server' && !app.workspace
      ? [
          {
            label: 'Open another storyboard…',
            icon: 'folder' as const,
            command: 'open-other',
            // the start screen (recent storyboards, files, folders) without leaving this server
            onSelect: async () => {
              if (await app.finishBeforeSwitch())
                location.assign(`${location.pathname}?source=local`);
            },
          },
        ]
      : []),
  ]);

  const edit = $derived<MenuItem[]>([
    {
      label: app.undoLabel ? `Undo ${app.undoLabel}` : 'Undo',
      icon: 'undo',
      shortcut: `${MOD}Z`,
      disabled: !app.undoLabel,
      command: 'undo',
      onSelect: () => app.undo(),
    },
    {
      label: app.redoLabel ? `Redo ${app.redoLabel}` : 'Redo',
      icon: 'redo',
      shortcut: `⇧${MOD}Z`,
      disabled: !app.redoLabel,
      command: 'redo',
      onSelect: () => app.redo(),
    },
    sep(),
    {
      label: 'Copy shot ID',
      icon: 'copy',
      disabled: !app.selectedShot,
      onSelect: async () => {
        const id = app.selectedShot;
        if (id && (await copyText(id))) app.toast(`Copied shot ID ${id}`, { kind: 'info' });
      },
    },
    {
      label: 'Copy line ID',
      icon: 'copy',
      disabled: !app.selectedLine,
      onSelect: async () => {
        const id = app.selectedLine;
        if (id && (await copyText(id))) app.toast(`Copied line ID ${id}`, { kind: 'info' });
      },
    },
    sep(),
    {
      label: 'Clear tag filter',
      icon: 'filter',
      disabled: !app.tagFilter.length,
      onSelect: () => app.setTagFilter([]),
    },
  ]);

  const view = $derived<MenuItem[]>([
    ...TABS.map((t, i) => ({
      label: t.label,
      radio: true,
      checked: app.tab === t.id,
      shortcut: String(i + 1),
      command: `tab-${t.id}`,
      onSelect: () => app.setTab(t.id),
    })),
    sep(),
    { label: 'Story layout', heading: true },
    {
      label: 'Script',
      radio: true,
      checked: app.storyView === 'script',
      command: 'view-script',
      onSelect: () => {
        app.setStoryView('script');
        app.setTab('story');
      },
    },
    {
      label: 'Board',
      radio: true,
      checked: app.storyView === 'board',
      command: 'view-board',
      onSelect: () => {
        app.setStoryView('board');
        app.setTab('story');
      },
    },
    sep(),
    {
      label: 'Soundtrack',
      checked: ui.soundtrackOpen,
      command: 'toggle-soundtrack',
      onSelect: () => (ui.soundtrackOpen = !ui.soundtrackOpen),
    },
    {
      label: 'Animatic',
      checked: player.stageOpen,
      command: 'toggle-animatic',
      onSelect: () => (player.stageOpen = !player.stageOpen),
    },
    sep(),
    {
      label: 'Appearance',
      icon: 'palette',
      detail: theme.choice === 'system' ? 'System' : themeLabel(theme.choice),
      submenu: appearance,
    },
  ]);

  const shot = $derived.by<MenuItem[]>(() => {
    const scriptShown = app.tab === 'story' && app.storyView === 'script' && !!ui.scriptCommands;
    const items: MenuItem[] = [];
    if (app.canEdit)
      items.push(
        {
          label: 'Make shot from selection',
          icon: 'shot',
          shortcut: `${MOD}↵`,
          command: 'make-shot',
          disabled: !scriptShown,
          onSelect: () => ui.scriptCommands?.makeShot(),
        },
        {
          label: 'Extend shot to selection',
          icon: 'mark',
          command: 'extend-shot',
          disabled: !scriptShown,
          onSelect: () => ui.scriptCommands?.extendShot(),
        },
        {
          label: 'Shot without script text',
          icon: 'plus',
          shortcut: `⇧${MOD}↵`,
          command: 'lineless-shot',
          disabled: !scriptShown,
          onSelect: () => ui.scriptCommands?.addLineless(),
        },
        sep(),
      );
    const sel = app.selectedShot;
    const entry = app.shots.find((s) => s.ref.id === sel);
    if (entry) {
      items.push({
        label: `Shot ${entry.index + 1}${entry.shot.title ? `: ${entry.shot.title}` : ''}`,
        heading: true,
      });
      items.push(...shotMenuItems(entry.ref.id));
    } else items.push({ label: 'No shot selected', heading: true });
    items.push(
      sep(),
      {
        label: player.playing ? 'Pause' : 'Play animatic',
        icon: player.playing ? 'pause' : 'play',
        shortcut: 'Space',
        onSelect: () => player.toggle(),
      },
      {
        label: 'Previous shot',
        icon: 'prev',
        shortcut: 'K',
        onSelect: () => step(-1),
      },
      { label: 'Next shot', icon: 'next', shortcut: 'J', onSelect: () => step(1) },
    );
    return items;
  });

  function step(d: number) {
    const ids = app.shots.map((s) => s.ref.id);
    const i = app.selectedShot ? ids.indexOf(app.selectedShot) : -1;
    const next = ids[Math.max(0, Math.min(ids.length - 1, i + d))];
    if (next) app.selectShot(next, { scroll: true });
  }

  const help = $derived<MenuItem[]>([
    {
      label: 'Guided tours',
      icon: 'compass',
      command: 'tours',
      submenu: TOURS.map((t) => ({
        label: t.title,
        command: `tour-${t.id}`,
        onSelect: () => void tour.start(t.id),
      })),
    },
    {
      label: 'Keyboard shortcuts',
      icon: 'search',
      shortcut: '?',
      command: 'shortcuts',
      onSelect: () => (ui.shortcutsOpen = true),
    },
    {
      label: 'Fountain syntax guide',
      icon: 'script',
      checked: ui.guideOpen,
      command: 'toggle-guide',
      onSelect: () => ui.setGuide(!ui.guideOpen),
    },
    sep(),
    { label: 'About Storyboard Viewer', onSelect: () => (ui.aboutOpen = true) },
  ]);

  const menus = $derived<BarMenu[]>([
    { id: 'file-menu', label: 'File', items: file },
    { id: 'edit-menu', label: 'Edit', items: edit },
    { id: 'view-menu', label: 'View', items: view },
    { id: 'shot-menu', label: 'Shot', items: shot },
    { id: 'help-menu', label: 'Help', items: help },
  ]);
</script>

<MenuBar {menus} />
{#if app.workspace}<WorkspaceSelector />{/if}
