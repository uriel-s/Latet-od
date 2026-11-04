// Sets the document's language and direction while a page in that language is shown. index.html
// starts as Hebrew right-to-left; the English booking form (`/en`) switches it to English
// left-to-right, so screen readers, hyphenation and the browser's own widgets follow, and puts
// it back when the customer leaves.
import { useEffect } from 'react';
import type { Lang } from '@bottlerun/shared';

/** The writing direction of each language. */
const DIRECTION_BY_LANG: Readonly<Record<Lang, 'rtl' | 'ltr'>> = { he: 'rtl', en: 'ltr' };

/**
 * Makes `<html>` carry `lang` and its `dir` while `lang` is current. Leaving (or changing
 * language) restores Hebrew/RTL first, so the next page never inherits English by accident.
 */
export function useDocumentLanguage(lang: Lang): void {
  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = DIRECTION_BY_LANG[lang];
    return () => {
      root.lang = 'he';
      root.dir = DIRECTION_BY_LANG.he;
    };
  }, [lang]);
}
