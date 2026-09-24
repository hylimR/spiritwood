import type { GameWorld } from '../../src/sim/world.ts';
import type { Bot } from './bot.ts';

/** Tile → world x/y of the tile's left/top edge. */
const X = (tx: number): number => tx * 48;
const Y = (ty: number): number => ty * 48;

export interface Segment {
  name: string;
  /** Checkpoint index to start from (teleport to its respawn point); -1 = the level start. */
  from: number;
  /** Checkpoint index that must become active, or 'goal'. */
  to: number | 'goal';
  run(bot: Bot): void;
}

const cpActive = (i: number) => (w: GameWorld): boolean => w.checkpoints[i]?.active === true;

/**
 * The scripted route through Forest_Night (tools/level/forest.map.txt). Positions are tile columns /
 * rows of the map; each move is keyed to the player's position, so the route reads like the level.
 */
export const FOREST_ROUTE: readonly Segment[] = [
  {
    name: 'start → glade checkpoint',
    from: -1,
    to: 0,
    run(bot) {
      bot.hold(1, cpActive(0));
    },
  },
  {
    name: 'Hollow Glade + Thorn Gully',
    from: 0,
    to: 1,
    run(bot) {
      bot.leap(X(9.5), 1); // over the root
      bot.leap(X(17), 1); // up the 3-tile ledge
      bot.runTo(X(20.5), true);
      bot.arc(1, { holdTicks: 40 }); // onto the branch
      bot.runTo(X(25.5), true);
      bot.arc(1); // onto the upper branch
      bot.runTo(X(34), false); // walk off onto the ground
      bot.land(1);
      bot.leap(X(43) - 20, 1, { double: true }); // gap 1 (9 tiles)
      bot.leap(X(57) - 20, 1, { double: true }); // gap 2 (10 tiles)
      bot.leap(X(71) - 20, 1, { double: true }); // gap 3 (9 tiles)
      bot.hold(1, cpActive(1));
    },
  },
  {
    name: 'Rootwell',
    from: 1,
    to: 2,
    run(bot) {
      bot.runTo(X(92));
      bot.arc(1, { until: (w) => w.player.mode === 'wallSlide' });
      bot.climb(1, Y(12));
      bot.hold(1, cpActive(2));
    },
  },
  {
    name: 'Canopy Walk',
    from: 2,
    to: 3,
    run(bot) {
      bot.leap(X(107) - 20, 1, { double: true, dash: true }); // gap A: 14 tiles, 2 up
      bot.runTo(X(124.5), true);
      bot.arc(0, { double: true }); // up to the twig
      bot.dropThrough();
      bot.land(0);
      bot.runTo(X(128.6), true);
      // Wait for the Gloomcrawler to head east, drop in behind it, then jump it on its way back.
      const enemy = bot.w.enemies[0];
      if (!enemy) throw new Error('route: the canopy needs its Gloomcrawler');
      bot.hold(0, () => enemy.facing > 0 && enemy.x > X(138), 900);
      bot.arc(1, { holdTicks: 20, until: (w) => w.player.x > X(132.5) });
      bot.land(0);
      bot.settle();
      bot.hold(0, () => enemy.facing < 0 && enemy.x - bot.p.x < 170, 900);
      bot.arc(1);
      bot.hold(1, cpActive(3));
    },
  },
  {
    name: 'Moonwell',
    from: 3,
    to: 'goal',
    run(bot) {
      bot.leap(X(147) - 20, 1, { double: true, dash: true }); // gap B: 14 tiles, 2 up
      bot.runTo(X(166));
      bot.land(1);
      bot.hold(1, (w) => w.player.y >= Y(28) && w.player.grounded, 600);
      bot.dropThrough();
      bot.land(0);
      bot.dropThrough();
      bot.land(0);
      bot.hold(1, (w) => w.completed, 600);
    },
  },
];
