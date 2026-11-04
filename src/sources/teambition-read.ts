/** Bounded Teambition thread context for assessments: pages of a task's activity and the task itself. */
import { z } from 'zod'
import { isoTime, type Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import { ActivitySchema, TaskSchema, commentText, listOf, taskText, type TeambitionActivity } from './teambition-trigger.ts'
import type { TeambitionConfig } from './teambition.ts'

const Activities = listOf(ActivitySchema)
const Tasks = z.looseObject({ result: z.array(TaskSchema).default([]) })
/** The activity feed names its creator only by id, but its sentence starts with the display name; the id is the fallback. */
function authorName(activity: TeambitionActivity): string {
  const name = (activity.message ?? '').trim().split(/[:：]/)[0]?.trim() ?? ''
  return name && name.length <= 40 && !/\s/.test(name) ? name : activity.creatorId ?? ''
}
function message(activity: TeambitionActivity): ContextMessage | undefined {
  const text = activity.action === 'comment' ? commentText(activity) : (activity.message ?? '')
  if (!text) return undefined
  return { id: activity.id, from: authorName(activity), at: isoTime(activity.updateTime ?? activity.createTime), text }
}
/** Reads one page of a task's activity (`thread`), the task itself (`root`), or nothing for a reply target Teambition does not expose. */
export const teambitionThreadContext: ThreadContext<TeambitionConfig> = {
  messageId: (trigger: Trigger) => String(trigger.meta.activityId ?? ''),
  async read(commands: Commands, trigger: Trigger, part, cursor, config): Promise<ContextPart> {
    const taskId = String(trigger.meta.taskId ?? trigger.channel?.address.taskId ?? '')
    const cli = String(trigger.channel?.address.cli ?? config.cli)
    if (!taskId) throw new Error('The Teambition Trigger names no task')
    if (part === 'root') {
      const task = (await commands.tb(Tasks, cli, ['task', 'query', '--task-id', taskId])).result[0]
      if (!task) return { messages: [], body: {} }
      return { messages: [{ id: task.id, from: task.creatorId ?? '', at: isoTime(task.created ?? ''), text: taskText(task) }],
        body: { title: task.content, description: task.note ?? '', status: task.tfsId ?? '', done: task.isDone === true } }
    }
    if (part === 'parent') return { messages: [], body: {} }
    const args = ['task', 'activity', '--task-id', taskId, '--actions', '', '--page-size', String(config.readPageSize)]
    if (cursor) args.push('--page-token', cursor)
    const page = await commands.tb(Activities, cli, args)
    return { messages: page.result.flatMap(item => { const one = message(item); return one ? [one] : [] }),
      ...page.nextPageToken ? { next: page.nextPageToken } : {}, body: {} }
  },
}
