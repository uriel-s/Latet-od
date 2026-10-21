// The frame around every page: the brand at the top (spec §3.1, colours in styles.css from
// spec §7) with the flyer's garland of flags under it and, on the public booking form, the
// collector's way in; the page itself in <main>; and a quiet footer with the OpenStreetMap credit
// (ADR-0005: the street points come from OSM under ODbL, so the credit is on every page).
import type { ReactNode } from 'react';
import { APP_NAME, APP_SLOGAN } from '@bottlerun/shared';
import { Bunting } from './components/Bunting.tsx';
import { Link } from './router.tsx';

// OSM's attribution guideline: the credit links to the copyright page, which states the ODbL.
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
// The short form of STREETS_ATTRIBUTION: still names OpenStreetMap, which is what the licence asks for.
const OSM_CREDIT_LABEL = '© OpenStreetMap';

/** Props of {@link Layout}. */
export interface LayoutProps {
  children: ReactNode;
  /**
   * Adds the "כניסת מנהל" button to the header: a link to /login, for the public booking form
   * only. The customer's own page and Yoel's app do not need it, and an extra button there would
   * only confuse an elderly customer.
   */
  collectorLink?: boolean;
}

/**
 * Wraps a page in the shared header and footer.
 *
 * Heading rule for every page: the header shows the app name and slogan as plain text, not as a
 * heading, and each page renders exactly one `<h1>` of its own (the form's is "הזמנת איסוף
 * בקבוקים"). So a screen reader's heading list starts at what the page is about, and pages never
 * compete with the header for the `<h1>`.
 */
export function Layout({ children, collectorLink = false }: LayoutProps) {
  return (
    <div className="layout">
      <header className="site-header">
        <div className="column site-header-inner">
          <div>
            <p className="app-name">{APP_NAME}</p>
            <p className="app-slogan">{APP_SLOGAN}</p>
          </div>
          {collectorLink && (
            <Link to="/login" className="button button-secondary header-login">
              כניסת מנהל
            </Link>
          )}
        </div>
      </header>
      <Bunting />

      <main className="column site-main">{children}</main>

      <footer className="site-footer">
        <div className="column site-footer-inner">
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
              {OSM_CREDIT_LABEL}
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
