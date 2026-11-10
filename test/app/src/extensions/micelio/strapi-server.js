// The inverse side of `article.category` and `article.tags`: a plugin's type cannot target a type
// of the host, so the core cannot declare `articles` (the core plugin's architecture note
// in micelio-cms).
module.exports = (plugin) => {
  const { category, tag } = plugin.contentTypes

  category.schema.attributes = {
    ...category.schema.attributes,
    articles: {
      type: 'relation',
      relation: 'oneToMany',
      target: 'api::article.article',
      mappedBy: 'category',
    },
  }
  tag.schema.attributes = {
    ...tag.schema.attributes,
    articles: {
      type: 'relation',
      relation: 'manyToMany',
      target: 'api::article.article',
      mappedBy: 'tags',
    },
  }

  return plugin
}
