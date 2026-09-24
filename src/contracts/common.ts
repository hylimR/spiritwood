export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned rect: top-left + size, world units unless stated otherwise. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Min/max form, used by collision code. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Facing = 1 | -1;

export interface Disposable {
  destroy(): void;
}
