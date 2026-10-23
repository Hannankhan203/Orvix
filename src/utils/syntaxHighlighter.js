/**
 * Orvix Zero-Dependency Syntax Highlighter Engine
 *
 * Provides fast, safe, deterministic lexical tokenization for code blocks
 * without external CJS/ESM bundling dependencies.
 *
 * Supported language profiles:
 * - JavaScript / TypeScript / JSX / TSX
 * - Python
 * - HTML / XML / SVG / Markup
 * - CSS / SCSS
 * - JSON
 * - SQL / PostgreSQL / MySQL
 * - Bash / Shell / Zsh
 * - Java
 * - C / C++
 * - C# / CSharp
 * - PHP
 * - Go
 * - Rust
 * - YAML / Markdown
 * - Universal fallback
 */

export const TOKEN_TYPES = {
  COMMENT: 'comment',
  STRING: 'string',
  KEYWORD: 'keyword',
  TYPE: 'type',
  CONSTANT: 'constant',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  FUNCTION: 'function',
  PROPERTY: 'property',
  OPERATOR: 'operator',
  PUNCTUATION: 'punctuation',
  TAG: 'tag',
  ATTR_NAME: 'attr-name',
  VARIABLE: 'variable',
  DIRECTIVE: 'directive',
  PLAIN: 'plain'
};

// Language rules definitions
const GRAMMARS = {
  javascript: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.STRING, regex: /`(?:\\.|[^`\\])*(?:`|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null|undefined|NaN)\b/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|type|as|from)\b/y
    },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(string|number|boolean|any|unknown|never|void|object|symbol|bigint|Promise|Record|Array|Map|Set|Partial|Required|Readonly|Pick|Omit)\b/y
    },
    { type: TOKEN_TYPES.CONSTANT, regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b0b[01]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: TOKEN_TYPES.TAG, regex: /<\/?(?:[a-zA-Z_$][a-zA-Z0-9_$-]*)(?=[>\s\/]|$)|<\s*\/>|<\s*>/y },
    { type: TOKEN_TYPES.ATTR_NAME, regex: /\b[a-zA-Z0-9_-]+(?=\s*=)/y },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/y },
    { type: TOKEN_TYPES.PROPERTY, regex: /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*:)/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\+=|-=|\*=|\/=|%=|[+\-*/%&|^~!=<>?:.]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  python: [
    { type: TOKEN_TYPES.COMMENT, regex: /#[^\n]*/y },
    {
      type: TOKEN_TYPES.STRING,
      regex: /[rfbRFB]?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$))/y
    },
    { type: TOKEN_TYPES.VARIABLE, regex: /@[a-zA-Z_][a-zA-Z0-9_.]*|\b(self|cls)\b/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(True|False|None)\b/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|global|nonlocal|async|await|assert|match|case)\b/y
    },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(int|str|float|bool|list|dict|set|tuple|bytes|bytearray|object|type|Exception|BaseException|Any|Optional|Union|List|Dict|Tuple|Set)\b/y
    },
    { type: TOKEN_TYPES.CONSTANT, regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    {
      type: TOKEN_TYPES.FUNCTION,
      regex: /\b(print|len|range|enumerate|zip|isinstance|issubclass|sum|min|max|sorted|map|filter|any|all|open|id|hex|oct|bin|abs|round|callable|iter|next)\b|\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/y
    },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b0b[01]+\b|\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /==|!=|<=|>=|\+=|-=|\*=|\/=|\/\/=|\/\/|[+\-*/%&|^~!=<>:]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;.]/y }
  ],

  sql: [
    { type: TOKEN_TYPES.COMMENT, regex: /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.STRING, regex: /'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|PRIMARY|KEY|FOREIGN|REFERENCES|NOT|NULL|DEFAULT|CASCADE|SET|VALUES|UNION|ALL|AND|OR|IN|LIKE|ILIKE|BETWEEN|EXISTS|CASE|WHEN|THEN|ELSE|END|AS|DISTINCT|DATABASE|SCHEMA|TRANSACTION|COMMIT|ROLLBACK|BEGIN|ASC|DESC|WITH|RETURNING)\b/iy
    },
    {
      type: TOKEN_TYPES.FUNCTION,
      regex: /\b(COUNT|SUM|AVG|MIN|MAX|COALESCE|NOW|CONCAT|SUBSTRING|ROUND|UPPER|LOWER|ROW_NUMBER|DENSE_RANK|RANK|LEAD|LAG)\b|\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/iy
    },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(VARCHAR|TEXT|CHAR|INT|INTEGER|BIGINT|SMALLINT|BOOLEAN|BOOL|FLOAT|DOUBLE|DECIMAL|NUMERIC|DATE|TIME|TIMESTAMP|TIMESTAMPTZ|JSON|JSONB|UUID|SERIAL|BIGSERIAL)\b/iy
    },
    { type: TOKEN_TYPES.NUMBER, regex: /\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /<=|>=|!=|<>|=|<|>|\+|-|\*|\//y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[(),;.]/y }
  ],

  json: [
    { type: TOKEN_TYPES.PROPERTY, regex: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*(?:"|$)/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null)\b/y },
    { type: TOKEN_TYPES.NUMBER, regex: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],:]/y }
  ],

  markup: [
    { type: TOKEN_TYPES.COMMENT, regex: /<!--[\s\S]*?(?:-->|$)/y },
    { type: TOKEN_TYPES.DIRECTIVE, regex: /<!DOCTYPE[^>]*>/iy },
    { type: TOKEN_TYPES.TAG, regex: /<\/?(?:[a-zA-Z0-9:-]+)(?=[>\s\/]|$)|<\s*\/>|<\s*>/iy },
    { type: TOKEN_TYPES.ATTR_NAME, regex: /\b[a-zA-Z0-9:-]+(?=\s*=)/y },
    { type: TOKEN_TYPES.STRING, regex: /"[^"]*(?:"|$)|'[^']*(?:'|$)/y },
    { type: TOKEN_TYPES.CONSTANT, regex: /&[a-zA-Z0-9#]+;/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[=<>\/]/y }
  ],

  css: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.DIRECTIVE, regex: /@(media|keyframes|import|supports|charset|font-face)\b/y },
    { type: TOKEN_TYPES.PROPERTY, regex: /\b[a-zA-Z-]+(?=\s*:)/y },
    { type: TOKEN_TYPES.VARIABLE, regex: /var\(--[a-zA-Z0-9_-]+\)|--[a-zA-Z0-9_-]+/y },
    { type: TOKEN_TYPES.CONSTANT, regex: /#[0-9a-fA-F]{3,8}\b/y },
    { type: TOKEN_TYPES.STRING, regex: /"[^"]*(?:"|$)|'[^']*(?:'|$)/y },
    { type: TOKEN_TYPES.NUMBER, regex: /-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|dvh|dvw|%|s|ms|deg|fr|ch)?\b/y },
    { type: TOKEN_TYPES.ATTR_NAME, regex: /[.#][a-zA-Z0-9_-]+|:[a-zA-Z-]+/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(inherit|initial|unset|auto|none|solid|flex|grid|block|inline|absolute|relative|fixed|sticky|important)\b/y
    },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}();:,]/y }
  ],

  bash: [
    { type: TOKEN_TYPES.COMMENT, regex: /#[^\n]*/y },
    {
      type: TOKEN_TYPES.STRING,
      regex: /"(?:\\.|[^"\\])*(?:"|$)/y,
      tokenize: (str) => {
        const varRegex = /\$[a-zA-Z_0-9]+|\$\{[^}]+\}|\$\d+|\$\?|\$\*|\$@/g;
        const subTokens = [];
        let lastIndex = 0;
        let match;
        while ((match = varRegex.exec(str)) !== null) {
          if (match.index > lastIndex) {
            subTokens.push({
              type: TOKEN_TYPES.STRING,
              content: str.slice(lastIndex, match.index)
            });
          }
          subTokens.push({
            type: TOKEN_TYPES.VARIABLE,
            content: match[0]
          });
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < str.length) {
          subTokens.push({
            type: TOKEN_TYPES.STRING,
            content: str.slice(lastIndex)
          });
        }
        return subTokens.length ? subTokens : [{ type: TOKEN_TYPES.STRING, content: str }];
      }
    },
    { type: TOKEN_TYPES.STRING, regex: /'[^']*(?:'|$)/y },
    { type: TOKEN_TYPES.VARIABLE, regex: /\$[a-zA-Z_0-9]+|\$\{[^}]+\}|\$\d+|\$\?|\$\*|\$@/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(if|then|else|elif|fi|case|esac|for|while|until|do|done|in|function|select|time|return|exit)\b/y
    },
    {
      type: TOKEN_TYPES.FUNCTION,
      regex: /\b(echo|cd|ls|mkdir|rm|cp|mv|cat|grep|npm|npx|pnpm|yarn|node|git|curl|wget|chmod|chown|sudo|export|source|alias|pkill|kill|systemctl|docker|find|sed|awk|tail|head|tee)\b/y
    },
    { type: TOKEN_TYPES.ATTR_NAME, regex: /--?[a-zA-Z0-9_-]+/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /&&|\|\||[|><;=&]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\]]/y }
  ],

  java: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null)\b/y },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(int|long|short|byte|float|double|char|boolean|void|String|Integer|Long|Boolean|Double|Float|List|Map|Set|ArrayList|HashMap|HashSet|Object|Optional)\b/y
    },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|volatile|while|record|sealed|permits)\b/y
    },
    { type: TOKEN_TYPES.VARIABLE, regex: /@\w+/y },
    { type: TOKEN_TYPES.CONSTANT, regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDlL]?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>?:.]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  cpp: [
    { type: TOKEN_TYPES.DIRECTIVE, regex: /#(?:include|define|undef|ifdef|ifndef|if|else|elif|endif|pragma)\b[^\n]*/y },
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|NULL|nullptr)\b/y },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(int|long|short|char|float|double|bool|void|size_t|uint8_t|uint16_t|uint32_t|uint64_t|int32_t|int64_t|auto|string|vector|map|unordered_map|pair|shared_ptr|unique_ptr)\b/y
    },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(asm|auto|break|case|catch|class|const|constexpr|continue|default|delete|do|else|enum|explicit|export|extern|for|friend|goto|if|inline|mutable|namespace|new|noexcept|operator|private|protected|public|return|sizeof|static|struct|switch|template|this|throw|try|typedef|typename|union|using|virtual|volatile|while)\b/y
    },
    { type: TOKEN_TYPES.CONSTANT, regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-zA-Z_]\w*(?=\s*\()/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /::|->|<<|>>|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>?:.]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  csharp: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.STRING, regex: /\$?"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null)\b/y },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(int|long|short|byte|float|double|char|bool|string|object|decimal|void|var|List|Dictionary|Task)\b/y
    },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(abstract|as|base|break|case|catch|checked|class|const|continue|default|delegate|do|else|enum|event|explicit|extern|finally|fixed|for|foreach|goto|if|implicit|in|interface|internal|is|lock|namespace|new|operator|out|override|params|private|protected|public|readonly|ref|return|sealed|sizeof|stackalloc|static|struct|switch|this|throw|try|typeof|unchecked|unsafe|using|virtual|volatile|while|async|await)\b/y
    },
    { type: TOKEN_TYPES.CONSTANT, regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-zA-Z_]\w*(?=\s*\()/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?[fFdDmMlL]?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|[+\-*/%&|^~!=<>?:.]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  php: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/y },
    { type: TOKEN_TYPES.VARIABLE, regex: /\$[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|null|TRUE|FALSE|NULL)\b/y },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|die|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|eval|exit|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|parent|print|private|protected|public|readonly|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield)\b/iy
    },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-zA-Z_]\w*(?=\s*\()/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /=>|->|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>?:.]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  go: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.STRING, regex: /`(?:\\.|[^`\\])*(?:`|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false|nil|iota)\b/y },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(bool|string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|byte|rune|float32|float64|complex64|complex128|error)\b/y
    },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/y
    },
    {
      type: TOKEN_TYPES.FUNCTION,
      regex: /\b(make|new|append|len|cap|copy|delete|close|panic|recover|print|println)\b|\b[a-zA-Z_]\w*(?=\s*\()/y
    },
    { type: TOKEN_TYPES.CONSTANT, regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /:=|<-|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>:]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  rust: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: TOKEN_TYPES.STRING, regex: /r#"[^"]*(?:"#|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/y },
    { type: TOKEN_TYPES.BOOLEAN, regex: /\b(true|false)\b/y },
    {
      type: TOKEN_TYPES.TYPE,
      regex: /\b(i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Option|Result|Vec|Box|Rc|Arc)\b/y
    },
    {
      type: TOKEN_TYPES.KEYWORD,
      regex: /\b(as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while)\b/y
    },
    { type: TOKEN_TYPES.FUNCTION, regex: /\b[a-z_][a-z0-9_]*!|\b[a-zA-Z_]\w*(?=\s*\()/y },
    { type: TOKEN_TYPES.CONSTANT, regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    { type: TOKEN_TYPES.NUMBER, regex: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?[a-zA-Z0-9_]*\b/y },
    { type: TOKEN_TYPES.OPERATOR, regex: /=>|->|::|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>?:.]/y },
    { type: TOKEN_TYPES.PUNCTUATION, regex: /[{}()\[\],;]/y }
  ],

  universal: [
    { type: TOKEN_TYPES.COMMENT, regex: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*/y },
    { type: TOKEN_TYPES.STRING, regex: /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`(?:\\.|[^`\\])*(?:`|$)/y },
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

// Grammar aliases
GRAMMARS.js = GRAMMARS.javascript;
GRAMMARS.node = GRAMMARS.javascript;
GRAMMARS.mjs = GRAMMARS.javascript;
GRAMMARS.cjs = GRAMMARS.javascript;
GRAMMARS.typescript = GRAMMARS.javascript;
GRAMMARS.ts = GRAMMARS.javascript;
GRAMMARS.tsx = GRAMMARS.javascript;
GRAMMARS.jsx = GRAMMARS.javascript;
GRAMMARS.py = GRAMMARS.python;
GRAMMARS.python3 = GRAMMARS.python;
GRAMMARS.html = GRAMMARS.markup;
GRAMMARS.xml = GRAMMARS.markup;
GRAMMARS.svg = GRAMMARS.markup;
GRAMMARS.scss = GRAMMARS.css;
GRAMMARS.sass = GRAMMARS.css;
GRAMMARS.sh = GRAMMARS.bash;
GRAMMARS.shell = GRAMMARS.bash;
GRAMMARS.zsh = GRAMMARS.bash;
GRAMMARS.c = GRAMMARS.cpp;
GRAMMARS['c++'] = GRAMMARS.cpp;
GRAMMARS.cc = GRAMMARS.cpp;
GRAMMARS.cxx = GRAMMARS.cpp;
GRAMMARS.cs = GRAMMARS.csharp;
GRAMMARS.mysql = GRAMMARS.sql;
GRAMMARS.pgsql = GRAMMARS.sql;
GRAMMARS.postgres = GRAMMARS.sql;
GRAMMARS.postgresql = GRAMMARS.sql;
GRAMMARS.sqlite = GRAMMARS.sql;
GRAMMARS.golang = GRAMMARS.go;
GRAMMARS.rs = GRAMMARS.rust;
GRAMMARS.yaml = GRAMMARS.universal;
GRAMMARS.yml = GRAMMARS.universal;
GRAMMARS.markdown = GRAMMARS.universal;
GRAMMARS.md = GRAMMARS.universal;

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
        if (typeof rules[r].tokenize === 'function') {
          const sub = rules[r].tokenize(match[0]);
          tokens.push(...sub);
        } else {
          tokens.push({
            type,
            content: match[0]
          });
        }
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
