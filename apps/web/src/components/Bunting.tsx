// The flyer's garland: flags in the dawn palette (soft blue, card white, a hint of peach) in a row, hanging from the header's lower edge
// (Layout.tsx). One tile of three flags repeats across the whole width, so it fits any phone without
// stretching. Pure decoration: hidden from screen readers, never a tap target. The colours come
// from the .bunting-flag-* classes in styles.css (brand tokens), not from this file.

const FLAG_WIDTH = 44;
const FLAG_GAP = 4;
const FLAG_HEIGHT = 26;
// One tile holds a soft-blue, a white and a peach flag, each followed by a gap.
const TILE_WIDTH = 3 * (FLAG_WIDTH + FLAG_GAP);

/** The three corners of a flag whose top edge starts at `x`: a triangle pointing down. */
function flagPoints(x: number): string {
  return `${x},0 ${x + FLAG_WIDTH},0 ${x + FLAG_WIDTH / 2},${FLAG_HEIGHT}`;
}

/** The decorative row of flags under the header. */
export function Bunting() {
  return (
    <svg className="bunting" aria-hidden="true" focusable="false">
      <defs>
        {/* userSpaceOnUse: the tile keeps its size and repeats, whatever the width of the page. */}
        <pattern
          id="bunting-flags"
          width={TILE_WIDTH}
          height={FLAG_HEIGHT}
          patternUnits="userSpaceOnUse"
        >
          <polygon className="bunting-flag-light" points={flagPoints(FLAG_GAP / 2)} />
          <polygon
            className="bunting-flag-white"
            points={flagPoints(FLAG_GAP / 2 + FLAG_WIDTH + FLAG_GAP)}
          />
          <polygon
            className="bunting-flag-peach"
            points={flagPoints(FLAG_GAP / 2 + 2 * (FLAG_WIDTH + FLAG_GAP))}
          />
        </pattern>
      </defs>
      <rect width="100%" height={FLAG_HEIGHT} fill="url(#bunting-flags)" />
    </svg>
  );
}
