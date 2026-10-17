# HackHarvard demo script

## Three-minute version

### 0:00–0:20 — The problem

Say: “A browser agent can find a Cancel button. That does not mean policy allows the
user to press it. Bureaucracy Slayer turns observed website content into evidence-bound,
guidance-only decisions—and refuses to guess when the evidence is incomplete.”

On screen: point to **Evidence-bound**, **Fail-closed**, and **Guidance only**.

### 0:20–0:55 — A verified route

Select **Verified fixture** and **Dynamic replanning**, then click **Analyze website**.

Say: “This hand-checked fixture is our controlled successful case: scheduled, standard,
and processing has not begun. The real evidence validator, three-valued evaluator, and
dependency planner produce these two safe guidance steps. Nothing is executed.”

Point to **Safe route found**, Open transfer details, Cancel transfer, and the
`autoExecutable: false` message.

### 0:55–1:15 — Exact evidence

Open **View supporting evidence (2)** under Cancel transfer.

Say: “The recommendation is bound to exact captured text, including: ‘Scheduled
transfers may be canceled before processing begins.’ Exact matching proves provenance;
it is not a claim of universal or legal correctness.”

### 1:15–1:55 — Guided counterfactual

In **Guided**, open **Review or change earlier answers**, choose **Change** for Transfer
method, then choose **instant**.

Say: “One answer changes the decision. The observed Cancel button still exists, but the
Instant-transfer prohibition activates. Cancellation moves to `PROHIBITED`, and the safe
route becomes Contact support.”

Point to **Original vs updated route** and say: “Snapshot unchanged, evidence unchanged,
no Claude call, no browser collection. Replanning is deterministic and local.”

### 1:55–2:30 — Real-model refusal

Select **Recorded Sonnet extraction**, then **Analyze website**.

Say: “This is a genuine saved Sonnet extraction—not the hand-checked fixture. We replay
its immutable snapshot and model through independent validation. Sonnet found relevant
procedures, but its cancellation permission omitted an operative ‘standard’ qualifier.”

Point to **Human review required**, **Evidence rejected**, and the Semantic review text.

Say: “So the system withholds both cancellation and recovery guidance. User answers
cannot clear an evidence gate. Refusal is a product result, not an error.”

### 2:30–2:50 — Live lifecycle, with no paid call

Select **Live Sonnet extraction** and click **Start live extraction** only after the
mock-only probe has passed.

Say: “For this offline judging run, Live is a deterministic sanitized mock of that
recorded result. It demonstrates the real queued, collection, extraction, validation,
and recovery UI without making a paid model call.”

If time is tight, do not wait—switch back to Recorded and say it is the deterministic
fallback. Never imply the mock response was generated live by Sonnet.

### 2:50–3:00 — Close

Say: “The differentiator is separation of powers: a model proposes a structured policy
and procedure map; hashes, source bindings, semantic audit, evaluation, and planning
decide whether it is usable. Bureaucracy Slayer helps an agent know not only where it
can click, but when it should stop.”

## 60-second fallback

### 0:00–0:10

Say: “Browser agents see controls. Bureaucracy Slayer checks policy evidence before it
offers guidance, and every step is non-executable.”

### 0:10–0:30

In **Verified fixture → Dynamic replanning**, click **Analyze website** and open the
Cancel transfer citation.

Say: “Scheduled, Standard, and not-processing yields a verified two-step route tied to
this exact source text.”

### 0:30–0:45

In **Guided**, change Transfer method to **instant**.

Say: “The same button is now prohibited. The route changes locally—no Claude call and no
new browser collection.”

### 0:45–0:58

Select **Recorded Sonnet extraction** and click **Analyze website**.

Say: “This real saved Sonnet model omitted a mandatory qualifier, so independent
Semantic Audit forces human review and withholds the action.”

### 0:58–1:00

Say: “We combine model flexibility with deterministic, evidence-first refusal.”

## Presenter truth rules

- Fixture is hand-checked and is the only ready-cancellation demo.
- Recorded is genuine prior Sonnet output; it is intentionally review-required.
- Live mock is deterministic, sanitized, and makes no Anthropic call.
- Exact citation matching proves captured provenance, not legal correctness.
- Bureaucracy Slayer gives guidance only and never submits a financial action.
