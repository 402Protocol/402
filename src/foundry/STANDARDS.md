# Foundry Launch Standards

The rules every agent launch through Foundry follows. Phase 1 scope: the
safety wrapper, these standards, and the reputation schema. No real launches
happen in Phase 1.

## 1. ERC-8004 identity gate — no ID, no launch

Every launch, fee claim, and ETH send through Foundry is bound to the
launching agent's ERC-8004 identity. The gate is enforced in the service
layer: a request without a valid ERC-8004 id is rejected before it is even
recorded.

The permission lives on the identity, not the wallet. A wallet can be thrown
away; the identity carries the agent's whole history — every launch, every
fee claimed, every win and every rug accrues to one id. Fresh wallets cannot
launder a track record.

## 2. dryRun-first discipline

`foundry_prepare_launch` is the only way to preview a launch, and it forces
`dryRun: true` on the underlying call. It returns the full unsigned
transaction plus a simulation without signing anything. The caller cannot
switch dryRun off — the flag belongs to the wrapper, not the caller.

The workflow is always: prepare (dry run) → request (pending approval) →
human approve → execute. Skipping the dry run is not possible through
Foundry.

## 3. Human approval on every real action

The underlying launcher signs and broadcasts with zero confirmation gates,
so Foundry never exposes its dangerous tools directly. `foundry_request_*`
writes a pending row to the approvals table and returns a plain-words
summary of what approving would do. `foundry_approve` is the single path by
which a real transaction can be signed — and it is human-only.

No unsupervised launches, ever. The approvals table is the audit trail:
every real action has a row, a decider, and a timestamp.

## 4. Capped launch-only wallets + the backup ritual

A program with a key can spend everything that key holds. The launch wallet
holds launch money and nothing else:

1. Create a fresh wallet for launches only.
2. Back the key up to durable secret storage IMMEDIATELY.
3. Reload the key from that storage and prove the backup reproduces the
   wallet before funding.
4. Fund it with the launch budget only — enough for the launch fee plus gas,
   never a treasury.

Never reuse a treasury, payroll, or personal wallet as a launch wallet.
Never put a key in chat, code, logs, or docs.

## 5. Disclosure rule

The 90% opening anti-snipe tax is standard practice; disclosure is enough.
Every Foundry launch publishes, in plain words, before it goes live:

- preset and modules used
- opening snipe tax
- base fee + hook tax breakdown (who gets what: creator / protocol / holders)
- quote pair
- dev buy, if any
- fee payout target

A launch that cannot state its own economics does not launch.

## 6. What Foundry does not do

- No custom launch contracts. The hook infra is the launch layer; Foundry is
  the agent path to it.
- No human launches. Agents only — that exclusivity is the position.
- Nothing public before legal review. No real launches without explicit
  human approval, twice over: the approval row and the ritual.
