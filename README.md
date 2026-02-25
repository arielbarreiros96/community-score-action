# community-score-action

A reusable GitHub Action that labels pull requests with a tier representing the
PR author's **Contribution Community Score**, encouraging reviewers to
approximately 2× review the lines they open.

## How it works

The action maintains per-user totals within each repository:

| Metric | Description |
|---|---|
| `opened_lines` | Sum of `additions + deletions` for **merged** PRs authored by the user |
| `reviewed_lines` | Sum of `additions + deletions` for PRs where the user submitted a qualifying review |

A **ratio** is computed as `reviewed_lines / max(opened_lines, 1)` and mapped
to a tier:

| Tier | Condition |
|---|---|
| **A** | ratio ≥ 2 |
| **B** | ratio ≥ 1 |
| **C** | ratio ≥ 0.5 |
| **D** | ratio ≥ 0 |

The PR receives exactly one label `community-score:<tier>` (e.g.
`community-score:A`).

State is persisted as JSON on a dedicated branch (`community-score-data` by
default) and is never stored in the default branch.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | **yes** | — | GitHub token with `contents: write` and `pull-requests: write` |
| `data-branch` | no | `community-score-data` | Branch used to persist state JSON |
| `state-path` | no | `.github/community-score/state.json` | Path to the state file on the data branch |
| `label-prefix` | no | `community-score` | Prefix for tier labels (`<prefix>:<tier>`) |
| `review-states` | no | `APPROVED,CHANGES_REQUESTED,COMMENTED` | Qualifying review states |
| `tiers` | no | `A:2,B:1,C:0.5,D:0` | Tier thresholds as `<name>:<min-ratio>` pairs |
| `exclude-self-reviews` | no | `true` | Exclude reviews where reviewer == PR author |

## Outputs

| Output | Description |
|---|---|
| `tier` | The tier letter assigned to the PR author (A/B/C/D) |
| `ratio` | The computed ratio (4 decimal places) |

---

## Setup

### Standard workflow (same-repo PRs)

Create `.github/workflows/community-score.yml` in your target repository:

```yaml
name: Community Score

on:
  pull_request:
    types: [opened, reopened, closed]
  pull_request_review:
    types: [submitted]

# Prevent concurrent runs from corrupting the state file
concurrency:
  group: community-score-${{ github.repository }}
  cancel-in-progress: false

jobs:
  score:
    runs-on: ubuntu-latest
    permissions:
      contents: write       # read/write the data branch
      pull-requests: write  # add/remove labels
      issues: write         # create labels

    steps:
      - uses: arielbarreiros96/community-score-action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Fork-safe workflow (using `pull_request_target`)

> **Security note:** `pull_request_target` runs in the context of the **base
> repository** and grants write access even when the PR comes from a fork. You
> **must not** check out the PR's code (or any code supplied by the contributor)
> in this workflow; the action relies only on the GitHub API and the event
> payload, so no code checkout is required.

```yaml
name: Community Score (fork-safe)

on:
  pull_request_target:
    types: [opened, reopened, closed]
  pull_request_review:
    types: [submitted]

# Prevent concurrent runs from corrupting the state file
concurrency:
  group: community-score-${{ github.repository }}
  cancel-in-progress: false

jobs:
  score:
    runs-on: ubuntu-latest
    permissions:
      contents: write       # read/write the data branch
      pull-requests: write  # add/remove labels
      issues: write         # create labels

    steps:
      - uses: arielbarreiros96/community-score-action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

> **Important:** Do **not** add a `actions/checkout` step with
> `ref: ${{ github.event.pull_request.head.ref }}` in this workflow.
> Checking out untrusted code in a `pull_request_target` job is a known
> supply-chain attack vector.

---

## Concurrency

Because multiple workflow runs may update the state file simultaneously, add a
`concurrency` block to serialize runs:

```yaml
concurrency:
  group: community-score-${{ github.repository }}
  cancel-in-progress: false   # never cancel; always finish processing
```

Setting `cancel-in-progress: false` is important: cancelling a run could leave
the state file in an inconsistent state (e.g., `opened_lines` updated but the
label not yet applied).

---

## Required permissions

| Permission | Reason |
|---|---|
| `contents: write` | Create the data branch and commit state JSON |
| `pull-requests: write` | Add/remove labels on pull requests |
| `issues: write` | Create tier labels if they don't exist |

---

## Advanced configuration

### Custom tiers

```yaml
- uses: arielbarreiros96/community-score-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    tiers: 'S:3,A:2,B:1,C:0.5,D:0'
```

### Allow self-reviews (useful for testing)

```yaml
- uses: arielbarreiros96/community-score-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    exclude-self-reviews: 'false'
```

### Custom data branch and state path

```yaml
- uses: arielbarreiros96/community-score-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    data-branch: 'gh-score-data'
    state-path: 'data/score.json'
```

---

## State file format

```json
{
  "users": {
    "octocat": {
      "opened_lines": 1200,
      "reviewed_lines": 2500,
      "merged_prs": ["PR_kwDO..."],
      "reviewed_prs": ["PR_kwDO...", "PR_kwDO..."]
    }
  }
}
```

`merged_prs` and `reviewed_prs` store node IDs to ensure deduplication even
when workflows are re-run.

---

## License

[MIT](LICENSE)
