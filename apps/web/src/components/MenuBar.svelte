<script lang="ts">
  // Application menu bar (WAI-ARIA menubar pattern): one tab stop; ←/→ move between menus (and
  // keep a menu open while moving), ↓/Enter/Space open a menu on its first item, ↑ on its last,
  // Esc closes and returns focus to the menu's title. Hovering another title while a menu is
  // open switches to it.
  import { tick } from 'svelte';
  import type { BarMenu } from '../lib/menu';
  import MenuList from './MenuList.svelte';

  let { menus }: { menus: BarMenu[] } = $props();

  let openId = $state<string | null>(null);
  let focusIndex = $state(0);
  let bar = $state<HTMLDivElement>();
  let list = $state<MenuList>();

  const titleEl = (i: number) =>
    bar?.querySelectorAll<HTMLButtonElement>(':scope > .m > [role="menuitem"]')[i];

  async function open(i: number, focus: 'first' | 'last' | 'none' = 'first') {
    focusIndex = i;
    openId = menus[i]!.id;
    await tick();
    if (focus !== 'none') await list?.focusItem(focus);
    // a menu whose items are all disabled: keep focus on its title (Esc still closes it)
    const listEl = document.getElementById(`${menus[i]!.id}-list`);
    if (focus !== 'none' && !listEl?.contains(document.activeElement)) titleEl(i)?.focus();
  }

  function close(returnFocus: boolean) {
    openId = null;
    if (returnFocus) titleEl(focusIndex)?.focus();
  }

  function move(dir: -1 | 1) {
    const i = (focusIndex + dir + menus.length) % menus.length;
    if (openId) void open(i);
    else {
      focusIndex = i;
      titleEl(i)?.focus();
    }
  }

  function onTitleKey(e: KeyboardEvent, i: number) {
    focusIndex = i;
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') void open(i, 'first');
    else if (e.key === 'ArrowUp') void open(i, 'last');
    else if (e.key === 'Home') {
      focusIndex = 0;
      titleEl(0)?.focus();
    } else if (e.key === 'End') {
      focusIndex = menus.length - 1;
      titleEl(menus.length - 1)?.focus();
    } else if (e.key === 'Escape' && openId) close(true);
    else return;
    e.preventDefault();
  }

  function onWindowPointer(e: PointerEvent) {
    if (openId && !bar?.contains(e.target as Node)) close(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointer} />

<div
  class="menubar"
  role="menubar"
  aria-label="Application menu"
  data-tour="menubar"
  bind:this={bar}
>
  {#each menus as m, i (m.id)}
    <div class="m">
      <button
        type="button"
        role="menuitem"
        id={m.id}
        data-tour={m.id}
        class="title"
        aria-haspopup="menu"
        aria-expanded={openId === m.id}
        aria-controls={openId === m.id ? `${m.id}-list` : undefined}
        tabindex={focusIndex === i ? 0 : -1}
        onclick={() => (openId === m.id ? close(true) : void open(i, 'first'))}
        onpointerenter={() => {
          if (openId && openId !== m.id) void open(i, 'none');
        }}
        onfocus={() => (focusIndex = i)}
        onkeydown={(e) => onTitleKey(e, i)}>{m.label}</button
      >
      {#if openId === m.id}
        <div class="pop">
          <MenuList
            bind:this={list}
            id="{m.id}-list"
            label={m.label}
            items={m.items}
            onclose={close}
            onnavigate={move}
          />
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .menubar {
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .m {
    position: relative;
  }
  .title {
    font: inherit;
    font-size: 13px;
    color: var(--fg-2);
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    padding: 3px 8px;
    cursor: default;
  }
  .title:hover,
  .title[aria-expanded='true'] {
    color: var(--fg);
    background: var(--surface-2);
  }
  .title:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .pop {
    position: absolute;
    left: 0;
    top: calc(100% + 3px);
    z-index: 40;
  }
  /* phones: menus span the screen under the bar instead of running off its right edge */
  @media (max-width: 600px) {
    .pop {
      position: fixed;
      left: 8px;
      right: 8px;
      top: 44px;
    }
    .pop :global(.menu-list) {
      max-height: calc(100dvh - 120px);
    }
    .pop :global([role^='menuitem']) {
      padding: 9px 10px;
    }
  }
</style>
