# Golden demo seed

The fictional 示范茶餐室 (`demo-teahouse`) is defined in [migration 0010](../../supabase/migrations/0010_reset_demo_data.sql). A1 is the public portfolio QR table. A2 and A3 are reserved for back-office use and share the same active table settings.

## Reserved UUIDs

Every ID below starts with `de000010-0000-4000-8000-` followed by the 12-character suffix shown here.

| Entity | UUID suffix |
| --- | --- |
| Store | `000000000001` |
| Logo object | `000000000002` |
| A1 (public) | `000000000010` |
| A2 | `000000000011` |
| A3 | `000000000012` |
| 招牌饭面 | `000000000020` |
| 小食 | `000000000021` |
| 饮料 | `000000000022` |
| 甜品 | `000000000023` |
| Items 0–15 in menu order | `000000000030` through `00000000003f` (hexadecimal, inclusive) |

Item images use their item's UUID for both object names. [manifest.json](manifest.json) maps all nine `menu-images` Storage keys to the PNGs rendered from [the mock logo](../../public/mock/logo.svg) and [dish](../../public/mock/dish.svg). The dish thumbnail is 160 × 160 px. The [reset runner](../../docs/demo-data-reset.md) syncs these files after the database reset.

## Reset

`public.reset_demo_data(p_allowed_emails text[]) returns jsonb` grants execute to `service_role`. It trims, lowercases and deduplicates the whitelist, then requires 1 to 10 unique emails. Every non-null auth email must match the whitelist, including emails on unverified accounts. Each non-golden store must have a whitelisted owner and all its members must be whitelisted. A foreign owner on any store also blocks the reset. Whitelisted users already present in Auth become golden-store owners. Auth users and profiles are preserved.

After the safety checks, the reset deletes eligible leftover stores and their business rows, restores the golden store and menu, and clears the demo store's operational rows and audit history. The result includes the store and public-table IDs, resulting seed counts and deletion counts. The deletion counts for operational rows and audit logs include eligible leftover stores. Each committed reset writes a new scoped audit entry and appends a row to `demo_reset_runs`. Rejected resets raise an error and leave the run history untouched.
