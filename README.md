# Wall Tree Generator

Life-size, bark-textured tree for a wall: thick trunk, a few fat branches that split into smaller ones, no leaves. Real geometry, exported as STL parts that fit your printer bed.

```
npm install
npm run dev     # live preview + "Download parts (.zip)"
npm test        # headless check: flat back/ceiling/floor, closed solids, clean tiling
```

- Units are mm. The back is flat on the wall (z = 0), the top of ceiling branches is flat on the ceiling, and the trunk has a flat bottom for the floor.
- "Only trunk on the wall" (default): the trunk runs up the wall, the main branches bend 90 degrees into the room along the ceiling and split into smaller branches there. Switch it off to let branches climb the wall first; they bend into the room when they reach the ceiling.
- Spread angle (0-90 degrees) fans the main branches out. Depth sets how far the tree stands out from the wall / hangs from the ceiling (0.55 is just over half round).
- Parts: the View dropdown switches between Assembled and Parts (exploded). Everything below the ceiling zone is cut into bed-sized tiles in the wall plane (`tree_wall_x*_y*.stl`, printed on the flat back). The ceiling zone is cut in the ceiling plane (`tree_ceiling_x*_z*.stl`, printed on the flat ceiling face). Neighbouring cut faces match, so glue or pin them.
- Each part holds overlapping closed solids (trunk, branches); slicers union them on import. A handful of parts may carry a few micron-sized stray edges; slicers repair those silently.
