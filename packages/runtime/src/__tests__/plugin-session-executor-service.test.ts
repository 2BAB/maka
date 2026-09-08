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
