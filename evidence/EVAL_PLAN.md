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
- 2026-11-20 03:45 IST: a partial-refund path was added to the contract, with a second, labelled attack list (evidence/attacks-2.json, 12 attacks + 2 valid cases) committed (da8f0f3) before any run against it. The first list is unchanged.
- 2026-11-20 03:50 IST: valid case PV2 (refund 1 sat) can't exist on chain: a 1-sat output is below the 546-sat dust limit. Kept as written and marked not applicable; PV3 (refund 546 sats) added as the smallest possible partial refund.

## Second plan: real nodes, a differential fuzzer and mutation testing (written 2026-11-20 19:40 IST, before any run of these)
This section was written and committed before any of the three runs below existed. Nothing above it changed.

### Question
1. Do real Bitcoin Cash nodes refuse the attack transactions from evidence/attacks.json and evidence/attacks-2.json when they are built from real chipnet coins and signed with real keys (the shop's hot refund key included), not only the local VM?
2. On randomly mutated purchases, refunds and partial refunds, does the contract's verdict always match an independent model of the written rules (the contract header and the README), and is every rule-breaking mutant refused?
3. Is every check in ReceiptMinter.cash needed: if any single `require` is removed, does at least one attack or fuzz case then get through?

### Metric and threshold
1. k of n attack transactions refused by a chipnet Electrum server (Fulcrum in front of a node), with the node's own reply saved for each, plus the signed raw transaction so anyone can rebroadcast it. Threshold: k = n. Attacks that need a token category that can't exist on a real chain are rebuilt with a real category we mint ourselves (a fake shop), or marked not applicable with the reason. The same run on mainnet once the mainnet shop exists.
2. n = 20,000 mutated transactions from seed 20261122 (one to three random mutations of a valid template each). Metric (a): disagreements between the contract (BCH 2026 VM) and the model, split into "contract accepted what the model says breaks a rule" (a security hole) and "contract refused what the model allows" (too strict). Metric (b): k of n rule-breaking mutants refused, Wilson 95% interval. Threshold: zero security-hole disagreements; too-strict ones are reported with their cause.
3. Mutation score: k of n single-`require` deletions killed (some attack or fuzz case gets through, or a valid case fails). Threshold: none; every surviving mutant is listed with the reason it survives (an equivalent check, or a gap we then close with a new labelled attack).

### Data and split
Lists 1 and 2 are unchanged. Fuzz mutations come only from the seed and the generator in the repo; the seed is fixed here. Fuzz cases are generated, not hand-picked, and none is dropped after the run. New attack ideas found by the fuzzer or the mutants go into a third labelled list (evidence/attacks-3.json), never merged into lists 1 and 2.

### Limits written in advance
The model of the rules is written by the same team as the contract, so a misunderstanding shared by both would not show up. Chipnet coins have no monetary value. Mutation testing deletes whole checks only; it does not try subtler edits.
- 2026-11-20 19:55 IST (real-node run, plan above): the first chipnet run of scripts/real-attacks.mjs built only 25 of the 46 attacks: our script's fee estimate used too low a fee for its own size check, and one server dropped connections. All 25 that reached the nodes were refused. We fixed the script (a larger fee for the size estimate, retries for unreachable servers) and reran the whole list once; evidence/real-node-chipnet.json is that second run (2026-11-20 19:51 IST). The attack definitions did not change between runs.
