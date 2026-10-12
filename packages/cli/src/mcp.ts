/**
 * MCP server for agents (`sbd mcp`). Every edit tool loads the storyboard fresh from disk, applies a
 * pure edit operation from @storyboard-viewer/format, validates, writes atomically and notifies a
 * running viewer (SSE) so the page refreshes.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  addAsset,
  addCue,
  addShot,
  addVariant,
  insertScriptLines,
  isPresetId,
  lineRange,
  moveShot,
  moveShotWithLines,
  orderedShots,
  removeAsset,
  removeCue,
  removeLines,
  removeShot,
  removeVariant,
  resolveLines,
  setActiveVariant,
  setScript,
  setShotLines,
  setShotSpan,
  splitShot,
  hasSpan,
  lineSegments,
  locateSpan,
  shotTexts,
  textLookup,
  unassignedLines,
  updateAsset,
  updateCue,
  updateLine,
  updateManifest,
  updateShot,
  activeVariant,
  slotFrameOf,
  addLayer,
  applyLayout,
  canvasSizeOf,
  CAPTION_STYLES,
  fillSlot,
  layoutsFor,
  moveLayer,
  newId,
  removeLayers,
  textLayerInput,
  updateLayers,
  updateVariant,
  type CanvasVariant,
  PRESET_IDS,
  type CueInput,
  type CueTarget,
  type Issue,
  type Layer,
  type SbdProject,
  type SpanPoint,
  type VariantInput,
} from '@storyboard-viewer/format';
import { prepareAsset } from './media-import.js';
import { createStoryboard } from './project-files.js';
import { startServer, type RunningServer } from './server.js';
import { EditRejectedError, ProjectStore, type EditOptions } from './store.js';
import { findViewer } from './registry.js';
import { VERSION } from './version.js';

export interface McpOptions {
  /** Storyboard to open at start (optional; agents can call open_storyboard). */
  path?: string;
  /** Also serve the viewer from this process (`sbd mcp --serve`). */
  serve?: { port?: number; host?: string; recent?: boolean } | false;
  log?: (msg: string) => void;
}

export interface McpSession {
  server: McpServer;
  store(): ProjectStore | null;
  viewer(): RunningServer | null;
  close(): Promise<void>;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (data: unknown): ToolResult => ({
  content: [
    { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) },
  ],
});
const failure = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

function lineView(p: SbdProject) {
  const lines = resolveLines(p);
  return (id: string) => {
    const l = lines.get(id);
    if (!l) return { id, missing: true };
    const out: Record<string, unknown> = { id, type: l.type, text: l.text };
    if (l.element?.character) out['character'] = l.element.character;
    if (l.element?.extension) out['extension'] = l.element.extension;
    return out;
  };
}

function shotView(p: SbdProject, id: string, detail: boolean) {
  const ref = p.ids.shots.find((s) => s.id === id)!;
  const shot = p.shots[id] ?? { id };
  const line = lineView(p);
  const base: Record<string, unknown> = {
    index: p.ids.shots.indexOf(ref),
    id,
    title: shot.title,
    fields: shot.fields ?? {},
    duration: shot.duration,
    lines: ref.lines.map(line),
    active_variant: activeVariant(shot)?.id ?? null,
    variants: (shot.variants ?? []).map((v) =>
      v.type === 'image'
        ? { id: v.id, type: v.type, name: v.name, asset: v.asset }
        : detail
          ? v
          : {
              id: v.id,
              type: v.type,
              name: v.name,
              layers: v.layers.length,
              ...(v.layers.some((l) => slotFrameOf(l))
                ? {
                    slots: v.layers
                      .filter((l) => slotFrameOf(l))
                      .map((l) => ({
                        layer_id: l.id,
                        name: slotFrameOf(l)!.name,
                        image: l.asset ?? null,
                      })),
                  }
                : {}),
            },
    ),
  };
  if (hasSpan(ref)) {
    // part of a line (format 0.2): where the shot starts / ends and the words it covers
    const parts = shotTexts(ref, textLookup(p.ids.lines));
    base['span'] = {
      ...(ref.start ? { start: ref.start } : {}),
      ...(ref.end ? { end: ref.end } : {}),
      text: parts.map((x) => x.text).join('\n'),
    };
  }
  if (detail) {
    base['cues'] = p.timeline.cues.filter((c) => {
      const t = c.target as Record<string, unknown>;
      return (
        t['shot'] === id ||
        ref.lines.includes(t['line'] as string) ||
        (Array.isArray(t['range']) && (t['range'] as string[]).some((l) => ref.lines.includes(l)))
      );
    });
    for (const [k, v] of Object.entries(shot)) {
      if (!['id', 'title', 'fields', 'duration', 'variants', 'active_variant'].includes(k))
        base[k] = v;
    }
  }
  return base;
}

function summary(p: SbdProject, issues: Issue[], store: ProjectStore, viewerUrl: string | null) {
  const m = p.manifest;
  const counts = (sev: string) => issues.filter((i) => i.severity === sev).length;
  return {
    path: store.path,
    form:
      store.kind === 'folder'
        ? 'unpacked folder'
        : 'packed .sbd file (saved in place; the previous version is kept as .bak)',
    viewer_url: viewerUrl,
    title: m.title,
    preset: m.preset,
    aspect_ratio: m.aspect_ratio ?? '16:9',
    fps: m.fps,
    shot_fields: (m.shot_fields ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type ?? 'text',
      options: f.options,
    })),
    categories: (m.categories ?? []).map((c) => c.id),
    has_script: p.script !== null,
    shots: orderedShots(p).map(({ ref, shot, index }) => ({
      index,
      id: ref.id,
      title: shot.title,
      lines: ref.lines.length,
      variants: shot.variants?.length ?? 0,
      active_variant: activeVariant(shot)?.id ?? null,
    })),
    unassigned_lines: unassignedLines(p).length,
    assets: p.assets.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      category: a.category,
    })),
    cues: p.timeline.cues.length,
    issues: { errors: counts('error'), warnings: counts('warning'), info: counts('info') },
  };
}

const idString = z.string().min(1);
const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const textStyleFields = {
  font: z
    .string()
    .optional()
    .describe('Font family: Montserrat, IBM Plex Sans, Courier Prime, IBM Plex Mono'),
  font_asset: z.string().optional().describe('A font asset ID to use instead of font'),
  font_size: z.number().positive().optional().describe('Canvas px'),
  font_weight: z.number().min(1).max(1000).optional(),
  italic: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  color: z.string().optional().describe('CSS color, default #ffffff'),
  align: z.enum(['left', 'center', 'right']).optional(),
  line_height: z.number().positive().optional(),
  stroke: z.object({ color: z.string(), width: z.number().min(0) }).optional(),
  shadow: z
    .object({
      color: z.string(),
      blur: z.number().min(0).optional(),
      offset_x: z.number().optional(),
      offset_y: z.number().optional(),
    })
    .optional(),
  box: z
    .object({
      color: z.string(),
      padding: z.number().min(0).optional(),
      radius: z.number().min(0).optional(),
    })
    .optional(),
};

const layerSchema = z
  .object({
    id: z.string().optional(),
    kind: z
      .enum(['image', 'text', 'slot'])
      .optional()
      .describe('image (default), text (on-screen text) or slot (empty placeholder)'),
    asset: idString.optional().describe('Image layers: image or video asset ID'),
    text: z.string().optional().describe('Text layers: the text'),
    group: z.string().optional().describe('Group ID shared by layers that belong together'),
    fit: z.enum(['cover', 'contain']).optional().describe('Slot layers: how a picture fits'),
    ...textStyleFields,
    name: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    scale_x: z.number().optional(),
    scale_y: z.number().optional(),
    rotation: z.number().optional().describe('Degrees clockwise'),
    opacity: z.number().min(0).max(1).optional(),
    crop: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .optional(),
    filters: z.array(z.object({ type: z.string(), value: z.number().optional() })).optional(),
    visible: z.boolean().optional(),
  })
  .passthrough();

const cueFields = {
  in: z
    .number()
    .min(0)
    .optional()
    .describe('Start position inside the media file, in seconds (default 0)'),
  out: z
    .number()
    .min(0)
    .optional()
    .describe('End position inside the media file, in seconds (default: end of file)'),
  offset: z.number().optional().describe('Delay after the target starts, in seconds (default 0)'),
  gain: z.number().min(0).optional().describe('Volume, 1 = unchanged (default 1)'),
  track: z.string().optional().describe('Mixing group such as dialogue, music, sfx, video'),
  loop: z
    .boolean()
    .optional()
    .describe('Repeat the [in, out] segment (useful for background music)'),
  fade_in: z.number().min(0).optional(),
  fade_out: z.number().min(0).optional(),
  label: z.string().optional(),
};
const targetFields = {
  line_id: z.string().optional().describe('Play with this script line'),
  shot_id: z.string().optional().describe('Play when this shot starts'),
  range: z.tuple([z.string(), z.string()]).optional().describe('[first line ID, last line ID]'),
  global_start: z
    .number()
    .min(0)
    .optional()
    .describe('Seconds from the start of the story (background music)'),
};

function targetFrom(a: {
  line_id?: string | undefined;
  shot_id?: string | undefined;
  range?: [string, string] | undefined;
  global_start?: number | undefined;
}): CueTarget | undefined {
  const given = [a.line_id, a.shot_id, a.range, a.global_start].filter(
    (x) => x !== undefined,
  ).length;
  if (given === 0) return undefined;
  if (given > 1)
    throw new Error('Give exactly one target: line_id, shot_id, range or global_start');
  if (a.line_id) return { line: a.line_id };
  if (a.shot_id) return { shot: a.shot_id };
  if (a.range) return { range: a.range };
  return { global: { start: a.global_start! } };
}

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const spanFields = {
  start_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Start at this character of the FIRST line (0 = its first character). For a shot on part of a line',
    ),
  end_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'End before this character of the LAST line (exclusive; default: the end of the line)',
    ),
  text: z
    .string()
    .optional()
    .describe(
      'Exact words of the line(s) the shot covers, e.g. "the cops" (alternative to start_offset/end_offset; across lines use \\n)',
    ),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('With text: which match to use when the words appear more than once (default 1)'),
};

interface SpanArgs {
  start_offset?: number | undefined;
  end_offset?: number | undefined;
  text?: string | undefined;
  occurrence?: number | undefined;
}

/** Start / end points for a shot on part of its lines, or null for whole lines. */
function spanFrom(
  p: SbdProject,
  lineIds: readonly string[],
  a: SpanArgs,
): { start: SpanPoint; end: SpanPoint } | null {
  if (a.text === undefined && a.start_offset === undefined && a.end_offset === undefined)
    return null;
  const ord = new Map(p.ids.lines.map((l) => [l.id, l.ordinal]));
  for (const l of lineIds) if (!ord.has(l)) throw new Error(`Unknown line "${l}"`);
  const sorted = [...new Set(lineIds)].sort((x, y) => ord.get(x)! - ord.get(y)!);
  if (!sorted.length) throw new Error('Give the line(s) the words are in');
  const textOf = textLookup(p.ids.lines);
  if (a.text !== undefined) {
    const found = locateSpan(sorted, textOf, a.text, a.occurrence ?? 1);
    if (!found)
      throw new Error(
        `"${a.text}" is not in ${sorted.length > 1 ? 'those lines' : `line ${sorted[0]}`} (text is matched exactly; call get_script to see line texts)`,
      );
    return found;
  }
  const last = sorted.at(-1)!;
  return {
    start: { line: sorted[0]!, offset: a.start_offset ?? 0 },
    end: { line: last, offset: a.end_offset ?? textOf(last)?.length ?? 0 },
  };
}

export async function createMcpSession(opts: McpOptions = {}): Promise<McpSession> {
  const log = opts.log ?? (() => {});
  let store: ProjectStore | null = null;
  let viewer: RunningServer | null = null;

  const server = new McpServer(
    { name: 'storyboard-viewer', version: VERSION },
    {
      instructions: [
        'Edits .sbd storyboards (Storyboard Viewer). A storyboard is a folder like story.sbd/ with a Fountain script, shots (in order), assets (images/audio/video) and timing cues.',
        'Start with open_storyboard (or get_storyboard if one is already open), then list_shots to see shot IDs and line IDs.',
        'Line IDs (l_…) identify script lines and never change when you edit through these tools. Shot IDs (s_… or readable names) identify shots.',
        'Every edit is validated and saved immediately; the viewer page refreshes by itself. Call get_viewer_url to give the user a link.',
      ].join('\n'),
    },
  );

  const viewerUrl = () => viewer?.url ?? null;

  const requireStore = (): ProjectStore => {
    if (!store)
      throw new Error(
        'No storyboard is open. Call open_storyboard with the path of a .sbd folder first.',
      );
    return store;
  };

  const openStore = async (path: string) => {
    const next = ProjectStore.open(path);
    if (viewer) {
      await viewer.close();
      viewer = null;
    }
    store = next;
    if (opts.serve) {
      // Several agent sessions may each run a viewer: when the port is taken, use the next one.
      const first = opts.serve.port ?? 4400;
      for (let port = first; ; port++) {
        try {
          viewer = await startServer(store, {
            port,
            host: opts.serve.host,
            recent: opts.serve.recent ?? false,
            log,
          });
          break;
        } catch (e) {
          const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
          if (!busy || port >= first + 20 || first === 0) throw e;
        }
      }
      log(`viewer: ${[viewer.url, ...viewer.networkUrls].join(' · ')}`);
    }
    return store;
  };

  /** Wraps a tool body: errors become readable tool errors instead of protocol errors. */
  const tool = <A>(fn: (args: A) => Promise<ToolResult>) => {
    return async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (e) {
        if (e instanceof EditRejectedError) return failure(e.message);
        return failure((e as Error).message);
      }
    };
  };

  /** Runs an edit and reports what changed. */
  const edit = async (
    fn: Parameters<ProjectStore['edit']>[0],
    describe: (r: { project: SbdProject } & Record<string, unknown>) => Record<string, unknown>,
    opts: EditOptions = {},
  ): Promise<ToolResult> => {
    const r = await requireStore().edit(fn, opts);
    const warnings = r.issues.filter((i) => i.severity === 'warning').map((i) => i.message);
    return text({
      ok: true,
      ...describe(r as never),
      saved: r.written,
      ...(warnings.length ? { warnings } : {}),
    });
  };

  server.registerTool(
    'open_storyboard',
    {
      title: 'Open a storyboard',
      description:
        'Open a storyboard so the other tools work on it. `path` is an unpacked folder (e.g. "./my-film.sbd") or a packed .sbd file (both editable; a packed file is re-packed in place on every edit, its previous version kept once as <file>.bak). Set create=true to make a new, empty storyboard at that path (optionally with a preset: blank, film, documentary, animation, motion, vertical).',
      inputSchema: {
        path: idString.describe('Path to the storyboard folder (or packed .sbd file)'),
        create: z
          .boolean()
          .optional()
          .describe('Create a new storyboard at path if it does not exist'),
        title: z.string().optional().describe('Title for a new storyboard'),
        preset: z
          .enum(PRESET_IDS as [string, ...string[]])
          .optional()
          .describe('Preset for a new storyboard'),
        aspect_ratio: z.string().optional().describe('For a new storyboard, e.g. "16:9" or "9:16"'),
      },
    },
    tool(
      async (a: {
        path: string;
        create?: boolean;
        title?: string;
        preset?: string;
        aspect_ratio?: string;
      }) => {
        const abs = resolve(a.path);
        if (!existsSync(abs)) {
          if (!a.create)
            return failure(`No storyboard at ${abs}. Pass create=true to make a new one.`);
          await createStoryboard(abs, {
            title: a.title ?? 'Untitled',
            ...(a.preset && isPresetId(a.preset) ? { preset: a.preset } : {}),
            ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
          });
        }
        const s = await openStore(abs);
        const opened = await s.load();
        return text(summary(opened.project, opened.issues, s, viewerUrl()));
      },
    ),
  );

  server.registerTool(
    'get_storyboard',
    {
      title: 'Storyboard overview',
      description:
        'Overview of the open storyboard: title, preset, shot fields, shots (IDs, titles, counts), assets, number of cues and validation issue counts. Set include to also return the raw script, timeline or manifest.',
      inputSchema: {
        include: z.array(z.enum(['script', 'timeline', 'manifest', 'assets'])).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (a: { include?: string[] }) => {
      const s = requireStore();
      const { project, issues } = await s.load();
      const out: Record<string, unknown> = summary(project, issues, s, viewerUrl());
      for (const k of a.include ?? []) {
        if (k === 'script') out['script'] = project.script;
        if (k === 'timeline') out['timeline'] = project.timeline;
        if (k === 'manifest') out['manifest'] = project.manifest;
        if (k === 'assets') out['assets'] = project.assets.assets;
      }
      return text(out);
    }),
  );

  server.registerTool(
    'list_shots',
    {
      title: 'List shots',
      description:
        'All shots in story order with their script lines (ID, type, character, text), fields, duration and variants. Also lists script lines that are not in any shot.',
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const { project } = await requireStore().load();
      const line = lineView(project);
      return text({
        shots: project.ids.shots.map((r) => shotView(project, r.id, false)),
        unassigned_lines: unassignedLines(project).map(line),
      });
    }),
  );

  server.registerTool(
    'get_shot',
    {
      title: 'Get one shot',
      description:
        'Everything about one shot: fields, lines, all variants (including canvas layers) and the cues that play during it.',
      inputSchema: { shot_id: idString },
      annotations: { readOnlyHint: true },
    },
    tool(async (a: { shot_id: string }) => {
      const { project } = await requireStore().load();
      if (!project.ids.shots.some((s) => s.id === a.shot_id))
        return failure(`Unknown shot "${a.shot_id}". Call list_shots to see shot IDs.`);
      return text(shotView(project, a.shot_id, true));
    }),
  );

  server.registerTool(
    'get_script',
    {
      title: 'Get the script',
      description:
        'The Fountain script text plus every script line with its ID, type and the shot it belongs to (null = not in a shot). A line split between shots (several shots on parts of one line) also lists `shots` with the character range [from, to) each one covers.',
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const { project } = await requireStore().load();
      const segs = lineSegments(project.ids.shots, textLookup(project.ids.lines));
      const line = lineView(project);
      return text({
        script: project.script,
        lines: project.ids.lines.map((l) => {
          const own = segs.get(l.id) ?? [];
          const out: Record<string, unknown> = { ...line(l.id), shot: own[0]?.shot ?? null };
          if (own.length > 1 || own.some((x) => !x.whole))
            out['shots'] = own.map((x) => ({ shot: x.shot, from: x.from, to: x.to }));
          return out;
        }),
      });
    }),
  );

  server.registerTool(
    'add_shot',
    {
      title: 'Add a shot',
      description: [
        'Add a new shot. By default it goes at the end; use after (shot ID, or null for the very start) or index to place it.',
        'Attach existing script lines with line_ids (they move out of other shots), OR write new script text with script_text (Fountain, e.g. "MAYA\\nWe should go." or "INT. KITCHEN - NIGHT\\n\\nRain on the window.") which is inserted into the script and attached to the shot.',
        'A shot can cover just PART of a line, and one line can hold several shots (e.g. one dialogue line with a shot of the speaker, one of "the cops", one of "the cars"): pass text with the exact words (e.g. text: "the cops") or start_offset / end_offset (characters in the first / last line). That text leaves other shots (shots never overlap).',
        'fields uses the shot field IDs from get_storyboard (e.g. camera, movement, notes); unknown keys become custom fields. Every field is optional: set only the ones that matter for this shot (the viewer hides empty fields). tags (e.g. ["act-1", "night"]) show on the shot card and can be filtered in the viewer; reuse existing tags.',
        'Optionally give image_asset_id to show an image right away.',
      ].join(' '),
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('Readable ID like "opening" (letters, digits, _ - .); generated if omitted'),
        title: z.string().optional(),
        fields: z.record(z.string(), fieldValue).optional(),
        tags: z.array(z.string()).optional(),
        duration: z
          .number()
          .positive()
          .optional()
          .describe('Seconds; omit to derive from lines/audio'),
        after: z
          .string()
          .nullable()
          .optional()
          .describe('Insert after this shot ID; null = at the start'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('0-based position (alternative to after)'),
        line_ids: z.array(z.string()).optional(),
        script_text: z.string().optional().describe('New Fountain text for this shot'),
        ...spanFields,
        image_asset_id: z.string().optional().describe('Image asset to use as the first variant'),
      },
    },
    tool(
      async (
        a: {
          id?: string;
          title?: string;
          fields?: Record<string, string | number | boolean | null>;
          tags?: string[];
          duration?: number;
          after?: string | null;
          index?: number;
          line_ids?: string[];
          script_text?: string;
          image_asset_id?: string;
        } & SpanArgs,
      ) =>
        edit(
          (p) => {
            const input: Parameters<typeof addShot>[1] = defined({
              id: a.id,
              title: a.title,
              fields: a.fields,
              tags: a.tags,
              duration: a.duration,
              index: a.index,
              lines: a.line_ids,
            });
            if (a.after !== undefined) input.after = a.after;
            if (a.image_asset_id)
              input.variants = [{ type: 'image', asset: a.image_asset_id, name: 'Image' }];
            const span = a.script_text ? null : spanFrom(p, a.line_ids ?? [], a);
            if (span) Object.assign(input, span);
            let { project, id } = addShot(p, input);
            let added: string[] = [];
            if (a.script_text) {
              const r = insertScriptLines(project, { text: a.script_text, shot: id });
              project = r.project;
              added = r.added;
              const later = spanFrom(project, added, a);
              if (later) project = setShotSpan(project, id, later.start, later.end);
            }
            return { project, id, added };
          },
          (r) => ({
            shot: shotView(r.project, r['id'] as string, false),
            new_lines: (r['added'] as string[]).map(lineView(r.project)),
          }),
        ),
    ),
  );

  server.registerTool(
    'update_shot',
    {
      title: 'Update a shot',
      description:
        "Change a shot's title, fields, duration or tags. fields are merged: only the keys you pass change, and a null value removes that field (fields are optional; the viewer shows only fields with a value). A key that is not a field ID from get_storyboard becomes a custom field; to give it a label in the viewer, add it to shot_fields with update_storyboard. tags replaces the whole tag list (null clears it).",
      inputSchema: {
        shot_id: idString,
        title: z.string().nullable().optional(),
        fields: z.record(z.string(), fieldValue).optional(),
        duration: z.number().positive().nullable().optional(),
        tags: z.array(z.string()).nullable().optional(),
      },
    },
    tool(
      async (a: {
        shot_id: string;
        title?: string | null;
        fields?: Record<string, string | number | boolean | null>;
        duration?: number | null;
        tags?: string[] | null;
      }) =>
        edit(
          (p) => ({
            project: updateShot(
              p,
              a.shot_id,
              defined({ title: a.title, fields: a.fields, duration: a.duration, tags: a.tags }),
            ),
          }),
          (r) => ({ shot: shotView(r.project, a.shot_id, false) }),
        ),
    ),
  );

  server.registerTool(
    'move_shot',
    {
      title: 'Move a shot',
      description:
        "Reorder: move a shot to a 0-based index, or right after another shot (after: null = to the start). By default the shot's script lines move with it (every line keeps its ID), so the script reads in shot order; pass move_lines: false to change only the shot order.",
      inputSchema: {
        shot_id: idString,
        index: z.number().int().min(0).optional(),
        after: z.string().nullable().optional(),
        move_lines: z
          .boolean()
          .optional()
          .describe("Also move the shot's script lines (default true)"),
      },
    },
    tool(
      async (a: { shot_id: string; index?: number; after?: string | null; move_lines?: boolean }) =>
        edit(
          (p) => {
            const to = a.index !== undefined ? { index: a.index } : { after: a.after ?? null };
            return {
              project:
                a.move_lines === false
                  ? moveShot(p, a.shot_id, to)
                  : moveShotWithLines(p, a.shot_id, to),
            };
          },
          (r) => ({ order: r.project.ids.shots.map((s) => s.id) }),
        ),
    ),
  );

  server.registerTool(
    'remove_shot',
    {
      title: 'Remove a shot',
      description:
        'Delete a shot. Its script lines stay in the script (they become unassigned); cues attached to the shot are removed.',
      inputSchema: { shot_id: idString },
      annotations: { destructiveHint: true },
    },
    tool(async (a: { shot_id: string }) =>
      edit(
        (p) => removeShot(p, a.shot_id),
        (r) => ({
          removed: a.shot_id,
          removed_cues: r['removedCues'],
          order: r.project.ids.shots.map((s) => s.id),
        }),
      ),
    ),
  );

  server.registerTool(
    'set_lines',
    {
      title: 'Set the script lines of a shot',
      description:
        'Choose which existing script lines a shot covers: either line_ids, or from_line + to_line (inclusive range in script order). The lines are removed from other shots. Pass an empty line_ids to clear. To cover only PART of a line (several shots can share one line), add text (the exact words, e.g. "the cars") or start_offset / end_offset (characters in the first / last line); only that text leaves other shots.',
      inputSchema: {
        shot_id: idString,
        line_ids: z.array(z.string()).optional(),
        from_line: z.string().optional(),
        to_line: z.string().optional(),
        ...spanFields,
      },
    },
    tool(
      async (
        a: {
          shot_id: string;
          line_ids?: string[];
          from_line?: string;
          to_line?: string;
        } & SpanArgs,
      ) =>
        edit(
          (p) => {
            let ids = a.line_ids;
            if (!ids) {
              if (!a.from_line || !a.to_line)
                throw new Error('Give line_ids, or from_line and to_line');
              ids = lineRange(p, a.from_line, a.to_line);
            }
            const span = ids.length ? spanFrom(p, ids, a) : null;
            if (span) return { project: setShotSpan(p, a.shot_id, span.start, span.end) };
            return { project: setShotLines(p, a.shot_id, ids, { whole: true }) };
          },
          (r) => ({ shot: shotView(r.project, a.shot_id, false) }),
        ),
    ),
  );

  server.registerTool(
    'split_shot',
    {
      title: 'Split a shot in two',
      description:
        'Split a shot into two at a script line, or inside a line: the text from that point on moves into a new shot right after it (fields are copied, pictures are not). Give line_id (a line of the shot) and optionally offset (character in that line) or text (the words the new shot starts with).',
      inputSchema: {
        shot_id: idString,
        line_id: idString,
        offset: z.number().int().min(0).optional(),
        text: z.string().optional().describe('The new shot starts at these words (in line_id)'),
        new_id: z.string().optional().describe('Readable ID for the new shot'),
        title: z.string().optional().describe('Title of the new shot'),
      },
    },
    tool(
      async (a: {
        shot_id: string;
        line_id: string;
        offset?: number;
        text?: string;
        new_id?: string;
        title?: string;
      }) =>
        edit(
          (p) => {
            let offset = a.offset;
            if (a.text !== undefined) {
              const found = locateSpan([a.line_id], textLookup(p.ids.lines), a.text);
              if (!found) throw new Error(`"${a.text}" is not in line ${a.line_id}`);
              offset = found.start.offset;
            }
            return splitShot(
              p,
              a.shot_id,
              a.line_id,
              defined({ offset, id: a.new_id, title: a.title }),
            );
          },
          (r) => ({
            shot: shotView(r.project, a.shot_id, false),
            new_shot: shotView(r.project, r['id'] as string, false),
          }),
        ),
    ),
  );

  server.registerTool(
    'insert_lines',
    {
      title: 'Write new script lines',
      description:
        'Insert Fountain text into the script as a new paragraph: after the paragraph of after_line, before the paragraph of before_line, after the last line of shot_id, or at the end. New lines join shot_id (or the shot of the neighbouring line). Existing line IDs never change. Use Fountain: scene headings start with INT./EXT., a character name in CAPS on its own line followed by dialogue, (parentheticals) on their own line.',
      inputSchema: {
        text: idString.describe('Fountain text, may contain several lines'),
        after_line: z.string().optional(),
        before_line: z.string().optional(),
        shot_id: z.string().optional(),
      },
    },
    tool(async (a: { text: string; after_line?: string; before_line?: string; shot_id?: string }) =>
      edit(
        (p) =>
          insertScriptLines(
            p,
            defined({
              text: a.text,
              after_line: a.after_line,
              before_line: a.before_line,
              shot: a.shot_id,
            }) as { text: string },
          ),
        (r) => ({ new_lines: (r['added'] as string[]).map(lineView(r.project)) }),
      ),
    ),
  );

  server.registerTool(
    'update_line',
    {
      title: 'Edit one script line',
      description:
        'Replace the text of one script line (single line, Fountain syntax). The line keeps its ID, so shots and cues stay attached.',
      inputSchema: { line_id: idString, text: idString },
    },
    tool(async (a: { line_id: string; text: string }) =>
      edit(
        (p) => updateLine(p, a.line_id, a.text),
        (r) => ({ line: lineView(r.project)(a.line_id) }),
      ),
    ),
  );

  server.registerTool(
    'remove_lines',
    {
      title: 'Delete script lines',
      description:
        'Delete lines from the script. A character name left without dialogue is removed too. Cues attached to the deleted lines are removed.',
      inputSchema: { line_ids: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    tool(async (a: { line_ids: string[] }) =>
      edit(
        (p) => removeLines(p, a.line_ids),
        (r) => ({ removed: r['removed'], removed_cues: r['removedCues'] }),
      ),
    ),
  );

  server.registerTool(
    'set_script',
    {
      title: 'Replace the whole script',
      description:
        'Replace script.fountain with new Fountain text. Unchanged lines keep their IDs and edited lines usually do; deleted lines leave their shots and their cues are removed. Prefer insert_lines / update_line for small changes.',
      inputSchema: { script: z.string() },
      annotations: { destructiveHint: true },
    },
    tool(async (a: { script: string }) =>
      edit(
        (p) => setScript(p, a.script),
        (r) => ({ added: r['added'], removed: r['removed'], removed_cues: r['removedCues'] }),
      ),
    ),
  );

  server.registerTool(
    'update_storyboard',
    {
      title: 'Update storyboard settings',
      description:
        'Change title, description, aspect_ratio ("16:9", "9:16", "2.39:1"), fps, default_shot_duration, shot_fields or categories of the open storyboard.',
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional(),
        aspect_ratio: z.string().optional(),
        fps: z.number().positive().optional(),
        default_shot_duration: z.number().positive().optional(),
        shot_fields: z
          .array(
            z.object({
              id: idString,
              label: z.string(),
              type: z.enum(['text', 'longtext', 'number', 'boolean', 'select']).optional(),
              options: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        categories: z
          .array(
            z.object({
              id: idString,
              label: z.string(),
              kinds: z.array(z.enum(['image', 'audio', 'video', 'font'])).optional(),
            }),
          )
          .optional(),
      },
    },
    tool(async (a: Record<string, unknown>) =>
      edit(
        (p) => ({ project: updateManifest(p, defined(a) as never) }),
        (r) => ({ manifest: r.project.manifest }),
      ),
    ),
  );

  server.registerTool(
    'add_asset',
    {
      title: 'Add an asset (image, audio, video, font)',
      description: [
        'Register a media file. For a local file give path: mode "embed" (default) copies it into the storyboard\'s media/ folder; mode "link" keeps it where it is (good for big videos) and stores a relative file: path.',
        'For an online file or stream give url (https://…, .m3u8 works).',
        'kind is guessed from the extension. category groups assets in the Assets tab (see categories in get_storyboard, e.g. character, location, prop, music, sfx).',
        'Returns the new asset ID to use in add_variant / add_cue. Prefer browser-friendly formats: PNG/JPEG/WebP, MP3/M4A/WAV, MP4 (H.264/AAC) or WebM.',
      ].join(' '),
      inputSchema: {
        path: z.string().optional(),
        url: z.string().optional(),
        mode: z.enum(['embed', 'link']).optional(),
        id: z
          .string()
          .optional()
          .describe('Readable ID like "maya-portrait"; generated if omitted'),
        name: z.string().optional(),
        kind: z.enum(['image', 'audio', 'video', 'font']).optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
    },
    tool(async (a: Parameters<typeof prepareAsset>[1]) => {
      const s = requireStore();
      const packed = s.kind === 'packed';
      const { asset, created, files } = await prepareAsset(
        s.path,
        a,
        packed ? { packed: { exists: (rel) => s.has(rel) } } : {},
      );
      try {
        return await edit(
          (p) => addAsset(p, asset),
          (r) => ({
            asset: r.project.assets.assets.find((x) => x.id === r['id']),
            copied: created,
          }),
          packed ? { add: files } : {},
        );
      } catch (e) {
        if (!packed) {
          const { rm } = await import('node:fs/promises');
          for (const f of created) await rm(resolve(s.path, f), { force: true });
        }
        throw e;
      }
    }),
  );

  server.registerTool(
    'update_asset',
    {
      title: 'Update an asset',
      description:
        'Change name, category, tags, notes, credit or license of an asset (null removes a value).',
      inputSchema: {
        asset_id: idString,
        name: z.string().optional(),
        category: z.string().nullable().optional(),
        tags: z.array(z.string()).nullable().optional(),
        notes: z.string().nullable().optional(),
        credit: z.string().nullable().optional(),
        license: z.string().nullable().optional(),
      },
    },
    tool(async ({ asset_id, ...rest }: { asset_id: string } & Record<string, unknown>) =>
      edit(
        (p) => ({ project: updateAsset(p, asset_id, defined(rest) as never) }),
        (r) => ({ asset: r.project.assets.assets.find((x) => x.id === asset_id) }),
      ),
    ),
  );

  server.registerTool(
    'remove_asset',
    {
      title: 'Remove an asset',
      description:
        'Remove an asset from the registry. Fails if it is still used, unless force=true (then variants, layers and cues using it are removed too). Embedded files stay in media/.',
      inputSchema: { asset_id: idString, force: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    tool(async (a: { asset_id: string; force?: boolean }) =>
      edit(
        (p) => ({ project: removeAsset(p, a.asset_id, { force: a.force ?? false }) }),
        () => ({ removed: a.asset_id }),
      ),
    ),
  );

  server.registerTool(
    'add_variant',
    {
      title: 'Add a visual variant to a shot',
      description:
        'Add an alternative visual to a shot. Simple case: asset_id of an image (or video) asset. Composition: layers = list of layers, bottom first, coordinates in canvas pixels (default canvas size from the storyboard, e.g. 1920x1080 or 1080x1920): image layers (asset, x, y, width, height, scale_x, scale_y, rotation, opacity, crop, filters), text layers (kind "text", text, x, y, width = wrap width, font, font_size, font_weight, color, align, stroke, shadow, box) and empty slots (kind "slot", name, x, y, width, height). For ready-made arrangements prefer apply_layout; for captions add_text_layer. The new variant becomes the active one unless activate=false.',
      inputSchema: {
        shot_id: idString,
        asset_id: z.string().optional(),
        layers: z.array(layerSchema).optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        background: z.string().optional(),
        name: z.string().optional(),
        id: z.string().optional(),
        notes: z.string().optional(),
        activate: z.boolean().optional(),
      },
    },
    tool(
      async (a: {
        shot_id: string;
        asset_id?: string;
        layers?: Array<Partial<Layer>>;
        width?: number;
        height?: number;
        background?: string;
        name?: string;
        id?: string;
        notes?: string;
        activate?: boolean;
      }) =>
        edit(
          (p) => {
            if (!!a.asset_id === !!a.layers)
              throw new Error('Give either asset_id (single image) or layers (composition)');
            const common = defined({ id: a.id, name: a.name, notes: a.notes });
            const v: VariantInput = a.asset_id
              ? { ...common, type: 'image', asset: a.asset_id }
              : {
                  ...common,
                  ...defined({ width: a.width, height: a.height, background: a.background }),
                  type: 'canvas',
                  layers: a.layers as Layer[],
                };
            return addVariant(p, a.shot_id, v, { activate: a.activate ?? true });
          },
          (r) => ({ variant_id: r['id'], shot: shotView(r.project, a.shot_id, false) }),
        ),
    ),
  );

  /** The canvas variant a layer tool works on: the given one, else the shot's active one. */
  const canvasFor = (p: SbdProject, shotId: string, variantId?: string): CanvasVariant => {
    const shot = p.shots[shotId];
    if (!shot) throw new Error(`Unknown shot "${shotId}"`);
    const v = variantId
      ? shot.variants?.find((x) => x.id === variantId)
      : (activeVariant(shot) ?? undefined);
    if (!v)
      throw new Error(
        `Shot "${shotId}" has no ${variantId ? `variant "${variantId}"` : 'variants'}`,
      );
    if (v.type !== 'canvas')
      throw new Error(
        `Variant "${v.id}" is a single image, not a layout. Use apply_layout (it can turn it into one) or add_variant with layers.`,
      );
    return v;
  };
  const variantField = z
    .string()
    .optional()
    .describe("Canvas variant ID (default: the shot's active variant)");
  const layersView = (p: SbdProject, shotId: string, variantId: string) =>
    canvasFor(p, shotId, variantId).layers;

  server.registerTool(
    'update_variant',
    {
      title: 'Change a variant',
      description:
        'Rename a variant, change its notes, or (canvas variants) its background color or size, or replace all of its layers at once (same layer format as add_variant). null removes a value.',
      inputSchema: {
        shot_id: idString,
        variant_id: idString,
        name: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        background: z.string().nullable().optional(),
        width: z.number().positive().nullable().optional(),
        height: z.number().positive().nullable().optional(),
        layers: z.array(layerSchema).optional(),
      },
    },
    tool(
      async ({
        shot_id,
        variant_id,
        ...rest
      }: { shot_id: string; variant_id: string } & Record<string, unknown>) =>
        edit(
          (p) => {
            const patch = { ...rest } as Record<string, unknown>;
            for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
            if (Array.isArray(patch['layers'])) {
              const taken = new Set<string>();
              patch['layers'] = (patch['layers'] as Array<Partial<Layer>>).map((l) => {
                const id = l.id ?? newId('ly', taken);
                taken.add(id);
                return { ...l, id };
              });
            }
            // layers are checked by validation (unknown assets, missing text) before saving
            return { project: updateVariant(p, shot_id, variant_id, patch as never) };
          },
          (r) => ({ shot: shotView(r.project, shot_id, true) }),
        ),
    ),
  );

  server.registerTool(
    'list_layouts',
    {
      title: 'List canvas layouts and caption styles',
      description:
        "Ready-made layouts (named slots for pictures, sometimes placeholder text) that suit this storyboard's frame (9:16 vertical, 16:9, 1:1, 4:5), and the caption styles for add_text_layer.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const opened = await requireStore().load();
      const size = canvasSizeOf({}, opened.project.manifest);
      return text({
        frame: size,
        layouts: layoutsFor(size.width, size.height).map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
          slots: l.slots.map((s) => s.name),
          texts: (l.texts ?? []).map((t) => t.name),
        })),
        caption_styles: CAPTION_STYLES.map((c) => ({ id: c.id, description: c.description })),
        text_positions: ['top', 'middle', 'bottom', 'lower-third'],
      });
    }),
  );

  server.registerTool(
    'apply_layout',
    {
      title: 'Apply a layout to a shot',
      description:
        'Arrange a shot with a ready-made layout (see list_layouts), e.g. "split" (top/bottom), "picture-in-picture", "caption-band", "two-up", "lower-third". Without variant_id a new canvas variant is made (and shown); images (asset IDs) fill the slots in order. With variant_id of a canvas variant its pictures are moved into the slots (largest first) and its text stays; with an image variant, that image goes into the first slot of a new canvas variant. Empty slots are placeholders the user sees in the editor (not in exports); fill them with fill_slot.',
      inputSchema: {
        shot_id: idString,
        layout: z.string().describe('Layout ID from list_layouts'),
        variant_id: z.string().optional(),
        images: z.array(z.string()).optional().describe('Asset IDs for the slots, in slot order'),
        name: z.string().optional().describe('Name of a new variant'),
        activate: z.boolean().optional(),
      },
    },
    tool(
      async (a: {
        shot_id: string;
        layout: string;
        variant_id?: string;
        images?: string[];
        name?: string;
        activate?: boolean;
      }) =>
        edit(
          (p) =>
            applyLayout(
              p,
              a.shot_id,
              a.layout,
              defined({
                variantId: a.variant_id,
                images: a.images,
                name: a.name,
                activate: a.activate,
              }),
            ),
          (r) => ({ variant_id: r['id'], shot: shotView(r.project, a.shot_id, true) }),
        ),
    ),
  );

  server.registerTool(
    'fill_slot',
    {
      title: 'Put a picture into a layout slot',
      description:
        'Fill an empty slot (or replace the picture in a slot) of a canvas variant with an image or video asset. slot = the slot layer ID or its name ("Top", "B-roll"). fit: cover (default, fills the slot and crops) or contain (shows the whole picture).',
      inputSchema: {
        shot_id: idString,
        variant_id: variantField,
        slot: z.string(),
        asset_id: idString,
        fit: z.enum(['cover', 'contain']).optional(),
      },
    },
    tool(
      async (a: {
        shot_id: string;
        variant_id?: string;
        slot: string;
        asset_id: string;
        fit?: 'cover' | 'contain';
      }) => {
        let vid = '';
        return edit(
          (p) => {
            vid = canvasFor(p, a.shot_id, a.variant_id).id;
            return { project: fillSlot(p, a.shot_id, vid, a.slot, a.asset_id, a.fit) };
          },
          (r) => ({ variant_id: vid, layers: layersView(r.project, a.shot_id, vid) }),
        );
      },
    ),
  );

  server.registerTool(
    'add_text_layer',
    {
      title: 'Add on-screen text (caption, hook, title)',
      description:
        'Add a text layer to a canvas variant in a caption style: bold (short-form captions: heavy white text with outline), boxed (dark text on white boxes), lower-third (name/title on a dark band), title (big capitals), subtitle (plain white with shadow). position: top, middle, bottom (above the TikTok/Reels/Shorts buttons on vertical frames) or lower-third; or give x/y/width in canvas px. Any text attribute (font, font_size, color, align, stroke, shadow, box) overrides the style. If the shot shows a single image, first make it a layout with apply_layout.',
      inputSchema: {
        shot_id: idString,
        variant_id: variantField,
        text: z.string(),
        style: z.enum(['bold', 'boxed', 'lower-third', 'title', 'subtitle']).optional(),
        position: z.enum(['top', 'middle', 'bottom', 'lower-third']).optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().positive().optional(),
        rotation: z.number().optional(),
        ...textStyleFields,
      },
    },
    tool(
      async ({
        shot_id,
        variant_id,
        ...rest
      }: { shot_id: string; variant_id?: string; text: string } & Record<string, unknown>) => {
        let vid = '';
        return edit(
          (p) => {
            const v = canvasFor(p, shot_id, variant_id);
            vid = v.id;
            const input = textLayerInput(defined(rest) as never, canvasSizeOf(v, p.manifest));
            return addLayer(p, shot_id, vid, input);
          },
          (r) => ({
            variant_id: vid,
            layer: layersView(r.project, shot_id, vid).find((l) => l.id === r['id']),
          }),
        );
      },
    ),
  );

  server.registerTool(
    'add_layer',
    {
      title: 'Add a layer to a canvas variant',
      description:
        'Add one layer on top (or at index, 0 = bottom): an image layer (asset, x, y, width, height, scale_x, scale_y, rotation, opacity, crop, filters), a text layer (kind "text", text, …; add_text_layer is easier) or an empty slot (kind "slot", name, x, y, width, height). Canvas px.',
      inputSchema: {
        shot_id: idString,
        variant_id: variantField,
        layer: layerSchema,
        index: z.number().int().min(0).optional(),
      },
    },
    tool(
      async (a: {
        shot_id: string;
        variant_id?: string;
        layer: Partial<Layer>;
        index?: number;
      }) => {
        let vid = '';
        return edit(
          (p) => {
            vid = canvasFor(p, a.shot_id, a.variant_id).id;
            return addLayer(
              p,
              a.shot_id,
              vid,
              a.layer as never,
              a.index === undefined ? {} : { index: a.index },
            );
          },
          (r) => ({
            variant_id: vid,
            layer_id: r['id'],
            layers: layersView(r.project, a.shot_id, vid),
          }),
        );
      },
    ),
  );

  server.registerTool(
    'update_layer',
    {
      title: 'Change a layer',
      description:
        'Change attributes of one layer of a canvas variant (position, size, rotation, opacity, crop, filters, text and text style, visible, locked, group, name). null removes a value. To move a layer in the stacking order give index (0 = bottom).',
      inputSchema: {
        shot_id: idString,
        variant_id: variantField,
        layer_id: idString,
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            'Attributes to set, same names as in add_layer (x, y, width, text, color, stroke…); null removes one',
          ),
        index: z.number().int().min(0).optional(),
      },
    },
    tool(
      async (a: {
        shot_id: string;
        variant_id?: string;
        layer_id: string;
        changes: Record<string, unknown>;
        index?: number;
      }) => {
        let vid = '';
        return edit(
          (p) => {
            vid = canvasFor(p, a.shot_id, a.variant_id).id;
            let next = updateLayers(p, a.shot_id, vid, { [a.layer_id]: a.changes as never });
            if (a.index !== undefined) next = moveLayer(next, a.shot_id, vid, a.layer_id, a.index);
            return { project: next };
          },
          (r) => ({ variant_id: vid, layers: layersView(r.project, a.shot_id, vid) }),
        );
      },
    ),
  );

  server.registerTool(
    'remove_layer',
    {
      title: 'Remove layers',
      description: 'Delete one or more layers from a canvas variant (the assets stay).',
      inputSchema: {
        shot_id: idString,
        variant_id: variantField,
        layer_ids: z.array(idString).min(1),
      },
      annotations: { destructiveHint: true },
    },
    tool(async (a: { shot_id: string; variant_id?: string; layer_ids: string[] }) => {
      let vid = '';
      return edit(
        (p) => {
          vid = canvasFor(p, a.shot_id, a.variant_id).id;
          return { project: removeLayers(p, a.shot_id, vid, a.layer_ids) };
        },
        (r) => ({ variant_id: vid, layers: layersView(r.project, a.shot_id, vid) }),
      );
    }),
  );

  server.registerTool(
    'set_active_variant',
    {
      title: 'Choose the variant a shot shows',
      description: "Make one of the shot's variants the active (default) one.",
      inputSchema: { shot_id: idString, variant_id: idString },
    },
    tool(async (a: { shot_id: string; variant_id: string }) =>
      edit(
        (p) => ({ project: setActiveVariant(p, a.shot_id, a.variant_id) }),
        () => ({ shot_id: a.shot_id, active_variant: a.variant_id }),
      ),
    ),
  );

  server.registerTool(
    'remove_variant',
    {
      title: 'Remove a variant',
      description: 'Delete one variant from a shot (the asset itself stays).',
      inputSchema: { shot_id: idString, variant_id: idString },
      annotations: { destructiveHint: true },
    },
    tool(async (a: { shot_id: string; variant_id: string }) =>
      edit(
        (p) => ({ project: removeVariant(p, a.shot_id, a.variant_id) }),
        (r) => ({ shot: shotView(r.project, a.shot_id, false) }),
      ),
    ),
  );

  server.registerTool(
    'add_cue',
    {
      title: 'Attach audio/video timing',
      description: [
        'Play (part of) an audio or video asset against the story. Give exactly one target: line_id (e.g. a dialogue line), shot_id, range [from_line, to_line] or global_start (seconds, for background music).',
        'in/out trim the media in seconds, so one long recording can be split into many cues (one per line).',
        'Use track to group cues (dialogue, music, sfx) so viewers can mute groups. Line cues also set how long that line lasts in the animatic.',
      ].join(' '),
      inputSchema: { asset_id: idString, id: z.string().optional(), ...targetFields, ...cueFields },
    },
    tool(async (a: { asset_id: string; id?: string } & Record<string, unknown>) =>
      edit(
        (p) => {
          const target = targetFrom(a as never);
          if (!target)
            throw new Error('A target is required: line_id, shot_id, range or global_start');
          const cue = {
            ...defined({
              id: a.id,
              in: a['in'],
              out: a['out'],
              offset: a['offset'],
              gain: a['gain'],
              track: a['track'],
              loop: a['loop'],
              fade_in: a['fade_in'],
              fade_out: a['fade_out'],
              label: a['label'],
            }),
            asset: a.asset_id,
            target,
          } as CueInput;
          return addCue(p, cue);
        },
        (r) => ({ cue: r.project.timeline.cues.find((c) => c.id === r['id']) }),
      ),
    ),
  );

  server.registerTool(
    'update_cue',
    {
      title: 'Update a cue',
      description:
        "Change a cue's trim (in/out), target, offset, gain, track, loop or fades. Pass a new target (line_id, shot_id, range or global_start) to move it. null removes optional values.",
      inputSchema: {
        cue_id: idString,
        asset_id: z.string().optional(),
        ...targetFields,
        ...Object.fromEntries(Object.entries(cueFields).map(([k, v]) => [k, v.nullable()])),
      },
    },
    tool(async (a: { cue_id: string; asset_id?: string } & Record<string, unknown>) =>
      edit(
        (p) => {
          const target = targetFrom(a as never);
          const patch: Record<string, unknown> = {};
          for (const k of Object.keys(cueFields)) if (a[k] !== undefined) patch[k] = a[k];
          if (a.asset_id) patch['asset'] = a.asset_id;
          if (target) patch['target'] = target;
          return { project: updateCue(p, a.cue_id, patch) };
        },
        (r) => ({ cue: r.project.timeline.cues.find((c) => c.id === a.cue_id) }),
      ),
    ),
  );

  server.registerTool(
    'remove_cue',
    {
      title: 'Remove a cue',
      description: 'Delete a timing cue (the asset stays).',
      inputSchema: { cue_id: idString },
      annotations: { destructiveHint: true },
    },
    tool(async (a: { cue_id: string }) =>
      edit(
        (p) => ({ project: removeCue(p, a.cue_id) }),
        () => ({ removed: a.cue_id }),
      ),
    ),
  );

  server.registerTool(
    'validate',
    {
      title: 'Check the storyboard',
      description:
        'Run all checks (schema, missing assets/lines/media files, non-browser-friendly media) and list problems. errors must be fixed; warnings are advice; info is FYI.',
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const { issues } = await requireStore().load();
      return text({ valid: !issues.some((i) => i.severity === 'error'), issues });
    }),
  );

  server.registerTool(
    'get_viewer_url',
    {
      title: 'Viewer link',
      description:
        'The localhost URL of the Storyboard Viewer showing this storyboard (open it in the in-app browser next to the chat). It refreshes automatically after every edit. When the viewer listens on the network (--host 0.0.0.0), network_urls are links that work from a phone on the same network or tailnet.',
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const s = requireStore();
      if (viewer)
        return text({
          url: viewer.url,
          // a phone or another computer opens one of these (the viewer listens on the network)
          ...(viewer.networkUrls.length ? { network_urls: viewer.networkUrls } : {}),
        });
      const found = await findViewer(s.path);
      if (found) return text({ url: found });
      return text({
        url: null,
        how_to_start: `No viewer is running for this storyboard. Ask the user to run: sbd serve "${s.path}" (or start this MCP server with --serve).`,
      });
    }),
  );

  if (opts.path) await openStore(opts.path);

  return {
    server,
    store: () => store,
    viewer: () => viewer,
    close: async () => {
      if (viewer) await viewer.close();
      viewer = null;
      await server.close();
    },
  };
}
