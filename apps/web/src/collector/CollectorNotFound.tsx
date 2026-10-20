// Shown inside the collector app for a path under /app/ that no screen has, such as a mistyped
// or outdated link. Unlike the public NotFoundPage, it keeps the bottom navigation around it and
// leads back to the orders tab, not to the public booking form.
import { Link } from '../router.tsx';

/** "Page not found" in the collector app. Renders the page's only `<h1>`. */
export function CollectorNotFound() {
  return (
    <>
      <h1>העמוד לא נמצא</h1>
      <p>אין באפליקציה עמוד בכתובת הזאת.</p>
      <Link to="/app/orders" className="button button-primary">
        להזמנות
      </Link>
    </>
  );
}
