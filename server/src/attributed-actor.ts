import { Person, Update } from '@fedify/fedify/vocab'

/**
 * Mastodon's `attributionDomains` term, defined as its own actor serializer defines it
 * (`app/helpers/context_helper.rb`): plain strings, not IRIs.
 */
const ATTRIBUTION_DOMAINS_CONTEXT = {
  toot: 'http://joinmastodon.org/ns#',
  attributionDomains: { '@id': 'toot:attributionDomains', '@container': '@set' },
}

const ATTRIBUTION_DOMAINS_IRI = 'http://joinmastodon.org/ns#attributionDomains'

/** What Fedify compacts the IRI to inside an activity, whose context knows `toot:` but not the term. */
const PREFIXED_ATTRIBUTION_DOMAINS = 'toot:attributionDomains'

type JsonObject = Record<string, unknown>
type PersonValues = ConstructorParameters<typeof Person>[0]
type PersonOptions = ConstructorParameters<typeof Person>[1]
type ToJsonLdOptions = Parameters<Person['toJsonLd']>[0]

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The document's `@context` with Mastodon's term definition appended. */
function withAttributionContext(context: unknown): unknown[] {
  const list = context === undefined ? [] : Array.isArray(context) ? context : [context]
  return [...list, ATTRIBUTION_DOMAINS_CONTEXT]
}

/**
 * The blog actor, carrying the domains Mastodon may credit it from on a link card
 * (`toot:attributionDomains`).
 *
 * @remarks
 * Fedify 2.4.4's `Person` has no such property and drops what it does not know when it builds
 * the document (fedify-dev/fedify#1234), so this adds it to what Fedify builds: as the bare
 * `attributionDomains` key with Mastodon's term definition when the actor is the document or is
 * embedded compact, and as the IRI with `@value` literals when it is expanded. Mastodon reads the
 * raw key and keeps only strings. Remove this class when Fedify ships the property.
 */
export class AttributedPerson extends Person {
  #attributionDomains: readonly string[]

  constructor(
    values: PersonValues & { attributionDomains?: readonly string[] },
    options?: PersonOptions
  ) {
    super(values, options)
    this.#attributionDomains = values.attributionDomains ?? []
  }

  override clone(
    values: Parameters<Person['clone']>[0] = {},
    options?: Parameters<Person['clone']>[1]
  ): Person {
    // Fedify clones through `new this.constructor`, which builds the copy without the domains.
    const copy = super.clone(values, options)
    if (copy instanceof AttributedPerson) copy.#attributionDomains = this.#attributionDomains
    return copy
  }

  override async toJsonLd(options: ToJsonLdOptions = {}): Promise<unknown> {
    const json = await super.toJsonLd(options)
    const domains = this.#attributionDomains
    if (domains.length === 0) return json

    if (options.format === 'expand') {
      const [node] = json as JsonObject[]
      if (node) node[ATTRIBUTION_DOMAINS_IRI] = domains.map((domain) => ({ '@value': domain }))
      return json
    }
    const document = json as JsonObject
    document.attributionDomains = [...domains]
    // Embedded in an activity it has no context of its own; `ActorUpdate` adds the term there.
    if (document['@context'] !== undefined) {
      document['@context'] = withAttributionContext(document['@context'])
    }
    return document
  }
}

/**
 * An `Update` of the blog actor that keeps the actor's `attributionDomains` under the key Mastodon
 * reads.
 *
 * @remarks
 * Mastodon hands the embedded actor to the code that reads a fetched one, and an actor without the
 * bare `attributionDomains` key resets the account's list to empty (fedify-dev/fedify#1234). When
 * Fedify compacts the activity through JSON-LD, its context lacks the term and the key comes out as
 * `toot:attributionDomains`; this renames it and adds the term's definition, which leaves the
 * document's meaning unchanged. The proofs and signatures are computed over this output.
 */
export class ActorUpdate extends Update {
  override async toJsonLd(options: Parameters<Update['toJsonLd']>[0] = {}): Promise<unknown> {
    const json = await super.toJsonLd(options)
    if (options.format === 'expand' || !isJsonObject(json) || !isJsonObject(json.object)) {
      return json
    }
    const actor = json.object
    const domains = actor.attributionDomains ?? actor[PREFIXED_ATTRIBUTION_DOMAINS]
    if (domains === undefined) return json

    delete actor[PREFIXED_ATTRIBUTION_DOMAINS]
    actor.attributionDomains = Array.isArray(domains) ? domains : [domains]
    json['@context'] = withAttributionContext(json['@context'])
    return json
  }
}
