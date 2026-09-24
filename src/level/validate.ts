import type { LevelData } from '../contracts/level.ts';
import { todo } from '../core/todo.ts';
import type { PlayerTuning } from '../sim/tuning.ts';

export interface LevelIssue {
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Content checks: player start and checkpoints stand on ground with head-room for the player collider,
 * orbs/entities inside bounds and not inside solids, enemy patrol ranges on a floor, grade zones
 * cover the level width, at least one checkpoint and exactly one goal.
 */
export function validateLevel(level: LevelData, tuning?: PlayerTuning): LevelIssue[] {
  void level;
  void tuning;
  return todo('SIM', 'validateLevel');
}
