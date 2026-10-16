// Yield engine, Phase 1: rules-based. A merchant sets price bands by
// capacity utilisation; given the current utilisation the engine suggests
// whether to release spare capacity, how many units and at what WORDS price.
// It only recommends. Nothing is released unless the merchant applies it, or
// has switched on auto-apply for that rule beforehand.

export const DEFAULT_BANDS = Object.freeze([
  { below: 30, points: 300 },
  { below: 50, points: 500 },
  { below: 70, points: 800 }
  // at or above 70%: no automatic offer
]);

export function validateRule(rule) {
  const errors = [];
  const bands = rule?.bands;
  if (!Array.isArray(bands) || bands.length === 0 || bands.length > 8) errors.push('bands: 1 to 8 bands');
  else {
    let prev = 0;
    for (const b of bands) {
      if (!Number.isInteger(b.below) || b.below <= prev || b.below > 100) errors.push('bands: "below" must rise from 1 to 100');
      if (!Number.isInteger(b.points) || b.points < 1 || b.points > 100000) errors.push('bands: points from 1 to 100000');
      prev = b.below;
    }
  }
  if (!Number.isInteger(rule?.capacity) || rule.capacity < 1 || rule.capacity > 100000) errors.push('capacity: whole number from 1');
  if (!Number.isInteger(rule?.target_utilisation) || rule.target_utilisation < 1 || rule.target_utilisation > 100) errors.push('target_utilisation: 1 to 100');
  if (!Number.isInteger(rule?.max_units) || rule.max_units < 1 || rule.max_units > 10000) errors.push('max_units: 1 to 10000');
  return [...new Set(errors)];
}

/**
 * Recommendation for a utilisation percentage (0–100).
 * Returns {action: 'release'|'hold', points_price, quantity, band, reason}.
 */
export function recommend(rule, utilisation) {
  if (!Number.isFinite(utilisation) || utilisation < 0 || utilisation > 100) throw new Error('utilisation must be 0–100');
  const band = rule.bands.find((b) => utilisation < b.below) ?? null;
  if (!band) return { action: 'hold', points_price: null, quantity: 0, band: null, reason: 'utilisation_above_bands' };
  const spare = Math.floor(((rule.target_utilisation - utilisation) / 100) * rule.capacity);
  const quantity = Math.min(rule.max_units, spare);
  if (quantity < 1) return { action: 'hold', points_price: null, quantity: 0, band, reason: 'at_target' };
  return { action: 'release', points_price: band.points, quantity, band, reason: 'spare_capacity' };
}
