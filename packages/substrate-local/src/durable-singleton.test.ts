import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { AutonomyIR } from '@open-autonomy/core';
import { compileLocal } from './emit';

const ir: AutonomyIR = {
  schema: 'autonomy.ir.v1',
  targets: ['termfleet'],
  codeHost: 'github',
  agents: {
    pm: { behavior: 'pm', capabilities: ['agent:launch'], triggers: [{ cron: '*/15 * * * *' }] },
  },
  policy: { box: {} },
  resources: [],
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(responses: Record<string, unknown>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oa-singleton-')));
  roots.push(root);
  const generated = compileLocal(ir).generated;
  mkdirSync(join(root, 'scripts', 'prompts', 'claude'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills', 'pm'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'run-agent.mjs'), generated['scripts/run-agent.mjs']!);
  writeFileSync(join(root, 'scripts', 'runner-defaults.mjs'), "export const RUNNER_DEFAULTS={harness:'claude',launchTimeoutMs:1000};\n");
  writeFileSync(join(root, 'scripts', 'prompts', 'claude', 'pm.txt'), '/pm\n');
  writeFileSync(join(root, '.claude', 'skills', 'pm', 'SKILL.md'), '# pm\n');
  writeFileSync(
    join(root, 'scripts', 'autonomy-runner.mjs'),
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(join(root, 'calls.jsonl'))};
const state = ${JSON.stringify(join(root, 'responses.json'))};
const [command, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ command, args }) + '\\n');
const responses = JSON.parse(readFileSync(state, 'utf8'));
const response = responses[command];
if (response?.exit) process.exit(response.exit);
if (response?.next) {
  response.value = response.next.shift();
  writeFileSync(state, JSON.stringify(responses));
}
console.log(JSON.stringify(response?.value ?? response ?? {}));
`,
  );
  writeFileSync(join(root, 'responses.json'), JSON.stringify(responses));
  return root;
}

function tick(root: string) {
  return spawnSync('node', ['scripts/run-agent.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTONOMY_AGENT: 'pm',
      AUTONOMY_SINGLETON: '1',
      TERMFLEET_AGENT: 'claude',
      TERMFLEET_LAUNCH_TIMEOUT_MS: '1000',
    },
  });
}

function calls(root: string): Array<{ command: string; args: string[] }> {
  return readFileSync(join(root, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function receipt(root: string) {
  return JSON.parse(readFileSync(join(root, '.open-autonomy', 'runner-state', 'singletons', 'pm.json'), 'utf8'));
}

describe('emitted scheduled durable singleton', () => {
  test('first tick launches once and records the canonical harness conversation', () => {
    const root = fixture({
      list: { value: [] },
      launch: { value: { id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'running' } },
    });
    expect(tick(root).status).toBe(0);
    expect(calls(root).map(({ command }) => command)).toEqual(['list', 'launch']);
    expect(receipt(root)).toMatchObject({
      terminalId: 'terminal-1',
      agentSessionId: 'claude:session-1',
    });
  });

  test('active canonical conversation makes a later tick a no-op', () => {
    const root = fixture({
      list: {
        next: [
          [],
          [{ id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'running' }],
        ],
      },
      launch: { value: { id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'running' } },
    });
    expect(tick(root).status).toBe(0);
    const second = tick(root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already active');
    expect(calls(root).map(({ command }) => command)).toEqual(['list', 'launch', 'list']);
  });

  test('ended canonical conversation is resumed with a transcript-confirmable skill instruction', () => {
    const root = fixture({
      list: {
        next: [
          [],
          [{ id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'done' }],
        ],
      },
      launch: { value: { id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'running' } },
      continue: { value: { mode: 'resumed', terminalId: 'terminal-2', agentSessionId: 'claude:session-1' } },
    });
    expect(tick(root).status).toBe(0);
    expect(tick(root).status).toBe(0);
    const continuation = calls(root).find(({ command }) => command === 'continue')!;
    expect(continuation.args).toContain(
      'Continue the scheduled "pm" tick in this same durable conversation. Read and follow .claude/skills/pm/SKILL.md completely before acting, then perform the tick now.',
    );
    expect(continuation.args).toContain('--if-idle-only');
    expect(receipt(root)).toMatchObject({
      terminalId: 'terminal-2',
      agentSessionId: 'claude:session-1',
      lastMode: 'resumed',
    });
  });

  test('failed continuation fails closed without launching a replacement', () => {
    const root = fixture({
      list: {
        next: [
          [],
          [{ id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'done' }],
        ],
      },
      launch: { value: { id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'running' } },
      continue: { exit: 1 },
    });
    expect(tick(root).status).toBe(0);
    const second = tick(root);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('refusing to launch a replacement');
    expect(calls(root).map(({ command }) => command)).toEqual(['list', 'launch', 'list', 'continue']);
  });
});


test('full emitted runner reuses one workspace and lease for first launch, active skip and resumed tick', () => {
  const root = fixture({
    list: { next: [[], [{ id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'running' }], []] },
    launch: { value: { id: 'terminal-1', ref: 'claude:session-1', agent: 'pm', status: 'running' } },
    continue: { value: { terminalId: 'terminal-2', agentSessionId: 'claude:session-1', mode: 'resumed' } },
  });
  const out = compileLocal({ ...ir, codeHost: 'local-git' }).generated;
  for (const [path, text] of Object.entries(out)) {
    if (['scripts/autonomy-runner.mjs', 'scripts/runner-defaults.mjs'].includes(path)) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
  }
  rmSync(join(root, '.open-autonomy', 'paused'), { force: true });
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n.open-autonomy/runner-state/\ncalls.jsonl\nresponses.json\n');
  const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.'); git('commit', '-qm', 'accepted fixture');
  const run = () => spawnSync('bun', ['scripts/runner.ts', 'launch', 'pm', '--workspace', 'isolated'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, AUTONOMY_CONTROL_ROOT: root, AUTONOMY_SINGLETON: '1', TERMFLEET_AGENT: 'claude', TERMFLEET_LAUNCH_TIMEOUT_MS: '1000' },
  });
  let path = ''; let leaseId = '';
  for (let tick = 0; tick < 3; tick++) {
    const r = run(); expect(r.status, r.stderr + r.stdout).toBe(0);
    const canonical = receipt(root);
    if (!path) path = canonical.cwd;
    expect(canonical.cwd).toBe(path);
    expect(git('worktree', 'list', '--porcelain').split('worktree ').length - 1).toBe(2);
    const leases = readdirSync(join(root, '.open-autonomy', 'runner-state', 'workspaces'));
    expect(leases.length).toBe(1);
    if (!leaseId) leaseId = leases[0]!;
    expect(leases[0]).toBe(leaseId);
    const lease = JSON.parse(readFileSync(join(root, '.open-autonomy', 'runner-state', 'workspaces', leaseId), 'utf8'));
    expect(lease.state).toBe('active'); expect(lease.sessionId).toBe(tick === 2 ? 'terminal-2' : 'terminal-1');
  }
  expect(calls(root).filter(call => call.command === 'launch')).toHaveLength(1);
  expect(calls(root).filter(call => call.command === 'continue')).toHaveLength(1);
});
