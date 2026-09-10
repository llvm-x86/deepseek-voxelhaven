/**
 * html-lite.mjs — a minimal, dependency-free HTML reader.
 *
 * The scraper needs to read recipe structure out of minecraft.wiki, and the
 * only route the wiki's robots.txt permits is a plain page view
 * (`GET /w/<Title>`), which returns rendered HTML. `action=raw` and `api.php`
 * are both disallowed, so wikitext is not available to us at all; the rendered
 * recipe grids are the canonical structured form instead.
 *
 * This is a real parser — a tokeniser plus a stack-based tree builder — not a
 * regular expression over the document. It understands nesting (recipe slots
 * are spans inside spans inside spans), raw-text elements, void elements and
 * HTML entities, which is exactly what `class="mcui-Crafting&#95;Table"`
 * requires to be decoded correctly.
 *
 * It is deliberately forgiving: unknown or unbalanced tags are repaired rather
 * than thrown on, because a live wiki page must never crash the tool.
 */

/** Elements that never have children. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * @typedef {Object} HtmlNode
 * @property {string} tag                lower-case element name, '#root' for the document
 * @property {Record<string,string>} attrs
 * @property {HtmlNode[]} children
 * @property {HtmlNode|null} parent
 * @property {string} text               text directly inside this element
 */

/** Decode the HTML entities that appear in wiki markup. */
export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    switch (body.toLowerCase()) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return '\u00a0';
      case 'ndash': return '\u2013';
      case 'mdash': return '\u2014';
      case 'times': return '\u00d7';
      case 'hellip': return '\u2026';
      default: return match;
    }
  });
}

/**
 * Parse the attribute list of a start tag.
 * @param {string} source
 * @returns {Record<string,string>}
 */
function parseAttributes(source) {
  const attrs = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    const raw = match[3] !== undefined ? match[3]
      : match[4] !== undefined ? match[4]
        : match[5] !== undefined ? match[5]
          : '';
    attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

/** Create one node. */
function makeNode(tag, attrs, parent) {
  return { tag, attrs: attrs || {}, children: [], parent: parent || null, text: '' };
}

/**
 * Parse an HTML document into a tree.
 *
 * @param {string} html
 * @returns {HtmlNode} the `#root` node
 */
export function parseHTML(html) {
  const source = String(html);
  const root = makeNode('#root', {}, null);
  /** @type {HtmlNode[]} */
  const stack = [root];
  let i = 0;

  const current = () => stack[stack.length - 1];

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      current().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) current().text += decodeEntities(source.slice(i, lt));

    // Comments and doctypes.
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const closeMatch = /^<\s*\/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*>/.exec(source.slice(lt, lt + 80));
    if (closeMatch) {
      const tag = closeMatch[1].toLowerCase();
      // Unwind to the matching open element, if it is still on the stack.
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) {
          stack.length = s;
          break;
        }
      }
      i = lt + closeMatch[0].length;
      continue;
    }

    const openMatch = /^<\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/.exec(source.slice(lt, lt + 4096));
    if (!openMatch) {
      // A stray '<' that is not a tag: treat it as text.
      current().text += '<';
      i = lt + 1;
      continue;
    }

    const tag = openMatch[1].toLowerCase();
    const selfClosing = openMatch[3] === '/';
    const node = makeNode(tag, parseAttributes(openMatch[2]), current());
    current().children.push(node);
    i = lt + openMatch[0].length;

    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;

    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closeTag = `</${tag}`;
      const end = source.toLowerCase().indexOf(closeTag, i);
      if (end === -1) {
        node.text += decodeEntities(source.slice(i));
        i = source.length;
      } else {
        node.text += decodeEntities(source.slice(i, end));
        const gt = source.indexOf('>', end);
        i = gt === -1 ? source.length : gt + 1;
      }
      continue;
    }

    stack.push(node);
  }

  return root;
}

/**
 * Depth-first walk over a subtree.
 * @param {HtmlNode} node
 * @param {(node:HtmlNode)=>void} visit
 */
export function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Every descendant (including `node` itself) matching a predicate.
 * @param {HtmlNode} node
 * @param {(node:HtmlNode)=>boolean} predicate
 * @returns {HtmlNode[]}
 */
export function findAll(node, predicate) {
  const out = [];
  walk(node, (candidate) => { if (predicate(candidate)) out.push(candidate); });
  return out;
}

/** Class list of a node. */
export function classList(node) {
  const value = node.attrs && node.attrs.class;
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

/** True when the node carries a CSS class. */
export function hasClass(node, name) {
  return classList(node).includes(name);
}

/**
 * All descendant elements carrying a class.
 * @param {HtmlNode} node
 * @param {string} className
 * @returns {HtmlNode[]}
 */
export function findByClass(node, className) {
  return findAll(node, (candidate) => hasClass(candidate, className));
}

/**
 * Direct children carrying a class.
 * @param {HtmlNode} node
 * @param {string} className
 * @returns {HtmlNode[]}
 */
export function childrenByClass(node, className) {
  return node.children.filter((child) => hasClass(child, className));
}

/** Concatenated text of a subtree, whitespace-collapsed. */
export function textOf(node) {
  let out = node.text || '';
  for (const child of node.children) out += ` ${textOf(child)}`;
  return out.replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * Nearest ancestor (or self) satisfying a predicate.
 * @param {HtmlNode} node
 * @param {(node:HtmlNode)=>boolean} predicate
 * @returns {HtmlNode|null}
 */
export function closest(node, predicate) {
  let current = node;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * The best item title for a node that depicts one inventory slot.
 *
 * Wiki inventory sprites are wrapped in an `<a title="Oak Planks">`, but
 * self-links (a page's own item) come through as `<a class="mw-selflink">`
 * with no title, and a few outputs are plain `<span title="Torch">`. Falling
 * back through title → link text → image alt covers all three.
 *
 * @param {HtmlNode} node
 * @returns {string|null}
 */
export function itemTitle(node) {
  const anchor = findAll(node, (candidate) => candidate.tag === 'a')[0];
  if (anchor) {
    if (anchor.attrs.title) return anchor.attrs.title.trim();
    const text = textOf(anchor);
    if (text) return text;
  }
  const titled = findAll(node, (candidate) => !!candidate.attrs.title
    && findAll(candidate, (inner) => inner.tag === 'img').length > 0)[0];
  if (titled) return titled.attrs.title.trim();
  const image = findAll(node, (candidate) => candidate.tag === 'img')[0];
  if (image && image.attrs.alt) {
    const alt = image.attrs.alt.replace(/^Invicon\s+/, '').split(':')[0].trim();
    if (alt) return alt;
  }
  return null;
}
