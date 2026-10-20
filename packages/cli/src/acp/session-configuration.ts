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

import type { SessionConfigOption, SetSessionConfigOptionRequest } from '@agentclientprotocol/sdk';
import { COLLABORATION_MODES, type CollaborationMode } from '@maka/core/collaboration';
import { THINKING_LEVELS, type ThinkingLevel } from '@maka/core/model-thinking';
import { ORCHESTRATION_MODES, type OrchestrationMode } from '@maka/core/orchestration';
import type { PermissionMode } from '@maka/core/permission';
import { CHAT_DEFAULT_PERMISSION_MODES } from '@maka/core/settings';
import type {
  SessionCatalogProjection,
  SessionConfigurationPatch,
} from '@maka/runtime-host/protocol';

interface AcpSessionConfigSpec {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly options: readonly (readonly [string, string])[];
}

/** One model the session's connection offers, as the Host resolved it. */
export interface AcpModelChoice {
  readonly id: string;
  readonly name?: string;
}

/** Everything a model-valued request needs, from the session and its catalogue. */
export interface AcpSessionModelConfigContext {
  readonly connectionId: string;
  readonly connectionSlug: string;
  readonly currentModel: string;
  readonly connectionLocked: boolean;
  readonly models: readonly AcpModelChoice[];
}

const MODEL_CONFIG_ID = 'model';
const MODEL_SPEC_NAME = 'Model';
const MODEL_CATEGORY = 'model';

/**
 * The values a session may select. A locked connection projects exactly the
 * model it already has: offering the rest and refusing every one of them would
 * advertise choices the client cannot take.
 */
function modelValues(
  models: readonly AcpModelChoice[],
  currentModel: string,
  locked: boolean,
): string[] {
  if (locked) return [currentModel];
  const offered = [...new Set(models.map(({ id }) => id).filter((id) => id.length > 0))];
  return offered.length > 0 ? offered : [currentModel];
}

function modelOptions(
  models: readonly AcpModelChoice[],
  currentModel: string,
  locked: boolean,
): readonly (readonly [string, string])[] {
  return modelValues(models, currentModel, locked).map(
    (id) => [id, models.find((model) => model.id === id)?.name ?? id] as const,
  );
}

const PERMISSION_NAMES: Readonly<Record<PermissionMode, string>> = {
  explore: 'Explore',
  ask: 'Ask',
  bypass: 'Bypass',
};

const THINKING_NAMES: Readonly<Record<ThinkingLevel | 'default', string>> = {
  default: 'Default',
  off: 'Off',
  on: 'On',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const COLLABORATION_NAMES: Readonly<Record<CollaborationMode, string>> = {
  agent: 'Agent',
  plan: 'Plan',
};

const ORCHESTRATION_NAMES: Readonly<Record<OrchestrationMode, string>> = {
  default: 'Default',
  swarm: 'Swarm',
  graph: 'Graph',
};

const PERMISSION_SPEC = {
  id: 'permission_mode',
  name: 'Permission mode',
  category: '_maka/permission_mode',
  options: namedOptions(CHAT_DEFAULT_PERMISSION_MODES, PERMISSION_NAMES),
} as const satisfies AcpSessionConfigSpec;
const THINKING_SPEC = {
  id: 'thinking_level',
  name: 'Thinking level',
  category: 'thought_level',
  options: namedOptions(['default', ...THINKING_LEVELS], THINKING_NAMES),
} as const satisfies AcpSessionConfigSpec;
const COLLABORATION_SPEC = {
  id: 'collaboration_mode',
  name: 'Collaboration mode',
  category: 'mode',
  options: namedOptions(COLLABORATION_MODES, COLLABORATION_NAMES),
} as const satisfies AcpSessionConfigSpec;
const ORCHESTRATION_SPEC = {
  id: 'orchestration_mode',
  name: 'Orchestration mode',
  category: '_maka/orchestration_mode',
  options: namedOptions(ORCHESTRATION_MODES, ORCHESTRATION_NAMES),
} as const satisfies AcpSessionConfigSpec;

const CONFIG_SPECS = [
  PERMISSION_SPEC,
  THINKING_SPEC,
  COLLABORATION_SPEC,
  ORCHESTRATION_SPEC,
] as const;

export function projectAcpSessionConfigOptions(
  session: SessionCatalogProjection,
  thinkingLevels: readonly ThinkingLevel[],
  models: readonly AcpModelChoice[] = [],
): SessionConfigOption[] {
  return [
    configOption(PERMISSION_SPEC, session.permissionMode),
    configOption(
      {
        id: MODEL_CONFIG_ID,
        name: MODEL_SPEC_NAME,
        category: MODEL_CATEGORY,
        options: modelOptions(models, session.model, session.connectionLocked),
      },
      session.model,
    ),
    ...(thinkingLevels.length === 0
      ? []
      : [
          configOption(
            {
              ...THINKING_SPEC,
              options: namedOptions(['default', ...thinkingLevels], THINKING_NAMES),
            },
            session.thinkingLevel ?? 'default',
          ),
        ]),
    configOption(COLLABORATION_SPEC, session.collaborationMode),
    configOption(ORCHESTRATION_SPEC, session.orchestrationMode),
  ];
}

function namedOptions<Value extends string>(
  values: readonly Value[],
  names: Readonly<Record<Value, string>>,
): readonly (readonly [Value, string])[] {
  return values.map((value) => [value, names[value]] as const);
}

function configOption(spec: AcpSessionConfigSpec, currentValue: string): SessionConfigOption {
  return {
    type: 'select',
    id: spec.id,
    name: spec.name,
    category: spec.category,
    currentValue,
    options: spec.options.map(([value, name]) => ({ value, name })),
  };
}

export class AcpSessionConfigInputError extends Error {
  readonly name = 'AcpSessionConfigInputError';
  constructor(
    readonly field: 'configId' | 'value',
    readonly reason: 'unsupported' | 'invalid_type',
  ) {
    super(`Invalid ACP Session configuration ${field}`);
  }
}

export function validateAcpSessionConfigOptionRequest(
  request: SetSessionConfigOptionRequest,
  modelContext?: AcpSessionModelConfigContext,
): asserts request is SetSessionConfigOptionRequest & { readonly value: string } {
  if (request.configId === MODEL_CONFIG_ID) {
    if (!modelContext) throw new AcpSessionConfigInputError('configId', 'unsupported');
    if (typeof request.value !== 'string')
      throw new AcpSessionConfigInputError('value', 'invalid_type');
    if (
      !modelValues(
        modelContext.models,
        modelContext.currentModel,
        modelContext.connectionLocked,
      ).includes(request.value)
    ) {
      throw new AcpSessionConfigInputError('value', 'unsupported');
    }
    return;
  }
  const spec = CONFIG_SPECS.find(({ id }) => id === request.configId);
  if (!spec) throw new AcpSessionConfigInputError('configId', 'unsupported');
  if (typeof request.value !== 'string')
    throw new AcpSessionConfigInputError('value', 'invalid_type');
  if (!spec.options.some(([value]) => value === request.value)) {
    throw new AcpSessionConfigInputError('value', 'unsupported');
  }
}

export function createAcpSessionConfigPatch(
  request: SetSessionConfigOptionRequest,
  modelContext?: AcpSessionModelConfigContext,
): SessionConfigurationPatch {
  validateAcpSessionConfigOptionRequest(request, modelContext);
  if (request.configId === MODEL_CONFIG_ID) {
    // Non-null: validation above rejects a model request without a context.
    const context = modelContext as AcpSessionModelConfigContext;
    return {
      modelTarget: {
        kind: 'explicit',
        connectionId: context.connectionId,
        connectionSlug: context.connectionSlug,
        model: request.value,
      },
    };
  }
  switch (request.configId) {
    case 'permission_mode':
      return { permissionMode: request.value as SessionConfigurationPatch['permissionMode'] };
    case 'thinking_level':
      return {
        thinkingLevel:
          request.value === 'default'
            ? null
            : (request.value as Exclude<
                SessionConfigurationPatch['thinkingLevel'],
                null | undefined
              >),
      };
    case 'collaboration_mode':
      return { collaborationMode: request.value as SessionConfigurationPatch['collaborationMode'] };
    case 'orchestration_mode':
      return { orchestrationMode: request.value as SessionConfigurationPatch['orchestrationMode'] };
    default:
      throw new AcpSessionConfigInputError('configId', 'unsupported');
  }
}
