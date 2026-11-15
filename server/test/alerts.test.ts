import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Task } from '../../shared/types.ts';
import { tempHome } from './helpers.ts';

tempHome();
const { alerts, _testHooks } = await import('../alerts.ts');
const { telegram } = await import('../gateways/telegram.ts');

// Telling the user when something needs them: a macOS notification and, for failures, the phone.

let ran: { command: string; args: string[] }[] = [];
let phone: string[] = [];
telegram.alert = (text: string) => void phone.push(text);

beforeEach(() => {
  ran = [];
  phone = [];
  _testHooks({ run: (command, args) => void ran.push({ command, args }), platform: 'darwin' });
  alerts.set({ mac: true, phoneFailures: true });
});

function task(fields: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    projectId: 'P-1',
    parentId: null,
    title: 'Draft 5 Instagram captions',
    brief: '',
    status: 'failed',
    crewId: 'social',
    crewName: 'Social',
    runtime: 'openai',
    model: '',
    effort: null,
    dependsOn: [],
    statusLine: 'Failed',
    result: '',
    error: 'The API key was refused (401)\n    at somewhere deep',
    attempt: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costIncluded: false,
    createdAt: 0,
    startedAt: 0,
    finishedAt: 1,
    ...fields,
  };
}

/** The title and text of the notification osascript was asked to show. */
const shown = () => ran.map((r) => r.args.slice(-2));

test('an approval waiting on the user posts a Mac notification with a sound', () => {
  alerts.needsApproval(task({ status: 'waiting', crewName: 'Back office' }), 'rm -rf build/');
  assert.equal(ran.length, 1);
  assert.equal(ran[0]!.command, 'osascript');
  assert.ok(ran[0]!.args.join(' ').includes('sound name "Glass"'));
  assert.deepEqual(shown(), [['Majordomo · needs your approval', 'Back office wants to run a command: rm -rf build/']]);
  assert.deepEqual(phone, [], 'approvals reach the phone through their own Allow / Decline message, not this one');
});

test('a failed task notifies the Mac and the phone, with the first line of the error', () => {
  alerts.taskFailed(task());
  assert.deepEqual(shown(), [["Majordomo · Social's task failed", 'Draft 5 Instagram captions — The API key was refused (401)']]);
  assert.equal(phone.length, 1);
  assert.ok(phone[0]!.includes('Draft 5 Instagram captions'));
  assert.ok(phone[0]!.includes('The API key was refused (401)'));
  assert.ok(!phone[0]!.includes('at somewhere deep'), 'no stack trace on the phone');
});

test('a helper failing inside a task is left to the agent that started it', () => {
  alerts.taskFailed(task({ parentId: 'T-0' }));
  assert.deepEqual(ran, []);
  assert.deepEqual(phone, []);
});

test('each kind of alert can be switched off', () => {
  alerts.set({ mac: false });
  alerts.taskFailed(task());
  alerts.needsApproval(task(), 'ls');
  assert.deepEqual(ran, [], 'no Mac notifications');
  assert.equal(phone.length, 1, 'the phone still hears about the failure');

  alerts.set({ mac: true, phoneFailures: false });
  alerts.taskFailed(task());
  assert.equal(ran.length, 1);
  assert.equal(phone.length, 1, 'and now it does not');
});

test('Mac notifications are only attempted on a Mac', () => {
  _testHooks({ run: (command, args) => void ran.push({ command, args }), platform: 'linux' });
  alerts.needsApproval(task(), 'ls');
  assert.deepEqual(ran, []);
  assert.equal(alerts.status().macSupported, false);
});

test('the settings survive and are reported', () => {
  alerts.set({ mac: false, phoneFailures: false });
  assert.deepEqual(alerts.status(), { macSupported: true, mac: false, phoneFailures: false });
});

test('the notification text is passed as data, so quotes in it cannot break the script', () => {
  alerts.needsApproval(task(), `echo "hi" && say 'done'`);
  const args = ran[0]!.args;
  assert.equal(args[args.length - 3], '--');
  assert.ok(args[args.length - 1]!.includes(`echo "hi" && say 'done'`));
  assert.ok(!args.slice(0, -3).some((a) => a.includes('echo')), 'never inside the script itself');
});
