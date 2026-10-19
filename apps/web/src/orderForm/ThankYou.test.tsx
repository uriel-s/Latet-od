import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThankYou } from './ThankYou.tsx';

/** A token as the api makes them: 43 base64url characters. */
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

describe('ThankYou', () => {
  it('thanks the customer and says the WhatsApp message comes before the round', () => {
    render(<ThankYou token={TOKEN} />);

    expect(screen.getByRole('heading', { level: 1, name: 'תודה!' })).toBeDefined();
    expect(
      screen.getByText('קיבלנו את ההזמנה. לפני הסבב באזור שלך נשלח לך הודעת WhatsApp לאישור.'),
    ).toBeDefined();
  });

  it('moves focus to its heading, so a screen reader announces it', () => {
    render(<ThankYou token={TOKEN} />);

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('links to the order page by its token', () => {
    render(<ThankYou token={TOKEN} />);

    const link = screen.getByRole('link', { name: 'לצפייה בהזמנה או לביטול' });
    expect(link.getAttribute('href')).toBe(`/o/${TOKEN}`);

    fireEvent.click(link);
    expect(window.location.pathname).toBe(`/o/${TOKEN}`);
  });
});
