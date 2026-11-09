/** The comments plugin's public REST prefix. */
const COMMENTS_API_PREFIX = '/api/comments/'

/** Whether a request path is under the comments plugin's public REST prefix (case is ignored). */
function isCommentsApiPath(path) {
  return `${path.toLowerCase().replace(/\/{2,}/g, '/')}/`.startsWith(COMMENTS_API_PREFIX)
}

module.exports = { isCommentsApiPath }
