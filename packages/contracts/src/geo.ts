/**
 * Geo canonicalisation for the cache key (ADR-0003).
 *
 * Two steps: ICU resolves aliases and retired codes to the current ISO code
 * (UK → GB, BU → MM, SU → RU …), then the result must be in the static ISO
 * 3166-1 alpha-2 set below. The static set — not ICU — decides validity, so a
 * runtime with different CLDR data can only fail closed (reject), never open a
 * new bucket for `EU`, `ZZ` or a typo. Rule R6: a wrong-but-accepted geo is a
 * permanent, silently wrong cache cell.
 */

/**
 * ISO 3166-1 alpha-2, 249 codes. Generated from ICU 78 region data minus
 * CLDR-only codes (EU EZ UN QO ZZ XA XB XK IC EA DG CP AC TA CQ) and aliases.
 */
export const ISO_3166_1_ALPHA2: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO ' +
    'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR ' +
    'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO ' +
    'RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV ' +
    'TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
)

/** Upper-case, alias-resolved ISO 3166-1 alpha-2, or a RangeError. */
export function canonicalGeo(geo: string): string {
  const upper = geo.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) throw new RangeError(`geo must be ISO 3166-1 alpha-2: ${geo}`)
  // 'und-UK' canonicalises to 'und-GB'; unknown-but-well-formed codes pass through unchanged.
  const canonical = (Intl.getCanonicalLocales(`und-${upper}`)[0] ?? '').slice(4).toUpperCase()
  if (!ISO_3166_1_ALPHA2.has(canonical)) throw new RangeError(`unknown ISO 3166-1 alpha-2 geo: ${geo}`)
  return canonical
}
