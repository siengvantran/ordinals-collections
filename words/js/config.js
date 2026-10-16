// WORDS configuration. Leave supabaseUrl empty to run in preview mode: the
// whole app works in this browser only, with demo venues, and nothing is
// sent anywhere. Fill both values in once the WORDS backend is deployed
// (see supabase/README.md).
export const CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  // Path the app is served from (GitHub Pages: /words/).
  basePath: '/words/',
  programmeTermsVersion: '2026-10-16',
  supportEmail: 'hello@example.com'
};

export const PREVIEW = !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey;
