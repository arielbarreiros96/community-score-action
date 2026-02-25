const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  const token = core.getInput('github-token', { required: true });
  const dataBranch = core.getInput('data-branch');
  const statePath = core.getInput('state-path');
  const labelPrefix = core.getInput('label-prefix');
  const reviewStatesInput = core.getInput('review-states');
  const tiersInput = core.getInput('tiers');
  const excludeSelfReviews = core.getInput('exclude-self-reviews') === 'true';

  const octokit = github.getOctokit(token);
  const context = github.context;
  const { owner, repo } = context.repo;

  // Parse review states
  const reviewStates = reviewStatesInput
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // Parse tiers (sort descending by threshold so first match wins)
  const tiers = tiersInput
    .split(',')
    .map((t) => {
      const [name, threshold] = t.split(':');
      return { name: name.trim(), threshold: parseFloat(threshold.trim()) };
    })
    .sort((a, b) => b.threshold - a.threshold);

  const eventName = context.eventName;
  const payload = context.payload;

  core.info(`Event: ${eventName}, action: ${payload.action}`);

  let pr;
  let prAuthor;

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    pr = payload.pull_request;
    prAuthor = pr.user.login;
  } else if (eventName === 'pull_request_review') {
    pr = payload.pull_request;
    prAuthor = pr.user.login;
  } else {
    core.warning(`Unsupported event: ${eventName}. Supported events: pull_request, pull_request_target, pull_request_review`);
    return;
  }

  // Ensure data branch exists before loading state
  await ensureBranch(octokit, owner, repo, dataBranch);

  // Load state from data branch
  const state = await loadState(octokit, owner, repo, dataBranch, statePath);

  // Process event
  if ((eventName === 'pull_request' || eventName === 'pull_request_target') && payload.action === 'closed' && pr.merged) {
    // Update opened_lines for PR author on merge
    const prId = String(pr.node_id);
    ensureUser(state, prAuthor);

    if (!state.users[prAuthor].merged_prs.includes(prId)) {
      const lines = (pr.additions || 0) + (pr.deletions || 0);
      state.users[prAuthor].merged_prs.push(prId);
      state.users[prAuthor].opened_lines += lines;
      core.info(`Updated opened_lines for ${prAuthor}: +${lines} (total: ${state.users[prAuthor].opened_lines})`);
    } else {
      core.info(`PR ${prId} already counted for ${prAuthor}, skipping`);
    }
  } else if (eventName === 'pull_request_review' && payload.action === 'submitted') {
    const review = payload.review;
    const reviewer = review.user.login;
    const reviewState = (review.state || '').toUpperCase();

    if (!reviewStates.includes(reviewState)) {
      core.info(`Review state "${reviewState}" not in qualifying states [${reviewStates.join(', ')}], skipping`);
    } else if (excludeSelfReviews && reviewer === prAuthor) {
      core.info(`Skipping self-review by ${reviewer} on their own PR`);
    } else {
      const prId = String(pr.node_id);
      ensureUser(state, reviewer);

      if (!state.users[reviewer].reviewed_prs.includes(prId)) {
        const lines = (pr.additions || 0) + (pr.deletions || 0);
        state.users[reviewer].reviewed_prs.push(prId);
        state.users[reviewer].reviewed_lines += lines;
        core.info(`Updated reviewed_lines for ${reviewer}: +${lines} (total: ${state.users[reviewer].reviewed_lines})`);
      } else {
        core.info(`Reviewer ${reviewer} already credited for PR ${prId}, skipping`);
      }
    }
  } else {
    core.info(`No state update needed for event "${eventName}" / action "${payload.action}"`);
  }

  // Persist updated state
  await saveState(octokit, owner, repo, dataBranch, statePath, state);

  // Compute tier for PR author and apply label
  ensureUser(state, prAuthor);
  const userState = state.users[prAuthor];
  const ratio = userState.reviewed_lines / Math.max(userState.opened_lines, 1);
  const tier = tiers.find((t) => ratio >= t.threshold) || tiers[tiers.length - 1];

  core.info(
    `Author ${prAuthor}: opened_lines=${userState.opened_lines}, reviewed_lines=${userState.reviewed_lines}, ratio=${ratio.toFixed(4)}, tier=${tier.name}`
  );

  const desiredLabel = `${labelPrefix}:${tier.name}`;
  await ensureLabel(octokit, owner, repo, desiredLabel);
  await applyTierLabel(octokit, owner, repo, pr.number, labelPrefix, desiredLabel);

  core.setOutput('tier', tier.name);
  core.setOutput('ratio', ratio.toFixed(4));
}

/**
 * Ensure a user entry exists in state with default values.
 */
function ensureUser(state, login) {
  if (!state.users[login]) {
    state.users[login] = {
      opened_lines: 0,
      reviewed_lines: 0,
      merged_prs: [],
      reviewed_prs: [],
    };
  }
}

/**
 * Load state JSON from the data branch, returning empty state on first run.
 */
async function loadState(octokit, owner, repo, branch, path) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    // Ensure structure is valid
    if (!parsed.users || typeof parsed.users !== 'object') {
      parsed.users = {};
    }
    return parsed;
  } catch (error) {
    if (error.status === 404) {
      core.info(`State file not found at ${path} on branch ${branch}, starting fresh`);
      return { users: {} };
    }
    throw error;
  }
}

/**
 * Save state JSON to the data branch, creating or updating the file.
 */
async function saveState(octokit, owner, repo, branch, path, state) {
  const content = Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64');

  let sha;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    sha = data.sha;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: 'chore: update community score state [skip ci]',
    content,
    branch,
    sha,
  });

  core.info(`State saved to ${branch}:${path}`);
}

/**
 * Ensure the data branch exists; create it from the default branch head if missing.
 */
async function ensureBranch(octokit, owner, repo, branch) {
  try {
    await octokit.rest.repos.getBranch({ owner, repo, branch });
    core.info(`Data branch "${branch}" already exists`);
  } catch (error) {
    if (error.status === 404) {
      const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
      const defaultBranch = repoData.default_branch;

      const { data: refData } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
      });

      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: refData.object.sha,
      });

      core.info(`Created data branch "${branch}" from "${defaultBranch}"`);
    } else {
      throw error;
    }
  }
}

/**
 * Ensure a label exists in the repository; create it if missing.
 */
async function ensureLabel(octokit, owner, repo, name) {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name });
  } catch (error) {
    if (error.status === 404) {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name,
        color: 'ededed',
        description: 'Community contribution score tier',
      });
      core.info(`Created label: ${name}`);
    } else {
      throw error;
    }
  }
}

/**
 * Remove any existing community-score tier labels and add the desired one.
 */
async function applyTierLabel(octokit, owner, repo, prNumber, prefix, desiredLabel) {
  const { data: currentLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: prNumber,
  });

  // Remove stale tier labels
  for (const label of currentLabels) {
    if (label.name.startsWith(`${prefix}:`) && label.name !== desiredLabel) {
      await octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: prNumber,
        name: label.name,
      });
      core.info(`Removed stale label: ${label.name}`);
    }
  }

  // Add desired label if not already present
  const alreadyLabeled = currentLabels.some((l) => l.name === desiredLabel);
  if (!alreadyLabeled) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [desiredLabel],
    });
  }

  core.info(`Applied label "${desiredLabel}" to PR #${prNumber}`);
}

run().catch((error) => {
  core.setFailed(error.message);
});
