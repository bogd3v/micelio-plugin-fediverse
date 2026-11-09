/**
 * The RFC 9421 `Signature-Input` check of inbox deliveries (ASVS V11.4.3).
 *
 * Fedify 2.4.2 checks an RFC 9421 `Content-Digest` only when the signature
 * covers the `content-digest` component, and nothing requires an inbox `POST`
 * to cover it. The inbox middleware therefore refuses an RFC 9421 delivery
 * unless every signature in it covers `content-digest`. See
 * `docs/FEDIVERSE.md`, "Inbox digest algorithms".
 */
import { decodeDict } from 'structured-field-values'

/** One signature of a `Signature-Input` header, as Fedify would verify it. */
export interface SignatureInputLabel {
  /** The dictionary key that names the signature (`sig1`). */
  label: string
  /** Whether the covered components include `"content-digest"`. */
  coversContentDigest: boolean
}

const CONTENT_DIGEST_COMPONENT = 'content-digest'

/**
 * Lists the signatures of a `Signature-Input` header with whether each covers
 * `content-digest`, or answers `null` when the header is not a structured
 * dictionary (RFC 8941).
 *
 * @remarks
 * Follows Fedify 2.4.2 `parseRfc9421SignatureInput`, with the same
 * `structured-field-values` `decodeDict`: a member counts as a signature only
 * when it is an inner list with a string `keyid` and a numeric `created`
 * parameter, and a component counts only when it is a string. Component
 * parameters (`"content-digest";sf`) do not matter: Fedify signs the whole
 * header whatever they are. A duplicate label keeps its last value.
 *
 * One difference: `decodeDict` gives a member without parameters
 * `params: null`, on which Fedify throws (it reads `item.params.keyid`) while
 * this function skips the member. The result is never more permissive: a
 * header left with no signature is refused here, and one whose other
 * signatures all cover `content-digest` reaches Fedify, which still fails on
 * the bare member as it did before this check.
 *
 * @internal
 */
export function parseSignatureInput(header: string): SignatureInputLabel[] | null {
  let dict: unknown
  try {
    dict = decodeDict(header)
  } catch {
    // Fedify reads a header it cannot parse as having no signature and refuses it.
    return null
  }
  if (typeof dict !== 'object' || dict === null) return null
  const labels: SignatureInputLabel[] = []
  for (const [label, member] of Object.entries(dict)) {
    if (!isSignatureMember(member)) continue
    labels.push({
      label,
      coversContentDigest: member.value.some(
        (component) =>
          isRecord(component) &&
          typeof component.value === 'string' &&
          component.value === CONTENT_DIGEST_COMPONENT
      ),
    })
  }
  return labels
}

/**
 * Whether an inbox delivery's `Signature-Input` header has at least one
 * signature and every signature covers `content-digest`.
 *
 * @remarks
 * Fedify accepts a delivery when any one of its signatures verifies, so a
 * single signature that skips `content-digest` would leave the body
 * unchecked: all of them must cover it. A header that does not parse, or has
 * no signature, is refused too; Fedify would refuse it anyway. Whether the
 * `Content-Digest` header is present, uses SHA-256 or SHA-512 and matches the
 * body is Fedify's check once the component is covered.
 */
export function isContentDigestCovered(header: string): boolean {
  const labels = parseSignatureInput(header)
  return labels !== null && labels.length > 0 && labels.every((l) => l.coversContentDigest)
}

/** A dictionary member Fedify reads as a signature: an inner list with `keyid` and `created`. */
function isSignatureMember(member: unknown): member is { value: unknown[] } {
  if (!isRecord(member) || !Array.isArray(member.value) || !isRecord(member.params)) return false
  return typeof member.params.keyid === 'string' && typeof member.params.created === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
