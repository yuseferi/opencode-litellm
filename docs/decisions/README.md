# Architecture Decision Records

This directory captures architecturally significant decisions for
`opencode-plugin-litellm` using the
[MADR](https://adr.github.io/madr/) (Markdown Any Decision Records) format.

One decision per file. Records are immutable once accepted — if a decision
is revised, a new ADR supersedes it and the old one's status is updated.

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-sdk-native-auth.md) | SDK-native auth resolution via plugin hooks | Proposed |

## Adding a new ADR

1. Copy the most recent ADR as a template.
2. Increment the four-digit prefix (`0002-…`).
3. Set `Status: Proposed` and fill in Context, Decision, Alternatives
   Considered, and Consequences.
4. Open a PR. Status moves to `Accepted` on merge.
5. To revise a past decision, create a new ADR with
   `Supersedes: 000N-old-title` and update the old record's status to
   `Superseded by 000N`.

## Status values

| Status | Meaning |
|---|---|
| `Proposed` | Under discussion, not yet merged |
| `Accepted` | Merged and in effect |
| `Superseded by 000N` | Replaced by a later ADR; kept for historical context |
| `Deprecated` | No longer relevant; kept for historical context |
