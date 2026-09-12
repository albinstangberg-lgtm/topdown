/**
 * Everything the ship added after the walkers: the two mutants, the four utility items,
 * and the three hazards. Built to be walked through in one pass rather than to be fair
 * — this is the map you load when you want to SEE a thing work.
 *
 * Reading it from the top left:
 *
 *  - the squad starts beside a row of supply caches (`+` medkit, `j` adrenaline,
 *    `k` flare, `y` welder), so every item is one step away;
 *  - `L` lights the room next door: with your beam on in there you pull nothing,
 *    which is the light-and-aggro trade in one room;
 *  - the long left-hand column ends in `S`, a Strangler with a clear line up it —
 *    walk in and something takes hold of you from the dark;
 *  - `H` bulkheads split the middle: weld one shut and listen to what is behind it;
 *  - top right is standing water `~` with a live cable `=` on the far wall. Put a
 *    round into the cable while something is standing in the puddle;
 *  - bottom right is a split coolant line `%` — inside that fog your cone is gone and
 *    the only thing left is the sound ripples;
 *  - `n` are ceiling vents, and `s` is a Stalker that will use them to get behind
 *    whoever has wandered off on their own.
 */
export const HAZARDS = `
##############################
#..PP....#........#..........#
#..PP....#...n....#...~~~~~..#
#..+jky..H........H...~~~~~..#
#........#........#...~~~~~=.#
#...L....#........#...~~~n~..#
####.#####........####.#######
#........#........#..........#
#...n....#...ZZ...#....E.....#
#........#........#..........#
####.#####........H..........#
#........#........#..........#
#...S....#........####.#######
#........#........#..........#
#........#...E....#...%%%....#
####.#####........#..........#
#........#........#...s.n....#
#...E....H........#..........#
#........#........#..........#
#........#........#..........#
#...>....#........#...E......#
##############################
`;
