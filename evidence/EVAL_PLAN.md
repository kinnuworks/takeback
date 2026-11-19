# Evaluation plan

This plan is written and committed before any evaluation run. The commit hash and time of this file show that the question, the data, the baseline and the success rule were fixed before any result existed. If something has to change after a run, the change goes under "Changes after the first run" with its reason, and the original lines stay as they were.

There are no real users in this evaluation. Nobody was recruited, messaged or contacted for it, and our own traffic counts as testing, never as usage.

## Question
Does the Takeback receipt contract refuse every refund that breaks its rules (more than the receipt, a second refund of the same receipt, a refund to anyone but the receipt holder, an underpaid purchase that still mints a receipt), while letting every valid purchase and refund through?

## Metric and threshold
- Metric: (a) k of n rule-breaking transactions rejected, over a fixed attack list run against the contract on the real BCH virtual machine (libauth) and, for a subset, broadcast attempts on mainnet from wallets we control; (b) k of n valid purchase + refund pairs accepted, on mainnet from wallets we control; (c) seconds from refund broadcast to the refund being seen by the payer's address on an Electrum server, per mainnet refund.
- Threshold: (a) every attack rejected (k = n); (b) every valid pair accepted (k = n); (c) reported as measured, no threshold.
- Interval: 95%, from `python3 evidence/interval.py` (Wilson for k of n, bootstrap for a mean or a difference)

## Data
- Dataset: our own generated attack list (evidence/attacks.json, written before the first run) and our own mainnet test transactions; no third-party data.
- Version or hash: the commit that adds evidence/attacks.json, before any run.
- Split: attacks are fixed in evidence/attacks.json before the contract's final version; new attack ideas found later are added as a separate, labelled second list, never silently merged.

## Baseline
- Whose: n/a for (a) and (b) (a rule check, not a comparison). For context only: a plain BCH payment has no refund path at all, and processor refunds are sent by hand to an address the customer types (CoinGate merchant refunds, https://coingate.com/merchant-refunds).

## Success rule
(a) k = n with n >= 30 attack cases, reported with the Wilson 95% interval from evidence/interval.py; (b) k = n with n >= 5 mainnet pairs; any failure is reported next to the successes and fixed in a new, labelled version.

## Models and seeds
- Models: none
- Seeds: attack keys and order ids derived from the fixed seed 20261122

## How results are reported
Every result names its kind at first mention, gives n, the source, the period and a 95% interval, and links its rerun command and commit. Measured numbers and estimates are kept apart, and failures are shown next to successes.

| Kind | Label at first mention | Travels with the number | Never used for this kind |
|---|---|---|---|
| Replay on public data | Back-test on public data (<dataset>, <years>) | n records, source and licence, period, whose baseline, 95% interval, rerun command and commit | `users`, `patients helped`, `customers`, `pilot`, `deployed with`, `proven`, `clinically validated` |
| Estimate from a replay | Estimate, not an observed result | the assumptions, and the data fields used to price it | `impact achieved`, `saved X hours for users`, `lives saved` |
| Real public system | Test transactions from wallets we control (addresses listed), or replayed in our own forks | counts, links, addresses | `users`, `volume`, `traction` |
| Break test | Our own break test (we tried to make it fail) | what we tried, how many attempts, what broke and what we fixed | `users`, `testers`, `validated` |

The README and the submission text open their evidence section with one line before any number:

> Evidence, stated plainly: no real users yet; it was built for this hackathon. Instead: <a back-test on <dataset> against <published baseline>>, <test transactions from wallets we control>, <our own break test of <the main claim>>. Each one reruns from the repo with one command.

Then one card per claim:

> Claim: <product> <does k of n <cases>> at <budget>.
> Evidence type: <label from the table above>, not real users.
> Data: <dataset, link, licence>, <period>, <n rows>. Baseline: <source> scores <x> on the same split.
> Result: <y> (95% interval <a> to <b>).
> Rerun: `<command>` at commit <hash>. Limits: <historical data, no live behaviour; any specific skew>.

Then a short limits paragraph, in numbers: zero real users, the interval, the data's years, and the next real test, with the metric and threshold that would change the conclusion.

## Changes after the first run
<None yet. Each change: the date, what changed, and why.>
