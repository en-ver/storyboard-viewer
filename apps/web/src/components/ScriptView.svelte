<script lang="ts">
  // Script view of the Story tab: one continuous Fountain editor (CodeMirror 6) — the hero — with
  // shots marked calmly on the exact words they cover, and the shots' cards beside the script
  // (Genius-style). A shot can be any span of text: part of a line, several shots in one line,
  // or several lines.
  //
  // Typing: edits are buffered in CodeMirror and committed to the project ~300 ms after the last
  // keystroke (and before any other edit, undo, save or merge) as one `replaceScriptRange` with
  // the exact changes, so line IDs of untouched lines never change and shot spans move with
  // their words. Consecutive commits coalesce into one undo step. Changes that arrive from
  // outside (agent edits, undo) are applied to the editor as minimal line-level changes so the
  // cursor stays where it is.
  import { tooltip } from '../lib/tooltip';
  import { defaultKeymap } from '@codemirror/commands';
  import { Annotation, Compartment, EditorState, type ChangeSet } from '@codemirror/state';
  import {
    EditorView,
    keymap,
    placeholder,
    drawSelection,
    type ViewUpdate,
  } from '@codemirror/view';
  import {
    carveShots,
    diffLines,
    moveShotWithLines,
    normalizeSpans,
    pointAt,
    replaceScriptRange,
    scriptDocument,
    setScript,
    setShotSpan,
    shotBounds,
    splitShot,
    textLookup,
    type PosChange,
    type SbdProject,
    type ScriptPoint,
    type SpanPoint,
  } from '@storyboard-viewer/format';
  import { onMount, untrack } from 'svelte';
  import { audio } from '../lib/audio-editor.svelte';
  import { MOD, sep, type MenuItem } from '../lib/menu';
  import {
    addLinelessShot,
    extendShotTo,
    makeShot,
    makeShotFromSpan,
    spanFromRange,
  } from '../lib/script-editor/actions';
  import {
    setAnnotationUi,
    setAnnotations,
    shotAnnotations,
    type AnnotationUi,
  } from '../lib/script-editor/annotations';
  import { fountainHighlight } from '../lib/script-editor/fountain-highlight';
  import {
    computeAnnotations,
    linesInRange,
    nudgeBoundary,
    shotsAt,
    type Annotations,
  } from '../lib/script-editor/geometry';
  import { screenplayKeys } from '../lib/script-editor/screenplay-keys';
  import { player } from '../lib/player.svelte';
  import { shotMenuItems } from '../lib/shot-actions';
  import { app } from '../lib/state.svelte';
  import { copyText, ui } from '../lib/ui.svelte';
  import AnnotationCard from './AnnotationCard.svelte';
  import Icon from './Icon.svelte';

  const COMMIT_DELAY = 300;
  const remote = Annotation.define<boolean>();
  const editable = new Compartment();

  let host = $state<HTMLDivElement>();
  let page = $state<HTMLDivElement>();
  let rail = $state<HTMLElement>();
  let view: EditorView | null = null;
  /** Script text the project had when the editor last agreed with it. */
  let committed = '';
  let pending: ChangeSet | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hover = $state<string | null>(null);
  let layoutTick = $state(0);
  /** Asks for a card layout pass (safe to call from inside effects). */
  const bump = () => untrack(() => layoutTick++);
  let heights = $state<Record<string, number>>({});
  /** Where the floating "Make shot" button sits (next to a selection), or null. */
  let selButton = $state<{ x: number; y: number } | null>(null);
  let announcement = $state('');
  let drag = $state<{ id: string; y: number; index: number } | null>(null);

  const mod = MOD;

  const ann = shotAnnotations(
    {
      onSelect: (id) => selectShot(id, true),
      onHandle: (id, edge, e) => startBoundaryDrag(id, edge, e),
      onHandleKey: (id, edge, e) => handleKey(id, edge, e),
      onShotMenu: (id, e) => {
        selectShot(id);
        ui.openContextMenu(
          e,
          shotMenuItems(id, { onMoved: (m) => (announcement = m) }),
          shotName(id),
        );
      },
    },
    () => app.canEdit,
  );
  const screenplay = screenplayKeys(() => app.canEdit);

  // ---------------------------------------------------------------- committing typed text

  function flush() {
    clearTimeout(timer);
    if (!pending || !view) {
      app.buffered = false;
      return;
    }
    const changes = pending;
    pending = null;
    let from = Infinity;
    let toA = -Infinity;
    const list: PosChange[] = [];
    changes.iterChanges((fA, tA, fB, tB, inserted) => {
      from = Math.min(from, fA);
      toA = Math.max(toA, tA);
      list.push({ from: fA, to: tA, length: tB - fB, text: inserted.toString() });
    });
    const text = view.state.doc.toString();
    const insert = text.slice(from, toA + (changes.newLength - changes.length));
    const base = app.project?.script ?? '';
    const ok = app.edit(
      'Edit script',
      (p) =>
        base === committed
          ? replaceScriptRange(p, from, toA, insert, { changes: list })
          : setScript(p, text), // the project changed underneath: re-anchor the whole script
      { coalesce: 'script-typing' },
    );
    committed = ok ? text : committed;
    app.buffered = false;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, COMMIT_DELAY);
  }

  /** Applies a script that changed outside the editor as minimal line-level changes. */
  function applyExternal(next: string) {
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === next) return;
    const a = cur.split('\n');
    const b = next.split('\n');
    const offA = [0];
    for (const l of a) offA.push(offA.at(-1)! + l.length + 1);
    const offB = [0];
    for (const l of b) offB.push(offB.at(-1)! + l.length + 1);
    const pairs = [...diffLines(a, b), [a.length, b.length] as [number, number]];
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    let i = 0;
    let j = 0;
    for (const [pi, pj] of pairs) {
      if (pi > i || pj > j) {
        let from = offA[i]!;
        let to = Math.min(offA[pi]!, cur.length);
        let bFrom = offB[j]!;
        const bTo = Math.min(offB[pj]!, next.length);
        if ((pi === a.length || pj === b.length) && i > 0 && j > 0) {
          from -= 1; // include the newline before the region when it reaches the end
          bFrom -= 1;
        }
        to = Math.max(from, to);
        changes.push({ from, to, insert: next.slice(bFrom, Math.max(bFrom, bTo)) });
      }
      i = pi + 1;
      j = pj + 1;
    }
    view.dispatch({ changes, annotations: remote.of(true) });
    if (view.state.doc.toString() !== next)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        annotations: remote.of(true),
      });
  }

  // ---------------------------------------------------------------- annotations

  function pushAnnotations() {
    if (!view || !app.project) return;
    const current: Annotations = computeAnnotations(app.project, (id) => {
      const s = app.project!.shots[id];
      return !s || app.matchesFilter(s);
    });
    view.dispatch({ effects: setAnnotations.of(current) });
    bump();
  }

  /** Shot whose text contains `pos` (mapped data). */
  function shotAt(pos: number): string | null {
    if (!view) return null;
    return shotsAt(ann.data(view), pos)[0] ?? null;
  }

  function lineIdAt(pos: number): string | null {
    if (!view) return null;
    const from = view.state.doc.lineAt(pos).from;
    return ann.data(view).lines.find((l) => l.pos === from)?.id ?? null;
  }

  function selectShot(id: string | null, fromClick = false) {
    if (app.selectedShot !== id) app.selectShot(id);
    if (fromClick && id) announcement = `Shot ${app.shots.findIndex((s) => s.ref.id === id) + 1}`;
  }

  // ---------------------------------------------------------------- commands

  function selectedLineIds(): string[] {
    if (!view) return [];
    flush();
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc;
    const a = doc.lineAt(from).from;
    let zLine = doc.lineAt(to);
    if (to > from && to === zLine.from && zLine.number > 1) zLine = doc.line(zLine.number - 1);
    return linesInRange(ann.data(view), a, zLine.from);
  }

  /** The selected text (without space at its ends) as span points; null for no selection. */
  function selectionSpan(): { start: SpanPoint; end: SpanPoint } | null {
    if (!view || !app.project) return null;
    flush();
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    const doc = view.state.doc;
    let a = from;
    let z = to;
    while (a < z && /\s/.test(doc.sliceString(a, a + 1))) a++;
    while (z > a && /\s/.test(doc.sliceString(z - 1, z))) z--;
    if (z <= a) return null;
    return spanFromRange(app.project, a, z);
  }

  function makeShotFromSelection(): boolean {
    if (!app.canEdit) return false;
    const span = selectionSpan();
    let id = '';
    if (span) {
      if (
        app.edit('Make shot', (p) => {
          const r = makeShotFromSpan(p, span.start, span.end);
          id = r.id;
          return r;
        })
      ) {
        app.selectShot(id);
        announcement = `Shot ${app.shots.findIndex((s) => s.ref.id === id) + 1} created from the selection`;
      }
      return true;
    }
    const ids = menuLineIds();
    if (!ids.length) {
      app.toast('Select some script text first (or put the cursor on a line).', { kind: 'info' });
      return true;
    }
    if (
      app.edit('Make shot', (p) => {
        const r = makeShot(p, ids);
        id = r.id;
        return r;
      })
    ) {
      app.selectShot(id);
      const n = app.shots.findIndex((s) => s.ref.id === id) + 1;
      announcement = `Shot ${n} created from ${ids.length} line${ids.length > 1 ? 's' : ''}`;
    }
    return true;
  }

  function addLineless(): boolean {
    if (!app.canEdit) return false;
    flush();
    let ordinal: number | null = null;
    if (view) {
      const head = view.state.selection.main.head;
      const doc = view.state.doc;
      // the last anchored line at or before the cursor
      const lines = ann.data(view).lines.filter((l) => l.pos <= doc.lineAt(head).from);
      const lid = lines.at(-1)?.id;
      ordinal = lid ? (app.project!.ids.lines.find((l) => l.id === lid)?.ordinal ?? null) : null;
    }
    let id = '';
    if (
      app.edit('Add shot without lines', (p) => {
        const r = addLinelessShot(p, ordinal);
        id = r.id;
        return r;
      })
    ) {
      app.selectShot(id);
      announcement = 'Shot without script text added';
    }
    return true;
  }

  // ---------------------------------------------------------------- context menu (script text)

  const shotName = (id: string) => {
    const e = app.shots.find((s) => s.ref.id === id);
    return e ? `Shot ${e.index + 1}${e.shot.title ? `: ${e.shot.title}` : ''}` : id;
  };

  /** Lines the menu acts on: the selection, or the line at the cursor (a cue → its dialogue). */
  function menuLineIds(): string[] {
    const ids = selectedLineIds();
    if (ids.length || !view) return ids;
    const doc = view.state.doc;
    const n = doc.lineAt(view.state.selection.main.head).number;
    for (let k = n + 1; k <= Math.min(doc.lines, n + 2); k++) {
      const hit = linesInRange(ann.data(view), doc.line(k).from, doc.line(k).from);
      if (hit.length) return hit;
    }
    return [];
  }

  /** What the menu acts on, as script points: the selected text, else the menu's lines. */
  function targetRange(p: SbdProject): { start: ScriptPoint; end: ScriptPoint } | null {
    const ord = new Map(p.ids.lines.map((l) => [l.id, l.ordinal]));
    const span = selectionSpan();
    if (span)
      return {
        start: { ordinal: ord.get(span.start.line)!, offset: span.start.offset },
        end: { ordinal: ord.get(span.end.line)!, offset: span.end.offset },
      };
    const ids = menuLineIds();
    if (!ids.length) return null;
    const os = ids.map((l) => ord.get(l)!).filter((o) => o !== undefined);
    const last = p.ids.lines.find((l) => l.ordinal === Math.max(...os));
    return {
      start: { ordinal: Math.min(...os), offset: 0 },
      end: { ordinal: Math.max(...os), offset: last?.text.length ?? 0 },
    };
  }

  const cmp = (a: ScriptPoint, b: ScriptPoint) => a.ordinal - b.ordinal || a.offset - b.offset;

  /** Nearest shot ending before (dir -1) or starting after (+1) the range. */
  function neighbourShot(r: { start: ScriptPoint; end: ScriptPoint }, dir: -1 | 1): string | null {
    const p = app.project!;
    const ord = new Map(p.ids.lines.map((l) => [l.id, l.ordinal]));
    const textOf = textLookup(p.ids.lines);
    let best: { id: string; at: ScriptPoint } | null = null;
    for (const s of p.ids.shots) {
      const b = shotBounds(s, (id) => ord.get(id), textOf);
      if (!b) continue;
      if (dir < 0 && cmp(b.end, r.start) <= 0 && (!best || cmp(b.end, best.at) > 0))
        best = { id: s.id, at: b.end };
      if (dir > 0 && cmp(b.start, r.end) >= 0 && (!best || cmp(b.start, best.at) < 0))
        best = { id: s.id, at: b.start };
    }
    return best?.id ?? null;
  }

  /** The shot the range overlaps (first in story order). */
  function overlappingShot(r: { start: ScriptPoint; end: ScriptPoint }): string | null {
    const p = app.project!;
    const ord = new Map(p.ids.lines.map((l) => [l.id, l.ordinal]));
    const textOf = textLookup(p.ids.lines);
    for (const s of p.ids.shots) {
      const b = shotBounds(s, (id) => ord.get(id), textOf);
      if (b && cmp(b.start, r.end) < 0 && cmp(b.end, r.start) > 0) return s.id;
    }
    return null;
  }

  const toSpan = (p: SbdProject, pt: ScriptPoint): SpanPoint => ({
    line: p.ids.lines.find((l) => l.ordinal === pt.ordinal)!.id,
    offset: pt.offset,
  });

  function extendTo(shot: string, r: { start: ScriptPoint; end: ScriptPoint }) {
    if (
      app.edit('Extend shot', (p) => extendShotTo(p, shot, toSpan(p, r.start), toSpan(p, r.end)))
    ) {
      app.selectShot(shot);
      announcement = `${shotName(shot)} now covers the selection`;
    }
  }

  function removeFromShots(r: { start: ScriptPoint; end: ScriptPoint }) {
    app.edit('Remove from shot', (p) =>
      normalizeSpans({
        ...p,
        ids: { ...p.ids, shots: carveShots(p.ids.shots, '', r.start, r.end, p.ids.lines) },
      }),
    );
  }

  async function attachAudio(line: string) {
    const asset = await ui.pickAsset(['audio', 'video'], 'Attach audio to this line');
    if (!asset) return;
    const inShot = app.project?.ids.shots.some((s) => s.lines.includes(line));
    app.selectLine(line, { withShot: true });
    if (inShot) audio.sectionOpen = true;
    else ui.soundtrackOpen = true;
    audio.addCueFrom(asset, { line }, inShot ? 'shot' : 'story');
  }

  function playFrom(line: string) {
    const t = player.animatic.shots.flatMap((s) => s.lines).find((l) => l.id === line);
    if (!t) return;
    player.seek(t.start);
    if (!player.playing) player.play();
  }

  /** Split the shot under the cursor at the cursor (inside a line, or before a line). */
  function splitHere(): { shot: string; line: string; offset: number } | null {
    if (!view || !app.project) return null;
    const head = view.state.selection.main.head;
    const doc = scriptDocument(app.project);
    const pt = doc ? pointAt(doc, head, 'start') : null;
    if (!pt) return null;
    const line = app.project.ids.lines.find((l) => l.ordinal === pt.ordinal);
    const shot =
      shotAt(head) ??
      (line ? overlappingShot({ start: pt, end: { ...pt, offset: pt.offset + 1 } }) : null);
    if (!line || !shot) return null;
    const ref = app.project.ids.shots.find((s) => s.id === shot)!;
    const ord = new Map(app.project.ids.lines.map((l) => [l.id, l.ordinal]));
    const b = shotBounds(ref, (id) => ord.get(id), textLookup(app.project.ids.lines));
    if (!b || cmp(pt, b.start) <= 0 || cmp(pt, b.end) >= 0) return null;
    return { shot, line: line.id, offset: pt.offset };
  }

  function lineMenuItems(): MenuItem[] {
    flush();
    const p = app.project!;
    const ids = menuLineIds();
    const first = ids[0];
    const hasSelection = !!view && !view.state.selection.main.empty;
    const range = targetRange(p);
    const owner = range ? overlappingShot(range) : null;
    const prev = range ? neighbourShot(range, -1) : null;
    const next = range ? neighbourShot(range, 1) : null;
    const extendTarget = hasSelection ? (owner ?? prev) : null;
    const split = splitHere();
    const edit = app.canEdit;
    const items: MenuItem[] = [];
    if (edit)
      items.push(
        {
          label: hasSelection ? 'Make shot from selection' : 'Make shot from line',
          icon: 'shot',
          shortcut: `${mod}↵`,
          command: 'make-shot',
          disabled: !range,
          onSelect: () => void makeShotFromSelection(),
        },
        ...(hasSelection
          ? [
              {
                label: extendTarget
                  ? `Extend ${shotName(extendTarget)} to selection`
                  : 'Extend shot to selection',
                icon: 'mark' as const,
                command: 'extend-shot',
                disabled: !extendTarget,
                onSelect: () => extendTo(extendTarget!, range!),
              },
            ]
          : []),
        {
          label: prev ? `Add to previous shot (${shotName(prev)})` : 'Add to previous shot',
          icon: 'up',
          command: 'add-to-previous-shot',
          disabled: !prev,
          onSelect: () => extendTo(prev!, range!),
        },
        {
          label: next ? `Add to next shot (${shotName(next)})` : 'Add to next shot',
          icon: 'down',
          command: 'add-to-next-shot',
          disabled: !next,
          onSelect: () => extendTo(next!, range!),
        },
        {
          label: 'Remove from shot',
          icon: 'close',
          command: 'remove-from-shot',
          disabled: !owner,
          onSelect: () => removeFromShots(range!),
        },
        {
          label: 'Split shot here',
          icon: 'scissors',
          command: 'split-shot-here',
          disabled: !split,
          onSelect: () => {
            let nid = '';
            if (
              app.edit('Split shot', (q) => {
                const r = splitShot(q, split!.shot, split!.line, { offset: split!.offset });
                nid = r.id;
                return r;
              })
            )
              app.selectShot(nid);
          },
        },
        {
          label: 'Insert shot without script text here',
          icon: 'plus',
          shortcut: `⇧${mod}↵`,
          command: 'insert-lineless-shot',
          onSelect: () => void addLineless(),
        },
        sep(),
        {
          label: 'Attach audio to line…',
          icon: 'volume',
          command: 'attach-audio',
          disabled: !first,
          onSelect: () => void attachAudio(first!),
        },
      );
    else if (ids.length) items.push(sep());
    items.push(
      {
        label: 'Play from here',
        icon: 'play',
        command: 'play-from-line',
        disabled: !first,
        onSelect: () => playFrom(first!),
      },
      sep(),
      {
        label: 'Copy line ID',
        icon: 'copy',
        command: 'copy-line-id',
        disabled: !first,
        onSelect: async () => {
          if (first && (await copyText(first)))
            app.toast(`Copied line ID ${first}`, { kind: 'info' });
        },
      },
    );
    if (owner)
      items.push(sep(), {
        label: shotName(owner),
        icon: 'shot',
        submenu: shotMenuItems(owner, { onMoved: (m) => (announcement = m) }),
      });
    return items;
  }

  /** Right click in the script: keep a selection that contains the click, else move the cursor. */
  function openLineMenu(e: MouseEvent | null) {
    if (!view || !app.project) return;
    const v = view;
    if (e) {
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      const sel = v.state.selection.main;
      if (pos !== null && (sel.empty || pos < sel.from || pos > sel.to))
        v.dispatch({ selection: { anchor: pos } });
      ui.openContextMenu(e, lineMenuItems(), 'Script', v.contentDOM);
    } else {
      const c = v.coordsAtPos(v.state.selection.main.head);
      ui.openContextMenu(
        { x: c?.left ?? 0, y: (c?.bottom ?? 0) + 2 },
        lineMenuItems(),
        'Script',
        v.contentDOM,
      );
    }
  }

  // ---------------------------------------------------------------- boundary handles

  /**
   * Drags one end of a shot's text. The end snaps to whole words (hold Alt for single
   * characters) and may cross lines; releasing sets the shot to the new span.
   */
  function startBoundaryDrag(id: string, edge: 'start' | 'end', e: MouseEvent) {
    if (!view || !app.canEdit) return;
    flush();
    const v = view;
    const geom = ann.data(v).shots.find((s) => s.id === id);
    if (!geom?.pieces.length) return;
    const from0 = geom.pieces[0]!.from;
    const to0 = geom.pieces.at(-1)!.to;
    let from = from0;
    let to = to0;
    const snap = (pos: number, exact: boolean) => {
      if (exact) return pos;
      const w = v.state.wordAt(pos);
      if (!w) return pos;
      return edge === 'start' ? w.from : w.to;
    };
    const move = (ev: PointerEvent) => {
      const raw = v.posAtCoords({ x: ev.clientX, y: ev.clientY }, false);
      const pos = snap(raw, ev.altKey);
      if (edge === 'start') from = Math.min(pos, to - 1);
      else to = Math.max(pos, from + 1);
      v.dispatch({ effects: setAnnotationUi.of({ preview: { shot: id, from, to } }) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.documentElement.classList.remove('sb-resizing');
      v.dispatch({ effects: setAnnotationUi.of({ preview: null }) });
      if (from === from0 && to === to0) return;
      const span = app.project ? spanFromRange(app.project, from, to) : null;
      if (!span) return;
      if (app.edit('Change shot text', (p) => setShotSpan(p, id, span.start, span.end)))
        announcement = `${shotName(id)} changed`;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // the resize cursor stays while dragging, wherever the pointer goes
    document.documentElement.classList.add('sb-resizing');
    e.preventDefault();
  }

  /** Keys on a focused handle: ←/→ move the boundary by a word (Alt: a character). */
  function handleKey(id: string, edge: 'start' | 'end', e: KeyboardEvent): boolean {
    const v = view;
    if (!v) return false;
    if (e.key === 'Escape' || e.key === 'Enter') {
      v.focus();
      return true;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
    if (!app.canEdit) return true;
    flush();
    const geom = ann.data(v).shots.find((s) => s.id === id);
    if (!geom?.pieces.length) return true;
    let from = geom.pieces[0]!.from;
    let to = geom.pieces.at(-1)!.to;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    const text = v.state.doc.toString();
    if (edge === 'start')
      from = Math.min(nudgeBoundary(text, from, 'start', dir, e.altKey), to - 1);
    else to = Math.max(nudgeBoundary(text, to, 'end', dir, e.altKey), from + 1);
    const span = app.project ? spanFromRange(app.project, from, to) : null;
    if (!span) return true;
    if (app.edit('Change shot text', (p) => setShotSpan(p, id, span.start, span.end))) {
      announcement = `${shotName(id)}: ${v.state.sliceDoc(from, to).slice(0, 80)}`;
      // the handle is drawn again at its new place: keep the keyboard on it
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          v.dom
            .querySelector<HTMLElement>(`.sb-handle.${edge}[data-handle-shot="${CSS.escape(id)}"]`)
            ?.focus(),
        ),
      );
    }
    return true;
  }

  // ---------------------------------------------------------------- shot reorder (cards)

  function moveShotTo(id: string, index: number) {
    const from = app.shots.findIndex((s) => s.ref.id === id);
    if (from < 0 || index === from) return;
    if (app.edit('Move shot', (p) => moveShotWithLines(p, id, { index })))
      announcement = `Moved shot to position ${index + 1} of ${app.shots.length}`;
  }

  function startCardDrag(id: string, e: PointerEvent) {
    if (!rail) return;
    e.preventDefault();
    const railTop = () => rail!.getBoundingClientRect().top;
    const indexAt = (y: number) => {
      // shots (in order) whose card centre is above the pointer, not counting the dragged one
      let index = 0;
      for (const c of placed) {
        if (c.id === id) continue;
        if (c.top + (heights[c.id] ?? 60) / 2 < y) index++;
      }
      return index;
    };
    drag = { id, y: e.clientY - railTop(), index: app.shots.findIndex((s) => s.ref.id === id) };
    const move = (ev: PointerEvent) => {
      const y = ev.clientY - railTop();
      drag = { id, y, index: indexAt(y) };
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = drag;
      drag = null;
      if (d) moveShotTo(id, d.index);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------- card layout

  interface Placed {
    id: string;
    top: number;
    /** Where the shot's text starts (rail coordinates): the card's leader points there. */
    anchor: number;
  }
  let placed = $state<Placed[]>([]);
  const placedTop = $derived(new Map(placed.map((c) => [c.id, c.top])));
  let railHeight = $state(0);
  const LINE = 22;

  function layout() {
    if (!view || !rail) return;
    const v = view;
    const offset = v.documentTop - rail.getBoundingClientRect().top;
    const data = ann.data(v);
    const anchors: Placed[] = [];
    for (const s of data.shots) {
      if (s.dim) continue;
      let top: number;
      if (s.pieces.length) {
        const c = v.coordsAtPos(Math.min(s.pieces[0]!.from, v.state.doc.length), 1);
        top = c ? c.top - v.documentTop : v.lineBlockAt(s.pieces[0]!.from).top;
      } else {
        const b = v.lineBlockAt(Math.min(s.marker!.pos, v.state.doc.length));
        top = s.marker!.side < 0 ? b.top : b.bottom - 28;
        if (Array.isArray(b.type)) {
          const w = b.type.find(
            (x) => x.widget && (x.widget as unknown as { shot?: { id: string } }).shot?.id === s.id,
          );
          if (w) top = w.top;
        }
      }
      const at = Math.max(0, top + offset);
      anchors.push({ id: s.id, top: at, anchor: at });
    }
    anchors.sort((a, b) => a.top - b.top);
    const gap = 6;
    const h = (id: string) => heights[id] ?? 40;
    const act = anchors.findIndex((a) => a.id === app.selectedShot);
    const out = anchors.map((a) => ({ ...a }));
    if (act >= 0) {
      for (let i = act - 1; i >= 0; i--)
        out[i]!.top = Math.min(out[i]!.top, out[i + 1]!.top - h(out[i]!.id) - gap);
      // nothing above the top: push everything down again from the first card
      if (out[0] && out[0].top < 0) out[0].top = 0;
    }
    for (let i = 1; i < out.length; i++)
      out[i]!.top = Math.max(out[i]!.top, out[i - 1]!.top + h(out[i - 1]!.id) + gap);
    placed = out;
    const last = out.at(-1);
    railHeight = Math.max(v.contentHeight, last ? last.top + h(last.id) + 24 : 0);
  }

  $effect(() => {
    void layoutTick;
    void heights;
    void app.selectedShot;
    void app.tagFilter;
    requestAnimationFrame(layout);
  });

  /** The open (or hovered) card's leader: from the script's edge at its text to the card. */
  const leader = $derived.by(() => {
    const id = app.selectedShot ?? hover;
    const c = placed.find((x) => x.id === id);
    if (!c) return null;
    const color = (app.shots.findIndex((s) => s.ref.id === id) % 6) + 1;
    return { y1: c.anchor + LINE / 2, y2: c.top + 12, color };
  });

  // ---------------------------------------------------------------- floating "Make shot"

  function placeSelButton() {
    if (!view || !page || !app.canEdit) return (selButton = null);
    const sel = view.state.selection.main;
    if (sel.empty || !view.hasFocus) return (selButton = null);
    const c = view.coordsAtPos(sel.to, -1);
    if (!c) return (selButton = null);
    const r = page.getBoundingClientRect();
    selButton = { x: Math.min(c.right - r.left + 6, r.width - 150), y: c.bottom - r.top + 4 };
  }

  // ---------------------------------------------------------------- lifecycle and syncing

  function onUpdate(u: ViewUpdate) {
    const isRemote = u.transactions.some((t) => t.annotation(remote));
    if (u.docChanged && !isRemote) {
      pending = pending ? pending.compose(u.changes) : u.changes;
      app.buffered = true;
      schedule();
    }
    if (u.selectionSet || u.docChanged || u.focusChanged) {
      untrack(placeSelButton);
      if (u.selectionSet && !isRemote && u.view.hasFocus) {
        const head = u.state.selection.main.head;
        untrack(() => {
          selectShot(shotAt(head));
          const lid = lineIdAt(head);
          if (lid && lid !== app.selectedLine) app.selectLine(lid);
        });
      }
    }
    if (u.docChanged || u.heightChanged || u.geometryChanged) bump();
  }

  onMount(() => {
    committed = app.project?.script ?? '';
    view = new EditorView({
      parent: host!,
      state: EditorState.create({
        doc: committed,
        extensions: [
          editable.of([EditorState.readOnly.of(!app.canEdit), EditorView.editable.of(app.canEdit)]),
          keymap.of([
            { key: 'Mod-Enter', run: () => makeShotFromSelection() },
            { key: 'Shift-Mod-Enter', run: () => addLineless() },
            { key: 'Mod-z', run: () => (app.undo(), true), preventDefault: true },
            { key: 'Shift-Mod-z', run: () => (app.redo(), true), preventDefault: true },
            { key: 'Mod-y', run: () => (app.redo(), true), preventDefault: true },
            ...screenplay.keys,
            { key: 'Shift-F10', run: () => (openLineMenu(null), true), preventDefault: true },
            { key: 'ContextMenu', run: () => (openLineMenu(null), true), preventDefault: true },
          ]),
          keymap.of(defaultKeymap),
          drawSelection(),
          EditorView.lineWrapping,
          placeholder('Write your script here. INT. KITCHEN - NIGHT …'),
          fountainHighlight,
          screenplay.extension,
          ann.extension,
          EditorView.contentAttributes.of({
            'aria-label':
              'Script (Fountain). Select text and press Control or Command+Enter to make a shot. Tab formats screenplay elements; Escape then Tab leaves the editor.',
            'aria-multiline': 'true',
            role: 'textbox',
            spellcheck: 'true',
            id: 'script-editor',
          }),
          EditorView.domEventHandlers({
            mousemove(e) {
              const el = (e.target as HTMLElement).closest<HTMLElement>(
                '.sb-text[data-shot-id], [data-handle-shot]',
              );
              const id = el?.dataset['shotId'] ?? el?.dataset['handleShot'] ?? null;
              if (id !== hover) {
                hover = id;
                view?.dispatch({ effects: setAnnotationUi.of({ hover: id }) });
              }
              return false;
            },
            mouseleave() {
              if (hover) {
                hover = null;
                view?.dispatch({ effects: setAnnotationUi.of({ hover: null }) });
              }
              return false;
            },
            blur() {
              flush();
              return false;
            },
            contextmenu(e) {
              if ((e.target as HTMLElement).closest('[data-lineless]')) return false;
              openLineMenu(e);
              return true;
            },
          }),
          EditorView.updateListener.of(onUpdate),
        ],
      }),
    });
    pushAnnotations();
    view.dispatch({ effects: setAnnotationUi.of({ active: app.selectedShot }) });
    const unregister = app.registerFlush(flush);
    ui.scriptCommands = {
      makeShot: () => void makeShotFromSelection(),
      addLineless: () => void addLineless(),
      extendShot: () => {
        if (!app.project) return;
        const r = targetRange(app.project);
        const target =
          app.selectedShot ?? (r ? (overlappingShot(r) ?? neighbourShot(r, -1)) : null);
        if (r && target) extendTo(target, r);
      },
    };
    const ro = new ResizeObserver(bump);
    ro.observe(host!);
    // initial deep link (#shot=…): bring the shot's text into view
    if (app.selectedShot) scrollToShot(app.selectedShot);
    return () => {
      flush();
      unregister();
      ui.scriptCommands = null;
      app.buffered = false;
      ro.disconnect();
      view?.destroy();
      view = null;
    };
  });

  function scrollToShot(id: string) {
    if (!view) return;
    const s = ann.data(view).shots.find((x) => x.id === id);
    const pos = s?.pieces[0]?.from ?? s?.marker?.pos;
    if (pos !== undefined)
      view.dispatch({
        effects: EditorView.scrollIntoView(Math.min(pos, view.state.doc.length), { y: 'center' }),
      });
  }

  // The project changed (agent edit, undo, an edit elsewhere): bring the editor in line.
  $effect(() => {
    const p = app.project;
    void app.tagFilter;
    if (!view || !p) return;
    if (pending) return; // our own typing is flushed before any other change lands
    const script = p.script ?? '';
    if (script !== view.state.doc.toString()) applyExternal(script);
    committed = script;
    pushAnnotations();
  });

  $effect(() => {
    const can = app.canEdit;
    view?.dispatch({
      effects: editable.reconfigure([EditorState.readOnly.of(!can), EditorView.editable.of(can)]),
    });
  });

  $effect(() => {
    const active = app.selectedShot;
    view?.dispatch({ effects: setAnnotationUi.of({ active }) });
  });

  // Board → "Edit in script": cursor at the end of that line.
  $effect(() => {
    const req = app.revealLine;
    if (!req || !view) return;
    const v = view;
    untrack(() => {
      const l = ann.data(v).lines.find((x) => x.id === req.id);
      app.revealLine = null;
      if (!l) return;
      const line = v.state.doc.lineAt(l.pos);
      v.dispatch({
        selection: { anchor: line.to },
        effects: EditorView.scrollIntoView(line.to, { y: 'center' }),
      });
      v.focus();
    });
  });

  // Playback: the playing line, and the playing shot's words on it with a sweeping marker.
  // Only while playing or paused part-way (not at rest at 0:00). Rebuilt when the shot, the line
  // or play/pause changes, not every frame (the marker is a CSS animation).
  $effect(() => {
    const shotId = player.shotId;
    const lineId = player.lineId;
    const playing = player.playing;
    const started = playing || untrack(() => player.time) > 0;
    let now: AnnotationUi['now'] = null;
    if (started && shotId) {
      const t = untrack(() => player.time);
      const shot = untrack(() => player.animatic.shots.find((x) => x.id === shotId));
      const line = shot?.lines.find((l) => l.id === lineId);
      const span = line ?? shot;
      now = {
        shot: shotId,
        line: lineId,
        dur: span ? span.end - span.start : 1,
        elapsed: span ? t - span.start : 0,
        paused: !playing,
      };
    }
    view?.dispatch({ effects: setAnnotationUi.of({ playing: started ? lineId : null, now }) });
  });
</script>

<div class="script-view">
  {#if !app.canEdit}
    <p class="visually-hidden">Read-only script.</p>
  {/if}
  <div class="columns">
    <div class="page" class:readonly={!app.canEdit} data-tour="script" bind:this={page}>
      <div class="editor-host" bind:this={host}></div>
      {#if selButton}
        <button
          type="button"
          class="make-shot"
          id="make-shot"
          style:left="{selButton.x}px"
          style:top="{selButton.y}px"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          {@attach tooltip(`Make a shot from the selected text (${mod}Enter)`)}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => makeShotFromSelection()}
          ><Icon name="shot" size={12} />Make shot <kbd>{mod}↵</kbd></button
        >
      {/if}
    </div>
    <aside
      class="rail"
      bind:this={rail}
      aria-label="Shots beside the script"
      style:min-height="{railHeight}px"
    >
      {#if leader}
        <svg class="leader" aria-hidden="true" style:--shot-c="var(--shot-{leader.color})">
          <path d="M -18 {leader.y1} C -8 {leader.y1}, -8 {leader.y2}, 0 {leader.y2}" fill="none" />
        </svg>
      {/if}
      <!-- Shot order, not position order: re-laying out must not move focused cards in the DOM. -->
      {#each app.shots.filter((e) => placedTop.has(e.ref.id)) as entry (entry.ref.id)}
        {@const c = { id: entry.ref.id, top: placedTop.get(entry.ref.id)! }}
        {#if entry}
          <AnnotationCard
            {entry}
            active={app.selectedShot === c.id}
            hover={hover === c.id}
            top={c.top}
            dragging={drag?.id === c.id}
            onselect={() => {
              selectShot(app.selectedShot === c.id ? null : c.id, true);
              if (app.selectedShot === c.id) scrollToShot(c.id);
            }}
            ongrip={(e) => startCardDrag(c.id, e)}
            onmoved={(m) => (announcement = m)}
            onheight={(h) =>
              untrack(() => {
                if (h && heights[c.id] !== h) heights = { ...heights, [c.id]: h };
              })}
          />
        {/if}
      {/each}
      {#if drag}
        <div class="drop-line" style:top="{drag.y}px" aria-hidden="true"></div>
      {/if}
      {#if !app.shots.length && app.canEdit}
        <div class="empty">
          <p>
            Select some words of the script and press <kbd>{mod}↵</kbd> to make a shot, or start with
            a picture:
          </p>
          <button
            type="button"
            class="btn small"
            id="add-lineless-shot"
            onclick={() => addLineless()}
            ><Icon name="plus" size={12} />Shot without script text</button
          >
        </div>
      {/if}
    </aside>
  </div>
  <p class="visually-hidden" aria-live="polite">{announcement}</p>
</div>

<style>
  .script-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--fg-muted);
  }
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1fr) clamp(220px, 28%, 320px);
    gap: var(--space-5);
    align-items: start;
  }
  .page {
    position: relative;
    background: var(--paper);
    color: var(--paper-fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-height: 60vh;
  }
  .rail {
    position: relative;
  }
  .leader {
    position: absolute;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
    overflow: visible;
    pointer-events: none;
  }
  .leader path {
    stroke: var(--shot-c);
    stroke-width: 1.25;
    opacity: 0.55;
  }
  .empty {
    padding: var(--space-3);
    font-size: 12.5px;
    color: var(--fg-muted);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
  }
  .empty p {
    margin: 0 0 var(--space-2);
  }
  .drop-line {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--accent);
    pointer-events: none;
  }
  .make-shot {
    position: absolute;
    z-index: 6;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    font: 500 12px var(--font-sans);
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 2px 8px var(--shadow-color);
    cursor: pointer;
  }
  .make-shot:hover {
    border-color: var(--accent);
  }
  @media (max-width: 860px) {
    .columns {
      grid-template-columns: 1fr;
    }
    .rail {
      display: none;
    }
  }

  /* ------------------------------------------------ CodeMirror: page, type, screenplay layout */
  .editor-host :global(.cm-editor) {
    font-family: var(--font-script);
    font-size: 14px;
    line-height: 1.6;
    color: var(--paper-fg);
    background: transparent;
  }
  .editor-host :global(.cm-editor.cm-focused) {
    outline: none;
  }
  .page:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: -1px;
  }
  .editor-host :global(.cm-scroller) {
    font-family: inherit;
    overflow: visible;
  }
  .editor-host :global(.cm-content) {
    padding: 32px 0 40vh;
    caret-color: var(--accent);
  }
  .editor-host :global(.cm-line) {
    padding: 0 48px 0 40px;
  }
  .editor-host :global(.cm-cursor) {
    border-left-color: var(--accent);
    border-left-width: 2px;
  }
  .editor-host :global(.cm-selectionBackground),
  .editor-host :global(.cm-focused .cm-selectionBackground) {
    background: color-mix(in srgb, var(--accent) 26%, transparent) !important;
  }
  .editor-host :global(.cm-placeholder) {
    color: var(--fg-muted);
  }
  .editor-host :global(.sb-element-hint) {
    color: var(--fg-muted);
    opacity: 0.7;
    pointer-events: none;
  }

  /* Screenplay elements (classes from fountain-highlight.ts) */
  .editor-host :global(.cm-fx-scene_heading) {
    color: var(--sx-scene);
    font-weight: 700;
    text-transform: uppercase;
  }
  .editor-host :global(.cm-fx-character) {
    color: var(--sx-character);
    padding-left: calc(40px + 34%) !important;
    text-transform: uppercase;
  }
  .editor-host :global(.cm-fx-parenthetical) {
    color: var(--sx-paren);
    padding-left: calc(40px + 26%) !important;
    font-style: italic;
  }
  .editor-host :global(.cm-fx-dialogue) {
    color: var(--sx-dialogue);
    padding-left: calc(40px + 16%) !important;
    padding-right: calc(48px + 12%) !important;
  }
  .editor-host :global(.cm-fx-dialogue.cm-fx-vo) {
    font-style: italic;
  }
  .editor-host :global(.cm-fx-transition) {
    color: var(--sx-transition);
    text-align: right;
    text-transform: uppercase;
  }
  .editor-host :global(.cm-fx-centered) {
    color: var(--sx-centered);
    text-align: center;
  }
  .editor-host :global(.cm-fx-lyrics) {
    font-style: italic;
    padding-left: calc(40px + 16%) !important;
  }
  .editor-host :global(.cm-fx-note),
  .editor-host :global(.cm-fx-inline-note),
  .editor-host :global(.cm-fx-synopsis) {
    color: var(--sx-note);
    font-style: italic;
  }
  .editor-host :global(.cm-fx-section) {
    color: var(--sx-section);
    font-weight: 700;
  }
  .editor-host :global(.cm-fx-title_page) {
    color: var(--fg-muted);
  }
  .editor-host :global(.cm-fx-boneyard) {
    color: var(--fg-muted);
    text-decoration: line-through;
  }
  .editor-host :global(.cm-fx-emphasis) {
    font-style: italic;
  }

  /* Shot annotations (classes from annotations.ts): a light tint and a thin underline on the exact
     words of a shot, stronger on hover and for the open shot. Nothing in the margin. */
  .editor-host :global(.sb-text) {
    background: color-mix(in srgb, var(--shot-c) 9%, transparent);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--shot-c) 45%, transparent);
    text-decoration-thickness: 1.5px;
    text-underline-offset: 4px;
    text-decoration-skip-ink: none;
    border-radius: 2px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    cursor: text;
    transition:
      background 120ms var(--ease),
      text-decoration-color 120ms var(--ease);
  }
  .editor-host :global(.sb-text.sb-hover) {
    background: color-mix(in srgb, var(--shot-c) 16%, transparent);
    text-decoration-color: var(--shot-c);
  }
  .editor-host :global(.sb-text.sb-active) {
    background: color-mix(in srgb, var(--shot-c) 20%, transparent);
    text-decoration-color: var(--shot-c);
  }
  .editor-host :global(.sb-text.sb-dim) {
    background: transparent;
    text-decoration-color: color-mix(in srgb, var(--shot-c) 20%, transparent);
  }
  .editor-host :global(.sb-preview-text) {
    background: color-mix(in srgb, var(--shot-c) 18%, transparent);
    text-decoration: underline dashed var(--shot-c);
  }
  /* Playback: the playing line gets a faint wash and a bar at its edge; the playing shot's words
     are marked more strongly, and its words on the playing line carry a thin marker that sweeps
     under them over the line's time (a static full underline with reduced motion). */
  .editor-host :global(.sb-playing) {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .editor-host :global(.sb-text.sb-now-shot) {
    background: color-mix(in srgb, var(--shot-c) 24%, transparent);
    text-decoration-color: var(--shot-c);
    text-decoration-thickness: 2px;
  }
  .editor-host :global(.sb-text.sb-now) {
    color: var(--fg);
    background-color: color-mix(in srgb, var(--shot-c) 30%, transparent);
    background-image: linear-gradient(var(--accent), var(--accent));
    background-repeat: no-repeat;
    background-position: 0 100%;
    background-size: 0% 3px;
    text-decoration: none;
    /* one marker across a wrapped line, not one per fragment */
    box-decoration-break: slice;
    -webkit-box-decoration-break: slice;
    animation: sb-sweep var(--sb-dur, 2s) linear var(--sb-delay, 0s) forwards;
  }
  .editor-host :global(.sb-text.sb-now.sb-paused) {
    animation-play-state: paused;
  }
  @keyframes -global-sb-sweep {
    from {
      background-size: 0% 3px;
    }
    to {
      background-size: 100% 3px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .editor-host :global(.sb-text.sb-now) {
      animation: none;
      background-size: 100% 3px;
    }
  }
  /* boundary handles: small bars at the ends of the open / hovered shot's text */
  .editor-host :global(.sb-handle) {
    position: relative;
    display: inline-block;
    width: 2px;
    margin: 0 -1px;
    height: 1em;
    vertical-align: text-bottom;
    outline: none;
  }
  .editor-host :global(.sb-handle::before) {
    content: '';
    position: absolute;
    top: -2px;
    bottom: -3px;
    width: 2px;
    border-radius: 2px;
    background: var(--shot-c);
    cursor: ew-resize;
    transition:
      width 100ms var(--ease),
      box-shadow 100ms var(--ease);
  }
  /* pointer over the (large) hit area or keyboard focus: the bar gets a little bolder */
  .editor-host :global(.sb-handle:hover::before),
  .editor-host :global(.sb-handle:focus-visible::before) {
    width: 3px;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--shot-c) 25%, transparent);
  }
  .editor-host :global(.sb-handle:focus-visible::after) {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    border-radius: 3px;
  }
  /* just outside the words, so no letter is covered */
  .editor-host :global(.sb-handle.start::before) {
    left: -2px;
  }
  .editor-host :global(.sb-handle.end::before) {
    left: 2px;
  }
  .editor-host :global(.sb-handle::after) {
    /* invisible hit area, 18 × (line + 14) px, mostly outside the words so clicks on the
       first / last letter still place the cursor */
    content: '';
    position: absolute;
    top: -7px;
    bottom: -7px;
    left: -8px;
    width: 18px;
    cursor: ew-resize;
  }
  .editor-host :global(.sb-handle.start::after) {
    left: -13px;
  }
  .editor-host :global(.sb-handle.end::after) {
    left: -3px;
  }
  :global(html.sb-resizing),
  :global(html.sb-resizing *) {
    cursor: ew-resize !important;
    user-select: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .editor-host :global(.sb-handle::before) {
      transition: none;
    }
  }
  .editor-host :global(.sb-lineless) {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 6px 48px 6px 40px;
    padding: 1px 8px;
    font-family: var(--font-sans);
    font-size: 11.5px;
    color: var(--fg-muted);
    border: 1px dashed color-mix(in srgb, var(--shot-c) 55%, var(--border));
    border-radius: var(--radius);
    cursor: pointer;
  }
  .editor-host :global(.sb-lineless.sb-active) {
    color: var(--fg-2);
    border-style: solid;
    background: color-mix(in srgb, var(--shot-c) 10%, transparent);
  }
  .editor-host :global(.sb-lineless.sb-dim) {
    opacity: 0.4;
  }
  .editor-host :global(.sb-lineless .sb-title) {
    font-weight: 500;
  }
  /* phones: a slimmer page margin and screenplay indents, so dialogue isn't three words wide */
  @media (max-width: 600px) {
    .editor-host :global(.cm-editor) {
      font-size: 13px;
    }
    .editor-host :global(.cm-content) {
      padding-top: 20px;
    }
    .editor-host :global(.cm-line) {
      padding: 0 14px 0 14px;
    }
    .editor-host :global(.cm-fx-character) {
      padding-left: calc(14px + 30%) !important;
    }
    .editor-host :global(.cm-fx-parenthetical) {
      padding-left: calc(14px + 20%) !important;
    }
    .editor-host :global(.cm-fx-dialogue) {
      padding-left: calc(14px + 8%) !important;
      padding-right: calc(14px + 4%) !important;
    }
    .editor-host :global(.cm-fx-lyrics) {
      padding-left: calc(14px + 8%) !important;
    }
  }
</style>
