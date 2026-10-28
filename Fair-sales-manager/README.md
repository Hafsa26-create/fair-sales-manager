# Fair Sales Manager PWA

Mobile-first installable app for multiple jewellery fairs, using Supabase Auth, Postgres RLS and Realtime. Existing ecommerce tables are not used by this app. `config.js` contains only a browser-safe publishable key; never add a service-role key.

## Setup
1. Host all files on HTTPS (GitHub Pages works).
2. In Supabase Authentication URL Configuration, add the deployed URL as a redirect URL/site URL as needed.
3. Enable email/password sign-up. If confirmation is enabled, confirm both accounts before sign-in.
4. Owner creates an account, signs in, creates a fair, then adds categories and their buying prices.
5. Employee creates a separate account. Owner enters the employee's registered email in Add employee.
6. Employee signs in on their Android phone and records sales. Owner dashboard listens for new sales.

## Android install
Open the HTTPS website in Chrome > menu ⋮ > Install app or Add to Home screen.

## Notes
Test with sample data before relying on it for a live fair. Employee cannot read buying costs, expense records or the owner sales report through database RLS. Product costs are stored per fair. This is an initial working version and should be further tested before commercial use.
