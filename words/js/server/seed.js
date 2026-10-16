// Demo venues and rewards for preview mode. The venues are fictional: they
// show what a pilot in Elephant & Castle / SE1 could look like, and are not
// real businesses.
import { londonParts } from '../core/redemption.js';

const MERCHANTS = [
  { key: 'bean', name: 'Castle Bean Coffee (demo)', category: 'coffee', area: 'Elephant & Castle', address: 'Demo venue, Elephant Road, London SE17', lat: 51.4946, lng: -0.1001, description: 'Neighbourhood espresso bar.' },
  { key: 'bakehouse', name: 'Newington Bakehouse (demo)', category: 'food', area: 'Elephant & Castle', address: 'Demo venue, Newington Butts, London SE11', lat: 51.4932, lng: -0.1023, description: 'Sourdough, pastries and lunch.' },
  { key: 'noodle', name: 'Walworth Noodle Bar (demo)', category: 'food', area: 'Walworth', address: 'Demo venue, Walworth Road, London SE17', lat: 51.4885, lng: -0.0951, description: 'Hand-pulled noodles and dumplings.' },
  { key: 'jazz', name: 'The Lantern Jazz Room (demo)', category: 'music', area: 'Elephant & Castle', address: 'Demo venue, London Road, London SE1', lat: 51.4973, lng: -0.1009, description: 'Live jazz six nights a week.' },
  { key: 'stage', name: 'Borough Lane Studio Theatre (demo)', category: 'theatre', area: 'Borough', address: 'Demo venue, Borough Road, London SE1', lat: 51.4985, lng: -0.0989, description: 'New writing in a 90-seat studio.' },
  { key: 'comedy', name: 'Kennington Cellar Comedy (demo)', category: 'comedy', area: 'Kennington', address: 'Demo venue, Kennington Park Road, London SE11', lat: 51.4880, lng: -0.1060, description: 'Stand-up every Thursday to Saturday.' }
];

function londonTonight(now, hh = 23, mm = 0) {
  // Roughly the end of today in London; precise enough for demo data.
  const { minutes } = londonParts(now);
  return new Date(now.getTime() + (hh * 60 + mm - minutes) * 60_000);
}

export function seedState(state, now) {
  const ids = {};
  for (const m of MERCHANTS) {
    const id = crypto.randomUUID();
    ids[m.key] = id;
    const { key, ...rest } = m;
    state.merchants[id] = { id, ...rest, contact_email: `${key}@example.com`, status: 'approved', created_at: now.toISOString(), demo: true };
  }
  const tonight = londonTonight(now);
  const tomorrowNight = new Date(tonight.getTime() + 86_400_000);
  const inAMonth = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const offers = [
    { m: 'bean', title: 'Welcome coffee', description: 'Any regular hot drink, on us. Your first reward.', category: 'coffee', image: '☕', points_price: 300, standard_price_pence: 320, fulfilment_cost_pence: 60, quantity_total: 200, max_per_customer: 1, window_start: '08:00', window_end: '18:00', hold_minutes: 30, terms: 'One per player. Regular size. Dine in or take away.', welcome: true },
    { m: 'bean', title: 'Afternoon flat white', description: 'Beat the 3 pm slump. Quietest hours of the day.', category: 'coffee', image: '☕', points_price: 500, standard_price_pence: 350, fulfilment_cost_pence: 70, quantity_total: 20, max_per_customer: 2, window_start: '14:00', window_end: '17:00', hold_minutes: 30, terms: 'Weekdays 2–5 pm.', days: [1, 2, 3, 4, 5] },
    { m: 'bakehouse', title: 'Pastry upgrade', description: 'Add any pastry to a hot drink.', category: 'food', image: '🥐', points_price: 300, standard_price_pence: 290, fulfilment_cost_pence: 80, quantity_total: 40, max_per_customer: 3, hold_minutes: 30, terms: 'With any hot drink purchase.' },
    { m: 'noodle', title: 'Free dumplings with any bowl', description: 'Six pork or vegetable dumplings with any noodle bowl.', category: 'food', image: '🥟', points_price: 400, standard_price_pence: 650, fulfilment_cost_pence: 140, quantity_total: 25, max_per_customer: 2, window_start: '15:00', window_end: '18:30', hold_minutes: 45, terms: 'Early evening, before the dinner rush.' },
    { m: 'jazz', title: 'Live jazz ticket — tonight', description: 'Standing ticket for the 8 pm set. Spare capacity tonight only.', category: 'music', image: '🎷', points_price: 600, standard_price_pence: 1200, fulfilment_cost_pence: 0, quantity_total: 12, max_per_customer: 2, valid_until: tonight.toISOString(), hold_minutes: 480, terms: 'Show the code at the door. 18+.' },
    { m: 'stage', title: 'Theatre ticket — tomorrow', description: 'Unsold seat for tomorrow’s 7.30 pm performance.', category: 'theatre', image: '🎭', points_price: 1200, standard_price_pence: 2200, fulfilment_cost_pence: 0, quantity_total: 8, max_per_customer: 1, valid_until: tomorrowNight.toISOString(), hold_minutes: 1440, terms: 'Best available seat, allocated at the box office.' },
    { m: 'comedy', title: 'Comedy night entry', description: 'Entry to any Thursday–Saturday show this month.', category: 'comedy', image: '🎤', points_price: 800, standard_price_pence: 1000, fulfilment_cost_pence: 0, quantity_total: 30, max_per_customer: 2, valid_until: inAMonth, hold_minutes: 240, terms: 'Subject to capacity on the night. 18+.', days: [4, 5, 6] }
  ];
  for (const o of offers) {
    const id = crypto.randomUUID();
    const { m, ...rest } = o;
    state.offers[id] = {
      id, merchant_id: ids[m], days: null, window_start: null, window_end: null, valid_from: null, valid_until: null,
      ...rest, status: 'active', funding: 'merchant', created_at: now.toISOString()
    };
  }
}
