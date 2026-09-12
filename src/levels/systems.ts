/**
 * The second showcase deck: everything the ship's systems round added. Walk it left to
 * right and you meet each mechanic once, in the order it makes sense to learn them.
 *
 *  - the squad starts beside a **charging point** (`e`), a **battery rack** (`b`) and a
 *    **fusion core rack** (`O`): one power budget, and the two things that refill it;
 *  - `H` bulkheads split that room from the middle corridor;
 *  - the middle-left column is three **fusion sockets** (`U`). Because this deck has a
 *    core rack on it, those sockets will not take a dwell — you have to carry a core
 *    over in both hands, with your rifle stowed, which is the escort job;
 *  - the centre is an **airlock**: a two-tile chamber (`:`) walled in behind two
 *    doors (`]`). Two people fit, the doors shut for five seconds, and the third
 *    member of the squad is on their own until they open again;
 *  - top right is standing water; bottom right a **hull breach** (`@`), the **lever**
 *    that opens it (`Y`) and a line of **railings** (`|`) to hold on to when it does;
 *  - `n` are ceiling vents, `l` is a **Ceiling Lurker** that lives in them, and `s` a
 *    Stalker, because the ducts are worth being nervous about twice.
 */
export const SYSTEMS = `
##################################
#..PP.....#..........#...........#
#..PP.....#....n.....#....~~~....#
#.........H..........#....~~~....#
#...e.....#..........#....~~~....#
#...b.....#....l.....H....~~~....#
#...O.....#..........#...........#
####.######..........####.########
#.........#..........#...........#
#....U....#..........#....Y..|...#
#.........####.......#.......|...#
#....U....]::].......#....@..|...#
#.........####.......#.......|...#
#....U....#..........#...........#
#.........#..........####.########
####.######..........#...........#
#.........#....E.....#....n......#
#....T....#..........#..........s#
#.........#..........#...........#
#....>....#....ZZ....#....E......#
##################################
`;
