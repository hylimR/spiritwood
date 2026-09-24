import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { CrawlerDef, LevelData } from '../../src/contracts/level.ts';
import { Ability, SimEventType } from '../../src/contracts/sim.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { LDTK_PATH } from '../../tools/level/build-level.ts';
import { Bot } from './bot.ts';
import { WorldRig } from './helpers.ts';
import { FOREST_ROUTE, type Segment } from './route.ts';

const level: LevelData = parseLdtk(JSON.parse(readFileSync(LDTK_PATH, 'utf8')));
const X = (tx: number): number => tx * 48;
const Y = (ty: number): number => ty * 48;

function startAt(bot: Bot, checkpoint: number): void {
  if (checkpoint < 0) return;
  const c = bot.w.checkpoints[checkpoint];
  if (!c) throw new Error(`no checkpoint ${checkpoint}`);
  bot.w.teleport(c.x + c.w / 2, c.y + c.h);
}

/** A segment run on its own: teleport never passes the shrine, so launch segments unlock it directly. */
function startSegment(bot: Bot, s: Segment): void {
  startAt(bot, s.from);
  if (s.launch) bot.w.unlock(Ability.Launch);
}

function arrived(bot: Bot, s: Segment): boolean {
  return s.to === 'goal' ? bot.w.completed : bot.w.checkpoints[s.to]?.active === true;
}

describe('playthrough: forest.ldtk is completable with the real controller', () => {
  for (const segment of FOREST_ROUTE) {
    test(`${segment.name} (checkpoint ${segment.from} → ${segment.to})`, () => {
      const bot = new Bot(new WorldRig(level));
      startSegment(bot, segment);
      segment.run(bot);
      expect(arrived(bot, segment)).toBe(true);
      expect(bot.rig.eventsOf(SimEventType.Died)).toHaveLength(0);
    });
  }

  test('the whole route in one run: every checkpoint in order, the goal, and ≥ 70% of the orbs', () => {
    const bot = new Bot(new WorldRig(level));
    const w = bot.w;
    for (const segment of FOREST_ROUTE) {
      startAt(bot, segment.from);
      segment.run(bot);
      expect(arrived(bot, segment), segment.name).toBe(true);
    }
    const activated = bot.rig.eventsOf(SimEventType.CheckpointActivated).map((e) => e.id);
    expect(activated).toEqual(level.checkpoints.map((c) => c.id));
    expect(bot.rig.eventsOf(SimEventType.GoalReached)).toHaveLength(1);
    expect(w.orbsCollected / w.orbsTotal).toBeGreaterThanOrEqual(0.7);
    expect(w.elapsed).toBeGreaterThan(0);
  });

  test('optional detour: the low orb line over the Thorn Gully twig, and back up to the ledge', () => {
    const bot = new Bot(new WorldRig(level));
    const w = bot.w;
    w.teleport(X(54.5), Y(40));
    const low = w.orbs.filter((o) => o.y > Y(42) && o.x > X(57) && o.x < X(66));
    expect(low.length).toBe(4);
    bot.runTo(X(57.5));
    bot.land(1);
    expect(w.player.y).toBe(Y(44));
    bot.runTo(X(62.8), true);
    bot.idle(30);
    expect(low.every((o) => o.collected)).toBe(true);
    bot.arc(1, { double: true, until: (x) => x.player.x > X(67.5) });
    bot.land(0);
    expect(w.player.y).toBe(Y(40));
    expect(w.player.x).toBeGreaterThan(X(67));
  });

  test('optional: the Gloomcrawler can be stomped from its branch', () => {
    // Stand at the branch's west end (outside the patrol), jump east as it walks away; some take-off
    // point along its walk lands the player on its back.
    let stomps = 0;
    for (let trigger = 134; trigger <= 141; trigger += 0.5) {
      const bot = new Bot(new WorldRig(level));
      const w = bot.w;
      const enemy = w.enemies[0];
      if (!enemy) throw new Error('fixture');
      w.teleport(X(132.5), Y(14));
      expect(w.player.x + w.player.width / 2).toBeLessThan(((level.enemies[0] as CrawlerDef | undefined)?.patrolMinX ?? 0) - enemy.width / 2);
      try {
        bot.hold(0, () => enemy.facing > 0 && enemy.x >= X(trigger), 1200);
        bot.arc(1, { until: () => enemy.mode === 'stunned' });
      } catch {
        continue;
      }
      if (enemy.mode === 'stunned') {
        stomps++;
        expect(bot.rig.eventsOf(SimEventType.EnemyStomped)).toHaveLength(1);
        expect(w.player.vy).toBeLessThan(0);
      }
    }
    expect(stomps).toBeGreaterThan(0);
  });
});
