import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutonomyIR } from '@open-autonomy/core';
import { compileLocal } from './emit';

const ir: AutonomyIR = {
  schema: 'autonomy.ir.v1',
  targets: ['local'],
  agents: {
    seed: { behavior: 'scripts/seed.ts', capabilities: [], triggers: [{ cron: '*/15 * * * *' }] },
  },
  policy: { box: {} },
  resources: [],
};

describe('emitted scheduler hard controls', () => {
  test('maxConcurrent denies a new agent launch while a scheduled agent session is active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-scheduler-controls-'));
    try {
      const out = compileLocal(ir);
      const run = out.generated['scheduler/run.mjs'];
      mkdirSync(join(dir, 'scheduler'), { recursive: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scheduler', 'run.mjs'), run);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'workspace-lifecycle.mjs'), out.generated['scripts/workspace-lifecycle.mjs']!);
      writeFileSync(join(dir, 'scripts', 'autonomy-runner.mjs'),
        `console.log(JSON.stringify([{id:'live',agent:'one',status:'running'}]));\n`);
      const sentinel = join(dir, 'launched');
      writeFileSync(join(dir, 'scripts', 'launch.mjs'),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'launched');\n`);
      writeFileSync(join(dir, 'scheduler', 'schedule.json'), JSON.stringify({
        maxConcurrent: 1,
        env: {},
        jobs: [
          { name: 'one', agent: 'one', command: 'node scripts/launch.mjs', intervalSeconds: 60, retrySeconds: 10 },
          { name: 'two', agent: 'two', command: 'node scripts/launch.mjs', intervalSeconds: 60, retrySeconds: 10 },
        ],
      }));
      const result = spawnSync('node', ['scheduler/run.mjs', '--once'], { cwd: dir, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('maxConcurrent fails closed when session liveness cannot be established', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-scheduler-controls-'));
    try {
      const out = compileLocal(ir);
      const run = out.generated['scheduler/run.mjs'];
      mkdirSync(join(dir, 'scheduler'), { recursive: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scheduler', 'run.mjs'), run);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'workspace-lifecycle.mjs'), out.generated['scripts/workspace-lifecycle.mjs']!);
      writeFileSync(join(dir, 'scripts', 'autonomy-runner.mjs'), `process.exit(1);\n`);
      const sentinel = join(dir, 'launched');
      writeFileSync(join(dir, 'scripts', 'launch.mjs'),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'launched');\n`);
      writeFileSync(join(dir, 'scheduler', 'schedule.json'), JSON.stringify({
        maxConcurrent: 1,
        env: {},
        jobs: [
          { name: 'one', agent: 'one', command: 'node scripts/launch.mjs', intervalSeconds: 60, retrySeconds: 10 },
        ],
      }));
      const result = spawnSync('node', ['scheduler/run.mjs', '--once'], { cwd: dir, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('manual dispatch runs one declared job while preserving env, fences, and concurrency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-scheduler-dispatch-'));
    try {
      const out = compileLocal(ir);
      const run = out.generated['scheduler/run.mjs'];
      mkdirSync(join(dir, 'scheduler'), { recursive: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, '.open-autonomy'), { recursive: true });
      writeFileSync(join(dir, 'scheduler', 'run.mjs'), run);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'workspace-lifecycle.mjs'), out.generated['scripts/workspace-lifecycle.mjs']!);
      const one = join(dir, 'one.json');
      const two = join(dir, 'two.json');
      writeFileSync(join(dir, 'scripts', 'one.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(one)}, 'ran');\n`);
      writeFileSync(join(dir, 'scripts', 'two.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(two)}, JSON.stringify({ trigger: process.env.AUTONOMY_TRIGGER_KIND, value: process.env.SCHEDULE_VALUE }));\n`);
      writeFileSync(join(dir, 'scripts', 'autonomy-runner.mjs'), `console.log('[]');\n`);
      writeFileSync(join(dir, 'scheduler', 'schedule.json'), JSON.stringify({
        maxConcurrent: 1,
        env: { SCHEDULE_VALUE: 'declared' },
        jobs: [
          { name: 'one', agent: 'one', command: 'node scripts/one.mjs', intervalSeconds: 60 },
          { name: 'two', agent: 'two', command: 'node scripts/two.mjs', intervalSeconds: 60, fence: '.open-autonomy/two-paused' },
        ],
      }));

      const dispatched = spawnSync('node', ['scheduler/run.mjs', '--dispatch', 'two'], { cwd: dir, encoding: 'utf8' });
      expect(dispatched.status).toBe(0);
      expect(existsSync(one)).toBe(false);
      expect(JSON.parse(readFileSync(two, 'utf8'))).toEqual({ trigger: 'dispatch', value: 'declared' });

      rmSync(two);
      writeFileSync(join(dir, '.open-autonomy', 'two-paused'), 'paused\n');
      const fenced = spawnSync('node', ['scheduler/run.mjs', '--dispatch', 'two'], { cwd: dir, encoding: 'utf8' });
      expect(fenced.status).toBe(1);
      expect(existsSync(two)).toBe(false);

      rmSync(join(dir, '.open-autonomy', 'two-paused'));
      writeFileSync(join(dir, 'scripts', 'autonomy-runner.mjs'), `console.log(JSON.stringify([{id:'live',agent:'one',status:'running'}]));\n`);
      const atCapacity = spawnSync('node', ['scheduler/run.mjs', '--dispatch', 'two'], { cwd: dir, encoding: 'utf8' });
      expect(atCapacity.status).toBe(1);
      expect(atCapacity.stderr).toContain('maxConcurrent 1 is already reached');
      expect(existsSync(two)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('continuous reconciliation retains legacy ownership without calling the runner reaper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-scheduler-lease-grace-'));
    let child;
    try {
      const out = compileLocal(ir);
      const run = out.generated['scheduler/run.mjs'];
      const leases = join(dir, '.open-autonomy', 'runner-state', 'workspaces');
      const worktree = join(dir, 'fresh-worktree');
      const fresh = join(leases, 'fresh.json');
      const stale = join(leases, 'stale.json');
      const effects = join(dir, '.open-autonomy', 'runner-state', 'effects');
      const effectMarker = join(effects, 'fresh.json');
      const effectSentinel = join(dir, 'effect-ran');
      const liveMarker = join(dir, 'fresh-is-live');
      const polls = join(dir, 'provider-polls');
      mkdirSync(join(dir, 'scheduler'), { recursive: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(leases, { recursive: true });
      mkdirSync(effects, { recursive: true });
      mkdirSync(worktree);
      writeFileSync(join(dir, 'scheduler', 'run.mjs'), run);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'workspace-lifecycle.mjs'), out.generated['scripts/workspace-lifecycle.mjs']!);
      writeFileSync(join(dir, 'scheduler', 'schedule.json'), JSON.stringify({ jobs: [] }));
      writeFileSync(join(dir, 'scripts', 'autonomy-runner.mjs'), `
        import { existsSync, appendFileSync } from 'node:fs';
        export class TermfleetRunner {
          async list(){ appendFileSync(${JSON.stringify(polls)}, 'poll\\n'); return existsSync(${JSON.stringify(liveMarker)}) ? [{ id: 'fresh', agent: 'test', status: 'running' }] : []; }
          async reapIdle(){ throw new Error('scheduler must not reap sessions'); }
        }
      `);
      writeFileSync(join(dir, 'scripts', 'effect.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(effectSentinel)}, 'ran');\n`);
      const lease = (id: string, path: string, createdAt: string) => JSON.stringify({
        schema: 'open-autonomy.workspace-lease.v1', id, agent: 'test', branch: `test/${id}`, worktree: path, createdAt,
      });
      writeFileSync(fresh, lease('fresh', worktree, new Date().toISOString()));
      writeFileSync(stale, lease('stale', join(dir, 'missing'), '1970-01-01T00:00:00.000Z'));
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      spawnSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: dir });
      spawnSync('git', ['config', 'user.name', 'scheduler-test'], { cwd: dir });
      spawnSync('git', ['add', 'scheduler/run.mjs', 'scheduler/schedule.json', 'scripts/autonomy-runner.mjs', 'scripts/effect.mjs'], { cwd: dir });
      spawnSync('git', ['commit', '-q', '-m', 'accepted test control'], { cwd: dir });
      const controlSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(dir, '.open-autonomy', 'runner-state', 'control-generation.json'), JSON.stringify({
        schema: 'open-autonomy.control-generation.v1', sha: controlSha, codeHost: 'local-git', acceptedAt: new Date().toISOString(),
      }));
      writeFileSync(effectMarker, JSON.stringify({
        schema: 'open-autonomy.effect-marker.v2', id: 'fresh', agent: 'test', effect: 'scripts/effect.mjs', worktree,
        controlRoot: dir, controlSha, env: {},
      }));
      child = spawn('node', ['scheduler/run.mjs'], {
        cwd: dir,
        env: { ...process.env, AUTONOMY_REAP_POLL_MS: '1000', AUTONOMY_WORKSPACE_LEASE_GRACE_MS: '60000' },
        stdio: 'ignore',
      });
      const waitForPoll = async (previous: number) => {
        const deadline = Date.now() + 5000;
        while ((!existsSync(polls) || readFileSync(polls, 'utf8').length <= previous) && Date.now() < deadline) await Bun.sleep(50);
        expect(readFileSync(polls, 'utf8').length).toBeGreaterThan(previous);
      };
      await waitForPoll(0);
      writeFileSync(liveMarker, 'live\n');
      await waitForPoll(readFileSync(polls, 'utf8').length);
      rmSync(liveMarker);
      await waitForPoll(readFileSync(polls, 'utf8').length);
      expect(existsSync(stale)).toBe(true);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(effectMarker)).toBe(true);
      expect(existsSync(effectSentinel)).toBe(false);
      expect(child.exitCode).toBe(null);
    } finally {
      if (child && child.exitCode === null) child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
