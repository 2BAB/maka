/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import { PluginAgentService } from '../plugin-agent-service.js';
import { Context } from '../plugin-kernel.js';
import { PluginSessionExecutorService } from '../plugin-session-executor-service.js';

test('registered Session executor runs inside the canonical event and invocation adapters', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const executors = new PluginSessionExecutorService(root, agents);
  const plugin = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 3 },
  });
  let stopped = false;
  plugin.sessionExecutors.register({
    id: 'codex',
    label: 'Codex',
    capabilities: { stop: true },
    create: () => ({
      async *run(input) {
        assert.equal(plugin.agent?.sessionId, 'session-a');
        yield { type: 'text_delta', text: `reply:${input.text}` };
        yield { type: 'text_complete', text: `reply:${input.text}` };
        yield { type: 'complete' };
      },
      stop: () => {
        stopped = true;
      },
    }),
  });

  assert.deepEqual(executors.list('session-a'), [
    {
      id: 'codex',
      label: 'Codex',
      capabilities: { stop: true },
      extensionId: 'fixture',
    },
  ]);
  const header = sessionHeader({ executionBackend: 'codex' });
  const prepared = executors.prepare('codex', {
    sessionId: header.id,
    workspaceRoot: header.workspaceRoot,
    header,
  });
  assert.match(prepared.providerStateIdentity ?? '', /^sha256:[a-f0-9]{64}$/u);
  const backend = await prepared.build({
    sessionId: header.id,
    workspaceRoot: header.workspaceRoot,
    header,
    store: {} as never,
  });
  const events = [];
  for await (const event of backend.send({ turnId: 'turn-a', text: 'hello' })) {
    events.push(event);
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ['text_delta', 'text_complete', 'complete'],
  );
  assert.equal(events[0]?.turnId, 'turn-a');
  await backend.stop('user_stop');
  assert.equal(stopped, true);
  await backend.dispose();
  await root.fiber.dispose();
});

test('Session executor registration is Profile-scoped and fail-closes on missing terminal events', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const executors = new PluginSessionExecutorService(root, agents);
  const sessionPlugin = root.extend({
    maka: {
      rootId: 'session:session-a',
      packageId: 'fixture',
      entryId: 'session-fixture',
      generation: 1,
    },
  });
  assert.throws(
    () =>
      sessionPlugin.sessionExecutors.register({
        id: 'invalid',
        label: 'Invalid',
        create: () => ({ run: async function* () {} }),
      }),
    /Profile scope/u,
  );

  const profile = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 1 },
  });
  profile.sessionExecutors.register({
    id: 'short',
    label: 'Short',
    create: () => ({
      async *run() {
        yield { type: 'text_complete', text: 'done' } as const;
      },
    }),
  });
  const header = sessionHeader({ executionBackend: 'short' });
  const backend = await executors
    .prepare('short', { sessionId: header.id, workspaceRoot: header.workspaceRoot, header })
    .build({
      sessionId: header.id,
      workspaceRoot: header.workspaceRoot,
      header,
      store: {} as never,
    });
  const events = [];
  for await (const event of backend.send({ turnId: 'turn-a', text: 'hello' })) events.push(event);
  assert.deepEqual(
    events.map((event) => event.type),
    ['text_complete', 'error', 'complete'],
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type === 'complete' && terminal.stopReason, 'error');
  await root.fiber.dispose();
});

test('Session executor continuation identity binds package content and Entry config', async () => {
  const identity = async (packageContentDigest: string, entryConfigDigest: `sha256:${string}`) => {
    const root = new Context();
    const agents = new PluginAgentService(root);
    const executors = new PluginSessionExecutorService(root, agents);
    const plugin = root.extend({
      maka: {
        rootId: 'profile' as const,
        packageId: 'fixture',
        packageContentDigest,
        entryConfigDigest,
        entryId: 'fixture',
        generation: 1,
      },
    });
    plugin.sessionExecutors.register({
      id: 'codex',
      label: 'Codex',
      create: () => ({ run: async function* () {} }),
    });
    const header = sessionHeader({ executionBackend: 'codex' });
    const result = executors.prepare('codex', {
      sessionId: header.id,
      workspaceRoot: header.workspaceRoot,
      header,
    }).providerStateIdentity;
    await root.fiber.dispose();
    return result;
  };

  const base = await identity('sha256-package-a', `sha256:${'1'.repeat(64)}`);
  assert.notEqual(await identity('sha256-package-b', `sha256:${'1'.repeat(64)}`), base);
  assert.notEqual(await identity('sha256-package-a', `sha256:${'2'.repeat(64)}`), base);
  assert.equal(await identity('sha256-package-a', `sha256:${'1'.repeat(64)}`), base);
});

test('Session executor closes its iterator on exhaustion and early consumer exit', async () => {
  for (const exit of ['exhausted', 'consumer'] as const) {
    let returns = 0;
    const { backend, close } = await executorBackend(() => ({
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          next: async () => {
            if (emitted) return { done: true as const, value: undefined };
            emitted = true;
            return {
              done: false as const,
              value: { type: 'text_delta' as const, text: 'partial' },
            };
          },
          return: async () => {
            returns += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    }));
    for await (const _event of backend.send({ turnId: 'turn-a', text: 'hello' })) {
      if (exit === 'consumer') break;
    }
    assert.equal(returns, 1, exit);
    await close();
  }
});

test('Session executor contains iterator cleanup failure after one terminal outcome', async () => {
  let returns = 0;
  const { backend, close } = await executorBackend(() => ({
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) return { done: true as const, value: undefined };
          emitted = true;
          return { done: false as const, value: { type: 'complete' as const } };
        },
        return: async () => {
          returns += 1;
          throw new Error('cleanup failed');
        },
      };
    },
  }));
  const events = [];
  for await (const event of backend.send({ turnId: 'turn-a', text: 'hello' })) events.push(event);
  assert.deepEqual(
    events.map(({ type }) => type),
    ['complete'],
  );
  assert.equal(returns, 1);
  await close();
});

async function executorBackend(
  run: () => AsyncIterable<
    { readonly type: 'text_delta'; readonly text: string } | { readonly type: 'complete' }
  >,
) {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const executors = new PluginSessionExecutorService(root, agents);
  const plugin = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 1 },
  });
  plugin.sessionExecutors.register({ id: 'fixture', label: 'Fixture', create: () => ({ run }) });
  const header = sessionHeader({ executionBackend: 'fixture' });
  const backend = await executors
    .prepare('fixture', { sessionId: header.id, workspaceRoot: header.workspaceRoot, header })
    .build({
      sessionId: header.id,
      workspaceRoot: header.workspaceRoot,
      header,
      store: {} as never,
    });
  return { backend, close: () => root.fiber.dispose() };
}

function sessionHeader(patch: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-a',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    name: 'Session',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
    ...patch,
  };
}
