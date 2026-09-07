/**
 * The same format in its glyph form, which is easier to eyeball than digits.
 * # wall · . floor · P player spawn · E enemy spawn · X crate · G glass · L lamp
 *
 * Built to show what the tile ids actually do: glass lets your cone through but not
 * your body, crates cast shadows you can hide behind, lamps are permanently lit rooms.
 */
export const SHOWCASE = `
#########################
#.......#.......#.......#
#.PP....#...E...G...E...#
#.PP....#.......#.......#
#.......#########.......#
#...L...#.......#...L...#
#.......X.......X.......#
#########.......#########
#.......#...E...#.......#
#...E...G.......G...E...#
#.......#.......#.......#
#########.......#########
#.......#...L...#.......#
#..XX...#.......#...XX..#
#..XX...#...E...#...XX..#
#.......#.......#.......#
#########################
`;
