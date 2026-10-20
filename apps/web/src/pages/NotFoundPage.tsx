// Shown for any path no route matches, such as a link cut short when it was copied.
import { Link } from '../router.tsx';

/** "Page not found", with a way back to the booking form. */
export function NotFoundPage() {
  return (
    <>
      <h1>העמוד לא נמצא</h1>
      <p>ייתכן שהקישור לא הועתק עד הסוף.</p>
      <Link to="/" className="button button-primary">
        לטופס ההזמנה
      </Link>
    </>
  );
}
