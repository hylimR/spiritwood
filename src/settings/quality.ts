import type { GpuInfo, QualityLevel, QualitySettings, UserSettings } from '../contracts/quality.ts';
import { todo } from '../core/todo.ts';

/** Preset values per ARCHITECTURE.md §5.7 (fpsCap/dynamicResolution are overridden by UserSettings). */
export const QUALITY_PRESETS: Readonly<Record<QualityLevel, Readonly<QualitySettings>>> = Object.freeze({
  high: Object.freeze({
    level: 'high', pixelRatioCap: 1.5, renderScale: 1, minRenderScale: 0.7, maxRenderPixels: 2560 * 1440,
    dynamicResolution: true, bloom: true, bloomScale: 0.5, bloomPasses: 4, layerBudget: 10,
    particleDensity: 1, lightShafts: true, foliageSway: true, fogBands: 2, fpsCap: 60,
  }),
  medium: Object.freeze({
    level: 'medium', pixelRatioCap: 1, renderScale: 0.9, minRenderScale: 0.6, maxRenderPixels: 1600 * 900,
    dynamicResolution: true, bloom: true, bloomScale: 0.5, bloomPasses: 3, layerBudget: 8,
    particleDensity: 0.65, lightShafts: true, foliageSway: true, fogBands: 2, fpsCap: 60,
  }),
  low: Object.freeze({
    level: 'low', pixelRatioCap: 1, renderScale: 0.75, minRenderScale: 0.5, maxRenderPixels: 1280 * 720,
    dynamicResolution: true, bloom: true, bloomScale: 0.25, bloomPasses: 2, layerBudget: 6,
    particleDensity: 0.35, lightShafts: true, foliageSway: false, fogBands: 1, fpsCap: 60,
  }),
}) as Readonly<Record<QualityLevel, Readonly<QualitySettings>>>;

/** Classify from the (unmasked) renderer/vendor strings. */
export function classifyGpu(renderer: string, vendor: string): GpuInfo['tier'] {
  void renderer; void vendor;
  return todo('PIPE', 'classifyGpu');
}

/**
 * Resolve user settings + GPU into concrete quality. auto: integrated/unknown → high features with
 * pixelRatioCap 1 and dynamic resolution; discrete → high; software → low. Explicit presets use the
 * table. A non-null user pixelRatioCap overrides; fpsCap and dynamicResolution come from settings.
 */
export function resolveQuality(settings: UserSettings, gpu: GpuInfo): QualitySettings {
  void settings; void gpu;
  return todo('PIPE', 'resolveQuality');
}
