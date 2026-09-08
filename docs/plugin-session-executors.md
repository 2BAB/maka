<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Plugin Session executors

Trusted Host plugins can register a Session execution backend without changing WorkHub or the
Session transcript format. A Session stores the selected executor id in `executionBackend`; an
absent value means the built-in Maka Agent Loop.

```ts
export default (ctx) =>
  ctx.sessionExecutors.register({
    id: 'codex',
    label: 'Codex',
    description: 'Run this Session with Codex app-server',
    capabilities: { stop: true },
    create: ({ cwd }) => ({
      async *run({ text, signal }) {
        // Start and drive codex app-server in cwd. Observe signal for cancellation.
        yield { type: 'text_delta', text: 'Working…' };
        yield { type: 'text_complete', text: `Finished: ${text}` };
        yield { type: 'complete' };
      },
      async stop() {
        // Stop the child process owned by this executor instance.
      },
    }),
  });
```

Executor registrations are Profile-scoped because their ids are persisted in Session headers.
The Host rejects creation with an unavailable executor. Plugin reload or uninstall invalidates
idle backend instances; running Turns retain their current instance through settlement.

The Host adapts executor output to canonical Session events, so text, errors, terminal state,
stop, and restart recovery use the existing Turn and transcript authorities. A provider that
ends without a terminal event fails closed. During `run`, other invocation-safe plugin services,
including `ctx.attachments`, remain bound to the active Session and Turn.

Clients can discover installed providers through `plugin.platform.query` with
`view: "execution_backends"`. WorkHub forwards `newWorkDefaults.executionBackend` only when it
creates a new Session; it never changes the executor of existing work.
