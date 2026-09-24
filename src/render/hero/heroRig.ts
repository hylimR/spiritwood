import { PALETTE } from '../../config.ts';
import { bonesFromWorldRest, Skeleton, type WorldBoneDef } from './rig.ts';

/**
 * The spirit child's skeleton, authored in world units at rest, facing right, feet at the origin
 * (y down). About 67 u tall including the sprout; the body fits the 28 × 58 collider.
 */
const HALF_PI = Math.PI / 2;

function bone(name: string, parent: WorldBoneDef | null, x: number, y: number, angle: number, length: number): WorldBoneDef {
  return { name, parent: parent ? parent.name : null, x, y, angle, length };
}

/** A bone starting at its parent's tip. */
function tip(name: string, parent: WorldBoneDef, angle: number, length: number): WorldBoneDef {
  const x = parent.x + Math.cos(parent.angle) * parent.length;
  const y = parent.y + Math.sin(parent.angle) * parent.length;
  return bone(name, parent, x, y, angle, length);
}

function buildBones(): WorldBoneDef[] {
  const root = bone('root', null, 0, 0, 0, 0);
  const core = bone('core', root, 0, -26, 0, 0);
  const pelvis = bone('pelvis', core, 0, -18.5, 0, 0);
  const spine = bone('spine', core, 0, -19, -HALF_PI, 14);
  const head = bone('head', spine, 0.5, -33.5, 0, 0);
  const sproutA = bone('sproutA', head, -1.2, -55.2, -HALF_PI - 0.34, 4.8);
  const sproutB = tip('sproutB', sproutA, -HALF_PI + 0.42, 4.6);
  const armB = bone('armB', spine, -1.6, -30.8, HALF_PI + 0.12, 7);
  const foreB = tip('foreB', armB, HALF_PI - 0.05, 6);
  const handB = tip('handB', foreB, HALF_PI, 0);
  const thighB = bone('thighB', pelvis, -2.3, -18.5, HALF_PI + 0.03, 9);
  const shinB = tip('shinB', thighB, HALF_PI, 8.2);
  const footB = tip('footB', shinB, 0, 0);
  const thighF = bone('thighF', pelvis, 2.3, -18.5, HALF_PI - 0.03, 9);
  const shinF = tip('shinF', thighF, HALF_PI, 8.2);
  const footF = tip('footF', shinF, 0, 0);
  const armF = bone('armF', spine, 1.8, -30.8, HALF_PI - 0.1, 7);
  const foreF = tip('foreF', armF, HALF_PI + 0.08, 6);
  const handF = tip('handF', foreF, HALF_PI, 0);
  return [
    root, core, pelvis, spine, head, sproutA, sproutB, armB, foreB, handB, thighB, shinB, footB,
    thighF, shinF, footF, armF, foreF, handF,
  ];
}

export const HERO_BONES: readonly WorldBoneDef[] = buildBones();

export function createHeroSkeleton(): Skeleton {
  return new Skeleton(bonesFromWorldRest(HERO_BONES));
}

/** How a part image is attached to a bone (image pivot at bone-local (x, y), rotated). */
export interface PartAttachment {
  /** Sprite slot id (unique). */
  id: string;
  /** Atlas image base name; lit parts get `@R` / `@L` lighting variants. */
  image: string;
  bone: string;
  x: number;
  y: number;
  rotation: number;
  lit: boolean;
  /** Extra local scale (e.g. the far eye is foreshortened). */
  sx?: number;
  sy?: number;
  /** Multiplied into the image colour (far limbs sit a little deeper). */
  tint: number;
  /** Alpha of the part's bloom twin (0 = not twinned). */
  glow: number;
}

const FAR = 0xc2dce8;
const BODY = 0xffffff;

/** Back-to-front draw order (facing right; the rig is mirrored as a whole for facing left). */
export const HERO_PARTS: readonly PartAttachment[] = [
  { id: 'armB', image: 'upperArm', bone: 'armB', x: 0, y: 0, rotation: 0, lit: true, tint: FAR, glow: 0.35 },
  { id: 'foreB', image: 'foreArm', bone: 'foreB', x: 0, y: 0, rotation: 0, lit: true, tint: FAR, glow: 0.35 },
  { id: 'handB', image: 'hand', bone: 'handB', x: 0, y: 0, rotation: 0, lit: true, tint: FAR, glow: 0.35 },
  { id: 'thighB', image: 'thigh', bone: 'thighB', x: 0, y: 0, rotation: 0, lit: true, tint: FAR, glow: 0.35 },
  { id: 'shinB', image: 'shin', bone: 'shinB', x: 0, y: 0, rotation: 0, lit: true, tint: FAR, glow: 0.35 },
  { id: 'footB', image: 'foot', bone: 'footB', x: 0, y: 0, rotation: 0, lit: true, tint: FAR, glow: 0.35 },
  { id: 'torso', image: 'torso', bone: 'spine', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.5 },
  { id: 'stemA', image: 'stemA', bone: 'sproutA', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.3 },
  { id: 'leaf', image: 'leaf', bone: 'sproutA', x: 1.5, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.35 },
  { id: 'stemB', image: 'stemB', bone: 'sproutB', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.3 },
  { id: 'bud', image: 'bud', bone: 'sproutB', x: 4.6, y: 0, rotation: 0, lit: false, tint: BODY, glow: 1 },
  { id: 'head', image: 'head', bone: 'head', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.5 },
  { id: 'eyeB', image: 'eye', bone: 'head', x: -2.2, y: -10.6, rotation: 0, lit: false, sx: 0.8, sy: 0.96, tint: 0xd0dde2, glow: 0 },
  { id: 'eyeF', image: 'eye', bone: 'head', x: 5.4, y: -10.4, rotation: 0, lit: false, tint: BODY, glow: 0 },
  { id: 'thighF', image: 'thigh', bone: 'thighF', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.4 },
  { id: 'shinF', image: 'shin', bone: 'shinF', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.4 },
  { id: 'footF', image: 'foot', bone: 'footF', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.4 },
  { id: 'armF', image: 'upperArm', bone: 'armF', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.4 },
  { id: 'foreF', image: 'foreArm', bone: 'foreF', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.4 },
  { id: 'handF', image: 'hand', bone: 'handF', x: 0, y: 0, rotation: 0, lit: true, tint: BODY, glow: 0.4 },
];

/** Neck point (head-bone space) the light scarf hangs from. */
export const SCARF_ANCHOR = { bone: 'head', x: -1.5, y: 0.8 } as const;

export const HERO_COLORS = Object.freeze({
  body: PALETTE.spiritGlow,
  scarfStart: PALETTE.spiritGlow,
  scarfEnd: PALETTE.floraGlow,
  halo: 0xcff6ff,
});
