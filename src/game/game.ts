import { GAME_TITLE, SIM_DT } from '../config.ts';
import { createInputFrame, type InputFrame } from '../contracts/input.ts';
import type { UserSettings } from '../contracts/quality.ts';
import { AudioSystem } from '../audio/audio.ts';
import type { FetchFn } from '../assets/embedded.ts';
import { loadManifest } from '../assets/manifest.ts';
import { FixedStepLoop } from '../core/loop.ts';
import { BenchRunner, type BenchWaypoint } from '../debug/bench.ts';
import { FrameTimer } from '../debug/frameTimer.ts';
import { DebugOverlay } from '../debug/overlay.ts';
import { InputManager } from '../input/input.ts';
import { loadLevel } from '../level/loader.ts';
import { createPipeViews } from '../render/pipeViews.ts';
import { RenderPipeline } from '../render/pipeline.ts';
import { createWorldViews } from '../render/world.ts';
import { applyUrlOverrides, loadSettings, saveSettings } from '../settings/store.ts';
import { GameWorld } from '../sim/world.ts';
import { Hud } from '../ui/hud.ts';
import { SettingsMenu } from '../ui/menu.ts';

export interface GameOptions {
  gameRoot: HTMLElement;
  uiRoot: HTMLElement;
  levelUrl: string;
  manifestUrl: string;
  search: string;
  /** Fetch for the level and manifest (the single-file build answers them from embedded data). */
  fetchFn?: FetchFn;
}

type Phase = 'title' | 'play' | 'bench';

const STATS_REFRESH_SEC = 0.25;

/** Fields of `next` that differ from `prev`, applied onto `base` (URL overrides stay unpersisted). */
function applyChanges(base: UserSettings, prev: UserSettings, next: UserSettings): UserSettings {
  const out: UserSettings = { ...base };
  if (next.preset !== prev.preset) out.preset = next.preset;
  if (next.pixelRatioCap !== prev.pixelRatioCap) out.pixelRatioCap = next.pixelRatioCap;
  if (next.fpsCap !== prev.fpsCap) out.fpsCap = next.fpsCap;
  if (next.dynamicResolution !== prev.dynamicResolution) out.dynamicResolution = next.dynamicResolution;
  if (next.debugOverlay !== prev.debugOverlay) out.debugOverlay = next.debugOverlay;
  return out;
}

/**
 * Orchestrator: wires loop → input → sim → render/HUD/audio. Owns no gameplay or rendering logic
 * itself (ARCHITECTURE.md §3).
 */
export class Game {
  readonly world: GameWorld;
  readonly pipeline: RenderPipeline;
  readonly input: InputManager;
  readonly loop: FixedStepLoop;
  /** Effective settings (persisted + one-off URL overrides). */
  settings: UserSettings;

  private persisted: UserSettings;
  private readonly hud: Hud;
  private readonly menu: SettingsMenu;
  private readonly overlay: DebugOverlay;
  private readonly frameTimer = new FrameTimer();
  private readonly audio = new AudioSystem();
  private readonly tickInput: InputFrame = createInputFrame();
  private readonly emptyInput: InputFrame = createInputFrame();
  private readonly benchPos: BenchWaypoint = { x: 0, y: 0 };
  private readonly bench: BenchRunner | null;
  private readonly resizeObserver: ResizeObserver;
  private readonly gameRoot: HTMLElement;
  private dprQuery: MediaQueryList | null = null;
  private phase: Phase;
  private debugDraw = false;
  private completeShown = false;
  private benchRunning = false;
  private benchTicks = 0;
  private statsRefreshedAt = -Infinity;
  private stepsThisFrame = 0;
  private simMsThisFrame = 0;

  private constructor(
    opts: GameOptions,
    persisted: UserSettings,
    settings: UserSettings,
    world: GameWorld,
    pipeline: RenderPipeline,
  ) {
    this.gameRoot = opts.gameRoot;
    this.persisted = persisted;
    this.settings = settings;
    this.world = world;
    this.pipeline = pipeline;
    this.input = new InputManager({ target: window });
    this.hud = new Hud(opts.uiRoot);
    this.overlay = new DebugOverlay(opts.uiRoot);
    this.overlay.setVisible(settings.debugOverlay);
    this.menu = new SettingsMenu(
      opts.uiRoot,
      settings,
      (s) => this.applySettings(s),
      () => this.closeMenu(),
      () => this.restart(),
    );
    this.menu.setGpuLabel(pipeline.gpu.renderer);

    const params = new URLSearchParams(opts.search);
    this.bench = params.has('bench') ? new BenchRunner(world.level, Number(params.get('bench')) || 30) : null;
    this.benchRunning = this.bench !== null;
    this.phase = this.bench ? 'bench' : 'title';
    this.hud.showTitle(this.phase === 'title');

    this.loop = new FixedStepLoop(
      {
        beginFrame: () => this.beginFrame(),
        step: () => this.step(),
        render: (alpha, frameDt, now, late) => this.render(alpha, frameDt, now, late),
      },
      { fpsCap: pipeline.quality.fpsCap },
    );

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(opts.gameRoot);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.watchDpr();
    this.resize();
  }

  static async boot(opts: GameOptions): Promise<Game> {
    document.title = GAME_TITLE;
    const persisted = loadSettings();
    const settings = applyUrlOverrides(persisted, opts.search);
    const fetchFn = opts.fetchFn ?? fetch;
    const [level, manifest] = await Promise.all([
      loadLevel(opts.levelUrl, undefined, fetchFn),
      loadManifest(opts.manifestUrl, fetchFn),
    ]);

    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    opts.gameRoot.appendChild(canvas);
    const pipeline = await RenderPipeline.create({
      canvas,
      level,
      manifest,
      manifestUrl: new URL(opts.manifestUrl, document.baseURI).href,
      settings,
    });
    const rect = opts.gameRoot.getBoundingClientRect();
    pipeline.resize(rect.width, rect.height, window.devicePixelRatio || 1);

    const world = new GameWorld(level, { viewW: pipeline.viewW, viewH: pipeline.viewH });
    for (const view of createWorldViews()) await pipeline.addView(view);
    for (const view of createPipeViews()) await pipeline.addView(view);

    const game = new Game(opts, persisted, settings, world, pipeline);
    game.loop.start();
    canvas.focus();
    return game;
  }

  private resize(): void {
    const rect = this.gameRoot.getBoundingClientRect();
    this.pipeline.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    this.world.setViewSize(this.pipeline.viewW, this.pipeline.viewH);
  }

  /** ResizeObserver misses pure devicePixelRatio changes (moving between monitors). */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private readonly onDprChange = (): void => {
    this.watchDpr();
    this.resize();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.loop.resetClock();
  };

  private beginFrame(): void {
    this.input.beginFrame();
    const meta = this.input.meta;
    this.stepsThisFrame = 0;
    this.simMsThisFrame = 0;

    if (meta.debugOverlayPressed) {
      this.applySettings({ ...this.settings, debugOverlay: !this.settings.debugOverlay });
    }
    if (meta.debugDrawPressed) {
      this.debugDraw = !this.debugDraw;
      this.pipeline.setDebugDraw(this.debugDraw);
    }

    if (this.menu.isOpen) {
      if (meta.pausePressed || meta.backPressed) this.closeMenu();
      else this.menu.navigate(meta);
      return;
    }
    if (meta.pausePressed && this.phase !== 'bench') {
      this.menu.open();
      this.loop.setPaused(true);
      return;
    }
    if (this.phase === 'title') {
      if (meta.anyPressed) {
        this.phase = 'play';
        this.hud.showTitle(false);
        this.hud.showControls(this.input.lastDevice);
        this.audio.unlock();
        this.input.clearEdges();
      }
      return;
    }
    if (meta.respawnPressed && this.phase === 'play') this.world.respawn();
  }

  private step(): void {
    const t0 = performance.now();
    if (this.phase === 'play') {
      this.world.step(this.input.nextTick(this.tickInput));
    } else if (this.phase === 'bench') {
      if (this.bench && this.benchRunning) {
        this.bench.positionAt(this.benchTicks * SIM_DT, this.benchPos);
        this.world.camera.setOverride(this.benchPos.x, this.benchPos.y);
        this.benchTicks++;
      }
      this.world.step(this.emptyInput);
    }
    // Title: the world stays frozen (render-side animation still runs on the render clock).
    this.stepsThisFrame++;
    this.simMsThisFrame += performance.now() - t0;
  }

  private render(alpha: number, frameDt: number, now: number, lateFrames: number): void {
    const t0 = performance.now();
    this.pipeline.render(this.world, alpha, now, frameDt, lateFrames);

    const events = this.world.events;
    for (let i = 0; i < events.count; i++) this.audio.onSimEvent(events.get(i));
    events.clear();

    if (this.world.completed && !this.completeShown) {
      this.completeShown = true;
      this.hud.showComplete(this.world.elapsed, this.world.orbsCollected, this.world.orbsTotal);
    }
    this.hud.update(this.world, now);

    const renderMs = performance.now() - t0;
    const frameMs = frameDt * 1000;
    this.frameTimer.frame(frameMs, lateFrames, this.stepsThisFrame, this.simMsThisFrame, renderMs);
    if (this.overlay.visible) {
      if (now - this.statsRefreshedAt >= STATS_REFRESH_SEC) {
        this.frameTimer.refresh();
        this.statsRefreshedAt = now;
      }
      this.overlay.update(
        this.frameTimer.stats, this.pipeline.stats, this.world, this.pipeline.quality.level, now, frameMs,
      );
    }

    if (this.bench && this.benchRunning) {
      this.bench.record(frameMs, lateFrames, this.pipeline.stats.renderScale, this.pipeline.stats.gpuMs);
      if (this.bench.done) {
        this.benchRunning = false;
        this.world.camera.clearOverride();
        const result = this.bench.result(this.settings.preset, this.pipeline.gpu.renderer, navigator.userAgent);
        this.hud.showBench(result);
        console.info('[bench]', JSON.stringify(result));
      }
    }
  }

  private applySettings(next: UserSettings): void {
    this.persisted = applyChanges(this.persisted, this.settings, next);
    this.settings = next;
    saveSettings(this.persisted);
    this.pipeline.applySettings(next);
    this.loop.setFpsCap(this.pipeline.quality.fpsCap);
    this.overlay.setVisible(next.debugOverlay);
    this.menu.setSettings(next);
  }

  private closeMenu(): void {
    this.menu.close();
    this.input.clearEdges();
    this.loop.setPaused(false);
    this.loop.resetClock();
  }

  private restart(): void {
    this.closeMenu();
    this.world.reset();
    this.hud.hideComplete();
    this.completeShown = false;
  }

  destroy(): void {
    this.loop.stop();
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input.destroy();
    this.hud.destroy();
    this.menu.destroy();
    this.overlay.destroy();
    this.audio.destroy();
    this.pipeline.destroy();
  }
}
