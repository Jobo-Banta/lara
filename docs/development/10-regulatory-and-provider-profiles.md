# Regulatory profiles and provider qualification

## Boundary

This specification defines the executable rule model and adapter inputs. It deliberately does not invent BIR schema versions, filing credentials, bank formats, statutory rates or a provider contract. An enabled live profile must carry the actual reviewed artifacts. Synthetic demo fixtures are invalid for legal use and cannot be promoted into approved live profiles.

## Rule profile contract

`RuleProfile` contains ID/version, jurisdiction, entity/taxpayer/institution applicability, book/currency scope, effective interval `[from,to)`, transaction date basis, source evidence/hash, reviewer and approval timestamp, calculation rules, required fields, allowed correction types, document series/wording/QR rules, reporting applicability/deadline, form-schema mappings and retention references. Versions are immutable after approval; deactivation affects future selection, not historical snapshots.

Rule evaluation order: verify profile applicability → choose effective version by approved date basis → validate required facts → evaluate ordered predicates → compute basis/rate/amount → apply rounding → validate arithmetic and output → snapshot rule/facts/result. Zero matching required rules is an error; multiple equally specific matching rules is `AMBIGUOUS_RULE`, never “first database row wins.”

Allowed predicate AST nodes: `all`, `any`, `not`, `eq`, `in`, `gte`, `lt`, `exists`; leaf fields come from a versioned allowlist such as party tax status, document kind, item category, transaction date, income category and instrument remaining maturity. Allowed arithmetic nodes: decimal constant, allowlisted field, add/subtract/multiply/divide, min/max, named tier-table lookup and currency rounding. Division by zero and missing fact fail. AST depth max 12, node count max 200; no loops, arbitrary functions, SQL, JS, network or filesystem. Expression text is not executable input.

Amounts carry basis provenance and source IDs. Rules can propose a treatment but evidence deficiency cannot be auto-resolved by a model. A manual exception requires authorized policy, reason, evidence and reviewer; it is not a silent override of a statutory required field.

## Form mapping artifact

Each form/return/schema version declares field name, type, length/scale, required condition, allowed codes, source query/version, aggregation/filter period, sign convention, rounding, validation messages, cross-field controls, serialization encoding and expected sample checksum. A mapping cannot supply zero for unavailable inputs. Golden fixtures cover positive, zero/exempt, mixed, amendment, boundary date and rejection scenarios appropriate to the form. Tax reviewer approves results and acceptance evidence from the official validator/provider where available.

P07 implements the mapper/validator and the selected forms as complete features. Each form remains disabled until its concrete mapping artifact is checked into the controlled artifact registry. A certified output never uses a placeholder layout merely because the engine works. External filing acknowledgement is a separate uploaded/returned record with source evidence.

## E-invoice adapter qualification

Required artifacts: taxpayer/profile coverage evidence; sandbox/production endpoints; schema and signing specification; canonicalization algorithm; required key/certificate handling; idempotency/query capabilities; error/status taxonomy; timeout/rate limits; deadline rules; certification outcome; contingency procedure; support owner and escalation. LARA signs/transmits only through the versioned adapter. Keys stay in qualified key storage; audit uses key identifier and signature, not private material.

If the provider lacks reliable idempotency or lookup, uncertain submission is a manual reconciliation hold. Do not infer retry safety. Every accepted/rejected result must retain an authentic response reference and payload hash. Every provider version runs the common commit/send/ack failure tests. A “local-only provider” restriction or PTI rule is enforced only from verified effective authority for that taxpayer.

## Bank and source adapter qualification

Record accepted file/API version, encoding, decimal/date conventions, identifier normalization, manifest/control totals, duplicate rules, signed/encrypted transport, authorizations, acknowledgement meaning and correction process. Test a real representative redacted or authorized synthetic sample supplied by the institution. Reference adapters demonstrate behavior; they do not certify every local bank.

Payroll/marketplace/POS source adapters define source system of record, cutoff, gross/net/fee/withholding reconciliation and retained evidence. E-wallet payment references are identifiers, not evidence of settled funds without provider/bank confirmation. No full payroll calculation is introduced by a journal import.

## Activation record

For each tenant capability store phase/build/schema version, approved rule profile, external credentials reference, qualification evidence, customer obligation matrix, opening reconciliation, role training, recovery evidence, approving controller/tax/security/operations identities and activation time. Activation fails if any required item is absent/expired or if capability dependencies are not active. Deactivation stops new commands/sends as appropriate and preserves read/correction/reconciliation access.

## Decisions outstanding outside engineering

Actual pilot institution, source files, legal profile, current BIR artifacts and credentials, cloud region/accounts, qualified AI/channel/bank providers and any DCP reuse contract remain accountable owner inputs. Their absence is recorded as a named activation blocker. The internal schemas, deterministic calculation interpreter, error behavior and workflow are specified and can be built/tested now.
