/** Teambition outbound channel: comments on the task, deduplicated by the comment text already there. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { ActivitySchema, commentText, listOf, teambitionTaskUrl } from './teambition-trigger.ts'

const Comments = listOf(ActivitySchema)
/** The comment API has no idempotency key, so a retry looks for the same text among the task's newest comments first. */
async function posted(commands: SourceContext['commands'], cli: string, taskId: string, text: string): Promise<boolean> {
  const page = await commands.tb(Comments, cli, ['task', 'activity', '--task-id', taskId, '--actions', 'comment', '--page-size', '20'])
  return page.result.some(activity => commentText(activity).trim() === text.trim())
}
/** True when Teambition no longer accepts comments on the task, such as a deleted one. */
const gone = (error: unknown): boolean =>
  error instanceof CliError && /not found|not exist|不存在|已删除|无权限|forbidden/i.test(error.message)
/**
 * Comments on the task and mentions the person who asked, so Teambition notifies them.
 * Teambition shows a mention only when the content carries it, so the name goes into the text as well as the argument.
 */
export async function sendTeambition(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { taskId = '', cli = '', requesterId = '', requesterName = '' } = message.channel.address
  if (!taskId || !cli) throw new Error('Missing Teambition reply target')
  const mention = !!requesterId && !!requesterName && !message.text.includes(`@${requesterName}`)
  const text = mention ? `@${requesterName} ${message.text}` : message.text
  if (await posted(host.commands, cli, taskId, text)) return 'sent'
  const args = ['task', 'comment', '--task-id', taskId, '--content', text, '--render-mode', 'markdown']
  if (mention) args.push('--mention', requesterId)
  try { await host.commands.run(cli, args) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Deep link to the task, which every reply and result belongs to. */
export const teambitionLink = (address: Record<string, string>): ChannelLink => ({
  url: teambitionTaskUrl(address.taskId ?? ''), label: { zh: 'Teambition 任务', en: 'Teambition task' },
})
