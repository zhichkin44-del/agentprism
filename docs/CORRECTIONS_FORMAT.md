# Owner-pair format (`agentprism.owner-pair.v1`)

A reusable record of one exchange: what the agent did in a turn, and how the owner answered it. Built by
`research/q1-forgetting.mjs` from local Claude Code logs. It is written to
`.agentprism/research/owner-pairs.jsonl`, which is gitignored: the records contain private texts and never
leave the machine. The same data serves two uses: measuring the price of forgetting, and training an
"owner's voice" model that learns how the owner catches the agent's mistakes.

One JSON object per line:

| Field                            | Meaning                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `schema`                         | `"agentprism.owner-pair.v1"`                                                                  |
| `id`                             | 16 hex chars, stable: hash of session id + the owner message's uuid                           |
| `source`                         | `agent`, `session`, `project` (folder name), `ts` (ISO), `owner_message_index` in the session |
| `model_output`                   | the agent turn before the owner message, `null` for the first message of a session            |
| `model_output.text`              | the agent's last text in that turn                                                            |
| `model_output.actions`           | `[{ tool, target }]` in order (target is a file path when there is one)                       |
| `model_output.calls`, `.usd`     | model calls in the turn and their API-equivalent cost                                         |
| `owner_message.text`             | the owner's message, with system reminders stripped                                           |
| `signals.interrupted`            | the owner interrupted the turn                                                                |
| `signals.denied_with_feedback`   | the owner rejected a tool call and said why                                                   |
| `signals.edits_undone_after`     | edits of this turn that a later edit exactly reverted                                         |
| `signals.cues`                   | the cue patterns that matched the owner message                                               |
| `signals.strict_correction`      | the strict variant also flags it (cue in the first 160 characters, no generic "don't")        |
| `is_correction`                  | heuristic: the owner message corrects the turn                                                |
| `error_type`                     | any of `forgot_context`, `wrong`, `revert`, `overreach`, `repeat`, `rejection`                |
| `context.tokens`                 | prompt size of the turn's last call                                                           |
| `context.calls_since_compaction` | calls since the last compaction                                                               |
| `context.after_compaction`       | a compaction happened between the previous owner message and this one                         |
| `label.by`, `.confidence`        | who labelled it (`heuristic-v1`) and how sure (0–1, from cues and structural signals)         |
| `label.human`                    | `null` until the owner labels it: `{ is_correction, error_type }`                             |

Machine messages are excluded: messages from other sessions, task notifications, command output and
pasted blocks. Only `origin.kind = "human"` (or no origin) counts as the owner.

`research/q1-review-sample.mjs` writes a local labeling sheet with 30 flagged and 30 unflagged pairs. The
owner's marks become `label.human` and give the classifier's precision and recall.
