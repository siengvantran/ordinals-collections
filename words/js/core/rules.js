// Earning rules. Every value here is a default: the live values are stored in
// the database (loyalty.rules) and edited from the admin dashboard.

export const DEFAULT_RULES = Object.freeze({
  welcome_bonus: 250,         // once per player, so a first reward is reachable on day one
  complete_daily: 100,        // completing the daily challenge
  target_score: 25,           // reaching the day's target score
  personal_best: 25,          // beating your previous best daily score
  sponsored_challenge: 50,    // completing a sponsored challenge
  referral: 100,              // to the referrer, after the friend completes a daily challenge
  daily_game_cap: 250,        // most WORDS earned from gameplay per London day
  referral_monthly_cap: 10,   // most referral rewards per referrer per calendar month
  reservation_minutes: 30,    // default hold for a reserved reward
  expiry_inactive_days: 365   // balances expire after this long with no activity
});

export const RULE_LIMITS = Object.freeze({
  welcome_bonus: [0, 1000],
  complete_daily: [0, 1000],
  target_score: [0, 500],
  personal_best: [0, 500],
  sponsored_challenge: [0, 1000],
  referral: [0, 1000],
  daily_game_cap: [0, 5000],
  referral_monthly_cap: [0, 100],
  reservation_minutes: [5, 1440],
  expiry_inactive_days: [30, 1095]
});

/** Merge a patch into rules, rejecting unknown keys and out-of-range values. */
export function applyRulesPatch(rules, patch) {
  const out = { ...rules };
  for (const [k, v] of Object.entries(patch ?? {})) {
    const lim = RULE_LIMITS[k];
    if (!lim) throw new Error(`unknown rule: ${k}`);
    if (!Number.isInteger(v) || v < lim[0] || v > lim[1]) throw new Error(`${k} must be a whole number from ${lim[0]} to ${lim[1]}`);
    out[k] = v;
  }
  return out;
}

/**
 * Points earned for finishing a daily challenge.
 *   score: the server-computed game score
 *   target: the challenge's target score
 *   previousBest: best earlier daily score, or null for a first game
 *   sponsored: whether the challenge is sponsored
 *   earnedToday: gameplay WORDS already earned today (London day)
 * Returns [{kind, points}] in issue order, trimmed to the daily cap.
 * Awards trimmed to zero are left out.
 */
export function gameAwards(rules, { score, target, previousBest, sponsored = false, earnedToday = 0 }) {
  const wanted = [['complete_daily', rules.complete_daily]];
  if (score >= target) wanted.push(['target_score', rules.target_score]);
  if (previousBest !== null && previousBest !== undefined && score > previousBest) wanted.push(['personal_best', rules.personal_best]);
  if (sponsored) wanted.push(['sponsored_challenge', rules.sponsored_challenge]);
  let room = Math.max(0, rules.daily_game_cap - earnedToday);
  const out = [];
  for (const [kind, pts] of wanted) {
    const points = Math.min(pts, room);
    if (points > 0) out.push({ kind, points });
    room -= points;
  }
  return out;
}

/** Idempotency keys: one per thing that can earn, so retries never double-issue. */
export const keys = {
  welcome: (userId) => `welcome:${userId}`,
  game: (kind, userId, gameId) => `game:${kind}:${userId}:${gameId}`,
  referral: (referredUserId) => `referral:${referredUserId}`,
  reserve: (redemptionId) => `reserve:${redemptionId}`,
  release: (redemptionId) => `release:${redemptionId}`,
  redeem: (redemptionId) => `redeem:${redemptionId}`,
  refund: (redemptionId) => `refund:${redemptionId}`
};
