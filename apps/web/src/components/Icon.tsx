// The app's small, closed set of line icons (ADR-0011 item 4): inline SVG in the code, coloured by
// `currentColor`, no icon library. An icon is decoration next to visible text, never the meaning on
// its own: it is hidden from screen readers, so a button that shows an icon must still carry a text
// label (and an icon-only control would need its own aria-label, not one from here).
//
// Look: a 24×24 grid, 2-unit round strokes, taken from docs/design/route-mockup.html where an icon
// there matches; the rest are drawn here in the same style. Size follows the surrounding text
// (1.25em), so a bigger font gives a bigger icon with no extra CSS.
//
// Direction (RTL): every shape is symmetric or direction-neutral, so nothing is mirrored for
// `dir="rtl"` and the same drawing serves the Hebrew and the English pages. "navigate" is an arrow
// pointing up (straight ahead), not sideways; "list" centres its short last line instead of aligning
// it to one side. Three exceptions, all used only in the Hebrew-only collector app: "back" points
// right (the start side in RTL, where the previous screen or month is), "forward" points left (the
// next month) and "logout" points left (out, to the end side). An English screen using them
// would need them mirrored.

import type { ReactNode } from 'react';

/** Every icon name, in one closed list: the test iterates it, and the type below is derived from it. */
export const ICON_NAMES = [
  'navigate',
  'phone',
  'check',
  'more',
  'pin',
  'calendar',
  'bottle',
  'heart',
  'list',
  'clock',
  'route',
  'plus',
  'minus',
  'door',
  'building',
  'home',
  'back',
  'forward',
  'logout',
  'chat',
  'bell',
] as const;

/** One of the icons the app can draw. */
export type IconName = (typeof ICON_NAMES)[number];

// A filled dot inside a stroked icon ("more", the door knob): the svg defaults to fill none.
const DOT = { fill: 'currentColor', stroke: 'none' } as const;

// The shapes of each icon on the 24×24 grid. A Record, so leaving a name out is a type error.
const ICON_SHAPES: Record<IconName, ReactNode> = {
  // An arrowhead pointing up: "drive there" (opens the navigation app).
  navigate: <path d="M12 2l7 19-7-4-7 4z" />,
  phone: (
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  ),
  check: <path d="M5 13l4 4L19 7" />,
  more: (
    <>
      <circle cx="5" cy="12" r="2" {...DOT} />
      <circle cx="12" cy="12" r="2" {...DOT} />
      <circle cx="19" cy="12" r="2" {...DOT} />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  // A bottle with a label line across its body.
  bottle: (
    <>
      <path d="M10 2h4v3l2 3v12a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 8 20V8l2-3V2z" />
      <path d="M8 12h8" />
    </>
  ),
  heart: <path d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11z" />,
  // Lines of text; the short one is centred so it reads the same in RTL and LTR.
  list: <path d="M4 6h16M4 12h16M7 18h10" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  // Two stops joined by a winding road.
  route: (
    <>
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M8 19h7.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H16" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  // The apartment door (bottlesSpot): a door in its frame on the floor line, with a knob.
  door: (
    <>
      <path d="M3 21h18M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17" />
      <circle cx="14.5" cy="12" r="1.2" {...DOT} />
    </>
  ),
  // The building entrance (bottlesSpot): a block with windows and a doorway.
  building: (
    <>
      <path d="M3 21h18M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17" />
      <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3" />
    </>
  ),
  // A private house (bottlesSpot, and the route's start): roof, walls and a door.
  home: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5M10 21v-6h4v6" />
    </>
  ),
  // A chevron pointing right: "back" in the right-to-left collector app (see the note at the top).
  back: <path d="M9 6l6 6-6 6" />,
  // The mirror of "back": a chevron pointing left, onward in the right-to-left collector app
  // (the history tab's "החודש הבא").
  forward: <path d="M15 6l-6 6 6 6" />,
  // Leaving: an arrow pointing out (left) of an open door frame on the right.
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10" />,
  // A speech bubble with its tail at the start corner: a message (the plan's personal text).
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  // A bell: push notifications.
  bell: (
    <>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </>
  ),
};

/** Props of {@link Icon}. */
export interface IconProps {
  /** Which icon to draw. */
  name: IconName;
  /** Extra class for the svg, e.g. to colour it through `color`. */
  className?: string;
}

/**
 * One decorative line icon, sized to the surrounding text (1.25em) and drawn in its colour.
 * Hidden from screen readers: always put a visible text label next to it.
 */
export function Icon({ name, className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="1.25em"
      height="1.25em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // Drops the icon a little so it sits centred on the text line instead of on the baseline;
      // flexShrink keeps it whole inside a crowded flex button.
      style={{ verticalAlign: '-0.25em', flexShrink: 0 }}
    >
      {ICON_SHAPES[name]}
    </svg>
  );
}
