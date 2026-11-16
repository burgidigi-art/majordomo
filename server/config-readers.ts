// Small readers for the two config formats other tools keep their plugin servers in: Codex's TOML and
// Hermes's YAML. They cover what those files use for MCP servers (tables, strings, lists, nested maps),
// not the whole of either format; anything they do not understand is skipped, never guessed at.

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function unescape(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
}

/** Split "a, b, {c = d}" at top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"') cur += s[++i] ?? '';
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------- TOML ----------

function tomlValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('"""') || v.startsWith("'''")) return v.slice(3, -3);
  if (v.startsWith('"')) return unescape(v.slice(1, -1));
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[')) return splitTop(v.slice(1, -1)).map(tomlValue);
  if (v.startsWith('{')) {
    const obj: Record<string, unknown> = {};
    for (const pair of splitTop(v.slice(1, -1))) {
      const eq = pair.indexOf('=');
      if (eq > 0) obj[tomlKey(pair.slice(0, eq))] = tomlValue(pair.slice(eq + 1));
    }
    return obj;
  }
  return v;
}

const tomlKey = (k: string) => k.trim().replace(/^["']|["']$/g, '');

/** Parse the subset of TOML used in config files: [tables], [a.b] paths, key = value, arrays, inline tables. */
export function parseToml(text: string): Record<string, any> {
  const root: Record<string, any> = {};
  let table: Record<string, any> = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]!).trim();
    if (!line) continue;
    const header = /^\[\s*([^\][]+?)\s*\]$/.exec(line);
    if (header) {
      table = root;
      for (const part of header[1]!.split('.').map(tomlKey)) table = table[part] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    // A multi-line array: keep reading until the brackets balance.
    let value = line.slice(eq + 1).trim();
    while ((value.split('[').length > value.split(']').length || value.split('{').length > value.split('}').length) && i + 1 < lines.length) {
      value += ` ${stripComment(lines[++i]!).trim()}`;
    }
    line = line.slice(0, eq);
    const path = line.split('.').map(tomlKey);
    let target = table;
    for (const p of path.slice(0, -1)) target = target[p] ??= {};
    target[path.at(-1)!] = tomlValue(value);
  }
  return root;
}

// ---------- YAML ----------

function yamlScalar(raw: string): unknown {
  const v = raw.trim();
  if (!v || v === '~' || v === 'null') return null;
  if (v.startsWith('"')) return unescape(v.slice(1, v.lastIndexOf('"')));
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'")).replace(/''/g, "'");
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[')) return splitTop(v.slice(1, v.lastIndexOf(']'))).map(yamlScalar);
  if (v.startsWith('{')) {
    const obj: Record<string, unknown> = {};
    for (const pair of splitTop(v.slice(1, v.lastIndexOf('}')))) {
      const c = pair.indexOf(':');
      if (c > 0) obj[String(yamlScalar(pair.slice(0, c)))] = yamlScalar(pair.slice(c + 1));
    }
    return obj;
  }
  return v;
}

interface Line {
  indent: number;
  text: string;
}

/** Parse block YAML: nested maps by indentation, "- item" lists, flow [lists] and {maps}, quoted strings. */
export function parseYaml(text: string): any {
  const lines: Line[] = text
    .split(/\r?\n/)
    .map((l) => ({ indent: l.length - l.trimStart().length, text: stripComment(l).trimEnd().trim() }))
    .filter((l) => l.text && l.text !== '---');
  let i = 0;

  function block(indent: number): any {
    if (i >= lines.length || lines[i]!.indent < indent) return null;
    return lines[i]!.text.startsWith('- ') || lines[i]!.text === '-' ? list(lines[i]!.indent) : map(lines[i]!.indent);
  }

  function list(indent: number): unknown[] {
    const out: unknown[] = [];
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
      const rest = lines[i]!.text.slice(1).trim();
      i++;
      if (!rest) out.push(block(indent + 1));
      else if (/^[^"'[{][^:]*:(\s|$)/.test(rest)) {
        // "- key: value" starts a map inside the list.
        lines.splice(i, 0, { indent: indent + 2, text: rest });
        out.push(map(indent + 2));
      } else out.push(yamlScalar(rest));
    }
    return out;
  }

  function map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (i < lines.length && lines[i]!.indent === indent) {
      const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(lines[i]!.text);
      i++;
      if (!m) continue;
      const key = String(yamlScalar(m[1]!));
      const rest = (m[2] ?? '').trim();
      if (rest === '|' || rest === '>' || /^[|>][-+]$/.test(rest)) {
        const parts: string[] = [];
        while (i < lines.length && lines[i]!.indent > indent) parts.push(lines[i++]!.text);
        out[key] = parts.join(rest.startsWith('|') ? '\n' : ' ');
      } else if (rest) out[key] = yamlScalar(rest);
      else out[key] = i < lines.length && lines[i]!.indent > indent ? block(lines[i]!.indent) : i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ') ? list(indent) : null;
    }
    return out;
  }

  return block(0) ?? {};
}
