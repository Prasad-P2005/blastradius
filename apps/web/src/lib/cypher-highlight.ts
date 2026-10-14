/**
 * Tiny Cypher highlighter → array of [className, text] tokens. No dependency,
 * good enough to make the Why? drawer readable on a screen recording.
 */
const KW =
  /^(MATCH|OPTIONAL|WHERE|WITH|RETURN|ORDER|BY|LIMIT|SKIP|CALL|YIELD|UNWIND|AS|AND|OR|NOT|IN|DISTINCT|DESC|ASC|MERGE|CREATE|SET|DELETE|DETACH|ON|CASE|WHEN|THEN|ELSE|END|IS|NULL|TRUE|FALSE|COLLECT|COUNT|EXISTS|UNION|ALL|FOREACH|REMOVE)$/i;

export type Tok = [cls: string, text: string];

export function highlightCypher(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\$[A-Za-z_][\w]*)|(:[A-Z][A-Za-z_]*)|([A-Za-z_][\w.]*)(?=\s*\()|([A-Za-z_][\w]*)|(\s+)|(\d+(?:\.\d+)?)|([^\w\s])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) out.push(["cy-comment", m[1]]);
    else if (m[2]) out.push(["cy-str", m[2]]);
    else if (m[3]) out.push(["cy-param", m[3]]);
    else if (m[4]) out.push(["cy-label", m[4]]);
    else if (m[5]) out.push([KW.test(m[5]) ? "cy-kw" : "cy-fn", m[5]]);
    else if (m[6]) out.push([KW.test(m[6]) ? "cy-kw" : "", m[6]]);
    else if (m[8]) out.push(["cy-str", m[8]]);
    else out.push(["", m[0]]);
  }
  return out;
}
