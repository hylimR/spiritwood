/**
 * The subset of the LDtk 1.5.3 project JSON (https://ldtk.io/json) that the loader reads. Only the
 * exported "__" helper fields and instance data are used; editor definitions are ignored.
 */

export interface LdtkProject {
  jsonVersion: string;
  identifierStyle?: string;
  levels: LdtkLevel[];
}

export interface LdtkLevel {
  identifier: string;
  pxWid: number;
  pxHei: number;
  fieldInstances: LdtkFieldInstance[];
  /** null when the level is saved in an external file. */
  layerInstances: LdtkLayerInstance[] | null;
  externalRelPath?: string | null;
}

export type LdtkLayerType = 'IntGrid' | 'Entities' | 'Tiles' | 'AutoLayer';

export interface LdtkLayerInstance {
  __identifier: string;
  __type: LdtkLayerType;
  __cWid: number;
  __cHei: number;
  __gridSize: number;
  __pxTotalOffsetX: number;
  __pxTotalOffsetY: number;
  /** Row-major IntGrid values (0 = empty), length __cWid × __cHei. */
  intGridCsv: number[];
  entityInstances: LdtkEntityInstance[];
}

export interface LdtkEntityInstance {
  __identifier: string;
  /** Pivot as fractions of width/height; `px` is the pivot position in the layer. */
  __pivot: [number, number];
  px: [number, number];
  width: number;
  height: number;
  iid: string;
  fieldInstances: LdtkFieldInstance[];
}

/** `__type` is e.g. "Int", "Float", "String", "Bool", "LocalEnum.AreaGrade". */
export interface LdtkFieldInstance {
  __identifier: string;
  __type: string;
  __value: unknown;
}
