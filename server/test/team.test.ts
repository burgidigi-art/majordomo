import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '../../shared/types.ts';
import { teamOf } from '../../web/src/team.ts';

// The sidebar's team list: what each crew member is shown doing, and what a click opens.

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const crew = [
  { id: 'social', name: 'Social', runtime: 'openai' },
  { id: 'office', name: 'Back office', runtime: 'claude-code' },
  { id: 'research', name: 'Research', runtime: 'claude-code' },
];

let seq = 0;
function task(crewId: string, fields: Partial<Task>): Task {
  seq += 1;
  return {
    id: `T-${seq}`,
    projectId: 'P-1',
    parentId: null,
    title: `Task ${seq}`,
    brief: '',
    status: 'queued',
    crewId,
    crewName: crew.find((c) => c.id === crewId)?.name ?? crewId,
    runtime: 'claude-code',
    model: '',
    effort: null,
    dependsOn: [],
    statusLine: '',
    result: '',
    error: '',
    attempt: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costIncluded: true,
    createdAt: NOW - 60 * MIN,
    startedAt: null,
    finishedAt: null,
    ...fields,
  };
}

const member = (tasks: Task[], id: string) => teamOf(crew, tasks, NOW).find((m) => m.id === id)!;

test('every crew member is listed, including the ones with nothing to do', () => {
  const team = teamOf(crew, [], NOW);
  assert.deepEqual(
    team.map((m) => [m.name, m.state, m.line, m.target]),
    [
      ['Social', 'idle', 'No work yet', null],
      ['Back office', 'idle', 'No work yet', null],
      ['Research', 'idle', 'No work yet', null],
    ],
  );
});

test('a working member shows its task and how long it has run, and a click opens that task', () => {
  const t = task('social', { title: 'Draft 5 Instagram captions', status: 'running', startedAt: NOW - 3 * MIN - 5_000 });
  const m = member([t], 'social');
  assert.equal(m.state, 'working');
  assert.equal(m.line, 'Draft 5 Instagram captions');
  assert.equal(m.time, '3m 05s');
  assert.equal(m.target?.id, t.id);
});

test('with several tasks at once, the longest-running is shown and the rest are counted', () => {
  const newer = task('social', { title: 'Newer', status: 'running', startedAt: NOW - MIN });
  const older = task('social', { title: 'Older', status: 'running', startedAt: NOW - 5 * MIN });
  const m = member([newer, older], 'social');
  assert.equal(m.line, 'Older · +1 more');
  assert.equal(m.live, 2);
  assert.equal(m.target?.id, older.id);
});

test('a member waiting for an answer comes before its other work', () => {
  const running = task('office', { title: 'Reconcile receipts', status: 'running', startedAt: NOW - 9 * MIN });
  const waiting = task('office', { title: 'Which account is rent?', status: 'waiting', startedAt: NOW - 2 * MIN });
  const m = member([running, waiting], 'office');
  assert.equal(m.state, 'waiting');
  assert.equal(m.target?.id, waiting.id);
  assert.equal(m.line, 'Which account is rent? · +1 more');
});

test('queued work shows as up next, oldest first', () => {
  const later = task('research', { title: 'Second', createdAt: NOW - MIN });
  const first = task('research', { title: 'First', createdAt: NOW - 2 * MIN });
  const m = member([later, first], 'research');
  assert.equal(m.state, 'queued');
  assert.equal(m.line, 'First · +1 more');
});

test('a failed last task is flagged until there is new work', () => {
  const failed = task('research', { title: 'Scrape trends', status: 'failed', startedAt: NOW - 20 * MIN, finishedAt: NOW - 10 * MIN });
  assert.equal(member([failed], 'research').state, 'trouble');
  assert.equal(member([failed], 'research').line, 'Scrape trends · failed');

  const retry = task('research', { title: 'Scrape trends again', status: 'running', startedAt: NOW - MIN });
  assert.equal(member([failed, retry], 'research').state, 'working');
});

test('an idle member says when it last finished, and a click opens that task', () => {
  const old = task('office', { status: 'done', startedAt: NOW - 5 * 3600_000, finishedAt: NOW - 4 * 3600_000 });
  const recent = task('office', { status: 'done', startedAt: NOW - 3 * 3600_000, finishedAt: NOW - 2 * 3600_000 });
  const m = member([old, recent], 'office');
  assert.equal(m.state, 'idle');
  assert.equal(m.line, 'Last done 2h ago');
  assert.equal(m.target?.id, recent.id);
});

test('a member removed from the crew stays in view while it still has work running', () => {
  const orphan = task('gone', { crewName: 'Old helper', title: 'Still going', status: 'running', startedAt: NOW - MIN });
  const finished = task('also-gone', { crewName: 'Older helper', status: 'done', finishedAt: NOW - MIN });
  const team = teamOf(crew, [orphan, finished], NOW);
  assert.deepEqual(
    team.map((m) => m.name),
    ['Social', 'Back office', 'Research', 'Old helper'],
  );
});
