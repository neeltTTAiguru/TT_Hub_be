/**
 * Auth0 Login Action: only let trusted email domains into the Smart Hub.
 *
 * This is the real gate. The backend enforces the same rule in
 * beCRM/src/middleware/auth.js, but that only ever sees people who already got
 * a token - this refuses them before one is minted, which is the difference
 * between "the API says no" and "you cannot sign in".
 *
 * It also writes the caller's email onto the access token. Auth0 puts `email`
 * in the ID token only, which the browser keeps and the API never sees, so
 * without this claim the backend has to ask /userinfo on every request just to
 * learn who is calling.
 *
 * ---------------------------------------------------------------------------
 * Installing it (Auth0 dashboard, ~2 minutes)
 *
 *   1. Actions -> Library -> Build Custom -> name it "Restrict to trusted
 *      domains", trigger "Login / Post Login", runtime Node 18+.
 *   2. Paste this file over the default body. Deploy.
 *   3. On the same screen, open the Secrets/Configuration panel (the key icon)
 *      and add:
 *
 *        ALLOWED_EMAIL_DOMAINS = trustedtechnology.ai
 *
 *      Comma-separated for more than one. Nothing else is configurable on
 *      purpose - a second knob here is a second thing to get wrong.
 *   4. Actions -> Triggers -> post-login -> drag the action into the flow and
 *      Apply. It is not running until this step is done.
 *   5. Set the matching backend variable so the API enforces it too:
 *
 *        ALLOWED_EMAIL_DOMAINS=trustedtechnology.ai
 *
 * Order matters on the way in and on the way out. Deploy the action FIRST and
 * confirm you can still sign in; only then set the backend variable. Reversed,
 * the API starts refusing requests that carry no email claim before anything is
 * putting one there.
 * ---------------------------------------------------------------------------
 */

// Must match AUTH0_EMAIL_CLAIM on the backend. A namespaced URI because Auth0
// silently drops custom claims that are not namespaced.
const EMAIL_CLAIM = 'https://trustedtechnology.ai/email'

exports.onExecutePostLogin = async (event, api) => {
  const allowed = String(event.secrets.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

  // Fail open when unconfigured, and only here. A typo'd secret name must not
  // lock every employee out of the hub at once; the backend is the copy of this
  // rule that fails closed.
  if (!allowed.length) return

  const email = String(event.user.email || '').trim().toLowerCase()
  const domain = email.split('@')[1] || ''

  // Domain before verification, deliberately.
  //
  // Both refuse, so nothing gets through either way - this is only about which
  // sentence the person reads. A test account on gmail.com is also unverified,
  // and checking verification first told them to go and find a verification
  // email that was never going to let them in. The domain is the real reason
  // they are being turned away, so it is the reason they are given.
  //
  // The cost: an unverified stranger learns whether their domain is on the
  // list. That is a small thing to give up to stop sending colleagues after a
  // fix that does not exist.
  if (!email || !allowed.includes(domain)) {
    // Named, not vague. Someone signing in with a personal address needs to be
    // told to use their work one, not left guessing.
    api.access.deny(`${email || 'This account'} is not on an approved domain. Sign in with your work account.`)
    return
  }

  // An unverified address proves nothing about the domain: anyone can type
  // someone@trustedtechnology.ai into a signup form. This check is the reason
  // a domain allow-list means anything at all.
  if (!event.user.email_verified) {
    api.access.deny('Verify your email address before signing in.')
    return
  }

  // The claim the API reads. On both tokens: the access token is what reaches
  // the backend, the ID token is what the browser can show.
  api.accessToken.setCustomClaim(EMAIL_CLAIM, email)
  api.idToken.setCustomClaim(EMAIL_CLAIM, email)
}
