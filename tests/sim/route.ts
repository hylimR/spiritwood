import type { GameWorld } from '../../src/sim/world.ts';
import { BotError, type Bot } from './bot.ts';

/** Tile → world x/y of the tile's left/top edge. */
const X = (tx: number): number => tx * 48;
const Y = (ty: number): number => ty * 48;

export interface Segment {
  name: string;
  /** Checkpoint index to start from (teleport to its respawn point); -1 = the level start. */
  from: number;
  /** Checkpoint index that must become active, or 'goal'. */
  to: number | 'goal';
  /** Needs Spirit Launch: a run that starts here (past the shrine) unlocks it with GameWorld.unlock. */
  launch?: boolean;
  run(bot: Bot): void;
}

const cpActive = (i: number) => (w: GameWorld): boolean => w.checkpoints[i]?.active === true;

/** The route expects the player to have just landed at feet y (a specific floor, not a lower one). */
function landedOn(bot: Bot, y: number): void {
  if (bot.p.y !== y) throw new BotError(bot, `expected to land at y ${y}`);
}

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
    name: 'Thornveil: gap B, the drop into the veil, the shrine',
    from: 3,
    to: 4,
    run(bot) {
      bot.leap(X(147) - 20, 1, { double: true, dash: true }); // gap B: 14 tiles, 2 up
      landedOn(bot, Y(12));
      // Off the landing into the drop, down to the veil floor, then through the shrine corridor.
      bot.hold(1, (w) => w.player.grounded && w.player.y === Y(31), 400);
      bot.hold(1, cpActive(4), 300);
      if (!bot.w.launch.unlocked) throw new BotError(bot, 'the shrine did not unlock Spirit Launch');
    },
  },
  {
    name: 'Thornveil: teach pit, rise gate, stun gate, vertical gate',
    from: 4,
    to: 5,
    launch: true,
    run(bot) {
      bot.settle();
      // Out of the shrine pit onto level A, stopping short of the teach pit; hop it (its seeds stay low).
      bot.arc(1, { holdTicks: 30, until: (w) => w.player.x > X(176.3) && w.player.vy > 0 });
      bot.land(0);
      bot.runTo(X(177.5), true);
      bot.hold(1, (w) => w.player.x >= X(178.7));
      bot.arc(1, { until: (w) => w.player.x > X(183.4) && w.player.vy > 0 });
      bot.land(0);
      // Rise gate: from the chasm's edge, straight up off a seed lobbed from below, drift onto level B.
      bot.runTo(X(186.6), true);
      bot.launch(0, -1, (w) => w.launch.candidateKind === 'seed');
      bot.fly(1, { airJump: 'apex' });
      landedOn(bot, Y(21)); // the OneWay step, 7 up
      bot.arc(1, { holdTicks: 20 });
      landedOn(bot, Y(19)); // the lip of level B
      // Stun gate: down into the passage's west pit, then launch off the spitter (up, into the ceiling).
      bot.hold(1, (w) => w.player.grounded && w.player.y === Y(22), 200);
      bot.hold(1, (w) => w.launch.candidateKind === 'enemy', 120);
      bot.launch(0, -1);
      bot.hold(1, (w) => w.player.x > X(211.3), 300);
      bot.settle();
      // Vertical gate: up beside the stream, straight up off one of its seeds onto the OneWay ledge, then level C.
      bot.arc(1, { holdTicks: 30, until: (w) => w.player.x > X(213.5) && w.player.vy > 0 });
      bot.land(0);
      bot.settle();
      bot.launch(0, -1, (w) => w.launch.candidateKind === 'seed');
      bot.fly(0);
      landedOn(bot, Y(11));
      bot.arc(1, { holdTicks: 20 });
      bot.hold(1, cpActive(5), 200);
    },
  },
  {
    name: 'Moonwell',
    from: 5,
    to: 'goal',
    run(bot) {
      bot.hold(1, (w) => w.player.grounded && w.player.y === Y(12), 200); // down onto the plateau
      bot.runTo(X(226));
      // Zig-zag down the Moonwell: off the plateau onto the lantern ledge, off its tip onto the branch
      // by the east wall, back west off the branch onto the middle branch, west again down to the knoll
      // side of the clearing, then east through the lanterns to the shrine.
      bot.hold(1, (w) => w.player.grounded && w.player.y >= Y(28), 600);
      landedOn(bot, Y(28));
      bot.hold(-1, (w) => w.player.grounded && w.player.y >= Y(34), 600);
      landedOn(bot, Y(34));
      bot.hold(-1, (w) => w.player.grounded && w.player.y >= Y(44), 600);
      landedOn(bot, Y(44));
      bot.hold(1, (w) => w.completed, 900);
    },
  },
];
