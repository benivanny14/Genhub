// =============================================================================
// GENHUB - Pay-to-chat constants
//
// A route file in the App Router may only export HTTP handlers and a few known
// route options — anything else fails the build with an index-signature error
// ("Property 'MIN_PAID_MESSAGE' is incompatible with index signature"). The floor
// belongs here anyway: the composer in /inbox renders the same number the server
// enforces, and two copies of it is how a UI ends up offering an amount the API
// refuses.
// =============================================================================

/** The smallest amount a message can be sent for when it is not free. */
export const MIN_PAID_MESSAGE = 100;

/** The largest amount a message can be sent for, so a typo cannot drain a wallet. */
export const MAX_PAID_MESSAGE = 50_000;

/**
 * Why a message cost nothing.
 *
 *   subscription — the sender holds an active membership to the receiver, so the
 *                  month they already paid for includes chatting with them.
 *   reply        — the receiver started the thread, or is the sender's own
 *                  subscriber: this is a creator answering their inbox, and
 *                  charging for that would take money from the creator.
 */
export type PayMessageFreeReason = "subscription" | "reply";
