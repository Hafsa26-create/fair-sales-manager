# Fair Sales Manager — Launch Checklist

This checklist is the release gate for the live app. Static checks and database configuration are not a substitute for testing with the actual owner and employee accounts on their phones.

## Configuration completed

- [x] Supabase Realtime publication includes `public.fair_sales_entries`.
- [x] Foreign-key indexes added for the 12 relationships previously reported by Supabase Performance Advisor.
- [x] The service worker only removes old `fair-sales-static-*` caches owned by this app.
- [x] Pending offline sales are no longer silently deleted during login or fair refresh. Sync is restricted to fairs currently assigned to the signed-in employee.
- [x] Deleting old-fair pending sales requires an explicit confirmation.
- [x] Employee workspace has mobile-first input, button, spacing, and recent-sales styling.
- [x] Static validation and JavaScript syntax checks are configured in GitHub Actions.

## Required owner + employee acceptance tests

Use separate real owner and employee accounts. Use a temporary/test fair and clearly marked test sales; do not create test transactions in a live fair.

1. Owner signs in, creates a test fair, sets dates, rent, lunch allowance, and a non-default commission rate.
2. Owner adds a product code, buying price, display name, and default selling price.
3. Employee signs in on an Android phone, selects the test fair and product, changes the selling price, enters quantity, and saves a sale.
4. Confirm the owner sees the sale in the correct fair and the employee sees only their own recent sales.
5. Confirm employee screens and database access do not expose buying costs, owner expenses, commission, or profit.
6. Confirm the owner report uses the fair's configured commission rate consistently in all daily and employee summaries.
7. Confirm inventory, purchase history, stock adjustments, personal sales, expenses, corrections, and fair totals reconcile with the test transactions.
8. Turn off the employee phone's internet, enter a test sale, close/reopen the app, restore internet, and confirm the sale syncs exactly once.
9. While a test sale is pending offline, remove the employee from the test fair. Confirm the pending sale is retained locally and is not silently deleted. Reassign the employee and verify the sale can sync; separately test the explicit cleanup confirmation.
10. Test refresh, logout/login, switching fairs, and app restart on both devices.
11. Repeat the main sale-entry and report checks in desktop Chrome and mobile Chrome.

## Remaining account-level security setting

- Enable leaked-password protection in Supabase Authentication password/security settings. The Supabase Security Advisor currently reports this as disabled.
- The 17 SECURITY DEFINER advisor warnings were reviewed at the function-definition level. The app's RPC functions are granted to authenticated users and include sign-in, owner, membership, or own-sale checks as appropriate. Do not revoke these grants blindly: the app calls these RPCs. Re-test authorization with separate owner and employee accounts before changing them.
- `fair_sales_correction_requests` intentionally has no direct table policy and is accessed through checked RPC functions. Verify that direct employee/anon table reads remain denied.

## Release sign-off

Do not call the release fully verified until all owner/employee acceptance tests above pass on the real devices and the GitHub Actions run is green. Record the test date, device/browser, and any failed steps before using the app for another live fair.
