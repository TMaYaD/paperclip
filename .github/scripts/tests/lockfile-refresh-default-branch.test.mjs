import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkTemplate } from '../check-pr-template.mjs';
import { checkLinkedIssue } from '../check-pr-linked-issue.mjs';
import { checkDedupSearch } from '../check-pr-dedup-search.mjs';
import { checkTestCoverage } from '../check-pr-test-coverage.mjs';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const workflow = readFileSync(new URL('../../workflows/refresh-lockfile.yml', import.meta.url), 'utf8');

test('refresh supports main and master while checking out only the repository default branch', () => {
  assert.match(workflow, /branches:\n      - master\n      - main/);
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch' \|\| github.ref_name == github.event.repository.default_branch/);
  assert.match(workflow, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github.ref/);
});

test('refresh PR lookup and creation explicitly target the default branch', () => {
  assert.match(workflow, /BASE_BRANCH: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(workflow, /gh pr list --state open --base "\$BASE_BRANCH" --head "\$BRANCH"/);
  assert.match(workflow, /gh pr create \\\n\s+--head "\$BRANCH" \\\n\s+--base "\$BASE_BRANCH"/);
});

test('manual dispatch cannot automatically merge the generated repair', () => {
  const mergeStep = workflow.split('      - name: Enable auto-merge for lockfile PR\n')[1];
  assert.ok(mergeStep);
  assert.match(mergeStep, /if: github.event_name == 'push' && steps.upsert-pr.outputs.pr_url != ''/);
});

test('generated bot PR satisfies the existing quality gates and uses valid shell', () => {
  const body = workflow.match(/<<'BODY'\n([\s\S]*?)\n          BODY\n/)?.[1]
    .split('\n').map(line => line.replace(/^          /, '')).join('\n');
  assert.ok(body);
  const title = 'chore(lockfile): refresh pnpm-lock.yaml';
  const files = [{ filename: 'pnpm-lock.yaml', status: 'modified' }];
  for (const result of [checkTemplate(body), checkLinkedIssue(body, title), checkDedupSearch(body, title),
    checkTestCoverage(files, title), checkLockfile(files, 'github-actions[bot]', 'chore/refresh-lockfile')]) {
    assert.equal(result.passed, true, JSON.stringify(result.failures));
  }
  const script = workflow.split('      - name: Create or update pull request\n')[1]
    .split('        run: |\n')[1].split('\n      - name:')[0]
    .split('\n').map(line => line.replace(/^          /, '')).join('\n');
  execFileSync('bash', ['-n'], { input: script });
});
