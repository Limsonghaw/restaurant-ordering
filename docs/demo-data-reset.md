# Reset the public demo data

The reset runner restores the golden demo store, three tables, four categories, and 16 menu items. It clears orders, bills, and other demo activity. The default reset preserves Auth users and profiles and does not change passwords. Keep the demo account password out of the repository and this document.

## Configure the manual workflow

Song Haw should enter these secret values himself in **GitHub Settings → Secrets and variables → Actions**.

| Secret name | Value to configure |
| --- | --- |
| `DEMO_SUPABASE_URL` | HTTPS origin of the dedicated demo Supabase project |
| `DEMO_SUPABASE_SERVICE_ROLE_KEY` | Service-role credential for that project |
| `DEMO_ALLOWED_PROJECT_REF` | Project reference that matches the Supabase URL |
| `DEMO_ALLOWED_USER_EMAILS` | Comma- or whitespace-separated whitelist of 1 to 10 unique emails. The intended production example is `restaurantorderingdemo@gmail.com`. Every Auth email must be on this list. |
| `DEMO_QR_SIGNING_SECRET` | Same value as the live Worker's `QR_SIGNING_SECRET`, so the portfolio table URL verifies |

Set `DEMO_SITE_URL` as a **repository variable**. Use the public site's HTTP(S) origin with no path or trailing slash.

Create the GitHub Environment named `demo-reset` before relying on it. Add required reviewers there if you want an approval gate for dispatches. To dispatch, open **Actions → Reset demo data → Run workflow** and enter exactly `reset-demo-data` in **confirm**.

## Verify in an isolated, disposable Supabase project

1. Apply the migrations in filename order. Create only the demo Auth user.
2. Add fictional dirty rows such as changed menu items and orders. Add extra objects under `de000010-0000-4000-8000-000000000001/` in the `menu-images` bucket.
3. Set the environment variables for that isolated project and run `node scripts/reset-demo-data.mjs` twice. After each run, check the seed counts and [reserved IDs](../scripts/demo-seed/README.md), the menu contents, and `qr_version = 1` on A1. Verify that the golden-store Storage keys match the [manifest](../scripts/demo-seed/manifest.json) exactly.
4. Add an unlisted Auth email and rerun. Confirm the command fails and leaves business data, reset history, and Storage unchanged.
5. Supply 11 unique whitelist emails and confirm rejection before any mutation, with no new database reset history.

The database reset commits before Storage sync starts. A Storage failure exits nonzero and reports that the database reset already committed. After resolving the Storage issue, rerun against the same isolated project to restore and verify all manifest objects.

## Get the public table URL

Set `DEMO_QR_SIGNING_SECRET` and `DEMO_SITE_URL` and run `node scripts/reset-demo-data.mjs --print-table-urls`. This command signs A1 locally. The URL also appears in successful reset logs when both variables are configured.

A1 is the public portfolio table. Every reset restores the same store ID, table ID, and `qr_version = 1`, so the URL stays stable across resets with the same site origin and signing secret.

## Live rollout

Merging this PR does not deploy the Worker, write the live database, or enable a daily schedule. The first live reset and enabling `schedule: 0 20 * * *` (04:00 Malaysia time) each need separate approval.
