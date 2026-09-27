// =============================================================================
// GENHUB - Username rules (format, normalisation, reserved names)
//
// A username is the one name on an account that nobody else may take. displayName
// is free text and two accounts can share it, so it cannot stop somebody from
// passing as another person; a unique, quoted handle can.
//
// The rules live here, in one place, for the same reason the canonical secret
// comparison does: the signup form, the change-username form, the API and the
// migration all have to agree, and a rule written twice is a rule that drifts.
// =============================================================================

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

/** Lowercase letters, digits and underscore only. No dots, no dashes, no '@'. */
export const USERNAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * Names that must never belong to a normal account.
 *
 * Two kinds are in here, and both matter:
 *
 *   * Brand and infrastructure words — `genhub`, `admin`, `api`, `www` — that a
 *     person could use to make an account look like ours. A handle is shown with
 *     an `@` and quoted in replies; `@genhub` reads as an official voice.
 *   * Role and flow words — `support`, `official`, `moderator`, `staff` — that a
 *     scammer would pick first.
 *
 * Reserved names are refused case-insensitively (everything is lowercased before
 * the check), so `Admin` and `ADMIN` are the same refusal.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "root",
  "superuser",
  "sysadmin",
  "system",
  "genhub",
  "freebuff",
  "official",
  "support",
  "help",
  "helpdesk",
  "staff",
  "team",
  "moderator",
  "mod",
  "security",
  "abuse",
  "dmca",
  "legal",
  "billing",
  "payments",
  "wallet",
  "creator",
  "creators",
  "viewer",
  "viewers",
  "user",
  "users",
  "account",
  "accounts",
  "profile",
  "settings",
  "login",
  "signin",
  "signup",
  "register",
  "logout",
  "api",
  "www",
  "app",
  "mail",
  "email",
  "noreply",
  "no_reply",
  "contact",
  "info",
  "news",
  "faq",
  "about",
  "terms",
  "privacy",
  "privacy_policy",
  "2257",
  "anonymous",
  "me",
  "you",
  "null",
  "undefined",
  "none",
]);

/**
 * Prefixes that are never allowed either. Reserving only the exact words above
 * leaves `genhub_support`, `admin_hq` and `official_genhub` free — the same
 * impersonation through a different door — so these are refused at the front of
 * any handle.
 */
const RESERVED_PREFIXES = [
  "genhub",
  "admin",
  "support",
  "official",
  "moderator",
  "staff",
  "system",
  "security",
];

/**
 * Fold input to the stored form: trim, drop a leading `@`, lowercase.
 *
 * Only rewriting; it does not judge. Validation is a separate step so the caller
 * can both normalise what a person typed and then explain exactly what is wrong
 * with it, instead of silently turning `John.Doe` into something they did not ask
 * for.
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/** True when the (already normalised) handle is reserved. */
export function isReservedUsername(username: string): boolean {
  const value = normalizeUsername(username);
  if (RESERVED_USERNAMES.has(value)) return true;
  return RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * The reason a normalised handle is not allowed, or null when it is fine.
 *
 * Deliberately a short user-facing sentence: it is rendered next to the field,
 * so it says what to fix rather than naming a rule.
 */
export function usernameFormatError(username: string): string | null {
  const value = normalizeUsername(username);
  if (value.length < USERNAME_MIN_LENGTH) {
    return `Your username must be at least ${USERNAME_MIN_LENGTH} characters`;
  }
  if (value.length > USERNAME_MAX_LENGTH) {
    return `Your username cannot be longer than ${USERNAME_MAX_LENGTH} characters`;
  }
  if (!USERNAME_PATTERN.test(value)) {
    return "Use only lowercase letters, numbers and underscores";
  }
  if (isReservedUsername(value)) {
    return "That username is reserved — please choose another";
  }
  return null;
}

/**
 * The name to show for an account, everywhere a name is shown.
 *
 * The @handle wins when there is one, because it is the name nobody else can
 * take — showing the free-text display name first is what let two accounts look
 * identical. displayName is still the fallback so a legacy row (or a response
 * from an API that predates this) renders a name instead of an empty line.
 */
export function displayHandle(
  user:
    | { username?: string | null; displayName?: string | null }
    | null
    | undefined,
  fallback = "Genhub user"
): string {
  if (!user) return fallback;
  if (user.username) return `@${user.username}`;
  return user.displayName || fallback;
}

/** A short, user-facing summary of the rules, for the form's helper text. */
export const USERNAME_RULES_HINT =
  `${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters · lowercase letters, ` +
  "numbers and underscores only · must be unique";
