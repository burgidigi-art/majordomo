import { PM_SYSTEM } from '../agents/prompts.ts';
import type { ChatRequest, ChatResponse, Msg, Part, Provider } from './types.ts';

/**
 * A scripted stand-in for a real model. It drives the genuine harness — the same PM tools,
 * scheduler, worker tools and event stream — so the dashboard can be explored (and the whole
 * pipeline tested) without any account. It does not produce real work.
 */

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

const SPEED = Number(process.env.MAJORDOMO_DEMO_SPEED || 1);

async function say(req: ChatRequest, text: string): Promise<Part> {
  for (const word of text.split(/(?<=\s)/)) {
    req.onDelta('text', word);
    await sleep(18 / SPEED, req.signal);
  }
  return { type: 'text', text };
}

let callSeq = 0;
const call = (name: string, input: Record<string, unknown>): Part => ({
  type: 'tool_call',
  id: `demo_${Date.now().toString(36)}_${callSeq++}`,
  name,
  input,
});

function lastUser(messages: Msg[]): Msg {
  return [...messages].reverse().find((m) => m.role === 'user') ?? { role: 'user', parts: [] };
}

const texts = (m: Msg) =>
  m.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

const results = (m: Msg) => m.parts.filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');

function titleFrom(text: string): string {
  const cleaned = text
    .replace(/<context>[\s\S]*?<\/context>/g, '')
    .trim()
    .replace(/^(hey|hi|hello|please|ok|okay)[,!. ]+/i, '')
    .replace(/^(can|could|would) you /i, '')
    .replace(/^(i want to|i need to|i'd like to|i would like to|help me|let's|lets) /i, '')
    .replace(/[.?!,;:].*$/s, '')
    .replace(/\s+(and|then|with|so that|because)\s.*$/i, '');
  const title = cleaned.split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return title ? title[0].toUpperCase() + title.slice(1) : 'New project';
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'notes';

async function pmTurn(req: ChatRequest): Promise<Part[]> {
  const last = lastUser(req.messages);
  const text = texts(last);
  const toolResults = results(last);
  await sleep(500 / SPEED, req.signal);

  if (toolResults.length) {
    const created = toolResults.find((r) => r.name === 'create_project');
    if (created) {
      const id = /Created (P-\d+)/.exec(created.output)?.[1] ?? 'P-1';
      const name = /Created P-\d+ "([^"]+)"/.exec(created.output)?.[1] ?? 'the project';
      return [
        call('create_tasks', {
          project: id,
          tasks: [
            {
              title: 'Gather context and constraints',
              brief: `Project: ${name}. Collect what is already known, list constraints, and write them to notes/context.md.`,
              crew: 'scout',
            },
            {
              title: 'Review risks and open questions',
              brief: `Project: ${name}. List the main risks and the questions that need an owner. Write them to notes/risks.md.`,
              crew: 'scout',
            },
            {
              title: 'Produce the first version',
              brief: `Project: ${name}. Using the gathered context, produce a first working version in the workspace.`,
              crew: 'builder',
              depends_on: ['#1'],
            },
            {
              title: 'Write the summary for review',
              brief: `Project: ${name}. Turn the results into a one-page summary at SUMMARY.md.`,
              crew: 'scribe',
              depends_on: ['#2', '#3'],
            },
          ],
        }),
      ];
    }
    if (toolResults.some((r) => r.name === 'create_tasks')) {
      return [
        await say(
          req,
          'On it. I set this up as a project and split it four ways: Scout is gathering context and reviewing risks in parallel, Builder takes the first version once the context is in, and Scribe writes the summary at the end.\n\nYou can watch each of them in the panel on the right. I will come back to you when there is something worth reading.\n\n*This is the demo crew — the agents are simulated. Connect an account in Settings to put a real crew to work.*',
        ),
      ];
    }
    if (toolResults.some((r) => r.name === 'message_agent')) return [{ type: 'text', text: '<quiet/>' }];
    return [await say(req, 'Done.')];
  }

  // Several events can arrive in one batch: answer every question first, then report.
  const events = [...text.matchAll(/<event type="([a-z_]+)"([^>]*)>/g)].map((m) => ({
    type: m[1],
    task: /task="(T-\d+)"/.exec(m[2])?.[1],
    project: /project_name="([^"]+)"/.exec(m[2])?.[1] ?? 'the project',
    open: Number(/open_tasks="(\d+)"/.exec(m[2])?.[1] ?? 0),
  }));
  if (events.length) {
    const questions = events.filter((e) => e.type === 'task_question' && e.task);
    if (questions.length) {
      return questions.map((q) =>
        call('message_agent', {
          task: q.task,
          message: 'Favour thoroughness over speed, and note any assumption you make in the file.',
        }),
      );
    }
    const failed = events.find((e) => e.type === 'task_failed');
    if (failed) {
      return [await say(req, `A task on **${failed.project}** failed (${failed.task}). Open it in the dashboard to see why, or tell me to retry it.`)];
    }
    const cancelled = events.find((e) => e.type === 'task_cancelled');
    if (cancelled) {
      return [await say(req, `Noted — you stopped ${cancelled.task} on **${cancelled.project}**. Anything that depended on it is on hold; tell me if you want it re-run or dropped.`)];
    }
    if (events.some((e) => e.type === 'reminder')) return [await say(req, `Reminder: ${text.replace(/<context>[\s\S]*?<\/context>/g, '').replace(/<[^>]+>/g, '').trim()}`)];
    const last = events.at(-1)!;
    if (last.open > 0) return [{ type: 'text', text: '<quiet/>' }];
    return [
      await say(
        req,
        `**${last.project}** is finished. All four tasks came back clean: context and risks are in \`notes/\`, the first version is in the workspace, and the one-page summary is at \`SUMMARY.md\`.\n\nOpen the project to browse the files, or tell me what to change.`,
      ),
    ];
  }

  const files = /<attachments>[\s\S]*?<\/attachments>/.exec(text)?.[0].match(/^- /gm)?.length ?? 0;
  if (files) {
    return [
      await say(
        req,
        `Got ${files === 1 ? 'the file' : `all ${files} files`} — saved to the inbox on your computer. Tell me which project ${files === 1 ? 'it belongs' : 'they belong'} to and what you want done, and I will hand ${files === 1 ? 'it' : 'them'} to the crew.`,
      ),
    ];
  }

  const plain = text.replace(/<context>[\s\S]*?<\/context>/g, '').trim();
  if (plain.length < 24 || /^(hi|hello|hey|thanks|thank you|what can you do|who are you)\b/i.test(plain)) {
    return [
      await say(
        req,
        'Hello. I am your project manager: tell me about anything you are working on and I will break it down, hand the pieces to the crew, keep track of them, and report back.\n\nTry something like *“Plan the launch of my newsletter”* or *“Build a CLI that renames my photos by date”*.',
      ),
    ];
  }
  return [call('create_project', { name: titleFrom(plain), goal: plain.slice(0, 400) })];
}

async function workerTurn(req: ChatRequest): Promise<Part[]> {
  const first = texts(req.messages[0] ?? { role: 'user', parts: [] });
  const title = /^Task T-\d+: (.+)$/m.exec(first)?.[1] ?? 'the task';
  const step = req.messages.filter((m) => m.role === 'assistant').length;
  const file = /summary/i.test(title) ? 'SUMMARY.md' : /first version/i.test(title) ? 'build/first-version.md' : `notes/${slug(title)}.md`;
  const pause = (ms: number) => sleep((ms + Math.random() * ms) / SPEED, req.signal);

  // A follow-up from the manager after the task was finished.
  const prior = req.messages.slice(0, -1).some((m) => m.role === 'assistant' && !m.parts.some((p) => p.type === 'tool_call'));
  if (prior) return [await say(req, 'Understood — noted in the file and nothing else needed changing.')];

  await pause(700);
  switch (step) {
    case 0:
      return [await say(req, 'Reading the brief and looking at what is already in the workspace.'), call('report_progress', { note: 'Getting oriented' }), call('list_files', { depth: 2 })];
    case 1:
      if (/risks/i.test(title)) {
        return [call('ask_manager', { question: 'Should this review favour speed or thoroughness? I can do a quick pass or a full one.' })];
      }
      await pause(900);
      return [call('report_progress', { note: `Drafting ${file}` })];
    case 2:
      await pause(1200);
      return [
        call('write_file', {
          path: file,
          content: `# ${title}\n\n_Produced by the demo crew — placeholder content._\n\n- Point one, stated plainly\n- Point two, with the reasoning behind it\n- Point three, and what it depends on\n\n## Next\n\nReplace the demo crew with a real one in Settings to get real work here.\n`,
        }),
      ];
    case 3:
      await pause(600);
      return [call('report_progress', { note: 'Checking the result' }), call('bash', { command: `wc -l ${file} && ls -la $(dirname ${file})` })];
    default:
      return [
        await say(
          req,
          `Finished **${title}**.\n\n- Wrote \`${file}\`\n- Verified the file exists and is non-empty\n\nNothing is blocked. (Demo output: the content is placeholder text.)`,
        ),
      ];
  }
}

async function chat(req: ChatRequest): Promise<ChatResponse> {
  const isCompaction = /handoff note/.test(texts(lastUser(req.messages)));
  const parts = isCompaction
    ? [{ type: 'text' as const, text: 'Summary of earlier conversation (demo).' }]
    : req.system === PM_SYSTEM
      ? await pmTurn(req)
      : await workerTurn(req);
  const chars = JSON.stringify(req.messages).length;
  return {
    message: { role: 'assistant', parts },
    stop: parts.some((p) => p.type === 'tool_call') ? 'tool' : 'end',
    usage: { input: Math.round(chars / 4) + 900, output: Math.round(JSON.stringify(parts).length / 4), cacheRead: 0, cacheWrite: 0 },
    model: 'demo-1',
  };
}

export const demoProvider: Provider = {
  chat,
  listModels: async () => [{ id: 'demo-1', label: 'Demo (simulated)' }],
};
