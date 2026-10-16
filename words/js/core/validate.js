// Input validation shared by the preview server and the Edge Function, so a
// request is accepted or refused the same way in both.
import { ApiError } from './errors.js';

export const CATEGORIES = ['coffee', 'food', 'drinks', 'music', 'theatre', 'comedy', 'experience', 'other'];
export const OFFER_STATUSES = ['draft', 'active', 'paused', 'ended'];

export const bad = (code, details) => new ApiError(400, code, undefined, details);

export function str(v, { min = 0, max = 200, field = 'value' } = {}) {
  const s = typeof v === 'string' ? v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  if (s.length < min || s.length > max) throw bad('invalid_request', `${field}: ${min}–${max} characters`);
  return s;
}
export function int(v, { min = 0, max = 1e9, field = 'value' } = {}) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad('invalid_request', `${field}: whole number from ${min} to ${max}`);
  return v;
}
export function optInt(v, opts) {
  return v === null || v === undefined || v === '' ? null : int(v, opts);
}
export function optTime(v, field) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad('invalid_request', `${field}: HH:MM`);
  return v;
}
export function optDate(v, field) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad('invalid_request', `${field}: a date and time`);
  return d.toISOString();
}

export function email(v, field = 'email') {
  const e = str(v, { min: 3, max: 200, field }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('invalid_request', `${field}: a valid address`);
  return e;
}

export function displayName(v) {
  const name = str(v, { min: 2, max: 24, field: 'display_name' });
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(name)) throw bad('invalid_request', "display_name: letters, numbers, spaces and . _ ' - only");
  return name;
}

export function referralCode(v) {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return /^[A-Z0-9]{4,12}$/.test(s) ? s : null;
}

export function merchantInput(body, fallbackEmail) {
  return {
    name: str(body.name, { min: 2, max: 80, field: 'name' }),
    category: CATEGORIES.includes(body.category) ? body.category : 'other',
    description: str(body.description ?? '', { max: 400, field: 'description' }),
    area: str(body.area || 'Elephant & Castle', { min: 2, max: 60, field: 'area' }),
    address: str(body.address, { min: 5, max: 200, field: 'address' }),
    contact_email: email(body.contact_email || fallbackEmail, 'contact_email')
  };
}

/** Offer fields from a create/update request. Throws ApiError on anything invalid. */
export function offerInput(body) {
  const fields = {
    title: str(body.title, { min: 3, max: 80, field: 'title' }),
    description: str(body.description ?? '', { max: 500, field: 'description' }),
    category: CATEGORIES.includes(body.category) ? body.category : 'other',
    image: str(body.image || '🎁', { max: 300, field: 'image' }),
    points_price: int(body.points_price, { min: 50, max: 100000, field: 'points_price' }),
    standard_price_pence: optInt(body.standard_price_pence, { max: 1e7, field: 'standard_price_pence' }),
    fulfilment_cost_pence: optInt(body.fulfilment_cost_pence, { max: 1e7, field: 'fulfilment_cost_pence' }),
    quantity_total: int(body.quantity_total, { min: 1, max: 100000, field: 'quantity_total' }),
    max_per_customer: optInt(body.max_per_customer, { min: 1, max: 100, field: 'max_per_customer' }),
    valid_from: optDate(body.valid_from, 'valid_from'),
    valid_until: optDate(body.valid_until, 'valid_until'),
    days: Array.isArray(body.days) && body.days.length ? [...new Set(body.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort() : null,
    window_start: optTime(body.window_start, 'window_start'),
    window_end: optTime(body.window_end, 'window_end'),
    hold_minutes: optInt(body.hold_minutes, { min: 5, max: 1440, field: 'hold_minutes' }),
    terms: str(body.terms ?? '', { max: 1000, field: 'terms' })
  };
  if (fields.days && !fields.days.length) fields.days = null;
  if (fields.image && !/^https:\/\//.test(fields.image) && [...fields.image].length > 4) throw bad('invalid_request', 'image: an emoji or an https:// URL');
  if ((fields.window_start === null) !== (fields.window_end === null)) throw bad('invalid_request', 'window: set both start and end, or neither');
  if (fields.valid_from && fields.valid_until && fields.valid_until <= fields.valid_from) throw bad('invalid_request', 'valid_until must be after valid_from');
  return fields;
}
