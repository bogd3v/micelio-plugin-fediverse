// The host's side of the plugin's contract with `strapi-plugin-comments`: the comments plugin
// parses its responses through a fixed schema that drops every attribute it does not declare,
// including the fediverse fields the extension adds (src/extensions/comments). This puts them
// back with one query per response, so a frontend can label fediverse replies and link to them.
const { isCommentsApiPath } = require('../utils/comments-path')

const COMMENT_UID = 'plugin::comments.comment'

/** Calls `visit` on every comment of a response body (array, comment or `{ data }`, `children`). */
function walkComments(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkComments(item, visit)
    return
  }
  if (value == null || typeof value !== 'object') return
  if (typeof value.id === 'number' && 'content' in value) visit(value)
  if ('data' in value) walkComments(value.data, visit)
  if ('children' in value) walkComments(value.children, visit)
}

module.exports =
  (_config, { strapi }) =>
  async (ctx, next) => {
    await next()

    if (ctx.method !== 'GET' || !isCommentsApiPath(ctx.path)) return
    if (ctx.status !== 200 || ctx.body == null) return

    const ids = new Set()
    walkComments(ctx.body, (comment) => ids.add(comment.id))
    if (ids.size === 0) return

    const rows = await strapi.db.query(COMMENT_UID).findMany({
      select: ['id', 'fediverseUri', 'fediverseActorHandle', 'blocked', 'removed'],
      where: { id: { $in: [...ids] } },
    })
    // Blocked or removed replies keep their place in the thread, but don't point at the original note.
    const visible = new Map(
      rows.filter((row) => !row.blocked && !row.removed).map((r) => [r.id, r])
    )
    walkComments(ctx.body, (comment) => {
      const fields = visible.get(comment.id)
      comment.fediverseUri = fields?.fediverseUri ?? null
      comment.fediverseActorHandle = fields?.fediverseActorHandle ?? null
    })
  }
