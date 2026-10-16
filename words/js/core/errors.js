// API errors shared by the preview server, the client and the Edge Function.
// `code` is stable and machine-readable; `message` is for people.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable error code
   * @param {string} [message]
   * @param {unknown} [details]
   */
  constructor(status, code, message = MESSAGES[code] ?? code, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const MESSAGES = {
  unauthorised: 'Please sign in.',
  forbidden: "You don't have access to that.",
  not_found: "We couldn't find that.",
  invalid_request: 'Something in that request was not right.',
  account_suspended: 'This account is suspended. Contact support if you think this is a mistake.',
  profile_required: 'Choose a display name first.',
  already_played: "You've already played today's challenge. A new one starts at midnight.",
  session_closed: 'This game has finished.',
  invalid_path: 'Letters must touch, and each tile can be used once per word.',
  not_a_word: "That's not in today's word list.",
  duplicate_word: 'You already found that one.',
  too_short: 'Words need at least 3 letters.',
  insufficient_points: "You don't have enough WORDS for this reward yet.",
  offer_not_active: 'This reward is not available right now.',
  merchant_unavailable: 'This venue is not taking redemptions right now.',
  not_started: 'This reward is not available yet.',
  ended: 'This reward has ended.',
  outside_window: 'This reward is only available at the times shown.',
  sold_out: 'This reward has sold out.',
  limit_reached: "You've reached the limit for this reward.",
  invalid_code: "That code isn't valid.",
  already_redeemed: 'This code has already been used.',
  expired: 'This code has expired. The points went back to the player.',
  cancelled: 'This reservation was cancelled.',
  merchant_not_approved: 'Your venue is waiting for approval.',
  inventory_below_claimed: "You can't reduce the quantity below the rewards already reserved or redeemed.",
  rate_limited: 'Too many requests. Please wait a moment.',
  idempotency_conflict: 'That request was already made with different details.',
  ai_unavailable: 'Word explanations are not available right now.'
};
