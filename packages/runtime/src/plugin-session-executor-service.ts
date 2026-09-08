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

import { createHash, randomUUID } from 'node:crypto';
import type { AgentBackend, BackendSendInput, BackendStopMode } from '@maka/core/backend-types';
import type { AttachmentRef, SessionEvent } from '@maka/core/events';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { Service, type Context } from './plugin-kernel.js';
import type { PluginAgentInvocation, PluginAgentService } from './plugin-agent-service.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';
import {
  MakaPluginRuntimeError,
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
} from './plugin-runtime.js';
import type { BackendPreparationContext, PreparedBackendActivation } from './session-manager.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly sessionExecutors: PluginSessionExecutorService;
  }
}

export interface PluginSessionExecutorCapabilities {
  readonly stop?: boolean;
}

export interface PluginSessionExecutorCreateContext {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface PluginSessionExecutorRunInput {
  readonly turnId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  readonly signal: AbortSignal;
}

export type PluginSessionExecutorEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'text_complete'; readonly text: string }
  | { readonly type: 'error'; readonly message: string; readonly recoverable?: boolean }
  | {
      readonly type: 'complete';
      readonly stopReason?: 'end_turn' | 'user_stop' | 'error' | 'step_limit' | 'max_tokens';
    };

export interface PluginSessionExecutor {
  run(input: PluginSessionExecutorRunInput): AsyncIterable<PluginSessionExecutorEvent>;
  stop?(reason: 'user_stop' | 'redirect', mode?: BackendStopMode): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface PluginSessionExecutorDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly capabilities?: PluginSessionExecutorCapabilities;
  create(
    context: PluginSessionExecutorCreateContext,
  ): PluginSessionExecutor | Promise<PluginSessionExecutor>;
}

export interface PluginSessionExecutorSummary {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly capabilities: PluginSessionExecutorCapabilities;
  readonly extensionId: string;
}

export interface PluginSessionExecutorInspection
  extends MakaContributionIdentity,
    PluginSessionExecutorSummary {}

interface RegisteredExecutor extends MakaContributionIdentity {
  readonly definition: PluginSessionExecutorDefinition;
  readonly token: symbol;
  retired: boolean;
}

/** Scoped provider seam for Sessions whose turns are executed outside Maka's Agent Loop. */
export class PluginSessionExecutorService extends Service {
  private readonly registry = new PluginScopeRegistry<RegisteredExecutor>();

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
    private readonly onChanged: () => void = () => undefined,
  ) {
    super(ctx, 'sessionExecutors');
  }

  register(definition: PluginSessionExecutorDefinition): () => Promise<void> {
    validateDefinition(definition);
    if (definition.id === 'maka') throw new TypeError('Session executor id "maka" is reserved');
    const identity = pluginIdentity(this.ctx);
    if (identity.scopeId !== 'profile') {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        'Session executors must be registered in Profile scope',
      );
    }
    return registerPluginContribution(
      this.ctx,
      `sessionExecutors.register(${JSON.stringify(definition.id)})`,
      () => {
        const rootId = identity.scopeId as MakaPluginRootId;
        const existing = this.registry.get(rootId, definition.id);
        if (existing && existing.entryId !== identity.entryId) {
          throw new MakaPluginRuntimeError(
            'activation_failed',
            `Session executor ${JSON.stringify(definition.id)} is already registered by ${existing.entryId}`,
          );
        }
        const entry: RegisteredExecutor = {
          ...identity,
          definition: Object.freeze({
            ...definition,
            capabilities: Object.freeze({ ...(definition.capabilities ?? {}) }),
          }),
          token: Symbol(definition.id),
          retired: false,
        };
        return this.registry.publish(rootId, definition.id, entry, {
          onChanged: () => this.onChanged(),
        });
      },
    );
  }

  list(sessionId: string): readonly PluginSessionExecutorSummary[] {
    return Object.freeze(
      [...this.registry.visible(assertSessionId(sessionId)).values()]
        .sort((left, right) => left.definition.label.localeCompare(right.definition.label))
        .map(({ definition, extensionId }) => summary(definition, extensionId)),
    );
  }

  inspect(rootId?: MakaPluginRootId): readonly PluginSessionExecutorInspection[] {
    return Object.freeze(
      [...this.registry.entries(rootId)]
        .sort((left, right) => left.definition.label.localeCompare(right.definition.label))
        .map(({ definition, token: _token, retired: _retired, ...identity }) =>
          Object.freeze({ ...identity, ...summary(definition, identity.extensionId) }),
        ),
    );
  }

  prepare(executorId: string, context: BackendPreparationContext): PreparedBackendActivation {
    const entry = this.registry.visible(assertSessionId(context.sessionId)).get(executorId);
    if (!entry) throw new Error(`Session executor is unavailable: ${executorId}`);
    const providerStateIdentity = `sha256:${createHash('sha256')
      .update(
        JSON.stringify([entry.extensionId, entry.entryId, entry.generation, entry.definition.id]),
      )
      .digest('hex')}` as const;
    return {
      providerStateIdentity,
      build: async () =>
        new PluginSessionExecutorBackend(
          await entry.definition.create({
            sessionId: context.sessionId,
            workspaceRoot: context.workspaceRoot,
            cwd: context.header.cwd,
            signal: context.abortSignal,
          }),
          this.agents,
          context,
        ),
    };
  }
}

class PluginSessionExecutorBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;
  private readonly activeAborts = new Set<AbortController>();

  constructor(
    private readonly executor: PluginSessionExecutor,
    private readonly agents: PluginAgentService,
    private readonly context: BackendPreparationContext,
  ) {
    this.sessionId = context.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const abort = new AbortController();
    this.activeAborts.add(abort);
    const messageId = randomUUID();
    const invocation: PluginAgentInvocation = Object.freeze({
      sessionId: this.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      turnId: input.turnId,
      cwd: this.context.header.cwd,
      permissionMode: this.context.header.permissionMode,
      abortSignal: abort.signal,
    });
    let terminal = false;
    try {
      const iterable = this.agents.withInvocationContext(invocation, () =>
        this.executor.run({
          turnId: input.turnId,
          text: input.text,
          attachments: Object.freeze([...(input.attachments ?? [])]),
          signal: abort.signal,
        }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      for (;;) {
        const next = await this.agents.withInvocationContext(invocation, () => iterator.next());
        if (next.done) break;
        const event = validateEvent(next.value);
        const ts = Date.now();
        if (event.type === 'text_delta') {
          yield {
            type: 'text_delta',
            id: randomUUID(),
            turnId: input.turnId,
            ts,
            messageId,
            text: event.text,
          };
        } else if (event.type === 'text_complete') {
          yield {
            type: 'text_complete',
            id: randomUUID(),
            turnId: input.turnId,
            ts,
            messageId,
            text: event.text,
          };
        } else if (event.type === 'error') {
          yield {
            type: 'error',
            id: randomUUID(),
            turnId: input.turnId,
            ts,
            recoverable: event.recoverable ?? false,
            message: event.message,
          };
        } else {
          terminal = true;
          if (abort.signal.aborted) {
            yield {
              type: 'abort',
              id: randomUUID(),
              turnId: input.turnId,
              ts,
              reason: abort.signal.reason === 'redirect' ? 'redirect' : 'user_stop',
            };
          } else {
            yield {
              type: 'complete',
              id: randomUUID(),
              turnId: input.turnId,
              ts,
              stopReason: event.stopReason ?? 'end_turn',
            };
          }
          await iterator.return?.();
          break;
        }
      }
      if (!terminal) {
        yield {
          type: 'error',
          id: randomUUID(),
          turnId: input.turnId,
          ts: Date.now(),
          recoverable: false,
          message: 'Session executor ended without a terminal event',
        };
        yield {
          type: 'complete',
          id: randomUUID(),
          turnId: input.turnId,
          ts: Date.now(),
          stopReason: 'error',
        };
      }
    } catch (error) {
      if (abort.signal.aborted) {
        yield {
          type: 'abort',
          id: randomUUID(),
          turnId: input.turnId,
          ts: Date.now(),
          reason: abort.signal.reason === 'redirect' ? 'redirect' : 'user_stop',
        };
      } else {
        yield {
          type: 'error',
          id: randomUUID(),
          turnId: input.turnId,
          ts: Date.now(),
          recoverable: false,
          message: error instanceof Error ? error.message : String(error),
        };
        yield {
          type: 'complete',
          id: randomUUID(),
          turnId: input.turnId,
          ts: Date.now(),
          stopReason: 'error',
        };
      }
    } finally {
      this.activeAborts.delete(abort);
    }
  }

  async stop(reason: 'user_stop' | 'redirect', mode?: BackendStopMode): Promise<void> {
    for (const abort of this.activeAborts) abort.abort(reason);
    await this.executor.stop?.(reason, mode);
  }

  respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {
    return Promise.reject(
      new Error('Session executor does not support Sandbox Boundary responses'),
    );
  }

  async dispose(): Promise<void> {
    for (const abort of this.activeAborts) abort.abort('redirect');
    await this.executor.dispose?.();
  }
}

function summary(
  definition: PluginSessionExecutorDefinition,
  extensionId: string,
): PluginSessionExecutorSummary {
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    ...(definition.description ? { description: definition.description } : {}),
    capabilities: Object.freeze({ ...(definition.capabilities ?? {}) }),
    extensionId,
  });
}

function validateDefinition(definition: PluginSessionExecutorDefinition): void {
  if (
    !definition ||
    typeof definition.id !== 'string' ||
    definition.id.length > 128 ||
    !/^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*$/u.test(definition.id)
  ) {
    throw new TypeError('Session executor id is invalid');
  }
  if (
    typeof definition.label !== 'string' ||
    !definition.label.trim() ||
    definition.label.length > 512 ||
    (definition.description !== undefined &&
      (typeof definition.description !== 'string' || definition.description.length > 4_096)) ||
    typeof definition.create !== 'function'
  ) {
    throw new TypeError('Session executor label and create are required');
  }
  if (
    definition.capabilities !== undefined &&
    (typeof definition.capabilities !== 'object' ||
      definition.capabilities === null ||
      Array.isArray(definition.capabilities) ||
      Object.keys(definition.capabilities).some((key) => key !== 'stop') ||
      (definition.capabilities.stop !== undefined &&
        typeof definition.capabilities.stop !== 'boolean'))
  ) {
    throw new TypeError('Session executor capabilities are invalid');
  }
}

function validateEvent(value: unknown): PluginSessionExecutorEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Session executor emitted an invalid event');
  }
  const event = value as Record<string, unknown>;
  const allowed =
    event.type === 'error'
      ? ['type', 'message', 'recoverable']
      : event.type === 'complete'
        ? ['type', 'stopReason']
        : ['type', 'text'];
  if (Object.keys(event).some((key) => !allowed.includes(key))) {
    throw new TypeError('Session executor emitted an open event shape');
  }
  if (
    (event.type === 'text_delta' || event.type === 'text_complete') &&
    typeof event.text === 'string'
  ) {
    return event as unknown as PluginSessionExecutorEvent;
  }
  if (
    event.type === 'error' &&
    typeof event.message === 'string' &&
    (event.recoverable === undefined || typeof event.recoverable === 'boolean')
  ) {
    return event as unknown as PluginSessionExecutorEvent;
  }
  if (
    event.type === 'complete' &&
    (event.stopReason === undefined ||
      ['end_turn', 'user_stop', 'error', 'step_limit', 'max_tokens'].includes(
        event.stopReason as string,
      ))
  ) {
    return event as unknown as PluginSessionExecutorEvent;
  }
  throw new TypeError('Session executor emitted an invalid event');
}

function assertSessionId(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new TypeError('Session id is invalid');
  return value;
}
