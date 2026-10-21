// The "install to home screen" tags of the collector app (manifest, iOS icon and iOS app metas).
// App.tsx renders <CollectorPwaHead /> only on /login and /app/*: customers on / and /o/* get a
// plain website with nothing to install (spec: "אתר בלי התקנה"), so the tags are not in index.html.
//
// Adding them from JavaScript is enough: iOS Safari reads the live DOM <head> when Yoel taps
// "Add to Home Screen", and he does that while on /login or /app, where the tags are in place.
// Chrome on Android likewise looks for the manifest link in the current DOM.
import { useEffect } from 'react';
import { APP_NAME } from '@bottlerun/shared';

/** One element to add to `document.head`: its tag name and attributes. */
interface HeadTag {
  tag: 'link' | 'meta';
  attributes: Record<string, string>;
}

/** The tags CollectorPwaHead adds, in order. Exported for its tests. */
export const COLLECTOR_PWA_HEAD_TAGS: readonly HeadTag[] = [
  { tag: 'link', attributes: { rel: 'manifest', href: '/manifest.webmanifest' } },
  { tag: 'link', attributes: { rel: 'apple-touch-icon', sizes: '180x180', href: '/icon-180.png' } },
  // The standard name, and the older Apple one iOS still reads: open full screen, no browser bar.
  { tag: 'meta', attributes: { name: 'mobile-web-app-capable', content: 'yes' } },
  { tag: 'meta', attributes: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
  { tag: 'meta', attributes: { name: 'apple-mobile-web-app-title', content: APP_NAME } },
  // "default" keeps dark status-bar text over the light #DCEBF8 header; "black-translucent" would
  // put white text on it.
  {
    tag: 'meta',
    attributes: { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
  },
];

/**
 * Adds {@link COLLECTOR_PWA_HEAD_TAGS} to `document.head` while mounted and removes them on
 * unmount, so navigating from /app to / (no reload) leaves the customer's page without them.
 * Renders nothing. An explicit effect rather than React 19's hoisting of <link>/<meta>: cleanup
 * removes exactly the elements this mount added, so StrictMode's second effect run never leaves a
 * duplicate behind.
 */
export function CollectorPwaHead(): null {
  useEffect(() => {
    const added = COLLECTOR_PWA_HEAD_TAGS.map(({ tag, attributes }) => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      document.head.append(element);
      return element;
    });
    return () => {
      for (const element of added) element.remove();
    };
  }, []);
  return null;
}
