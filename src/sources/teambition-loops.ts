/** Teambition polling loop: resolves the account once, then reads each watched project's changed tasks and their new activity. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { isoTime, threadKey, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { cursorAt } from './poll.ts'
import { health, type SourceContext } from './host.ts'
import type { TeambitionConfig } from './teambition.ts'
import { SOURCE, ActivitySchema, TaskSchema, activityKind, listOf, ownActivity, teambitionThread, teambitionTaskUrl, teambitionTrigger, type TeambitionActivity, type TeambitionTask } from './teambition-trigger.ts'

/** Rounds a Source reports as `error` only after this many consecutive failures, as the GitHub Source does. */
const FAILURES = 3
/** Pages one round reads for one list, so a backlog cannot make a round run unbounded. */
const PAGES = 8

const Tasks = listOf(TaskSchema)
const Activities = listOf(ActivitySchema)
const Account = z.looseObject({ userId: z.string(), name: z.string().default('') })
const Members = z.looseObject({ result: z.array(z.looseObject({ userId: z.string() })).default([]), nextPageToken: z.string().nullish() })

export type TeambitionAccount = { cli: string; id: string; name: string }

export const runTeambition = (ctx: SourceContext, signal: AbortSignal): Promise<void> => poll(ctx, signal)

const enabled = (ctx: SourceContext): TeambitionConfig | undefined => ctx.config<TeambitionConfig>(SOURCE)

/** Polls while the Source is enabled; a disabled or unconfigured Source reports `paused` and reads nothing. */
async function poll(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('teambition', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    if (!config.cli) {
      ctx.report('teambition', health('paused', 'teambitionCliUnset'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const started = new Date().toISOString()
    try {
      const account = await resolveAccount(ctx, config)
      const received = await round(ctx, config, account, started, signal)
      failures = 0
      ctx.report('teambition', { state: 'ready', at: new Date().toISOString(),
        detail: `${received} new activity; ${config.projects.length} project(s); next poll ≥ ${config.pollSeconds}s` })
    } catch (error) {
      if (signal.aborted) return
      failures += 1
      const detail = `${failures} consecutive failed polls; last: ${error instanceof Error ? error.message : String(error)}`
      ctx.report('teambition', failures >= FAILURES ? { state: 'error', detail } : { state: 'ready', detail })
    }
    await delay(config.pollSeconds * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Reads the account the CLI acts as, cached until the configured CLI changes. */
async function resolveAccount(ctx: SourceContext, config: TeambitionConfig): Promise<TeambitionAccount> {
  const cached = ctx.state.get(KV.teambition.account)
  if (cached && cached.cli === config.cli) return cached
  const me = await ctx.commands.tb(Account, config.cli, ['user', 'me']).catch(() => undefined)
  if (!me) throw new Error(health('error', 'teambitionAccountUnread').detail)
  const value = { cli: config.cli, id: me.userId, name: me.name }
  ctx.state.set(KV.teambition.account, value)
  return value
}

/** One polling round over every watched project; returns how many Triggers it received. */
async function round(ctx: SourceContext, config: TeambitionConfig, account: TeambitionAccount,
  started: string, signal: AbortSignal): Promise<number> {
  let received = 0
  for (const project of config.projects) {
    if (signal.aborted) return received
    const key = KV.teambition.cursor(project.projectId)
    const since = ctx.state.get(key)
    // The first round only records where reading starts: work that was there before the Source ran is not replayed.
    if (!since) { ctx.state.set(key, cursorAt(started)); continue }
    let tasks: TeambitionTask[]
    try { tasks = await changedTasks(ctx, config, project.projectId, since) }
    catch (error) {
      if (error instanceof Error) throw new Error(`${project.name || project.projectId}: ${error.message}`)
      throw error
    }
    for (const task of tasks) {
      if (signal.aborted) return received
      received += await readTask(ctx, config, account, task, since)
    }
    ctx.state.set(key, cursorAt(started))
  }
  return received
}

/** Reads the tasks of one project that changed since `since`, oldest change first, paging until the list ends or the page cap is reached. */
async function changedTasks(ctx: SourceContext, config: TeambitionConfig, projectId: string, since: string): Promise<TeambitionTask[]> {
  const tql = `updated >= '${since}' AND isArchived = false ORDER BY updated ASC`
  const tasks: TeambitionTask[] = []
  let token: string | undefined
  for (let page = 0; page < PAGES; page++) {
    const args = ['project', 'task-query', '--project-id', projectId, '--tql', tql, '--page-size', '100']
    if (token) args.push('--page-token', token)
    const result = await ctx.commands.tb(Tasks, config.cli, args)
    tasks.push(...result.result)
    if (!result.nextPageToken) break
    token = result.nextPageToken
  }
  return tasks
}

/** Reads one task's new activity and receives a Trigger for each comment or assignment the agent did not write itself. */
async function readTask(ctx: SourceContext, config: TeambitionConfig, account: TeambitionAccount,
  task: TeambitionTask, since: string): Promise<number> {
  const mark = KV.teambition.activity(task.id)
  const floor = ctx.state.get(mark) ?? since
  const fresh: TeambitionActivity[] = []
  let newest = ctx.state.get(mark) ?? ''
  let token: string | undefined
  for (let page = 0; page < PAGES; page++) {
    const args = ['task', 'activity', '--task-id', task.id, '--actions', '', '--page-size', String(config.readPageSize)]
    if (token) args.push('--page-token', token)
    const result = await ctx.commands.tb(Activities, config.cli, args)
    for (const activity of result.result) {
      const at = isoTime(activity.createTime)
      if (at > floor) fresh.push(activity)
      if (at > newest) newest = at
    }
    if (!result.nextPageToken) break
    token = result.nextPageToken
  }
  fresh.sort((left, right) => isoTime(left.createTime).localeCompare(isoTime(right.createTime)))
  let received = 0
  for (const activity of fresh) {
    if (ownActivity(activity, account.id)) continue
    const kind = activityKind(activity, account.id)
    if (!kind) continue
    await ctx.receive(teambitionTrigger(activity, task, kind, account, config.cli))
    received += 1
  }
  if (newest) ctx.state.set(mark, newest)
  ctx.threads.describe(threadKey({ source: SOURCE, id: teambitionThread(task.id) }), { label: task.content, url: teambitionTaskUrl(task.id) })
  return received
}

/** Project members as the Policy's allowed list; names stay empty because the member list carries ids only. */
export async function syncMembers(ctx: SourceContext, projectId: string, signal?: AbortSignal): Promise<{ id: string }[]> {
  const commands = ctx.commands.withSignal(signal)
  const config = enabled(ctx)
  if (!config) throw new Error('The Teambition Source is off')
  const ids = new Set<string>()
  let token: string | undefined
  for (let page = 0; page < PAGES; page++) {
    const args = ['project', 'member-query', '--project-id', projectId, '--page-size', '100']
    if (token) args.push('--page-token', token)
    const result = await commands.tb(Members, config.cli, args)
    for (const member of result.result) ids.add(member.userId)
    if (!result.nextPageToken) break
    token = result.nextPageToken
  }
  return [...ids].map(id => ({ id }))
}
