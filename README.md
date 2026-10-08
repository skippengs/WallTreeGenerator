# Wall Tree Generator

Parametric tree with a flat back, exported as STL. Built with TypeScript, Three.js and three-bvh-csg.

```
npm install
npm run dev     # live preview + "Download STL"
npm test        # headless check that nothing sits behind the flat back
```

- Units are mm. The flat back lies on the z = 0 plane, so the exported model lies on its back on the print bed.
- Branch angle is 0–90° from horizontal; "Branches point down" flips the direction.
- The STL contains overlapping closed solids (trunk, stem, branches); slicers merge them on import.
