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
// There is no free chat and no exemption list on the buyer's side. A subscription
// buys a creator's videos for a month, not their inbox, so a subscriber pays to
// write like everybody else.
//
// A CREATOR (or an ADMIN) answering their own inbox is the one exception, and it
// is the rule that makes an inbox a conversation: charging the reply too left a
// creator with no way to answer unless they had topped up a wallet, since their
// money sits in earnings. See the freeReply check in /api/messages. The floor
// below still applies to every viewer-to-viewer or viewer-to-creator send.
// =============================================================================

/** The smallest amount a message can be sent for, on every send. */
export const MIN_PAID_MESSAGE = 100;

/** The largest amount a message can be sent for, so a typo cannot drain a wallet. */
export const MAX_PAID_MESSAGE = 50_000;
