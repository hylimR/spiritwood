import type { FrameStats, RenderStats } from '../contracts/debug.ts';
import type { SimView } from '../contracts/sim.ts';
import { el, ensureUiStyles } from '../ui/styles.ts';

const TEXT_INTERVAL = 0.25;
const GRAPH_W = 240;
const GRAPH_H = 44;
/** Frame time (ms) at the top of the graph. */
const GRAPH_MAX_MS = 50;
const BUDGET_MS = 1000 / 60;
const COLOR_OK = '#3fe0c5';
const COLOR_WARN = '#ffb45a';
const COLOR_BAD = '#ff4d6d';
const COLOR_GUIDE = 'rgba(216, 243, 255, 0.28)';

function f1(v: number): string {
  return v.toFixed(1);
}

/**
 * F3 debug overlay as a DOM panel (no Pixi text): fps avg / 1% low, frame/sim/render ms, GPU ms,
 * draw calls, fill estimate, render scale + RT size, canvas size, particles, texture MB, quality level,
 * player mode/velocity/grounded/wall, camera, tick. Includes a small canvas-2D frame-time graph.
 * DOM text updates at most 4 Hz; the graph may update every frame from a ring buffer.
 */
export class DebugOverlay {
  private readonly root: HTMLDivElement;
  private readonly text: HTMLPreElement;
  private readonly graph: HTMLCanvasElement;
  private readonly g2d: CanvasRenderingContext2D | null;
  private shown = false;
  private textAt = -Infinity;

  constructor(parent: HTMLElement) {
    const doc = parent.ownerDocument;
    ensureUiStyles(doc);
    this.root = el(doc, 'div', 'sw-debug sw-panel sw-hidden');
    this.root.style.pointerEvents = 'none';
    this.root.setAttribute('aria-hidden', 'true');
    this.text = el(doc, 'pre');
    this.graph = el(doc, 'canvas');
    this.graph.width = GRAPH_W;
    this.graph.height = GRAPH_H;
    this.g2d = this.graph.getContext('2d');
    this.root.append(this.text, this.graph);
    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.root.classList.toggle('sw-hidden', !visible);
    if (visible) this.textAt = -Infinity;
  }

  update(frame: FrameStats, render: RenderStats, sim: SimView, qualityLabel: string, nowSec: number, frameMs: number): void {
    if (!this.shown) return;
    this.plot(frameMs);
    if (nowSec - this.textAt < TEXT_INTERVAL) return;
    this.textAt = nowSec;
    const p = sim.player;
    const c = sim.camera;
    const gpu = render.gpuMs >= 0 ? `${render.gpuMs.toFixed(2)} ms` : 'n/a';
    this.text.textContent = [
      `fps ${f1(frame.fps)}  1% low ${f1(frame.frameMs1pLow > 0 ? 1000 / frame.frameMs1pLow : 0)}  late ${frame.lateFramePct.toFixed(2)}%`,
      `frame ${frame.frameMsAvg.toFixed(2)} ms  sim ${frame.simMs.toFixed(2)} ms ×${frame.simStepsLastFrame}  render ${frame.renderCpuMs.toFixed(2)} ms`,
      `gpu ${gpu}  draws ${render.drawCalls}  fill ${render.fillScreens.toFixed(2)}`,
      `rt ${render.rtWidth}×${render.rtHeight} @${render.renderScale.toFixed(2)}  canvas ${render.canvasWidth}×${render.canvasHeight}`,
      `quality ${qualityLabel}  particles ${render.particles}  tex ${f1(render.textureMB)} MB`,
      `player ${p.mode}${p.grounded ? ' grounded' : ''}${p.wallDir ? ` wall ${p.wallDir}` : ''}  v ${Math.round(p.vx)}, ${Math.round(p.vy)}`,
      `pos ${Math.round(p.x)}, ${Math.round(p.y)}  cam ${Math.round(c.x)}, ${Math.round(c.y)}  tick ${sim.tick}`,
    ].join('\n');
  }

  /** Scroll the graph one pixel and draw the newest frame time as a bar. */
  private plot(frameMs: number): void {
    const g = this.g2d;
    if (!g) return;
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.graph, -1, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(GRAPH_W - 1, 0, 1, GRAPH_H);
    const h = Math.min(GRAPH_H, (frameMs / GRAPH_MAX_MS) * GRAPH_H);
    g.fillStyle = frameMs <= BUDGET_MS * 1.05 ? COLOR_OK : frameMs <= BUDGET_MS * 2.05 ? COLOR_WARN : COLOR_BAD;
    g.fillRect(GRAPH_W - 1, GRAPH_H - h, 1, h);
    g.fillStyle = COLOR_GUIDE;
    g.fillRect(GRAPH_W - 1, GRAPH_H - (BUDGET_MS / GRAPH_MAX_MS) * GRAPH_H, 1, 1);
  }

  destroy(): void {
    this.root.remove();
  }
}
