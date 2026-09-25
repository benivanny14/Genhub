// =============================================================================
// GENHUB - Pay-to-chat constants
//
// A route file in the App Router may only export HTTP handlers and a few known
// route options — anything else fails the build with an index-signature error
// ("Property 'MIN_PAID_MESSAGE' is incompatible with index signature"). The floor
// belongs here anyway: the composer in /inbox renders the same number the server
// enforces, and two copies of it is how a UI ends up offering an amount the API
// refuses.
//
// There is no free chat and no exemption list. A subscription buys a creator's
// videos for a month, not their inbox, so a subscriber pays to write like
// everybody else — and so does a creator answering a fan.
// =============================================================================

/** The smallest amount a message can be sent for, on every send. */
export const MIN_PAID_MESSAGE = 100;

/** The largest amount a message can be sent for, so a typo cannot drain a wallet. */
export const MAX_PAID_MESSAGE = 50_000;
