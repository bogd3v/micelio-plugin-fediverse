// The host's side of the plugin's contract with `strapi-plugin-comments`: the fields a fediverse
// reply is stored in. It is an extension of the plugin's server rather than an extension
// `schema.json` because Strapi merges schema files shallowly: a `schema.json` that declared
// `attributes` would replace every attribute of the comments plugin.
module.exports = (plugin) => {
  // The plugin emails the author of the parent comment on every reply, to an address nobody
  // verified; the host sends nothing instead.
  const clientFactory = plugin.services.client
  plugin.services.client = (args) => {
    const client = clientFactory(args)
    client.sendResponseNotification = async () => undefined
    return client
  }

  const { schema } = plugin.contentTypes.comment

  schema.attributes = {
    ...schema.attributes,
    // Remote Note id: dedupes redelivered activities and resolves reply threads.
    fediverseUri: { type: 'string', unique: true, configurable: false },
    // `@user@host` of the remote author.
    fediverseActorHandle: { type: 'string', configurable: false },
    // Id of the `Note` this site published for a moderator's reply.
    fediverseNoteUri: { type: 'string', configurable: false },
    // Whether that `Note` was last retracted because the reply stopped being shown.
    fediverseNoteRetracted: { type: 'boolean', configurable: false },
  }

  return plugin
}
