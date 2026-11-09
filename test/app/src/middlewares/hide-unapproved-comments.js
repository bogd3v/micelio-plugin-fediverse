// The host's side of the plugin's contract with `strapi-plugin-comments` (docs/FEDIVERSE.md,
// "Replies"): the plugin stores a fediverse reply as `PENDING`, and the comments plugin's public
// endpoints return every comment. This is the middleware micelio-cms mounts to hide them.
const { isCommentsApiPath } = require('../utils/comments-path')

const COMMENT_UID = 'plugin::comments.comment'
const HIDDEN_STATUSES = new Set(['PENDING', 'REJECTED'])

function isHidden(value, hiddenIds = new Set()) {
  if (value == null || typeof value !== 'object') return false
  const { approvalStatus, id } = value
  return HIDDEN_STATUSES.has(approvalStatus ?? '') || (typeof id === 'number' && hiddenIds.has(id))
}

/** Collects the ids of the comments in a response body, with their `children` and `threadOf`. */
function collectIds(value, ids) {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, ids)
    return
  }
  if (value == null || typeof value !== 'object') return
  if (typeof value.id === 'number') ids.add(value.id)
  if (typeof value.threadOf === 'number') ids.add(value.threadOf)
  else if (value.threadOf != null) collectIds(value.threadOf, ids)
  if ('data' in value) collectIds(value.data, ids)
  if ('children' in value) collectIds(value.children, ids)
}

/**
 * Removes hidden comments, and their whole subtree, from the shapes the comments plugin returns. A
 * `threadOf` that points to a hidden comment becomes `null`.
 */
function pruneHiddenComments(value, hiddenIds) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isHidden(item, hiddenIds))
      .map((item) => pruneHiddenComments(item, hiddenIds))
  }
  if (value != null && typeof value === 'object') {
    const node = { ...value }
    if ('data' in node) node.data = pruneHiddenComments(node.data, hiddenIds)
    if ('children' in node) node.children = pruneHiddenComments(node.children, hiddenIds)
    const parent = node.threadOf
    if (typeof parent === 'number' ? hiddenIds?.has(parent) : isHidden(parent, hiddenIds)) {
      node.threadOf = null
    }
    return node
  }
  return value
}

// Visibility is read from the database by comment id, not from the response: the comments plugin
// accepts `omit` and `fields`, so a caller can drop `approvalStatus` from the body.
module.exports =
  (_config, { strapi }) =>
  async (ctx, next) => {
    await next()

    if (ctx.method !== 'GET' || !isCommentsApiPath(ctx.path)) return
    if (ctx.status !== 200 || ctx.body == null) return

    const ids = new Set()
    collectIds(ctx.body, ids)
    const hidden = await strapi.db.query(COMMENT_UID).findMany({
      select: ['id'],
      where: { id: { $in: [...ids] }, approvalStatus: { $in: [...HIDDEN_STATUSES] } },
    })
    const hiddenIds = new Set(hidden.map((row) => row.id))

    if (isHidden(ctx.body, hiddenIds)) {
      ctx.notFound()
      return
    }
    ctx.body = pruneHiddenComments(ctx.body, hiddenIds)
  }

module.exports.pruneHiddenComments = pruneHiddenComments
