# Semantics v0

This document records the minimum concepts required by the first reconciliation spike.

## Entity

A provider-neutral identity for one semantic subject. External IDs never become canonical IDs implicitly.

## External binding

Maps a canonical entity and canonical property paths to one provider representation. Each mapped field declares read/write capability.

## Candidate value

A value observed from one bound external source, with observation time and source revision/provenance.

## Authority rule

Defines how a canonical property is selected. v0 supports explicit provider priority and freshest-observation fallback.

## Conflict

A first-class result produced when equal-precedence candidates disagree. A conflict blocks mutation for that property.

## Reconciliation plan

A deterministic, side-effect-free plan containing canonical state, conflicts, and provider mutations required for convergence.

Execution, retries, compensation, subscriptions, and distributed transactions are intentionally outside v0.
