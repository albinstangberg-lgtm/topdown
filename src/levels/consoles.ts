/**
 * The console deck: the round where one of you stops being a gun.
 *
 * Three columns, and the only way out of the first one is through a screen:
 *
 *  - **left** is where the squad wakes up, and it holds both consoles. `*` is the lock
 *    controller and `&` is fire control, plus a terminal, a medkit cache and the exit;
 *  - `M` are **mag-locks**. Shooting them does nothing — the left column is sealed until
 *    somebody beats the lock console, which is the point of the deck: the first hack is
 *    done in a safe room, and the second one is not;
 *  - **middle** is the corridor the horde comes down, with a vent and a Stalker in it;
 *  - **right** is turret country: three `Q` emplacements covering the length of it, and
 *    a charging point on the far side of them. Beating `&` kills every one at once.
 *
 * The deck is deliberately winnable in the wrong order — you can walk the right column
 * with the turrets live if you are willing to sprint between cover, and the third `Q` is
 * placed so that trying it is a real decision rather than a formality.
 */
export const CONSOLES = `
####################################
#..PP......#...........#..........Q#
#..PP......#....E......#...........#
#..........M...........#...........#
#....*.....#...........M....E......#
#..........#...........#...........#
#..........#...........#..........Q#
####.#######...........######.######
#..........#...........#...........#
#....&.....#....Z......#....E......#
#..........#...........#...........#
#..........M...........#...........#
#....T.....#...........M...........#
#..........#...........#....Z......#
####.#######...........######.######
#..........#...........#...........#
#....+.....#....n......#....e......#
#..........#...........#...........#
#....>.....#....s......#..........Q#
####################################
`;
