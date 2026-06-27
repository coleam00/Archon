# Storyboard Extension

**Use when:** Page has multiple sketches (multi-step flows, state changes, transitions)

**Base:** Start with [page-specification.template.md](page-specification.template.md)

---

## What Changes

### 1. Add State Flow Overview (before Page Sections)

After Reference Materials, add:

```markdown
## State Flow Overview

{Brief description of states}

![Overview](Sketches/{page-number}-{page-name}-Overview.jpg)

┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ STATE 1 │───▶│ STATE 2 │───▶│ STATE 3 │
└─────────────┘ └─────────────┘ └─────────────┘

| State | Name   | Visual       | Entry     | Actions   |
| ----- | ------ | ------------ | --------- | --------- |
| **1** | {name} | {color/icon} | {trigger} | {actions} |
| **2** | {name} | {color/icon} | {trigger} | {actions} |
```

---

### 2. State 1 = Normal Page Specification

Document State 1 using the standard page spec structure:

- Page Sections
- Objects with OBJECT IDs
- Groups with nested objects

This is the **baseline** that other states reference.

---

### 3. States 2+ = Differences Only

After State 1, add for each additional state:

```markdown
# State 2: {State Name} — Differences from State 1

![State 2](Sketches/{page-number}-{page-name}-2-{state-name}.jpg)

> **The Story:** {User experience narrative}

| Property | Value                         |
| -------- | ----------------------------- |
| Purpose  | {what this state does}        |
| Entry    | {trigger from previous state} |
| Previous | State 1                       |
| Next     | State 3 / {options}           |

### Changes from State 1

| OBJECT ID       | Change   | Details        |
| --------------- | -------- | -------------- |
| `{existing-id}` | Modified | {what changed} |
| `{existing-id}` | Hidden   | {why hidden}   |
| `{new-id}`      | Added    | {new element}  |

### State 2 Elements

{Only document NEW objects not in State 1}

#### {New Object}

**OBJECT ID:** `{page-name}-{new-object}`

| Property        | Value                 |
| --------------- | --------------------- |
| Component       | [{Component}]({path}) |
| Translation Key | `{key}`               |
| SE              | "{text}"              |
| EN              | "{text}"              |
```

---

## Key Principles

1. **State 1 is baseline** — fully documented
2. **States 2+ show only changes** — reuse OBJECT IDs
3. **Same IDs across states** — `booking-detail-header` stays the same, just describe what changed
4. **New elements get new IDs** — only in the state they first appear
