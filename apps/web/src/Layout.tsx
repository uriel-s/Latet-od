// The frame around every page: the brand at the top (spec §3.1, the dawn gradient of ADR-0011
// in styles.css) with the flyer's garland of flags under it and, on the public booking form, the
// collector's way in; the page itself in <main>; and a quiet footer with the OpenStreetMap credit
// (ADR-0005: the street points come from OSM under ODbL, so the credit is on every page).
import type { ReactNode } from 'react';
import { APP_NAME, DEFAULT_LANG, STREETS_ATTRIBUTION, t, type Lang } from '@bottlerun/shared';
import { Bunting } from './components/Bunting.tsx';
import { Link } from './router.tsx';

// OSM's attribution guideline: the credit links to the copyright page, which states the ODbL.
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/** Props of {@link Layout}. */
export interface LayoutProps {
  children: ReactNode;
  /** The language of the page's own texts (the slogan). Default Hebrew; the English form passes 'en'. */
  lang?: Lang;
  /**
   * Adds the "כניסת מנהל" button to the header: a link to /login, for the public booking form
   * only. The customer's own page and Yoel's app do not need it, and an extra button there would
   * only confuse an elderly customer.
   */
  collectorLink?: boolean;
  /**
   * Yoel's app: a thin header with the slogan only and no bunting. The app name and the garland
   * are for the public pages; in the app they only take room from the work on the screen.
   */
  compact?: boolean;
}

/**
 * Wraps a page in the shared header and footer.
 *
 * Heading rule for every page: the header shows the app name and slogan as plain text, not as a
 * heading, and each page renders exactly one `<h1>` of its own (it changes with the screen: at `/` the
 * rules notice's "שימו לב!", then the form's "הזמנת איסוף בקבוקים"). So a screen reader's heading list starts at what the page is about, and pages never
 * compete with the header for the `<h1>`.
 */
export function Layout({
  children,
  lang = DEFAULT_LANG,
  collectorLink = false,
  compact = false,
}: LayoutProps) {
  return (
    <div className="layout">
      <header className={compact ? 'site-header site-header-compact' : 'site-header'}>
        <div className="column site-header-inner">
          <div>
            {!compact && <p className="app-name">{APP_NAME}</p>}
            <p className="app-slogan">{t(lang, 'appSlogan')}</p>
          </div>
          {/* Yoel logs in from the Hebrew page; the English form has no collector button. */}
          {collectorLink && lang === DEFAULT_LANG && (
            <Link to="/login" className="button button-secondary header-login">
              כניסת מנהל
            </Link>
          )}
        </div>
      </header>
      {!compact && <Bunting />}

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
              {STREETS_ATTRIBUTION}
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
