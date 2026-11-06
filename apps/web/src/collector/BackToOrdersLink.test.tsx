import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BACK_TO_ORDERS_NAME, BackToOrdersLink } from './BackToOrdersLink.tsx';
import { ORDERS_LIST_PATH } from './orderEditing.ts';

describe('BackToOrdersLink', () => {
  it('is a link named "חזרה להזמנות" to the orders list', () => {
    render(<BackToOrdersLink />);

    const link = screen.getByRole('link', { name: BACK_TO_ORDERS_NAME });
    expect(BACK_TO_ORDERS_NAME).toBe('חזרה להזמנות');
    expect(link.getAttribute('href')).toBe(ORDERS_LIST_PATH);
  });

  it('shows the short word "הזמנות" with a hidden chevron, read only once', () => {
    render(<BackToOrdersLink />);

    const link = screen.getByRole('link', { name: BACK_TO_ORDERS_NAME });
    const visible = [...link.querySelectorAll('[aria-hidden="true"]')];
    expect(visible.map((element) => element.tagName.toLowerCase())).toEqual(['svg', 'span']);
    expect(visible[1]?.textContent).toBe('הזמנות');
    expect(link.querySelector('.visually-hidden')?.textContent).toBe(BACK_TO_ORDERS_NAME);
  });
});
