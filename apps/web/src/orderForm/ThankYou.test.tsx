import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThankYou } from './ThankYou.tsx';

/** A token as the api makes them: 43 base64url characters. */
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

describe('ThankYou', () => {
  it('thanks the customer and says the WhatsApp message comes before the round', () => {
    render(<ThankYou token={TOKEN} bottlesEstimated={40} />);

    expect(screen.getByRole('heading', { level: 1, name: 'תודה!' })).toBeDefined();
    expect(
      screen.getByText(
        'קיבלנו את ההזמנה. לפני הסבב באזור שלך נשלח לך הודעת WhatsApp עם מועד האיסוף.',
      ),
    ).toBeDefined();
  });

  it('shows the donation line from the estimate, in Hebrew', () => {
    render(<ThankYou token={TOKEN} bottlesEstimated={40} />);

    expect(screen.getByText('כ־40 בקבוקים = כ־8 ₪ לתפילין לבר מצווה ולחיילים')).toBeDefined();
  });

  it('shows the donation line in English with the right amount', () => {
    render(<ThankYou token={TOKEN} bottlesEstimated={45} lang="en" />);

    expect(
      screen.getByText(
        'About 45 bottles = about 9 ₪ for tefillin for bar mitzvah boys and soldiers',
      ),
    ).toBeDefined();
  });

  it('moves focus to its heading, so a screen reader announces it', () => {
    render(<ThankYou token={TOKEN} bottlesEstimated={40} />);

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('links to the order page by its token', () => {
    render(<ThankYou token={TOKEN} bottlesEstimated={40} />);

    const link = screen.getByRole('link', { name: 'לצפייה בהזמנה או לביטול' });
    expect(link.getAttribute('href')).toBe(`/o/${TOKEN}`);

    fireEvent.click(link);
    expect(window.location.pathname).toBe(`/o/${TOKEN}`);
  });
});
