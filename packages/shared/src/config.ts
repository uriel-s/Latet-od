// Settings that live in code, with no settings screen (ADR-0005): they change maybe once a year,
// and then the developer edits the value and deploys. Only what the browser may see is here: the
// drop-off point is in apps/api/src/config.ts (never sent to the browser), and the start point is
// the ROUTE_START env var (Yoel's home, private).

/**
 * Value of one bottle in agorot (20 אג'). The "שווי" in the monthly statistics is the bottles
 * collected × this (spec §3.7). Kept in whole agorot, not shekels, so sums never hit float
 * rounding.
 */
export const BOTTLE_VALUE_AGOROT = 20;
