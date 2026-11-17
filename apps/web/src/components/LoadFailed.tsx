// What a screen shows when its data got no usable answer: the reason in plain words, announced at
// once, and a button that loads again.

/** Props of {@link LoadFailed}. */
export interface LoadFailedProps {
  message: string;
  onRetry: () => void;
  /** The button's text, for a page that follows the order's language; Hebrew by default. */
  retryLabel?: string;
}

/** The load error and the "לנסות שוב" button under it. */
export function LoadFailed({ message, onRetry, retryLabel = 'לנסות שוב' }: LoadFailedProps) {
  return (
    <>
      <p className="form-alert" role="alert">
        {message}
      </p>
      <button type="button" className="button button-primary button-block" onClick={onRetry}>
        {retryLabel}
      </button>
    </>
  );
}
