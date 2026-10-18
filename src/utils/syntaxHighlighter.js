/**
 * Orvix Zero-Dependency Syntax Highlighter Engine
 *
 * Provides fast, safe, deterministic lexical tokenization for code blocks
 * without external CJS/ESM bundling dependencies.
 *
 * Supported language profiles:
 * - JavaScript / TypeScript / JSX / TSX
 * - HTML / XML / SVG / Markup
 * - CSS / SCSS
 * - Python
 * - SQL
 * - JSON
 * - Bash / Shell
 * - YAML / Markdown
 * - Universal fallback
 */

const TOKEN_TYPES = {
  COMMENT: 'comment',
  STRING: 'string',
  KEYWORD: 'keyword',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  FUNCTION: 'function',
  PROPERTY: 'property',
  OPERATOR: 'operator',
  PUNCTUATION: 'punctuation',
  TAG: 'tag',
  ATTR_NAME: 'attr-name',
  VARIABLE: 'variable',
  PLAIN: 'plain'
};

// Language rules definitions
const GRAMMARS = {
  javascript: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
    { type: TOKEN_TYPES.STRING, regex: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null|undefined|NaN)\b/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|type|as|any|number|string|boolean|unknown|never|readonly)\b/y
    },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: TOKEN_TYPES.TAG, regex: /<\/?(?:[a-zA-Z_$][a-zA-Z0-9_$-]*|\s*>)\/?>/y },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/y },
    { type: TOKEN_TYPES.PROPERTY, regex: /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*:)/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>?:.]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  python: [
    { type: TOKEN_TYPES.COMMENT, regex: /#[^\n]*/y },
    { type: TOKEN_TYPES.STRING, regex: /"""[\s\S]*?"""|'''[\s\S]*?'''|f?"(?:\\.|[^"\\])*"|f?'(?:\\.|[^'\\])*'/y },
    { type: TOKEN_TYPES.VARIABLE, regex: /@[a-zA-Z_][a-zA-Z0-9_.]*/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(True|False|None)\b/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|global|nonlocal|async|await|assert)\b/y
    },
    {
      type: TOKEN_TYPES.FUNCTION,
      regex: /\b(self|cls|int|str|float|bool|list|dict|set|tuple|print|len|range|enumerate|zip|isinstance|type)\b|\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/y
    },
    { type: TOKEN_TYPES.NUMBER, regex: /\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /==|!=|<=|>=|\+=|-=|\*=|\/=|\/\/|[+\-*/%&|^~!=<>:]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;.]/y }
  ],

  sql: [
    { type: TOKEN_TYPES.COMMENT, regex: /--[^\n]*|\/\*[\s\S]*?\*\//y },
    { type: TOKEN_TYPES.STRING, regex: /'(?:''|[^'])*'|"(?:""|[^"])*"/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|PRIMARY|KEY|FOREIGN|REFERENCES|NOT|NULL|DEFAULT|CASCADE|SET|VALUES|UNION|ALL|AND|OR|IN|LIKE|ILIKE|BETWEEN|EXISTS|CASE|WHEN|THEN|ELSE|END|AS|DISTINCT|DATABASE|SCHEMA|TRANSACTION|COMMIT|ROLLBACK|BEGIN|ASC|DESC)\b/iy
    },
    {
      type: TOKEN_TYPES.FUNCTION,
      regex: /\b(COUNT|SUM|AVG|MIN|MAX|COALESCE|NOW|CONCAT|SUBSTRING|ROUND|UPPER|LOWER)\b|\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/iy
    },
    {
      type: TOKEN_TYPES.ATTR_NAME,
      regex: /\b(VARCHAR|TEXT|CHAR|INT|INTEGER|BIGINT|SMALLINT|BOOLEAN|BOOL|FLOAT|DOUBLE|DECIMAL|NUMERIC|DATE|TIME|TIMESTAMP|JSON|JSONB|UUID|SERIAL|BIGSERIAL)\b/iy
    },
    { type: TOKEN_TYPES.NUMBER, regex: /\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /<=|>=|!=|<>|=|<|>|\+|-|\*|\//y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[(),;.]/y }
  ],

  json: [
    { type: TOKEN_TYPES.PROPERTY, regex: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*"/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null)\b/y },
    { type: TOKEN_TYPES.NUMBER, regex: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],:]/y }
  ],

  markup: [
    { type: TOKEN_TYPES.COMMENT, regex: /<!--[\s\S]*?-->/y },
    { type: TOKEN_TYPES.TAG, regex: /<\/?(?:[a-zA-Z0-9:-]+|\s*>)\/?>/y },
    { type: TOKEN_TYPES.ATTR_NAME, regex: /\b[a-zA-Z0-9:-]+(?=\s*=)/y },
    { type: TOKEN_TYPES.STRING, regex: /"[^"]*"|'[^']*'/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[=<>\/]/y }
  ],

  css: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\*[\s\S]*?\*\//y },
    { type: TOKEN_TYPES.PROPERTY, regex: /\b[a-zA-Z-]+(?=\s*:)/y },
    { type: TOKEN_TYPES.STRING, regex: /"[^"]*"|'[^']*'/y },
    { type: TOKEN_TYPES.NUMBER, regex: /-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg|fr)?\b/y },
    { type: TOKEN_TYPES.ATTR_NAME, regex: /[.#][a-zA-Z0-9_-]+|:[a-zA-Z-]+/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(inherit|initial|unset|auto|none|solid|flex|grid|block|inline|absolute|relative|fixed|sticky|important)\b/y
    },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}();:,]/y }
  ],

  bash: [
    { type: TOKEN_TYPES.COMMENT, regex: /#[^\n]*/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*"|'[^']*'/y },
    { type: TOKEN_TYPES.VARIABLE, regex: /\$[a-zA-Z_0-9]+|\$\{[^}]+\}/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(if|then|else|elif|fi|case|esac|for|while|until|do|done|in|function|select|time)\b/y
    },
    {
      type: TOKEN_TYPES.FUNCTION,
      regex: /\b(echo|cd|ls|mkdir|rm|cp|mv|cat|grep|npm|npx|node|git|curl|wget|chmod|sudo|export|source|alias|pkill|kill|systemctl)\b/y
    },
    { type: TOKEN_TYPES.ATTR_NAME, regex: /-[a-zA-Z0-9]+|--[a-zA-Z0-9-]+/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /&&|\|\||[|><;=&]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\]]/y }
  ],

  universal: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null|undefined|nil|True|False|None)\b/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(function|def|func|class|return|if|else|for|while|import|export|const|let|var|package|public|private)\b/y
    },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /=>|===|!==|==|!=|[+\-*/%=<>!&|]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;.]/y }
  ]
};

// Aliases lookup
GRAMMARS.typescript = GRAMMARS.javascript;
GRAMMARS.tsx = GRAMMARS.javascript;
GRAMMARS.jsx = GRAMMARS.javascript;
GRAMMARS.html = GRAMMARS.markup;
GRAMMARS.xml = GRAMMARS.markup;
GRAMMARS.svg = GRAMMARS.markup;
GRAMMARS.scss = GRAMMARS.css;
GRAMMARS.sass = GRAMMARS.css;
GRAMMARS.sh = GRAMMARS.bash;
GRAMMARS.shell = GRAMMARS.bash;
GRAMMARS.zsh = GRAMMARS.bash;
GRAMMARS.yaml = GRAMMARS.universal;
GRAMMARS.yml = GRAMMARS.universal;
GRAMMARS.markdown = GRAMMARS.universal;
GRAMMARS.md = GRAMMARS.universal;
GRAMMARS.c = GRAMMARS.javascript;
GRAMMARS.cpp = GRAMMARS.javascript;
GRAMMARS.csharp = GRAMMARS.javascript;
GRAMMARS.java = GRAMMARS.javascript;
GRAMMARS.go = GRAMMARS.javascript;
GRAMMARS.rust = GRAMMARS.javascript;

/**
 * Tokenizes a string of source code according to the given language.
 * Guarantees 100% preservation of every single character, whitespace, and line break.
 *
 * @param {string} code - Raw code string
 * @param {string} language - Target language identifier
 * @returns {Array<{ type: string, content: string }>}
 */
export function tokenizeCode(code = '', language = '') {
  if (!code || typeof code !== 'string') {
    return [];
  }

  const langKey = String(language || '').toLowerCase().trim();
  const rules = GRAMMARS[langKey] || GRAMMARS.universal;

  const tokens = [];
  let index = 0;
  const len = code.length;

  while (index < len) {
    let matched = false;

    // Try rules at current index
    for (let r = 0; r < rules.length; r++) {
      const { type, regex } = rules[r];
      regex.lastIndex = index;
      const match = regex.exec(code);

      if (match && match.index === index) {
        tokens.push({
          type,
          content: match[0]
        });
        index += match[0].length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Accumulate plain characters until the next potential token boundary
      let plainEnd = index + 1;
      while (plainEnd < len) {
        let isBoundary = false;
        for (let r = 0; r < rules.length; r++) {
          rules[r].regex.lastIndex = plainEnd;
          const lookahead = rules[r].regex.exec(code);
          if (lookahead && lookahead.index === plainEnd) {
            isBoundary = true;
            break;
          }
        }
        if (isBoundary) break;
        plainEnd++;
      }

      tokens.push({
        type: TOKEN_TYPES.PLAIN,
        content: code.slice(index, plainEnd)
      });
      index = plainEnd;
    }
  }

  return tokens;
}
