// Placeholder for the customer's order page `/o/<token>` (spec §3.3). Section 9 replaces it with
// the real page, which loads the order by its token and shows what fits its status.

/** The customer's order page, until section 9 builds it. */
export function OrderPage() {
  return (
    <>
      <h1>עמוד ההזמנה</h1>
      <p>בקרוב אפשר יהיה לראות כאן את ההזמנה, לאשר את האיסוף או לבטל.</p>
    </>
  );
}
