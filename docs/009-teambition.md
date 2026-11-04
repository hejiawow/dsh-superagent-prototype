# 009 Teambition

This document specifies a third Source besides GitHub and Feishu: Teambition. It follows the terms of [001 Domain model](001-domain.md) and the rules of [002 Authorization](002-authorization.md), and it is written in the shape [008 Cookbook](008-cookbook.md) asks a Source to take.

## What the Source is

Teambition is a project management system: work lives in tasks, and discussion lives in comments on those tasks. For this Source:

- A **task** is a Thread.
- A **comment** on a task in a watched project, or an **assignment** of such a task to the agent's account, is a Trigger.
- A **reply** is a comment on the same task.
- The agent's **identity** is a dedicated Teambition member account, used through an isolated `teambition-cli` configuration. Teambition has no bot identity for API writes, so the account is person-shaped; see [Identity](#identity-and-limitations).

## Transport

Polling, because Teambition offers no event subscription this Source could hold:

1. Every `pollSeconds` (default 60), for each watched project, one `project task-query` with TQL `updated >= <cursor> AND isArchived = false ORDER BY updated ASC`.
2. For each changed task, `task activity --task-id … --actions comment,assign,update.fields…`, read from the newest known activity.
3. Cursors live in `KV`: one per project (`updated` of the last successful round) and one per task (the newest activity id already read). Trigger IDs are deduplicated by the Engine, so a re-read costs nothing.

The reads are bounded: a project that did not change costs one query, and a long thread costs one page beyond what is already known. Failures follow the GitHub Source: three consecutive rounds before the Source reports `error`.

## Triggers

| Kind | Event | addressed | Meta |
| --- | --- | --- | --- |
| `comment` | a new comment on a task in a watched project | the comment mentions the agent's account | `taskId`, `projectId`, `commentId`, `actorId`, `actorName`, `taskTitle` |
| `assignment` | the task's executor became the agent's account | always | `taskId`, `projectId`, `activityId`, `actorId`, `actorName`, `taskTitle` |

Rules:

- Activity written by the agent account itself is dropped, as the Feishu Source drops the bot's messages and the GitHub Source drops its own login.
- Only tasks of watched projects produce Triggers; a comment elsewhere is not an event of this Source.
- Trigger ids are `tb:comment:<commentId>` and `tb:assign:<taskId>:<activityId>`, so polling and replays are idempotent.
- A task first seen through a comment starts its Thread from the task itself: the assessment reads the task's title, description, status and executor as the Thread root.

## Threads

One Thread per task, `tb:task:<taskId>`. Later comments fan out to every live Ticket subscribed to it, so a person answers a question or asks for a follow-up without mentioning the agent again. An ended Ticket keeps its Subscription: a person's comment resumes it under the same Mandate unless a person stopped it.

Correlation between tasks (a task naming another) is out of scope for this version; it needs a stable link syntax to be worth the Concept.

## Channels

A reply is `task comment --task-id … --render-mode markdown --content …`, with `--mention <requester id>` and the person's display name written into the content, so Teambition notifies them. The Channel remembers each comment id it created in `KV`: Teambition's comment API has no idempotency key, and a retry after an ambiguous failure must not post twice.

`link(address)` returns `https://www.teambition.com/task/<taskId>`.

Acknowledgements, questions, results and pull request links all go to the task, the way GitHub's replies go to the thread.

## Thread context

`threadContext.read` maps `task activity` onto `ContextMessage`:

- `thread` — a page of the task's activity, bounded by `readPageSize`, oldest first.
- `root` — the task: title, description, status, executor.
- `parent` — the comment a reply answers, when the activity carries one.

Attachments are not read in this version; `images` is omitted and the prompts say so.

## Policy

```ts
{ allowed: [{ id: <userId>, name?: string }], syncProject?: <projectId> }
```

- `allowed` holds the Teambition member ids who may originate work through this Source.
- `syncProject` replaces the list with that project's members at startup and on **Sync now**, the way the Feishu Source syncs from a chat.
- Admission rows: one per watched project for `comments`, plus one `assignments` row. A listed person's addressed comment is admitted; unaddressed comments are listened to only when a project is configured to observe them, which rule-based proactive work needs.
- `explicit` text for the panel: *a comment that mentions this account, or a task assigned to it, always makes an explicit request.*

## Execution

Variables this Source registers with the execution environment:

| Variable | Meaning |
| --- | --- |
| `DSH_SUPERAGENT_TEAMBITION_TASK` | the task id the Ticket came from |
| `DSH_SUPERAGENT_TEAMBITION_PROJECT` | its project id |
| `DSH_SUPERAGENT_TEAMBITION_TASK_URL` | its URL |
| `DSH_SUPERAGENT_TEAMBITION_DONE` | the status id a finished Ticket moves the task to, or empty when the project names none |

The prepare command builds a worktree from whatever clone the operator names, exactly as for a GitHub Ticket, and the branch prefix stays `agent/`. A Ticket whose change belongs in a repository opens its pull request with the GitHub CLI already in `worker-bin`, then posts the link as a Teambition comment.

Workers get a `teambition-cli` shim in `worker-bin` that runs the agent's wrapper, so every CLI call inside a Ticket acts as the dedicated account and never as the operator.

**Status changes.** The operator allowed the agent to move tasks. The Source therefore names, per project, the status a finished Ticket moves the task to (`doneTaskflowId`). The worker moves the task only to that status, only once its change is ready, and never guesses a status or a workflow. A project that names none is only commented on.

## The account

The Source resolves the account itself on its first round with `user me --json` (`userId`, `name`) and keeps it for as long as the configured CLI stays the same; the poll loop is the only writer, so nothing has to be added to the deployment setup that GitHub and Feishu go through. A failed read reports `teambitionAccountUnread` on the card, and a project the account cannot read reports `teambitionProjectUnreadable` with the project name.

The CLI must point into a configuration directory holding only the dedicated account's login: `~/.config/teambition-mcp-agent/config.json`, wrapped as `tb-agent`. Teambition's CLI has no strict-mode switch, so this isolation is a file-layout rule rather than an enforced one, unlike the Feishu bot's.

## Identity and limitations

- **The account is a person.** Comments and status changes appear as the dedicated account, and it is never the operator's own account. Everything [000 Philosophy](000-philosophy.md) says about responsibility belongs to whoever owns that account.
- **OAuth expiry.** When the login can no longer be refreshed, the Source reports `error` and a person runs `auth login` again.
- **No event subscription.** Latency equals `pollSeconds`; the panel shows the next poll.
- **No attachments.** Files and images in comments do not reach assessments.
- **No task creation.** The Source only reads tasks; it never creates, archives or deletes one.

## Configuration form

| Field | Type | Notes |
| --- | --- | --- |
| `cli` | text | the `tb-agent` wrapper; saving resolves the account and restarts dsh-superagent |
| `projects` | rows | `projectId` (24-hex), `name`, and optional `doneTaskflowId` |
| `pollSeconds` | number | advanced, 60–900, default 60 |
| `readPageSize` | number | advanced, 1–50, default 20 |

## Checklist against 008

| 008 step | This Source |
| --- | --- |
| Map events onto the domain | task = Thread, comment or assignment = Trigger, comment = Channel |
| Configuration | `cli`, `projects`, `pollSeconds`, `readPageSize`; health entries `teambition` and `history` |
| Trigger | `tb:comment:<commentId>` / `tb:assign:<taskId>:<activityId>`, own activity dropped |
| Scope | watched projects only; `row` = project id or `assignments` |
| Channel | task comment with mention, idempotent by remembered comment id |
| Thread context | task activity pages, task root, replied-to comment |
| Policy | `allowed` + `syncProject` + admission rows per project |
| Variables | the four `DSH_SUPERAGENT_TEAMBITION_*` variables |
| Plugin entry | `dsh-superagent-teambition`, its own loop and its own patch entry, disabled in the bundle |
| Tests | trigger mapping, scope decisions, cursor and idempotency, channel retry |
