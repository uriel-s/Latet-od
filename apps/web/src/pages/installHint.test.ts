import { describe, expect, it } from 'vitest';
import { shouldShowInstallHint } from './installHint.ts';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
/** iPadOS Safari asks for the desktop site by default and reports itself as a Mac. */
const IPAD_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';

describe('shouldShowInstallHint', () => {
  it('shows the hint in iPhone Safari, where standalone is false', () => {
    expect(shouldShowInstallHint({ userAgent: IPHONE_SAFARI, standalone: false })).toBe(true);
  });

  it('shows the hint on an iPhone when standalone is missing', () => {
    expect(shouldShowInstallHint({ userAgent: IPHONE_SAFARI })).toBe(true);
  });

  it('hides the hint in the installed app (standalone is true)', () => {
    expect(shouldShowInstallHint({ userAgent: IPHONE_SAFARI, standalone: true })).toBe(false);
  });

  it('hides the hint on a desktop browser', () => {
    expect(shouldShowInstallHint({ userAgent: WINDOWS_CHROME })).toBe(false);
  });

  it('hides the hint on Android', () => {
    expect(shouldShowInstallHint({ userAgent: ANDROID_CHROME })).toBe(false);
  });

  it('hides the hint on an iPad, which reports itself as a Mac', () => {
    expect(shouldShowInstallHint({ userAgent: IPAD_SAFARI, standalone: false })).toBe(false);
  });
});
