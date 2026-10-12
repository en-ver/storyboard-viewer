<script lang="ts">
  import { aspectValue, stripEmphasis } from '@storyboard-viewer/format';
  import { formatTime, player } from '../lib/player.svelte';
  import { app } from '../lib/state.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';
  import VariantView from './VariantView.svelte';
  import SoundtrackPanel from './SoundtrackPanel.svelte';
  import { tooltip } from '../lib/tooltip';

  const shotEntry = $derived(app.shots.find((s) => s.ref.id === player.shotId));
  const line = $derived(player.lineId ? app.lines.get(player.lineId) : undefined);
  const duration = $derived(player.animatic.duration);
  /** Frame width / height, so the stage fits 42vh tall for any aspect ratio (16:9, 9:16, 2.39:1…). */
  const ratio = $derived(aspectValue(app.project?.manifest.aspect_ratio));
</script>

{#if player.stageOpen}
  <section class="stage" aria-label="Animatic" id="animatic">
    <div class="frame" class:short={ui.soundtrackOpen} style:--ratio={ratio}>
      {#if shotEntry}
        <VariantView
          variant={app.shownVariant(shotEntry.shot)}
          label="Shot {shotEntry.index + 1}"
        />
      {:else}
        <div class="empty-media">Press play</div>
      {/if}
    </div>
    <p class="subtitle" aria-live="polite">
      {#if line?.element?.character}<span class="who">{line.element.character}</span>{/if}
      {line ? stripEmphasis(line.text) : ''}
    </p>
    {#if ui.soundtrackOpen}
      <SoundtrackPanel docked />
    {/if}
  </section>
{/if}

<footer class="bar" aria-label="Playback" data-tour="player">
  <div class="transport">
    <button
      type="button"
      class="btn ghost icon"
      aria-label="Previous shot"
      onclick={() => player.stepShot(-1)}><Icon name="skipBack" /></button
    >
    <button
      type="button"
      id="play-toggle"
      class="btn primary icon play"
      aria-label={player.playing ? 'Pause' : 'Play animatic'}
      aria-keyshortcuts="Space"
      disabled={!duration}
      onclick={() => player.toggle()}><Icon name={player.playing ? 'pause' : 'play'} /></button
    >
    <button
      type="button"
      class="btn ghost icon"
      aria-label="Next shot"
      onclick={() => player.stepShot(1)}><Icon name="skipFwd" /></button
    >
  </div>
  <span class="time mono" aria-hidden="true"
    >{formatTime(player.time)}<span class="dur"> / {formatTime(duration)}</span></span
  >
  <input
    class="scrub"
    type="range"
    min="0"
    max={duration || 1}
    step="0.05"
    value={player.time}
    style:--fill="{duration ? (player.time / duration) * 100 : 0}%"
    aria-label="Playback position"
    aria-valuetext="{formatTime(player.time)} of {formatTime(duration)}"
    oninput={(e) => player.seek(Number((e.target as HTMLInputElement).value))}
  />
  <span class="now" aria-live="off">
    {#if shotEntry}Shot {shotEntry.index + 1}{shotEntry.shot.title
        ? ` · ${shotEntry.shot.title}`
        : ''}{/if}
  </span>
  <button
    type="button"
    class="btn ghost"
    id="soundtrack-toggle"
    data-tour="soundtrack-toggle"
    aria-label="Soundtrack"
    aria-pressed={ui.soundtrackOpen}
    aria-controls="soundtrack"
    {@attach tooltip(
      player.stageOpen
        ? 'Show the tracks under the animatic: cues, playhead, mute, solo, volume'
        : 'Music and sounds under the story, tracks (mute, solo, volume)',
    )}
    onclick={() => (ui.soundtrackOpen = !ui.soundtrackOpen)}
  >
    <Icon name="volume" /><span class="lbl">Soundtrack</span>
  </button>
  <button
    type="button"
    class="btn ghost"
    id="animatic-toggle"
    data-tour="animatic-toggle"
    aria-label="Animatic view"
    aria-pressed={player.stageOpen}
    aria-controls="animatic"
    onclick={() => (player.stageOpen = !player.stageOpen)}
  >
    <Icon name="expand" /><span class="lbl">Animatic</span>
  </button>
</footer>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .transport {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .play {
    border-radius: 50%;
  }
  .time {
    color: var(--fg-muted);
    min-width: 92px;
  }
  .scrub {
    flex: 1;
    min-width: 80px;
    accent-color: var(--accent);
  }
  .now {
    font-size: 12px;
    color: var(--fg-2);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn[aria-pressed='true'] {
    background: var(--surface-2);
  }
  .stage {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--stage);
    border-top: 1px solid var(--border);
  }
  .frame {
    width: min(100%, calc(42vh * var(--ratio, 1.7778)), 900px);
  }
  /* the soundtrack sits under the picture: a smaller picture keeps both in view */
  .frame.short {
    width: min(100%, calc(30vh * var(--ratio, 1.7778)), 720px);
  }
  .subtitle {
    margin: 0;
    min-height: 1.5em;
    max-width: 900px;
    color: var(--overlay-fg);
    font-size: 16px;
    text-align: center;
  }
  .who {
    color: var(--overlay-fg);
    opacity: 0.7;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    margin-right: var(--space-2);
  }
  @media (max-width: 900px) {
    .now {
      display: none;
    }
  }
  /* phones: icon-only toggles and a compact time, so the bar fits 320px */
  @media (max-width: 600px) {
    .bar {
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
    }
    .time {
      flex: none;
      min-width: 0;
      font-size: 11px;
      white-space: nowrap;
    }
    .scrub {
      min-width: 40px;
    }
    .lbl {
      display: none;
    }
    .stage {
      padding: var(--space-3);
    }
    .frame {
      width: min(100%, calc(50vh * var(--ratio, 1.7778)));
    }
  }
  /* the smallest phones: the scrubber shows the length, so the time is just the playhead */
  @media (max-width: 360px) {
    .dur {
      display: none;
    }
  }
</style>
