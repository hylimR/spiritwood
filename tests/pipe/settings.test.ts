import { describe, expect, test } from 'vitest';
import type { GpuInfo, QualityPreset, UserSettings } from '../../src/contracts/quality.ts';
import { STORAGE_KEY } from '../../src/config.ts';
import { classifyGpu, describeQuality, QUALITY_PRESETS, resolveQuality } from '../../src/settings/quality.ts';
import {
  applyUrlOverrides, DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings,
} from '../../src/settings/store.ts';
import { stepOption } from '../../src/ui/menu.ts';

const GPU_TABLE: [string, string, GpuInfo['tier']][] = [
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)', 'integrated'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)', 'integrated'],
  ['Mesa Intel(R) Xe Graphics (TGL GT2)', 'Intel', 'integrated'],
  ['Intel Iris OpenGL Engine', 'Intel Inc.', 'integrated'],
  ['ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)', 'integrated'],
  ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)', 'discrete'],
  ['ANGLE (Intel, Intel(R) Arc(TM) A370M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)', 'discrete'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (NVIDIA)', 'discrete'],
  ['NVIDIA GeForce GTX 1060 6GB/PCIe/SSE2', 'NVIDIA Corporation', 'discrete'],
  ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (AMD)', 'integrated'],
  ['ANGLE (AMD, AMD Radeon RX Vega 10 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (AMD)', 'integrated'],
  ['AMD Radeon 780M Graphics', 'AMD', 'integrated'],
  ['ANGLE (AMD, Radeon RX Vega 56 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (AMD)', 'discrete'],
  ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (AMD)', 'discrete'],
  ['AMD Radeon Pro 5500M OpenGL Engine', 'ATI Technologies Inc.', 'discrete'],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'Google Inc. (Google)', 'software'],
  ['llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa/X.org', 'software'],
  ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Microsoft)', 'software'],
  ['Apple M1 Pro', 'Apple Inc.', 'unknown'],
  ['WebKit WebGL', 'WebKit', 'unknown'],
  ['Adreno (TM) 730', 'Qualcomm', 'unknown'],
];

function gpu(tier: GpuInfo['tier']): GpuInfo {
  return { renderer: 'test', vendor: 'test', tier, maxTextureSize: 16384, timerQuery: true };
}

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

class FakeStorage implements Storage {
  readonly map = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    if (this.throwOnGet) throw new Error('SecurityError');
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
}

describe('classifyGpu', () => {
  test.each(GPU_TABLE)('%s → %s', (renderer, vendor, tier) => {
    expect(classifyGpu(renderer, vendor)).toBe(tier);
  });
});

describe('resolveQuality', () => {
  const tiers: GpuInfo['tier'][] = ['discrete', 'integrated', 'software', 'unknown'];
  const presets: QualityPreset[] = ['auto', 'high', 'medium', 'low'];

  test('auto maps tiers per §5.7', () => {
    expect(resolveQuality(settings(), gpu('discrete'))).toEqual({ ...QUALITY_PRESETS.high });
    expect(resolveQuality(settings(), gpu('integrated'))).toEqual({ ...QUALITY_PRESETS.high, pixelRatioCap: 1 });
    expect(resolveQuality(settings(), gpu('unknown'))).toEqual({ ...QUALITY_PRESETS.high, pixelRatioCap: 1 });
    expect(resolveQuality(settings(), gpu('software'))).toEqual({ ...QUALITY_PRESETS.low });
  });

  test('explicit presets ignore the GPU tier', () => {
    for (const preset of presets) {
      if (preset === 'auto') continue;
      for (const tier of tiers) {
        expect(resolveQuality(settings({ preset }), gpu(tier))).toEqual({ ...QUALITY_PRESETS[preset] });
      }
    }
  });

  test('user overrides: pixel ratio, fps cap, dynamic resolution', () => {
    for (const preset of presets) {
      for (const tier of tiers) {
        const q = resolveQuality(settings({ preset, pixelRatioCap: 2, fpsCap: 0, dynamicResolution: false }), gpu(tier));
        expect(q.pixelRatioCap).toBe(2);
        expect(q.fpsCap).toBe(0);
        expect(q.dynamicResolution).toBe(false);
      }
    }
  });

  test('returns a fresh mutable object, never a frozen preset', () => {
    const q = resolveQuality(settings({ preset: 'high' }), gpu('discrete'));
    expect(Object.isFrozen(q)).toBe(false);
    expect(q).not.toBe(QUALITY_PRESETS.high);
  });

  test('presets match the §5.7 table', () => {
    expect(QUALITY_PRESETS.low).toMatchObject({ pixelRatioCap: 1, renderScale: 0.75, minRenderScale: 0.5, maxRenderPixels: 1280 * 720, layerBudget: 6, bloomScale: 0.25, bloomPasses: 2, foliageSway: false, fogBands: 1 });
    expect(QUALITY_PRESETS.medium).toMatchObject({ pixelRatioCap: 1, renderScale: 0.9, minRenderScale: 0.6, maxRenderPixels: 1600 * 900, layerBudget: 8, bloomScale: 0.5, bloomPasses: 3 });
    expect(QUALITY_PRESETS.high).toMatchObject({ pixelRatioCap: 1.5, renderScale: 1, minRenderScale: 0.7, maxRenderPixels: 2560 * 1440, layerBudget: 10, bloomScale: 0.5, bloomPasses: 4 });
  });

  test('describeQuality labels auto', () => {
    const s = settings();
    expect(describeQuality(s, resolveQuality(s, gpu('integrated')))).toBe('auto → high (1×, dynamic)');
    const m = settings({ preset: 'medium', dynamicResolution: false });
    expect(describeQuality(m, resolveQuality(m, gpu('integrated')))).toBe('medium (1×)');
  });
});

describe('settings store', () => {
  test('missing key → defaults', () => {
    expect(loadSettings(new FakeStorage())).toEqual(DEFAULT_SETTINGS);
  });

  test('null storage → defaults, save is a no-op', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(settings({ preset: 'low' }), null)).not.toThrow();
  });

  test('round trip', () => {
    const s = new FakeStorage();
    const value = settings({ preset: 'medium', pixelRatioCap: 1.25, fpsCap: 0, dynamicResolution: false, debugOverlay: true });
    saveSettings(value, s);
    expect(s.map.has(STORAGE_KEY)).toBe(true);
    expect(loadSettings(s)).toEqual(value);
  });

  test('corrupt JSON → defaults', () => {
    const s = new FakeStorage();
    s.map.set(STORAGE_KEY, '{not json');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    s.map.set(STORAGE_KEY, '"a string"');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    s.map.set(STORAGE_KEY, '[1,2]');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    s.map.set(STORAGE_KEY, 'null');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
  });

  test('partial and invalid fields fall back field by field', () => {
    const s = new FakeStorage();
    s.map.set(STORAGE_KEY, JSON.stringify({ preset: 'low', fpsCap: 30, pixelRatioCap: 'big', debugOverlay: true, extra: 1 }));
    expect(loadSettings(s)).toEqual({ ...DEFAULT_SETTINGS, preset: 'low', debugOverlay: true });
    s.map.set(STORAGE_KEY, JSON.stringify({ preset: 'ultra', pixelRatioCap: 9, dynamicResolution: 'yes', fpsCap: 0 }));
    expect(loadSettings(s)).toEqual({ ...DEFAULT_SETTINGS, fpsCap: 0 });
    s.map.set(STORAGE_KEY, JSON.stringify({ pixelRatioCap: null }));
    expect(loadSettings(s).pixelRatioCap).toBeNull();
    s.map.set(STORAGE_KEY, JSON.stringify({ pixelRatioCap: Number.NaN }));
    expect(loadSettings(s).pixelRatioCap).toBeNull();
  });

  test('throwing storage never throws', () => {
    const s = new FakeStorage();
    s.throwOnGet = true;
    s.throwOnSet = true;
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(settings({ preset: 'high' }), s)).not.toThrow();
  });

  test('loaded settings are fresh objects', () => {
    const a = loadSettings(null);
    a.preset = 'low';
    expect(DEFAULT_SETTINGS.preset).toBe('auto');
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('URL overrides', () => {
  test('each flag', () => {
    const base = settings();
    expect(applyUrlOverrides(base, '?quality=low').preset).toBe('low');
    expect(applyUrlOverrides(base, '?quality=HIGH').preset).toBe('high');
    expect(applyUrlOverrides(base, '?fps=0').fpsCap).toBe(0);
    expect(applyUrlOverrides(settings({ fpsCap: 0 }), '?fps=60').fpsCap).toBe(60);
    expect(applyUrlOverrides(base, '?dpr=1.5').pixelRatioCap).toBe(1.5);
    expect(applyUrlOverrides(base, '?dynres=0').dynamicResolution).toBe(false);
    expect(applyUrlOverrides(settings({ dynamicResolution: false }), '?dynres=1').dynamicResolution).toBe(true);
    expect(applyUrlOverrides(base, '?debug=1').debugOverlay).toBe(true);
    expect(applyUrlOverrides(base, '?debug').debugOverlay).toBe(true);
    expect(applyUrlOverrides(settings({ debugOverlay: true }), '?debug=0').debugOverlay).toBe(false);
  });

  test('combined, without the leading ?', () => {
    expect(applyUrlOverrides(settings(), 'quality=medium&fps=0&dpr=2&dynres=0&debug=1')).toEqual({
      preset: 'medium', pixelRatioCap: 2, fpsCap: 0, dynamicResolution: false, debugOverlay: true,
    });
  });

  test('invalid values are ignored and the input is not mutated', () => {
    const base = settings({ preset: 'high', pixelRatioCap: 1.25 });
    const out = applyUrlOverrides(base, '?quality=ultra&fps=144&dpr=abc&dynres=maybe&bench');
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
    expect(applyUrlOverrides(base, '?dpr=').pixelRatioCap).toBe(1.25);
    expect(applyUrlOverrides(base, '?dpr=0').pixelRatioCap).toBe(1.25);
    expect(applyUrlOverrides(base, '?dpr=100').pixelRatioCap).toBe(1.25);
    expect(applyUrlOverrides(base, '')).toEqual(base);
  });
});

describe('menu option stepping', () => {
  const caps = [null, 1, 1.25, 1.5, 2] as const;

  test('listed values cycle and wrap both ways', () => {
    expect(stepOption(caps, 1.25, 1)).toBe(1.5);
    expect(stepOption(caps, 1.25, -1)).toBe(1);
    expect(stepOption(caps, 2, 1)).toBe(null);
    expect(stepOption(caps, null, -1)).toBe(2);
    expect(stepOption(['auto', 'high', 'medium', 'low'], 'low', 1)).toBe('auto');
  });

  test('an off-list override steps to the nearest listed value in that direction', () => {
    expect(stepOption(caps, 1.75, 1)).toBe(2);
    expect(stepOption(caps, 1.75, -1)).toBe(1.5);
    expect(stepOption(caps, 1.1, -1)).toBe(1);
    expect(stepOption(caps, 1.1, 1)).toBe(1.25);
    // Beyond the listed range: wrap like the end of the list.
    expect(stepOption(caps, 3, 1)).toBe(null);
    expect(stepOption(caps, 3, -1)).toBe(2);
    expect(stepOption(caps, 0.5, -1)).toBe(2);
    expect(stepOption(caps, 0.5, 1)).toBe(1);
  });
});
