// =============================================================================
// GENHUB - Pay-to-chat price
//
// ONE PAID MESSAGE COSTS THIS MUCH — for every viewer, on every send. The price
// is a constant rather than a field in the request on purpose. While the
// composer offered an amount, a message cost whatever the client said, so the
// figure a creator could count on and the figure a fan expected were both
// nobody's; a scripted client could make a single message cost a shilling or a
// salary. Now the number on the screen and the number taken from the wallet are
// the same one, and neither of them comes from the caller.
//
// A subscription is the DOOR to a creator's inbox, not a discount on it: a
// viewer can only write to a creator they follow, and once inside they still pay
// this price (see the subscription check in /api/messages). There is no free
// chat and no exemption list on the buyer's side.
//
// A CREATOR (or an ADMIN) answering their own inbox is the one exception, and it
// is the rule that makes an inbox a conversation: charging the reply too left a
// creator with no way to answer unless they had topped up a wallet, since their
// money sits in earnings. See the freeReply check in /api/messages.
//
// This lives outside the route file because a route may only export HTTP
// handlers and a few known options — anything else fails the build with an
// index-signature error ("Property 'PAID_MESSAGE_PRICE' is incompatible with
// index signature"). The composer in /inbox renders the same number the server
// enforces; two copies of it is how a UI ends up advertising a price the API
// does not charge.
// =============================================================================

/** The price of one message, charged to every viewer on every send. */
export const PAID_MESSAGE_PRICE = 100;
