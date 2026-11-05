import { expect, it } from 'vitest'
import { activityKind, mentions, ownActivity, teambitionTrigger, teambitionTriggerId, type TeambitionActivity, type TeambitionTask } from '../src/sources/teambition-trigger.ts'

const agent = { id: '5fa21cc722134dbded9c1118', name: 'hj-agent' }
const task: TeambitionTask = { id: '6aeacbff7b450f53769887f6', content: '修正登录页文案', note: '把“登入”改成“登录”',
  projectId: '6a9a60e25b0821fb32011faa', creatorId: '5e1da0eecc07fc0001f14e61', executorId: agent.id,
  created: '2026-11-04T06:09:03.595Z', updated: '2026-11-04T06:49:31.497Z' }
const comment = (text: string, creatorId = '5e1da0eecc07fc0001f14e61'): TeambitionActivity => ({
  id: '6aead57b1a8eb4a9ef9b6d22', action: 'comment', creatorId, createTime: '2026-11-04T06:49:31.509Z',
  message: `何佳: ${text}`, content: JSON.stringify({ comment: text, renderMode: 'markdown', attachments: [] }),
})
const assignment = (executorId: string, creatorId = '5e1da0eecc07fc0001f14e61'): TeambitionActivity => ({
  id: '6aead57b1a8eb4a9ef9b6d99', action: 'update_executor', creatorId, createTime: '2026-11-04T06:49:31.509Z',
  content: JSON.stringify({ _executorId: executorId, _oldExecutorId: null, actionVersion: 2 }),
})

it('turns a comment that mentions the account into an addressed Trigger on the task thread', () => {
  const trigger = teambitionTrigger(comment('@hj-agent 把这段文案改一下'), task, 'comment', agent, '/Users/me/.local/bin/tb-agent')
  expect(trigger).toMatchObject({
    id: teambitionTriggerId('6aead57b1a8eb4a9ef9b6d22'), source: 'teambition',
    threads: [{ source: 'teambition', id: 'tb:task:6aeacbff7b450f53769887f6' }],
    actor: { source: 'teambition', id: '5e1da0eecc07fc0001f14e61' }, human: true, addressed: 'mention',
    text: '@hj-agent 把这段文案改一下', url: 'https://www.teambition.com/task/6aeacbff7b450f53769887f6',
    channel: { source: 'teambition', thread: 'tb:task:6aeacbff7b450f53769887f6',
      address: { taskId: task.id, projectId: task.projectId, cli: '/Users/me/.local/bin/tb-agent', requesterId: '5e1da0eecc07fc0001f14e61', requesterName: '何佳' } },
    meta: { taskId: task.id, projectId: task.projectId, taskTitle: task.content, kind: 'comment', activityId: '6aead57b1a8eb4a9ef9b6d22', commentId: '6aead57b1a8eb4a9ef9b6d22' },
  })
})

it('leaves a comment that does not mention the account unaddressed, so only an observing project receives it as a candidate', () => {
  const trigger = teambitionTrigger(comment('这段文案看着不对'), task, 'comment', agent, 'tb-agent')
  expect(trigger.addressed).toBeUndefined()
  expect(trigger.text).toBe('这段文案看着不对')
})

it('treats an assignment to the account as an explicit request that quotes the task', () => {
  const trigger = teambitionTrigger(assignment(agent.id), task, 'assignment', agent, 'tb-agent')
  expect(trigger.addressed).toBe('direct')
  expect(trigger.text).toContain('修正登录页文案')
  expect(trigger.text).toContain('把“登入”改成“登录”')
})

it('recognizes only comments and assignments to the account', () => {
  expect(activityKind(comment('@hj-agent 看一下'), agent.id)).toBe('comment')
  expect(activityKind(assignment(agent.id), agent.id)).toBe('assignment')
  expect(activityKind(assignment('5e1da0eecc07fc0001f14e61'), agent.id)).toBeUndefined()
  expect(activityKind({ ...comment('x'), action: 'update.taskflowstatus' }, agent.id)).toBeUndefined()
})

it('drops activity the account wrote itself', () => {
  expect(ownActivity(comment('@hj-agent done', agent.id), agent.id)).toBe(true)
  expect(ownActivity(comment('@hj-agent 帮我', '5e1da0eecc07fc0001f14e61'), agent.id)).toBe(false)
})

it('matches a mention by display name only at a word boundary', () => {
  expect(mentions('@hj-agent 看看', 'hj-agent')).toBe(true)
  expect(mentions('请 @hj-agent 处理', 'hj-agent')).toBe(true)
  expect(mentions('@hj-agent2 看看', 'hj-agent')).toBe(false)
  expect(mentions('mail@hj-agent', 'hj-agent')).toBe(false)
  expect(mentions('@super-agent 看看', 'hj-agent')).toBe(false)
  expect(mentions('anything', '')).toBe(false)
})

it('reads the requester name from an assignment sentence as well as from a comment', () => {
  const assigned = { ...assignment(agent.id), message: '何佳 指派给了 hj-agent' } as TeambitionActivity
  const trigger = teambitionTrigger(assigned, task, 'assignment', agent, 'tb-agent')
  expect(trigger.channel?.address.requesterName).toBe('何佳')
  const said = { ...comment('@hj-agent 看一下'), message: '何佳: @hj-agent 看一下' }
  expect(teambitionTrigger(said, task, 'comment', agent, 'tb-agent').channel?.address.requesterName).toBe('何佳')
})

it('registers the repository and clone path a project names, and empty values when it names none', async () => {
  const { teambitionKind } = await import('../src/sources/teambition.ts')
  const config = { cli: 'tb-agent', pollSeconds: 60, readPageSize: 20,
    projects: [{ projectId: '6a9a60e25b0821fb32011faa', listen: 'mentions' as const, doneTfsId: '6a9a60e24b9cc0ae6da3fc5a',
      repo: 'hejiawow/ai_tiku', path: '/Users/zhuanz/projects/ai_tiku' }] }
  const trigger = teambitionTrigger(comment('@hj-agent 改一下'), task, 'comment', agent, 'tb-agent')
  const values = teambitionKind.environment!.values({ deployment: undefined as never, config, trigger })
  expect(values).toMatchObject({ DSH_SUPERAGENT_TEAMBITION_REPO: 'hejiawow/ai_tiku',
    DSH_SUPERAGENT_TEAMBITION_PATH: '/Users/zhuanz/projects/ai_tiku', DSH_SUPERAGENT_TEAMBITION_DONE: '6a9a60e24b9cc0ae6da3fc5a',
    DSH_SUPERAGENT_TEAMBITION_TASK: task.id })
  const unmapped = teambitionKind.environment!.values({ deployment: undefined as never, config: { ...config, projects: [] }, trigger })
  expect(unmapped.DSH_SUPERAGENT_TEAMBITION_REPO).toBe('')
  expect(unmapped.DSH_SUPERAGENT_TEAMBITION_PATH).toBe('')
})
