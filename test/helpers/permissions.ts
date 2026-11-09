/** The users-permissions role of a type (`public`, `authenticated`). */
async function getRole(type: string) {
  return strapi.query('plugin::users-permissions.role').findOne({ where: { type } })
}

/** The role of a visitor with no account. */
async function getPublicRole() {
  return getRole('public')
}

export { getRole, getPublicRole }
