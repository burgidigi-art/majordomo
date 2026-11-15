// Tests for lib/evidence.mjs: label classification, running windows, attribution,
// inference-hook session bindings, the evidence ring buffer and the capability statement.
// Everything is deterministic: time is always passed in, never read from the clock.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Coverage,
  EvidenceStore,
  GRADES,
  MASK_MODES,
  RunningWindows,
  SessionBindings,
  attribute,
  capabilityStatement,
  classifyLabel,
  sanitizeText,
} from '../lib/evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const labelFixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'evidence.labels.json'), 'utf8'));

const T0 = 1_731_600_000_000; // 2024-11-14T16:00:00.000Z, a fixed "now" for every test
const SEC = 1000;
const MIN = 60 * SEC;

/** A minimal evidence item; override what the test cares about. */
function item(overrides = {}) {
  return {
    at: T0,
    grade: 'B',
    source: 'usage-ledger',
    bot: { agentId: 'bot-a', name: 'Bot A' },
    attribution: 'high',
    label: 'grok-bot-default',
    classified: classifyLabel('grok-bot-default'),
    tokens: { in: 100, out: 10, cacheWrite: 0, cacheRead: 0 },
    extra: {},
    ...overrides,
  };
}

describe('constants', () => {
  it('GRADES lists the five grades with a title, summary and strength each, and is frozen', () => {
    assert.deepEqual(Object.keys(GRADES).sort(), ['A', 'B', 'B2', 'C', 'H']);
    for (const [key, grade] of Object.entries(GRADES)) {
      assert.equal(grade.grade, key);
      for (const field of ['title', 'summary', 'strength']) {
        assert.equal(typeof grade[field], 'string');
        assert.ok(grade[field].length > 0, `${key}.${field} is empty`);
      }
    }
    // Wording matters: grade A is "signed", never "verified"; grade C is a quote.
    assert.equal(GRADES.A.strength, 'signed');
    assert.equal(GRADES.B.strength, 'ledger');
    assert.equal(GRADES.C.strength, 'quote');
    for (const grade of Object.values(GRADES)) assert.doesNotMatch(`${grade.title} ${grade.strength}`, /verified|confirmed|detected/i);
    assert.ok(Object.isFrozen(GRADES));
  });

  it('MASK_MODES names the three mask labels Cursor writes for Bot work', () => {
    assert.deepEqual(Object.keys(MASK_MODES).sort(), ['automation', 'cua', 'default']);
    assert.equal(MASK_MODES.default.mode, 'chat');
    assert.equal(MASK_MODES.automation.mode, 'routine');
    assert.equal(MASK_MODES.cua.mode, 'computer-use');
    assert.ok(Object.isFrozen(MASK_MODES));
  });
});

describe('classifyLabel', () => {
  for (const c of labelFixture.cases) {
    it(`classifies ${JSON.stringify(c.label)} as ${c.kind}${c.family ? ` / ${c.family}` : ''}`, () => {
      const got = classifyLabel(c.label);
      assert.equal(got.kind, c.kind);
      assert.equal(got.mode, c.mode);
      assert.equal(got.family, c.family);
      assert.equal(got.opaque, c.opaque);
      assert.equal(got.label, c.label || 'unknown');
      if (c.display.startsWith('^')) assert.match(got.display, new RegExp(c.display));
      else assert.equal(got.display, c.display);
    });
  }

  it('returns the same shape for every input', () => {
    for (const label of ['grok-bot-default', 'sand-x', 'claude-4-opus', 'unknown', '']) {
      assert.deepEqual(Object.keys(classifyLabel(label)).sort(), ['display', 'family', 'familyNote', 'kind', 'label', 'mode', 'opaque']);
    }
  });

  it('the mask display says which kind of turn it was and that the model is hidden', () => {
    assert.match(classifyLabel('grok-bot-default').display, /^Grok Bot/);
    assert.match(classifyLabel('grok-bot-default').display, /chat turn/);
    assert.match(classifyLabel('grok-bot-automation').display, /routine run/);
    assert.match(classifyLabel('grok-bot-cua').display, /computer use/);
    for (const label of ['grok-bot-default', 'grok-bot-automation', 'grok-bot-cua', 'grok-bot-voice', 'sand-78zum5']) {
      assert.match(classifyLabel(label).display, /\(model hidden\)$/, label);
    }
  });

  it('mask and alias detection ignores case and surrounding whitespace but keeps the raw label', () => {
    const got = classifyLabel('  GROK-BOT-CUA  ');
    assert.equal(got.kind, 'grok-bot-mask');
    assert.equal(got.mode, 'computer-use');
    assert.equal(got.label, 'GROK-BOT-CUA');
    assert.equal(classifyLabel('SAND-78ZUM5').kind, 'opaque-alias');
    assert.equal(classifyLabel('SAND-78ZUM5').label, 'SAND-78ZUM5');
  });

  it('a mask label with an unfamiliar suffix is still a mask (mode other)', () => {
    const got = classifyLabel('grok-bot-something-new');
    assert.equal(got.kind, 'grok-bot-mask');
    assert.equal(got.mode, 'other');
    assert.equal(got.opaque, true);
    assert.equal(got.display, 'Grok Bot something-new (model hidden)');
  });

  it('concrete model ids are shown raw and are not opaque', () => {
    for (const label of ['claude-4-sonnet', 'grok-4', 'gpt-5', 'gemini-2.5-pro', 'composer-1', 'cursor-grok-4.6-high-fast']) {
      const got = classifyLabel(label);
      assert.equal(got.kind, 'model-id');
      assert.equal(got.opaque, false);
      assert.equal(got.mode, null);
      assert.equal(got.display, label);
      assert.equal(got.label, label);
    }
  });

  it('cursor-grok-4.6-high-fast is an xAI Grok id (grok wins over the cursor- prefix)', () => {
    const got = classifyLabel('cursor-grok-4.6-high-fast');
    assert.equal(got.family, 'xAI Grok');
    assert.equal(got.kind, 'model-id');
    assert.equal(got.opaque, false);
  });

  it('unknown, empty, blank and non-string labels classify as unknown and opaque without throwing', () => {
    for (const label of ['unknown', '', '   ', null, undefined, 42, {}, ['grok-bot-default']]) {
      const got = classifyLabel(label);
      assert.equal(got.kind, 'unknown', `label ${JSON.stringify(label)}`);
      assert.equal(got.opaque, true);
      assert.equal(got.label, 'unknown');
      assert.equal(got.display, 'unknown label');
      assert.equal(got.family, null);
      assert.equal(got.mode, null);
    }
  });

  it('a label that matches no vendor pattern is unrecognized and treated as opaque, not as a model id', () => {
    const got = classifyLabel('mystery-model-9000');
    assert.equal(got.kind, 'unrecognized-label');
    assert.equal(got.family, null);
    assert.equal(got.opaque, true);
    assert.match(got.display, /unrecognized label/);
  });

  it('a vendor family is always marked as inferred from the name', () => {
    assert.equal(classifyLabel('claude-opus-5-5').familyNote, 'name suggests Anthropic Claude');
    assert.equal(classifyLabel('grok-bot-default').familyNote, null);
  });

  it('the OpenAI pattern is anchored: o3 matches, a word merely containing o-digit does not', () => {
    assert.equal(classifyLabel('o3-pro').family, 'OpenAI');
    assert.equal(classifyLabel('gpt-5.6-terra').family, 'OpenAI');
    assert.equal(classifyLabel('turbo9').kind, 'unrecognized-label');
  });
});

describe('sanitizeText', () => {
  it('strips control characters, collapses whitespace and caps the length', () => {
    assert.equal(sanitizeText('  a\u0000b\n\tc  '), 'a b c');
    assert.equal(sanitizeText('x'.repeat(50), 10).length, 10);
    assert.equal(sanitizeText(42), '');
    assert.equal(sanitizeText(null), '');
  });
});

describe('Coverage', () => {
  it('on-time ticks extend one interval; a late tick starts a new one and leaves a gap', () => {
    const c = new Coverage({ graceMs: 0 });
    c.tick(T0, 3000);
    c.tick(T0 + 3 * SEC, 3000);
    c.tick(T0 + 6 * SEC, 3000);
    assert.equal(c.intervals.length, 1);
    assert.ok(c.covers(T0 + 4 * SEC));
    c.tick(T0 + 30 * MIN, 3000); // the laptop slept
    assert.equal(c.intervals.length, 2);
    assert.equal(c.covers(T0 + 10 * MIN), false);
    assert.ok(c.covers(T0 + 30 * MIN));
    const gaps = c.gaps();
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].from, T0 + 6 * SEC);
    assert.equal(gaps[0].to, T0 + 30 * MIN);
  });

  it('the allowance scales with the poll interval, so a slow idle cadence is not a gap', () => {
    const c = new Coverage();
    c.tick(T0, 15_000);
    c.tick(T0 + 30 * SEC, 15_000);
    assert.equal(c.intervals.length, 1);
  });
});

describe('RunningWindows', () => {
  it('defaults to a 20 s grace and a 12 h memory', () => {
    const w = new RunningWindows();
    assert.equal(w.graceMs, 20 * SEC);
    assert.equal(w.maxAgeMs, 12 * 60 * MIN);
  });

  it('observe opens a window when a Bot starts and closes it when it stops', () => {
    const w = new RunningWindows();
    assert.equal(w.isRunning('a'), false);
    w.observe('a', true, T0);
    assert.equal(w.isRunning('a'), true);
    assert.deepEqual(w.windows.get('a'), [{ start: T0, end: null }]);
    w.observe('a', true, T0 + 3 * SEC); // still running: no second window
    assert.deepEqual(w.windows.get('a'), [{ start: T0, end: null }]);
    w.observe('a', false, T0 + 30 * SEC);
    assert.equal(w.isRunning('a'), false);
    assert.deepEqual(w.windows.get('a'), [{ start: T0, end: T0 + 30 * SEC }]);
    w.observe('a', false, T0 + 33 * SEC); // idle again: nothing changes
    assert.deepEqual(w.windows.get('a'), [{ start: T0, end: T0 + 30 * SEC }]);
  });

  it('a Bot seen only idle has no window and is never active', () => {
    const w = new RunningWindows();
    w.observe('a', false, T0);
    assert.equal(w.isRunning('a'), false);
    assert.deepEqual(w.botsActiveAt(T0), []);
    assert.equal(w.windows.has('a'), false);
  });

  it('a second running period opens a second window and the gap between them is inactive', () => {
    const w = new RunningWindows();
    w.observe('a', true, T0);
    w.observe('a', false, T0 + MIN);
    w.observe('a', true, T0 + 5 * MIN);
    assert.equal(w.windows.get('a').length, 2);
    assert.equal(w.isRunning('a'), true);
    assert.deepEqual(w.botsActiveAt(T0 + 30 * SEC), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 + 3 * MIN), []);
    assert.deepEqual(w.botsActiveAt(T0 + 6 * MIN), ['a']);
  });

  it('botsActiveAt applies the grace on both ends of a closed window, inclusively', () => {
    const w = new RunningWindows({ graceMs: 20 * SEC });
    w.observe('a', true, T0);
    w.observe('a', false, T0 + MIN);
    assert.deepEqual(w.botsActiveAt(T0 - 20 * SEC), ['a'], 'start minus grace');
    assert.deepEqual(w.botsActiveAt(T0 - 20 * SEC - 1), [], 'just before start minus grace');
    assert.deepEqual(w.botsActiveAt(T0), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 + MIN), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 + MIN + 20 * SEC), ['a'], 'end plus grace');
    assert.deepEqual(w.botsActiveAt(T0 + MIN + 20 * SEC + 1), [], 'just after end plus grace');
  });

  it('an open window covers every later moment', () => {
    const w = new RunningWindows();
    w.observe('a', true, T0);
    assert.deepEqual(w.botsActiveAt(T0 + 3 * 60 * MIN), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 - 21 * SEC), []);
  });

  it('a zero grace means exact window bounds', () => {
    const w = new RunningWindows({ graceMs: 0 });
    w.observe('a', true, T0);
    w.observe('a', false, T0 + MIN);
    assert.deepEqual(w.botsActiveAt(T0 - 1), []);
    assert.deepEqual(w.botsActiveAt(T0), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 + MIN), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 + MIN + 1), []);
  });

  it('botsActiveAt lists every Bot whose window covers the moment', () => {
    const w = new RunningWindows();
    w.observe('a', true, T0);
    w.observe('b', true, T0 + 30 * SEC);
    w.observe('a', false, T0 + MIN);
    w.observe('b', false, T0 + 2 * MIN);
    assert.deepEqual(w.botsActiveAt(T0 + 5 * SEC), ['a'], 'before b\'s leading grace');
    assert.deepEqual(w.botsActiveAt(T0 + 15 * SEC).sort(), ['a', 'b'], 'inside b\'s leading grace');
    assert.deepEqual(w.botsActiveAt(T0 + 45 * SEC).sort(), ['a', 'b']);
    assert.deepEqual(w.botsActiveAt(T0 + 90 * SEC), ['b']);
    assert.deepEqual(w.botsActiveAt(T0 + 10 * MIN), []);
  });

  it('observeSpan records a closed window seen after the fact, once, in start order', () => {
    const w = new RunningWindows();
    w.observeSpan('a', T0 + 10 * MIN, T0 + 11 * MIN);
    w.observeSpan('a', T0, T0 + MIN);
    w.observeSpan('a', T0, T0 + MIN); // the same span again: no duplicate
    w.observeSpan('a', T0 + 10 * SEC, T0 + 30 * SEC); // inside an existing span: no duplicate
    assert.deepEqual(w.windows.get('a'), [
      { start: T0, end: T0 + MIN },
      { start: T0 + 10 * MIN, end: T0 + 11 * MIN },
    ]);
    assert.deepEqual(w.botsActiveAt(T0 + 30 * SEC), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 + 5 * MIN), []);
    assert.equal(w.isRunning('a'), false, 'a span is never an open window');
  });

  it('observeSpan does not duplicate a span that an open window already covers', () => {
    const w = new RunningWindows();
    w.observe('a', true, T0);
    w.observeSpan('a', T0 + 10 * SEC, T0 + 20 * SEC);
    assert.deepEqual(w.windows.get('a'), [{ start: T0, end: null }]);
    assert.equal(w.isRunning('a'), true);
  });

  it('a span that only partly overlaps a window is added, and the union is active', () => {
    const w = new RunningWindows({ graceMs: 0 });
    w.observeSpan('a', T0, T0 + MIN);
    w.observeSpan('a', T0 + 30 * SEC, T0 + 2 * MIN);
    assert.equal(w.windows.get('a').length, 2);
    assert.deepEqual(w.botsActiveAt(T0 + 90 * SEC), ['a']);
    assert.deepEqual(w.botsActiveAt(T0 + 2 * MIN + 1), []);
  });

  it('prune drops windows that ended before the cutoff, keeps open ones and forgets empty Bots', () => {
    const w = new RunningWindows();
    w.observeSpan('old', T0 - 3 * 60 * MIN, T0 - 2 * 60 * MIN);
    w.observeSpan('mixed', T0 - 3 * 60 * MIN, T0 - 2 * 60 * MIN);
    w.observeSpan('mixed', T0 - 5 * MIN, T0 - 4 * MIN);
    w.observe('live', true, T0 - 4 * 60 * MIN);
    w.prune(T0 - 60 * MIN);
    assert.equal(w.windows.has('old'), false);
    assert.deepEqual(w.windows.get('mixed'), [{ start: T0 - 5 * MIN, end: T0 - 4 * MIN }]);
    assert.deepEqual(w.windows.get('live'), [{ start: T0 - 4 * 60 * MIN, end: null }]);
    assert.equal(w.isRunning('live'), true);
  });

  it('observe forgets windows older than maxAgeMs on its own', () => {
    const w = new RunningWindows({ maxAgeMs: 10 * MIN });
    w.observe('a', true, T0);
    w.observe('a', false, T0 + MIN);
    w.observe('b', true, T0 + 5 * MIN);
    assert.equal(w.windows.has('a'), true, 'still within maxAge');
    w.observe('b', true, T0 + 12 * MIN);
    assert.equal(w.windows.has('a'), false, 'ended more than maxAge ago');
    assert.equal(w.isRunning('b'), true);
  });
});

describe('attribute', () => {
  function windows() {
    const w = new RunningWindows({ graceMs: 20 * SEC });
    w.observe('a', true, T0);
    w.observe('a', false, T0 + MIN);
    w.observe('b', true, T0 + 50 * SEC);
    w.observe('b', false, T0 + 3 * MIN);
    return w;
  }

  it('is high when exactly one Bot was running', () => {
    assert.deepEqual(attribute(T0 + 10 * SEC, windows()), { agentId: 'a', candidates: ['a'], confidence: 'high' });
    assert.deepEqual(attribute(T0 + 2 * MIN, windows()), { agentId: 'b', candidates: ['b'], confidence: 'high' });
  });

  it('is ambiguous with every candidate listed when several Bots overlap, grace included', () => {
    const got = attribute(T0 + 55 * SEC, windows());
    assert.equal(got.confidence, 'ambiguous');
    assert.equal(got.agentId, null);
    assert.deepEqual(got.candidates.sort(), ['a', 'b']);
    // 15 s after `a` stopped: still inside its grace, while `b` is running.
    const late = attribute(T0 + MIN + 15 * SEC, windows());
    assert.equal(late.confidence, 'ambiguous');
    assert.deepEqual(late.candidates.sort(), ['a', 'b']);
  });

  it('is none with no candidates when no Bot was working', () => {
    assert.deepEqual(attribute(T0 - 5 * MIN, windows()), { agentId: null, candidates: [], confidence: 'none' });
    assert.deepEqual(attribute(T0 + 10 * MIN, windows()), { agentId: null, candidates: [], confidence: 'none' });
    assert.deepEqual(attribute(T0, new RunningWindows()), { agentId: null, candidates: [], confidence: 'none' });
  });
});

describe('SessionBindings', () => {
  const timing = (agentId) => () => ({ agentId });
  const noIds = new Map();

  it('an id the Bot API reported wins outright and is labelled matched-by-id', () => {
    const s = new SessionBindings();
    const binding = s.resolve('sess-1', { knownIds: new Map([['sess-1', 'bot-a']]), resolveByTiming: timing('bot-z'), at: T0 });
    assert.equal(binding.agentId, 'bot-a');
    assert.equal(binding.how, 'matched-by-id');
    // Timing never overrides an id match.
    assert.equal(s.resolve('sess-1', { knownIds: noIds, resolveByTiming: timing('bot-z'), at: T0 + SEC }).agentId, 'bot-a');
  });

  it('a timing-only binding starts tentative and becomes learned after three consistent frames', () => {
    const s = new SessionBindings();
    const ctx = (at) => ({ knownIds: noIds, resolveByTiming: timing('bot-b'), at });
    assert.equal(s.resolve('sess-2', ctx(T0)).how, 'tentative');
    assert.equal(s.resolve('sess-2', ctx(T0 + SEC)).how, 'tentative');
    const third = s.resolve('sess-2', ctx(T0 + 2 * SEC));
    assert.equal(third.how, 'learned');
    assert.equal(third.count, 3);
  });

  it('nothing is bound when timing cannot name one Bot, and a later frame can still bind it', () => {
    const s = new SessionBindings();
    assert.equal(s.resolve('sess-3', { knownIds: noIds, resolveByTiming: () => ({ agentId: null }), at: T0 }), null);
    assert.equal(s.resolve('sess-3', { knownIds: noIds, resolveByTiming: () => null, at: T0 }), null);
    assert.equal(s.get('sess-3'), null);
    assert.equal(s.resolve('sess-3', { knownIds: noIds, resolveByTiming: timing('bot-a'), at: T0 + SEC }).agentId, 'bot-a');
  });

  it('a frame with no attributable Bot keeps an existing binding without strengthening it', () => {
    const s = new SessionBindings();
    s.resolve('sess-4', { knownIds: noIds, resolveByTiming: timing('bot-a'), at: T0 });
    const again = s.resolve('sess-4', { knownIds: noIds, resolveByTiming: () => ({ agentId: null }), at: T0 + SEC });
    assert.equal(again.agentId, 'bot-a');
    assert.equal(again.count, 1);
  });

  it('two contradictions unbind a timing-based binding', () => {
    const s = new SessionBindings();
    s.resolve('sess-5', { knownIds: noIds, resolveByTiming: timing('bot-a'), at: T0 });
    assert.equal(s.resolve('sess-5', { knownIds: noIds, resolveByTiming: timing('bot-b'), at: T0 + SEC }).agentId, 'bot-a');
    assert.equal(s.resolve('sess-5', { knownIds: noIds, resolveByTiming: timing('bot-b'), at: T0 + 2 * SEC }), null);
    assert.equal(s.get('sess-5'), null);
  });

  it('an empty or missing session id is never bound', () => {
    const s = new SessionBindings();
    for (const id of ['', null, undefined]) assert.equal(s.resolve(id, { knownIds: noIds, resolveByTiming: timing('bot-a'), at: T0 }), null);
    assert.equal(s.bySession.size, 0);
  });

  it('set, get, unbind and entries', () => {
    const s = new SessionBindings();
    assert.equal(s.get('nope'), null);
    s.set('sess-6', 'bot-m', 'manual', T0);
    assert.deepEqual(s.get('sess-6'), { agentId: 'bot-m', how: 'manual', at: T0, count: 1, contradictions: 0 });
    assert.deepEqual(s.entries().map((e) => e.sessionId), ['sess-6']);
    assert.equal(s.unbind('sess-6'), true);
    assert.equal(s.get('sess-6'), null);
  });
});

describe('EvidenceStore', () => {
  it('add stores the item with an increasing numeric id and returns it', () => {
    const store = new EvidenceStore();
    const first = store.add(item({ at: T0 }));
    const second = store.add(item({ at: T0 + SEC, label: 'grok-bot-cua' }));
    assert.equal(typeof first.id, 'number');
    assert.ok(second.id > first.id);
    assert.equal(first.at, T0);
    assert.equal(first.grade, 'B');
    assert.equal(first.label, 'grok-bot-default');
    assert.deepEqual(first.bot, { agentId: 'bot-a', name: 'Bot A' });
    assert.deepEqual(first.tokens, { in: 100, out: 10, cacheWrite: 0, cacheRead: 0 });
    assert.equal(store.list.length, 2);
    assert.equal(store.items().length, 2);
  });

  it('items() is newest first and is a copy', () => {
    const store = new EvidenceStore();
    store.add(item({ at: T0 + 2 * SEC, label: 'c' }));
    store.add(item({ at: T0, label: 'a' }));
    store.add(item({ at: T0 + SEC, label: 'b' }));
    const items = store.items();
    assert.deepEqual(items.map((e) => e.label), ['c', 'b', 'a']);
    items.length = 0;
    assert.equal(store.items().length, 3);
  });

  it('an item whose key was seen before is dropped: null result, no entry, no notification', () => {
    const store = new EvidenceStore();
    const seen = [];
    store.subscribe((e) => seen.push(e.id));
    const stored = store.add(item({ key: 'usage:1' }));
    assert.ok(stored);
    assert.equal(store.add(item({ key: 'usage:1', at: T0 + 5 * SEC })), null);
    assert.equal(store.list.length, 1);
    assert.deepEqual(seen, [stored.id]);
    assert.ok(store.add(item({ key: 'usage:2' })), 'a different key is new');
    assert.equal(store.list.length, 2);
  });

  it('items without a key are never deduplicated', () => {
    const store = new EvidenceStore();
    assert.ok(store.add(item()));
    assert.ok(store.add(item()));
    assert.equal(store.list.length, 2);
  });

  it('recent keys still deduplicate after the seen-key set is trimmed', () => {
    const store = new EvidenceStore({ max: 2 });
    for (let i = 1; i <= 12; i++) assert.ok(store.add(item({ key: `k${i}`, at: T0 + i * SEC })), `k${i}`);
    assert.equal(store.add(item({ key: 'k12', at: T0 + 12 * SEC })), null);
    assert.equal(store.add(item({ key: 'k11', at: T0 + 11 * SEC })), null);
    assert.equal(store.list.length, 2, 'the ring buffer is still bounded');
  });

  it('is a ring buffer of `max` items that drops the oldest by time', () => {
    const store = new EvidenceStore({ max: 3 });
    for (let i = 0; i < 5; i++) store.add(item({ at: T0 + i * SEC, label: `row-${i}` }));
    assert.equal(store.list.length, 3);
    assert.deepEqual(store.items().map((e) => e.label), ['row-4', 'row-3', 'row-2']);
  });

  it('eviction follows the timestamps, not the insertion order', () => {
    const store = new EvidenceStore({ max: 2 });
    store.add(item({ at: T0 + 2 * SEC, label: 'newer' }));
    store.add(item({ at: T0 + 3 * SEC, label: 'newest' }));
    store.add(item({ at: T0, label: 'late-arriving-old-row' }));
    assert.deepEqual(store.items().map((e) => e.label), ['newest', 'newer']);
  });

  it('listeners receive each stored item; unsubscribe stops them; a throwing listener harms nothing', () => {
    const store = new EvidenceStore();
    const a = [];
    const b = [];
    const unsubscribeA = store.subscribe((e) => a.push(e.label));
    store.subscribe(() => {
      throw new Error('broken listener');
    });
    store.subscribe((e) => b.push(e.label));
    const stored = store.add(item({ label: 'one' }));
    assert.ok(stored);
    assert.deepEqual(a, ['one']);
    assert.deepEqual(b, ['one']);
    unsubscribeA();
    store.add(item({ label: 'two' }));
    assert.deepEqual(a, ['one']);
    assert.deepEqual(b, ['one', 'two']);
    assert.equal(store.list.length, 2);
  });

  it('a keyed row may be stored as many times as the fetch contains it (ledger rows have no ids)', () => {
    const store = new EvidenceStore();
    assert.ok(store.add(item({ key: 'dup' }), 2));
    assert.ok(store.add(item({ key: 'dup' }), 2));
    assert.equal(store.add(item({ key: 'dup' }), 2), null);
    assert.equal(store.count('dup'), 2);
  });

  it('coincident rows stay out of a Bot\'s evidence and totals but are retrievable on their own', () => {
    const store = new EvidenceStore();
    const mask = store.add(item({ at: T0 }));
    const concrete = store.add(item({ at: T0 + SEC, label: 'claude-opus-5-5', classified: classifyLabel('claude-opus-5-5'), coincident: true, attribution: 'coincident' }));
    assert.equal(store.latestByGrade('bot-a').B.id, mask.id);
    assert.equal(store.latestCoincident('bot-a').id, concrete.id);
    assert.equal(store.totals('bot-a', { now: T0 + MIN }).requests, 1);
    assert.equal(store.latestCoincident('bot-b'), null);
  });

  it('recent returns items inside the window, newest first, optionally for one Bot', () => {
    const store = new EvidenceStore();
    store.add(item({ at: T0 - 20 * MIN, label: 'too-old' }));
    store.add(item({ at: T0 - 15 * MIN, label: 'edge' }));
    store.add(item({ at: T0 - 5 * MIN, label: 'a-recent' }));
    store.add(item({ at: T0 - 4 * MIN, label: 'b-recent', bot: { agentId: 'bot-b', name: 'Bot B' } }));
    store.add(item({ at: T0 - 3 * MIN, label: 'unattributed', bot: null, attribution: 'none' }));
    assert.deepEqual(
      store.recent({ minutes: 15, now: T0 }).map((e) => e.label),
      ['unattributed', 'b-recent', 'a-recent', 'edge'],
    );
    assert.deepEqual(store.recent({ minutes: 15, now: T0, agentId: 'bot-a' }).map((e) => e.label), ['a-recent', 'edge']);
    assert.deepEqual(store.recent({ minutes: 15, now: T0, agentId: 'bot-b' }).map((e) => e.label), ['b-recent']);
    assert.deepEqual(store.recent({ minutes: 1, now: T0 }), []);
    assert.deepEqual(store.recent({ minutes: 60, now: T0 }).length, 5);
  });

  it('latestByGrade gives the newest item per grade for one Bot and null where there is none', () => {
    const store = new EvidenceStore();
    store.add(item({ at: T0 + 2 * SEC, grade: 'B', label: 'b-new' }));
    store.add(item({ at: T0, grade: 'B', label: 'b-old' }));
    store.add(item({ at: T0 + 10 * SEC, grade: 'B', label: 'b-other-bot', bot: { agentId: 'bot-b', name: 'Bot B' } }));
    store.add(item({ at: T0 + 20 * SEC, grade: 'B', label: 'b-unattributed', bot: null, attribution: 'none' }));
    store.add(item({ at: T0 + SEC, grade: 'A', label: 'sand-78zum5', source: 'inference-hook', attribution: 'learned', tokens: undefined }));
    store.add(item({ at: T0 + 3 * SEC, grade: 'C', label: 'Anthropic Claude', source: 'self-report:mcp', attribution: 'self', tokens: undefined }));
    const latest = store.latestByGrade('bot-a');
    assert.deepEqual(Object.keys(latest).sort(), ['A', 'B', 'B2', 'C', 'H']);
    assert.equal(latest.B.label, 'b-new');
    assert.equal(latest.A.label, 'sand-78zum5');
    assert.equal(latest.C.label, 'Anthropic Claude');
    assert.equal(latest.B2, null);
    assert.deepEqual(store.latestByGrade('bot-b').B.label, 'b-other-bot');
    assert.deepEqual(store.latestByGrade('nobody'), { A: null, H: null, B: null, B2: null, C: null });
  });

  it('latestByGrade picks by timestamp even when the newer row was added first', () => {
    const store = new EvidenceStore();
    store.add(item({ at: T0 + 10 * SEC, grade: 'B2', label: 'later', source: 'usage-aggregate' }));
    store.add(item({ at: T0, grade: 'B2', label: 'earlier', source: 'usage-aggregate' }));
    assert.equal(store.latestByGrade('bot-a').B2.label, 'later');
  });

  it('totals counts only grade B rows for the Bot inside the window and sums their tokens', () => {
    const store = new EvidenceStore();
    store.add(item({ at: T0 - MIN, tokens: { in: 1000, out: 100, cacheWrite: 0, cacheRead: 500 } }));
    store.add(item({ at: T0 - 2 * MIN, tokens: { in: 250, out: 25, cacheWrite: 10, cacheRead: 0 } }));
    store.add(item({ at: T0 - 3 * MIN, tokens: undefined, label: 'row-without-token-counts' }));
    store.add(item({ at: T0 - 11 * MIN, tokens: { in: 9999, out: 9999, cacheWrite: 0, cacheRead: 0 }, label: 'outside-10m' }));
    store.add(item({ at: T0 - MIN, grade: 'A', source: 'inference-hook', tokens: undefined }));
    store.add(item({ at: T0 - MIN, grade: 'B2', source: 'usage-aggregate', tokens: { in: 777, out: 77, cacheWrite: 0, cacheRead: 0 } }));
    store.add(item({ at: T0 - MIN, grade: 'C', source: 'self-report:api', attribution: 'self', tokens: undefined }));
    store.add(item({ at: T0 - MIN, bot: { agentId: 'bot-b', name: 'Bot B' }, tokens: { in: 5, out: 5, cacheWrite: 0, cacheRead: 0 } }));
    store.add(item({ at: T0 - MIN, bot: null, attribution: 'none', tokens: { in: 5, out: 5, cacheWrite: 0, cacheRead: 0 } }));
    assert.deepEqual(store.totals('bot-a', { minutes: 10, now: T0 }), { requests: 3, inputTokens: 1250, outputTokens: 125 });
    assert.deepEqual(store.totals('bot-a', { minutes: 15, now: T0 }), { requests: 4, inputTokens: 11249, outputTokens: 10124 });
    assert.deepEqual(store.totals('bot-b', { minutes: 10, now: T0 }), { requests: 1, inputTokens: 5, outputTokens: 5 });
    assert.deepEqual(store.totals('nobody', { minutes: 10, now: T0 }), { requests: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('the default window for totals is 10 minutes', () => {
    const store = new EvidenceStore();
    store.add(item({ at: T0 - 9 * MIN }));
    store.add(item({ at: T0 - 11 * MIN }));
    assert.equal(store.totals('bot-a', { now: T0 }).requests, 1);
  });
});

describe('capabilityStatement', () => {
  it('is a non-empty, stable paragraph that names the grades and the mask labels honestly', () => {
    const text = capabilityStatement();
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 200);
    assert.equal(text, capabilityStatement(), 'stable across calls');
    assert.ok(!text.includes('\n'), 'one paragraph');
    for (const needle of ['Enterprise', 'grok-bot-default', 'grok-bot-automation', 'grok-bot-cua', 'inference hook', 'reporting, not allowlisting', 'a quote, not evidence']) {
      assert.ok(text.includes(needle), `mentions ${needle}`);
    }
    assert.match(text, /does not show it/i);
    assert.doesNotMatch(text, /verified/i);
  });
});
