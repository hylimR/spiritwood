import type { GpuInfo, QualityLevel, QualitySettings, UserSettings } from '../contracts/quality.ts';

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

const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/;
const NVIDIA = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla|titan/;
/** Arc A/B-series cards (A770, A370M, Pro A40, B580); "Arc Graphics" / "Arc 140V" are iGPUs. */
const INTEL_ARC_DISCRETE = /\barc(?:\(tm\))?\s*(?:pro\s*)?[ab]\d{2,3}m?\b/;
/** APUs: "Radeon(TM) Graphics", "Radeon R7 Graphics", "Radeon 780M", "Radeon Vega 8". */
const AMD_INTEGRATED = /radeon(?:\(tm\))?\s*(?:r\d\s*)?graphics|radeon(?:\(tm\))?\s*\d{3}m\b|\bvega\s*(?:[1-9]|1[01])\b/;
const AMD_DISCRETE = /\brx\s*(?:vega\s*)?\d{2,4}|radeon(?:\(tm\))?\s*(?:pro|r9|r7|r5|hd|vii)\b|\bfirepro\b|\bvega\s*(?:56|64)\b/;

/** Classify from the (unmasked) renderer/vendor strings. */
export function classifyGpu(renderer: string, vendor: string): GpuInfo['tier'] {
  const s = `${renderer} ${vendor}`.toLowerCase();
  if (SOFTWARE.test(s)) return 'software';
  if (NVIDIA.test(s)) return 'discrete';
  if (/intel/.test(s)) return INTEL_ARC_DISCRETE.test(s) ? 'discrete' : 'integrated';
  if (/\bamd\b|radeon|\bati\b/.test(s)) {
    if (AMD_INTEGRATED.test(s)) return 'integrated';
    if (AMD_DISCRETE.test(s)) return 'discrete';
  }
  return 'unknown';
}

/**
 * Resolve user settings + GPU into concrete quality. auto: integrated/unknown → high features with
 * pixelRatioCap 1 and dynamic resolution; discrete → high; software → low. Explicit presets use the
 * table. A non-null user pixelRatioCap overrides; fpsCap and dynamicResolution come from settings.
 */
export function resolveQuality(settings: UserSettings, gpu: GpuInfo): QualitySettings {
  let out: QualitySettings;
  if (settings.preset === 'auto') {
    if (gpu.tier === 'software') out = { ...QUALITY_PRESETS.low };
    else if (gpu.tier === 'discrete') out = { ...QUALITY_PRESETS.high };
    else out = { ...QUALITY_PRESETS.high, pixelRatioCap: 1 };
  } else {
    out = { ...QUALITY_PRESETS[settings.preset] };
  }
  if (settings.pixelRatioCap !== null) out.pixelRatioCap = settings.pixelRatioCap;
  out.fpsCap = settings.fpsCap;
  out.dynamicResolution = settings.dynamicResolution;
  return out;
}

/** Short human label for menus and the overlay, e.g. "auto → high (1×, dynamic)". */
export function describeQuality(settings: UserSettings, q: QualitySettings): string {
  const head = settings.preset === 'auto' ? `auto → ${q.level}` : q.level;
  return `${head} (${q.pixelRatioCap}×${q.dynamicResolution ? ', dynamic' : ''})`;
}
