import { GlProgram, Shader, UniformGroup, type TextureSource } from 'pixi.js';
import { KIT_FRAGMENT, KIT_VERTEX } from './kit.glsl.ts';
import type { KitMode, KitShadeParams } from './kitShading.ts';

let program: GlProgram | null = null;

/** The shared kit program (Pixi caches GlPrograms by source; every kit shader uses this one). */
export function kitProgram(): GlProgram {
  program ??= GlProgram.from({ vertex: KIT_VERTEX, fragment: KIT_FRAGMENT, name: 'sw-kit', preferredFragmentPrecision: 'highp' });
  return program;
}

function vec3(v: readonly number[]): Float32Array {
  return new Float32Array([v[0] as number, v[1] as number, v[2] as number]);
}

export function createKitLayerUniforms(p: KitShadeParams) {
  return new UniformGroup({
    uTime: { value: 0, type: 'f32' },
    uSway: { value: 0, type: 'f32' },
    uTint: { value: vec3(p.tint), type: 'vec3<f32>' },
    uFogColor: { value: vec3(p.fogColor), type: 'vec3<f32>' },
    uMistColor: { value: vec3(p.mistColor ?? p.fogColor), type: 'vec3<f32>' },
    uRimColor: { value: vec3(p.rimColor), type: 'vec3<f32>' },
    uFog: { value: p.fog, type: 'f32' },
    uDesat: { value: p.desaturate, type: 'f32' },
    uRim: { value: p.rim, type: 'f32' },
    uGlow: { value: p.glow, type: 'f32' },
    uMistY: { value: p.mistY, type: 'f32' },
    uMistDepth: { value: p.mistDepth, type: 'f32' },
    uMist: { value: p.mist, type: 'f32' },
  });
}
export type KitLayerUniforms = ReturnType<typeof createKitLayerUniforms>;

/**
 * A kit shader: shared program, the texture, the layer's uniform group (shared between its core,
 * band and twin shaders) and a per-pass group. Every kit shader declares the same resources in the
 * same order, as Pixi caches the resource sync per program.
 */
export function createKitShader(texture: TextureSource, layer: KitLayerUniforms, mode: KitMode, straightAlpha = false): Shader {
  return new Shader({
    glProgram: kitProgram(),
    resources: {
      uTexture: texture,
      kitLayer: layer,
      kitPass: new UniformGroup({
        uMode: { value: mode, type: 'f32' },
        uStraight: { value: straightAlpha ? 1 : 0, type: 'f32' },
      }),
    },
  });
}
