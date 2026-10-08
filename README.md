# Wall Tree Generator

Life-size, bark-textured tree for a wall: thick trunk, a few fat branches that split into smaller ones, no leaves. Real geometry, exported as STL parts that fit your printer bed.

```
npm install
npm run dev     # live preview + "Download parts (.zip)"
npm test        # headless check: flat back/ceiling/floor, closed solids, clean tiling
```

- Units are mm. The back is flat on the wall (z = 0), the top of ceiling branches is flat on the ceiling, and the trunk has a flat bottom for the floor.
- "Only trunk on the wall" (default): the trunk runs up the wall and widens towards the top. The main branches leave it at a slope (crotch height), reach the ceiling, bend 90 degrees into the room and split into smaller branches there. Switch it off to let branches climb the wall first.
- Character: lumpy foot, an arched hollow with a widening chamber at the foot, windows (arched or round pockets), and old sawn-off branch stubs. Each has its own sliders; set counts to 0 or untick the hollow to remove them.
- The hollow and windows are real cut-outs: the trunk is split into closed pieces around them (disjoint, sharing their cut faces), so the STL stays printable without boolean tools.
- A loading screen with a progress bar shows while the tree is grown or cut into parts.
- Parts: the View dropdown switches between Assembled and Parts (exploded). Everything below the ceiling zone is cut into bed-sized tiles in the wall plane (`tree_wall_x*_y*.stl`, printed on the flat back). The ceiling zone is cut in the ceiling plane (`tree_ceiling_x*_z*.stl`, printed on the flat ceiling face). Neighbouring cut faces match, so glue or pin them.
- Known limit: around the hollow and where branches meet the wall/ceiling corner there can be a few small cracks (tens of edges, sub-millimetre to a few millimetres). Slicers repair these on import; `npm test` allows up to 24 per solid.
