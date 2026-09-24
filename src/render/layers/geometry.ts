import { Buffer, BufferUsage, Geometry, type Attribute, type Mesh, type Shader, type VertexFormat } from 'pixi.js';
import { KIT_STRIDE_BYTES, MAX_MESH_VERTICES, type MeshData } from './kitMesh.ts';

/** Meshes built from custom geometry and a custom shader. */
export type WorldMesh = Mesh<Geometry, Shader>;

/** A GPU buffer uploaded once (STATIC_DRAW) and exempt from Pixi's idle-resource GC. */
export function staticBuffer(data: Float32Array | Uint16Array, index: boolean, label: string): Buffer {
  const b = new Buffer({ data, usage: (index ? BufferUsage.INDEX : BufferUsage.VERTEX) | BufferUsage.STATIC, label });
  b.autoGarbageCollect = false;
  return b;
}

export interface AttributeSpec {
  name: string;
  format: VertexFormat;
  offset: number;
}

/** Interleaved static geometry. The position attribute must be named `aPosition` (Pixi bounds). */
export function interleavedGeometry(
  vertices: Float32Array, indices: Uint16Array, stride: number, attrs: readonly AttributeSpec[], label: string, shared?: Buffer,
): Geometry {
  if (vertices.length / (stride / 4) > MAX_MESH_VERTICES) throw new Error(`${label}: more than ${MAX_MESH_VERTICES} vertices`);
  const buffer = shared ?? staticBuffer(vertices, false, `${label}-vertices`);
  const attributes: Record<string, Attribute> = {};
  for (const a of attrs) attributes[a.name] = { buffer, format: a.format, stride, offset: a.offset };
  const g = new Geometry({ attributes, indexBuffer: staticBuffer(indices, true, `${label}-indices`) });
  g.autoGarbageCollect = false;
  return g;
}

export const KIT_ATTRIBUTES: readonly AttributeSpec[] = [
  { name: 'aPosition', format: 'float32x2', offset: 0 },
  { name: 'aUV', format: 'float32x2', offset: 8 },
  { name: 'aSway', format: 'float32x2', offset: 16 },
  { name: 'aDepth', format: 'float32', offset: 24 },
  { name: 'aTint', format: 'unorm8x4', offset: 28 },
];

export function createKitGeometry(m: MeshData, label: string): Geometry {
  return interleavedGeometry(m.vertices, m.indices, KIT_STRIDE_BYTES, KIT_ATTRIBUTES, label);
}
