// The frame around every page: the brand at the top (spec §3.1, colours in styles.css from
// spec §7), the page itself in <main>, and the OpenStreetMap credit at the bottom (ADR-0005: the
// street points come from OSM under ODbL, so the credit is on every page).
import type { ReactNode } from 'react';
import { APP_NAME, APP_SLOGAN, STREETS_ATTRIBUTION } from '@bottlerun/shared';

// OSM's attribution guideline: the credit links to the copyright page, which states the ODbL.
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/**
 * Wraps a page in the shared header and footer.
 *
 * Heading rule for every page: the header shows the app name and slogan as plain text, not as a
 * heading, and each page renders exactly one `<h1>` of its own (the form's is "הזמנת איסוף
 * בקבוקים"). So a screen reader's heading list starts at what the page is about, and pages never
 * compete with the header for the `<h1>`.
 */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="layout">
      <header className="site-header">
        <div className="column">
          <p className="app-name">{APP_NAME}</p>
          <p className="app-slogan">{APP_SLOGAN}</p>
        </div>
      </header>

      <main className="column site-main">{children}</main>

      <footer className="site-footer">
        <div className="column">
          {/* English text inside a right-to-left page: dir="ltr" keeps the © before the words. */}
          <p>
            <a
              className="footer-link"
              href={OSM_COPYRIGHT_URL}
              lang="en"
              dir="ltr"
              // A new tab, so a customer who taps it does not lose a half-filled form.
              target="_blank"
              rel="noreferrer"
            >
              {STREETS_ATTRIBUTION}
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
