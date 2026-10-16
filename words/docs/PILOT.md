# WORDS pilot — operating instructions

Pilot: Elephant & Castle / SE1 · 100–500 players · 5–10 venues · 8 weeks.

## Before launch

1. Deploy the backend (`supabase/README.md`) and put its URL and anon key in `js/config.js`.
2. Make the operations team admins. Turn on MFA for them.
3. Set the earning rules in **Admin → Rules** (defaults: welcome 250, complete 100, target 25, personal
   best 25, referral 100, daily cap 250).
4. Publish the first week of challenges in **Admin → Challenges** (or let them generate automatically
   each day). Check each grid's word list for anything unsuitable.
5. Onboard venues (below). Make sure at least one **welcome reward priced 300 or less**, available all day,
   is live from day one.
6. Test the full journey yourself at each venue with a real phone: reserve, scan, confirm.

## Onboarding a venue (30 minutes)

1. The owner signs up at `/words/merchant/` and registers the venue.
2. An admin approves it in **Admin → Merchants**.
3. With the owner, create 2–4 offers. For each, agree:
   - the **WORDS price** (start from the yield bands: quiet-time items 300–500, tickets 600–1,200),
   - the **normal price** and the **cost to provide it** (so the pilot can measure economics),
   - **quantity**, **per-player limit**, **days and hours**, and **how long a code stays valid**
     (30 minutes for counter items; until the event for tickets),
   - plain-English **conditions**.
4. Add staff accounts (SQL in `supabase/README.md`) and show staff how to validate:
   scan the customer's QR with the phone camera (it opens the validation page), check the reward shown,
   press **Confirm and redeem**. If scanning fails, type the 10-character code.
5. Put the counter card up: "Play WORDS, get this free".

## Daily checks (10 minutes)

- **Admin → Overview:** completions today, redemptions, open fraud signals.
- **Admin → Fraud:** review new signals. Fast play or very high word coverage suggests automation:
  look at the player's ledger and games, then dismiss, or confirm and suspend + adjust.
- **Admin → Redemptions → reserved:** anything stuck near expiry at a venue that reports a problem.
- Venues with offers sold out or ended: prompt them to add stock or use **Yield**.

## Resolving problems

| Situation | Action |
|---|---|
| Venue honoured a reward but couldn't validate (no signal) | Admin → Redemptions → **Mark redeemed**, reason "validated offline" |
| Venue couldn't honour a reserved reward | Admin → Redemptions → **Release points** |
| Reward redeemed but the item was wrong / unavailable | **Refund** |
| Player says points are missing | Admin → Players → player → ledger. Every change has a reason and key. Adjust with a reason if needed. |
| Suspected bot or multiple accounts | Suspend the account (reason), adjust away unearned points, note it in the fraud signal |
| Offer is misleading or a venue misbehaves | Admin → Offers → **Suspend**, or suspend the venue. Existing reservations stay redeemable unless released. |

## Measuring the pilot (brief §13)

| Metric | Source |
|---|---|
| Registered players, completions, first-redemption rate | Admin → Overview |
| Day-1 / Day-7 retention | SQL on `game.sessions` (first `game_id` per player vs later days) |
| Median time to first redemption | `identity.players.created_at` → first `market.redemptions.validated_at` |
| QR validation success | redeemed ÷ (redeemed + expired at the venue's request + admin "mark redeemed") |
| Incremental revenue | Venue performance page: verified redemptions, reported spend, estimated value. Keep verified and reported apart in any report. |
| Points liability | Admin → Overview: outstanding points and their estimated cost |

Weekly: export the numbers, interview two venues, and review whether the offers are bringing new
customers at quiet times (the core question for the pilot).
