/** Normalizes Teambition task activities into domain Triggers. */
import { z } from 'zod'
import { isoTime, key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'teambition'
/** One Thread per task, so discussion and work on a task stay together across Tickets. */
export const teambitionThread = (taskId: string): string => `tb:task:${taskId}`
export const teambitionTaskUrl = (taskId: string): string => `https://www.teambition.com/task/${taskId}`
/** Reply address: the task, plus the settings that wrote it so a reply never needs the current configuration. */
export const teambitionChannel = (taskId: string, projectId: string, cli: string): ChannelRef =>
  ({ source: SOURCE, thread: teambitionThread(taskId), address: { taskId, projectId, cli } })
export const teambitionTriggerId = (activityId: string): string => key('teambition-activity', activityId)
/** Teambition writes a mention as `@` plus the account's display name, so a mention is a text match on that name. */
export const mentions = (text: string, name: string): boolean => {
  if (!name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_@])@${escaped}(?![A-Za-z0-9_-])`).test(text)
}
/** One entry of a task's activity feed; `content` is a JSON document whose shape depends on `action`. */
export const ActivitySchema = z.looseObject({
  id: z.string(), action: z.string(), creatorId: z.string().nullish(), createTime: z.string(),
  updateTime: z.string().nullish(), message: z.string().nullish(), content: z.string().nullish(),
  boundToObjectId: z.string().nullish(), boundToObjectType: z.string().nullish(),
})
export type TeambitionActivity = z.infer<typeof ActivitySchema>
/** A task as the project query returns it; `content` is the title and `note` the description. */
export const TaskSchema = z.looseObject({
  id: z.string(), content: z.string(), note: z.string().nullish(), projectId: z.string(),
  creatorId: z.string().nullish(), executorId: z.string().nullish(), created: z.string().nullish(),
  updated: z.string().nullish(), isDone: z.boolean().optional(), isArchived: z.boolean().optional(),
  uniqueId: z.number().optional(), tfsId: z.string().nullish(),
})
export type TeambitionTask = z.infer<typeof TaskSchema>
/** Envelope of `teambition-cli … --json` list answers: `result` plus a `nextPageToken` that is empty on the last page. */
export const listOf = <T extends z.ZodTypeAny>(item: T) =>
  z.looseObject({ result: z.array(item).default([]), nextPageToken: z.string().nullish() })
const body = (activity: TeambitionActivity): Record<string, unknown> => {
  if (!activity.content) return {}
  try {
    const parsed: unknown = JSON.parse(activity.content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} /* A non-JSON payload carries nothing this Source reads. */ }
}
export const commentText = (activity: TeambitionActivity): string =>
  typeof body(activity).comment === 'string' ? body(activity).comment as string : ''
/** Kinds of activity that become work: a comment a person wrote, and an assignment to the agent's account. */
export type ActivityKind = 'comment' | 'assignment'
export function activityKind(activity: TeambitionActivity, agentId: string): ActivityKind | undefined {
  if (activity.action === 'comment') return 'comment'
  const assigned = body(activity)._executorId
  if (activity.action === 'update_executor' && typeof assigned === 'string' && assigned === agentId) return 'assignment'
  return undefined
}
export const ownActivity = (activity: TeambitionActivity, agentId: string): boolean => activity.creatorId === agentId
/**
 * Builds the Trigger for one activity.
 * A comment's text is the comment itself; an assignment has no text of its own, so it quotes the activity sentence and the task.
 */
export function teambitionTrigger(activity: TeambitionActivity, task: TeambitionTask, kind: ActivityKind,
  agent: { id: string; name: string }, cli: string): Trigger {
  const at = isoTime(activity.updateTime ?? activity.createTime)
  const title = task.content
  const note = (task.note ?? '').trim()
  const text = kind === 'comment'
    ? commentText(activity)
    : [activity.message ?? 'The task was assigned to this account.', title, note].filter(Boolean).join('\n\n')
  return { id: teambitionTriggerId(activity.id), source: SOURCE,
    threads: [{ source: SOURCE, id: teambitionThread(task.id) }],
    actor: { source: SOURCE, id: activity.creatorId ?? '' },
    human: true,
    ...(kind === 'comment' ? mentions(text, agent.name) ? { addressed: 'mention' as const } : {} : { addressed: 'direct' as const }),
    at, text,
    channel: teambitionChannel(task.id, task.projectId, cli),
    url: teambitionTaskUrl(task.id),
    meta: { taskId: task.id, projectId: task.projectId, taskTitle: title, kind,
      activityId: activity.id, ...(kind === 'comment' ? { commentId: activity.id } : {}) } }
}
/** Trigger for a task as a whole, used when an assessment needs the task's own description as a Thread message. */
export const taskText = (task: TeambitionTask): string => [task.content, (task.note ?? '').trim()].filter(Boolean).join('\n\n')
