// The rules notice: the first screen of the booking form (`/` and `/en`). It says what Yoel
// accepts, so the customer reads it before filling anything in. OrderFormPage shows it on every
// entry and swaps it for the form on the button; nothing is stored, so it is never skipped.
import { t, type Lang } from '@bottlerun/shared';

/** Props of {@link RulesNotice}. */
export interface RulesNoticeProps {
  /** The language of every text on the screen. */
  lang: Lang;
  /** Called by the single button: the customer has read the rules and goes on to the form. */
  onAccept: () => void;
}

/**
 * The accepted-bottles rules and the button that leads on to the form. Renders the page's only
 * `<h1>` (Layout's heading rule) while it is shown; the language button above it belongs to
 * OrderFormPage.
 */
export function RulesNotice({ lang, onAccept }: RulesNoticeProps) {
  return (
    <>
      <h1>{t(lang, 'rules.title')}</h1>
      <p>{t(lang, 'rules.lead')}</p>
      <ol className="card rules-list">
        <li>{t(lang, 'rules.item1')}</li>
        <li>{t(lang, 'rules.item2')}</li>
        <li>{t(lang, 'rules.item3')}</li>
      </ol>
      <p>{t(lang, 'rules.thanks')}</p>
      {/* type="button": there is no form here to submit. */}
      <button
        type="button"
        className="button button-primary button-big button-block"
        onClick={onAccept}
      >
        {t(lang, 'rules.accept')}
      </button>
    </>
  );
}
