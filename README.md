# Wall Tree Generator

Life-size, bark-textured tree for a wall: thick trunk, a few fat branches that split into smaller ones, no leaves. Real geometry, exported as STL parts that fit your printer bed.

```
npm install
npm run dev     # live preview + "Download parts (.zip)"
npm test        # headless check: flat back/ceiling/floor, closed solids, clean tiling
```

- Units are mm. The back is flat on the wall (z = 0). Branches that reach the ceiling bend and run along it with a flat top face. The trunk has a flat bottom for the floor.
- Spread angle (0-90 degrees) and curl control how branches lean and bend towards the ceiling. Depth sets how far the tree stands out from the wall (0.5 = half round).
- Parts: the View dropdown switches between Assembled and Parts (exploded), which previews the cut into bed-sized tiles; the zip holds one STL per tile (`tree_x{col}_y{row}.stl`), each lying on its flat back, origin at the tile corner. Neighbouring cut faces match exactly, so glue or pin them.
- Each part holds overlapping closed solids (trunk, branches); slicers union them on import.
