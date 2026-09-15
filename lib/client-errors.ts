/**
 * Sentences for failures that happen on the way to the server — the request
 * never arrived, or what came back was not an answer. Shared by the text
 * form and the voice transport so both say the same thing about the same
 * failure. Pure; runs in the browser.
 */

export interface SubmitFailure {
  message: string;
  /** The person needs a fresh session; show the sign-in link. */
  signIn: boolean;
}

/** Chrome, Firefox and Safari's wording for "the network never answered". */
const NETWORK = /failed to fetch|networkerror|load failed|network request failed|internetdisconnected/i;
/** Next's wording when an action's response was not an action response — the proxy redirected it. */
const NOT_AN_ACTION = /unexpected response was received from the server/i;
const SIGNED_OUT = /not signed in|sign-in has expired|sign in again/i;

export function describeSubmitFailure(error: unknown, what = "answer"): SubmitFailure {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (NETWORK.test(message)) {
    return {
      message: `Lost the connection before that was sent. Your ${what} is still here — check your network and send it again.`,
      signIn: false,
    };
  }
  if (NOT_AN_ACTION.test(message) || SIGNED_OUT.test(message)) {
    return {
      message: `The server did not accept that — most often because the sign-in expired. Sign in again in a new tab, then come back and send it; your ${what} is still here.`,
      signIn: true,
    };
  }
  return {
    message: message
      ? `${message} Your ${what} is still here — try again.`
      : `That did not go through. Your ${what} is still here — try again.`,
    signIn: false,
  };
}
