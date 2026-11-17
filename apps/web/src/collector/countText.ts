// Counts in words, shared by the collector screens so every card, row and summary says a count the
// same way.

/** "הזמנה אחת", "3 הזמנות": Hebrew says "one" after the noun, and the plural from two up. */
export function ordersText(count: number): string {
  return count === 1 ? 'הזמנה אחת' : `${count} הזמנות`;
}

/** "בקבוק אחד", "40 בקבוקים". A real order has at least 20, but a count of one still reads right. */
export function bottlesText(count: number): string {
  return count === 1 ? 'בקבוק אחד' : `${count} בקבוקים`;
}
