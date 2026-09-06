/**
 * Contact redaction for stored excerpts.
 *
 * POLICY: an excerpt persists; a phone number, email address or URL inside it
 * must not. This runs at write time — before the row is built, not when it is
 * rendered — so nothing unredacted ever reaches the database. Redacting at
 * display time would leave the real value sitting in storage, which is the
 * thing being avoided.
 *
 * The analyser is separately told to describe contact-formatting problems
 * rather than quote them, so in the normal case there is nothing here to
 * catch. This is the backstop for when it quotes anyway.
 *
 * It errs toward over-redaction. Turning a rare run of years into "[phone]"
 * costs a little clarity in one finding; missing a real phone number puts
 * someone's contact details in a database they did not expect it in.
 */

/** Matches an email before the URL rule, whose domain would otherwise catch it. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Scheme URLs, www-prefixed hosts, and bare host+path (linkedin.com/in/x). */
const URL_PATTERN =
  /\b(?:https?:\/\/|www\.)[^\s<>"')]+|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|io|co|edu|gov|dev|me|app|ai|uk|au)(?:\.[a-z]{2})?\/[^\s<>"')]*/gi;

/**
 * A run of digits and phone separators. The optional brackets matter: without
 * them "(03) 9000 0000" matches from the 0 and leaves a stray "(" behind. The
 * length rule below is what keeps "2023-2026" and "WAM 78" out of it.
 */
const PHONE_CANDIDATE = /\+?\(?\d[\d\s().-]{6,}\d\)?/g;

function digitCount(value: string) {
  return (value.match(/\d/g) ?? []).length;
}

/**
 * True for runs long enough to be a phone number.
 *
 * Nine digits, or eight with a phone-shaped prefix (+, leading 0, or an area
 * code in brackets). "2023-2026" is eight digits starting with a 2, so it
 * survives; "0400 000 000" and "(03) 9000 0000" do not.
 */
function looksLikePhone(value: string) {
  const digits = digitCount(value);
  if (digits >= 9) return true;
  return digits >= 8 && /^[+(0]/.test(value.trim());
}

export function redactContactDetails(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(URL_PATTERN, "[url]")
    .replace(PHONE_CANDIDATE, (match) => {
      if (!looksLikePhone(match)) return match;
      // Keep any leading/trailing spaces the match swallowed, so the sentence
      // around it still reads correctly.
      const leading = match.match(/^\s*/)?.[0] ?? "";
      const trailing = match.match(/\s*$/)?.[0] ?? "";
      return `${leading}[phone]${trailing}`;
    });
}
