import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { announcePageChange, pageTitle } from './pageChange.ts';

const APP = 'לתת עוד';

/** A page as the app draws it: a link outside <main>, and inside it a heading, a field and a message. */
function drawPage(heading = 'הזמנות'): void {
  document.body.innerHTML = `
    <a id="outside" href="/">בית</a>
    <main>
      <h1>${heading}</h1>
      <input id="field" />
      <p id="message" tabindex="-1">נשמר</p>
    </main>`;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} is not on the page`);
  return element;
}

/** An `<h1>` with `text`, as a screen draws it. */
function heading(text: string): HTMLElement {
  return Object.assign(document.createElement('h1'), { textContent: text });
}

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('pageTitle', () => {
  it('puts the page heading before the app name', () => {
    expect(pageTitle('הזמנות', APP)).toBe('הזמנות | לתת עוד');
  });

  it('trims the heading', () => {
    expect(pageTitle('  סבבים \n', APP)).toBe('סבבים | לתת עוד');
  });

  it.each([null, '', '   '])('is the app name alone for the heading %j', (text) => {
    expect(pageTitle(text, APP)).toBe(APP);
  });
});

describe('announcePageChange', () => {
  it('titles the tab and focuses the heading', () => {
    drawPage();

    const stop = announcePageChange(APP);

    expect(document.title).toBe('הזמנות | לתת עוד');
    expect(document.activeElement).toBe(document.querySelector('h1'));
    stop();
  });

  it('moves focus from a link outside <main> to the heading', () => {
    drawPage();
    byId('outside').focus();

    const stop = announcePageChange(APP);

    expect(document.activeElement).toBe(document.querySelector('h1'));
    stop();
  });

  it('leaves focus on a field the page already focused', () => {
    drawPage();
    byId('field').focus();

    const stop = announcePageChange(APP);

    expect(document.activeElement).toBe(byId('field'));
    stop();
  });

  it('leaves focus on a message the page already focused', () => {
    drawPage();
    byId('message').focus();

    const stop = announcePageChange(APP);

    expect(document.activeElement).toBe(byId('message'));
    stop();
  });

  it('titles the tab with the app name alone when the page has no heading', () => {
    document.body.innerHTML = '<main><p>טוען...</p></main>';

    const stop = announcePageChange(APP);

    expect(document.title).toBe(APP);
    stop();
  });

  it('announces again when the heading is replaced after the first announcement', async () => {
    document.body.innerHTML = '<main><h1>אפליקציית האוסף</h1></main>';
    const stop = announcePageChange(APP);
    expect(document.title).toBe('אפליקציית האוסף | לתת עוד');

    // The screen that was loading draws its own heading in place of the temporary one.
    document.querySelector('main')?.replaceChildren(heading('סבבים'));

    await waitFor(() => expect(document.title).toBe('סבבים | לתת עוד'));
    expect(document.activeElement).toBe(document.querySelector('h1'));
    stop();
  });

  it('stops watching once the function it returned is called', async () => {
    drawPage('הזמנות');
    const stop = announcePageChange(APP);
    stop();

    document.querySelector('h1')?.replaceWith(heading('סבבים'));
    // Let any observer callback run before looking.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.title).toBe('הזמנות | לתת עוד');
  });
});
