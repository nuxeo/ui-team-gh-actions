/**
(C) Copyright Nuxeo Corp. (http://nuxeo.com/)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
const core = require('@actions/core');
const github = require('@actions/github');

let octokit;
const SETUP_WF_LABEL = 'Remote Caller ID';
// How long to keep polling for the dispatched run's identifying job before giving up, and how long
// to wait between polls. Expressed as an explicit time budget (rather than derived from the number
// of runs returned) so that narrowing the candidate list — e.g. adding `per_page` — cannot silently
// shrink the window in which a late handshake is still tolerated.
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_POLL_MS = 5000;

function sleep(milliseconds) {
  return new Promise((r) => setTimeout(r, milliseconds));
}

/**
 * Get the workflow runs for the provided workflow id, optionally narrowed by server-side filters
 * (e.g. event, branch, created).
 */
async function getWorkflowRuns(owner, repo, workflowID, filters = {}) {
  const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflowID,
    ...filters,
  });
  return runs.workflow_runs;
}

/**
 * Get the run that was triggered using the dispatch event.
 *
 * Polls until one of the candidate runs exposes our identifying `${SETUP_WF_LABEL} <id>` handshake
 * job, or until the time budget is exhausted. The candidate list is rescanned from the top on every
 * pass because the handshake job is frequently not registered yet on the first pass: a
 * cancel-in-progress concurrency group on the callee delays job scheduling by ~25-41s, so it is
 * usually a later pass that finds it. Returns undefined on timeout so the caller's `if (!run)`
 * guard can fail the action cleanly.
 */
async function getWorkflowRun(owner, repo, workflowID, srcWfRunID, filters = {}) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runs = await getWorkflowRuns(owner, repo, workflowID, filters);
    for (const activeRun of runs) {
      const { data: wfJobs } = await octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: activeRun.id,
      });
      if (wfJobs.jobs.some((j) => j.name === `${SETUP_WF_LABEL} ${srcWfRunID}`)) {
        return activeRun;
      }
    }
    await sleep(DEFAULT_POLL_MS);
  }
  return undefined;
}

/**
 * Create a new workflow run using the dispatch event.
 */
async function dispatchWorkflowRun(owner, repo, workflowID, branchName, inputs) {
  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflowID,
    ref: branchName,
    inputs,
  });
  core.info('Workflow run triggered successfully.');
}

/*
 * Wait for the workflow run to finish.
 */
async function waitForWorkflowRun(owner, repo, run, pollInterval) {
  let { conclusion, status, id} = run;
  do {
    await sleep(pollInterval);
    // get the workflow run using the id
    const runReq = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: id,
    });
    run = runReq.data;
    ({ conclusion, status } = run);
    core.info(`Workflow status: ${status}`);
    core.info(`Check run details ${run.html_url}`);
  } while (conclusion === null && status !== 'completed');
  return { conclusion, status };
}

async function run() {
  try {
    // Get the action inputs.
    const accessToken = core.getInput('access-token');
    const workflowID = core.getInput('workflow-id');
    const branchName = core.getInput('branch-name');
    const owner = core.getInput('owner');
    const repo = core.getInput('repo');
    const pollInterval = Number.parseInt(core.getInput('poll-interval'));
    const workflowInputs = core.getMultilineInput('inputs');

    // create a octokit instance with the provided access token
    octokit = github.getOctokit(accessToken);
    const context = github.context;

    // set runId for tracking purposes
    const srcWfRunID = `${context.runId}-${Date.now().toString()}`;
    // setup the workflow inputs
    let inputs = {
      caller_id: srcWfRunID,
    };
    workflowInputs.forEach((input) => {
      const exprs = input.split(':');
      inputs[exprs[0].trim()] = `${exprs[1].trim()}`;
    });

    // Narrow the candidate runs to the ones this dispatch could have created: same event and
    // branch, created no earlier than just before we dispatched (a 30s buffer absorbs client/server
    // clock skew). Deliberately NOT filtering on status: a run held back by the callee's
    // concurrency group is `queued`, which is exactly the delayed-handshake case this polling
    // exists to handle.
    const since = new Date(Date.now() - 30 * 1000).toISOString();

    // trigger the remote workflow using the dispatch event
    await dispatchWorkflowRun(owner, repo, workflowID, branchName, inputs);

    // get the run we just created using the dispatch event
    const filters = { event: 'workflow_dispatch', branch: branchName, created: `>=${since}` };
    const run = await getWorkflowRun(owner, repo, workflowID, srcWfRunID, filters);
    if (!run) {
      core.setFailed(`No run was found for id ${context.runId}`);
      return;
    }
    core.info(`\u001b[1mRun URL ${run.html_url}`);

    // wait for the called workflow to finish
    core.startGroup('Workflow run in progress');
    const { conclusion, status } = await waitForWorkflowRun(owner, repo, run, pollInterval);
    core.endGroup();

    if (conclusion === 'success' && status === 'completed') {
      core.info(`Workflow ${status} with ${conclusion}`);

      // get the output of the run if any is available
      const { data: wfJobs } = await octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: run.id,
      });
      // get the result job
      const job = wfJobs.jobs.find((j) => j.name.startsWith('Result: '));
      if (job) {
        core.setOutput('message', job.name.replace('Result: ', ''));
      }
    } else {
      core.setFailed(`Workflow ${status} with ${conclusion}.`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
