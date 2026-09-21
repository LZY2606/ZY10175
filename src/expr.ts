/**
 * 受限条件表达式解析器（不执行任意代码）。
 *
 * 文法（递归下降）：
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := '-' unary | primary
 *   primary := NUMBER | 'v' | '(' expr ')'
 *
 * 只允许：数字字面量、单一变量 v、四则运算与括号。
 * 标识符、函数调用、成员访问、字符串一律拒绝——规则包无法借此执行代码。
 */

export type EvalFn = (v: number) => number;

type Token =
  | { type: "num"; value: number }
  | { type: "ident"; name: string }
  | { type: "op"; value: string };

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([+\-*/()]))/g;
const ALLOWED_OPS = new Set(["+", "-", "*", "/", "(", ")"]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(input)) !== null) {
    if (match.index !== lastIndex) {
      const unexpected = input.slice(lastIndex, match.index).trim();
      if (unexpected.length > 0) {
        throw new Error(`非法字符: ${JSON.stringify(unexpected)}`);
      }
    }
    if (match[1] !== undefined) {
      tokens.push({ type: "num", value: Number(match[1]) });
    } else if (match[2] !== undefined) {
      tokens.push({ type: "ident", name: match[2] });
    } else if (match[3] !== undefined) {
      if (!ALLOWED_OPS.has(match[3])) {
        throw new Error(`非法运算符: ${match[3]}`);
      }
      tokens.push({ type: "op", value: match[3] });
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (input.slice(lastIndex).trim().length > 0) {
    throw new Error(`非法字符: ${JSON.stringify(input.slice(lastIndex).trim())}`);
  }
  if (tokens.length === 0) {
    throw new Error("空表达式");
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): EvalFn {
    const fn = this.parseExpr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new Error(`表达式在 ${t ? JSON.stringify(t.type === "op" ? t.value : t.type) : "?"} 处未结束`);
    }
    return fn;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) {
      throw new Error("表达式意外结束");
    }
    this.pos += 1;
    return t;
  }

  private parseExpr(): EvalFn {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.type === "op" && (t.value === "+" || t.value === "-")) {
        this.consume();
        const right = this.parseTerm();
        const op = t.value;
        const a = left;
        left = (v) => (op === "+" ? a(v) + right(v) : a(v) - right(v));
      } else {
        return left;
      }
    }
  }

  private parseTerm(): EvalFn {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.type === "op" && (t.value === "*" || t.value === "/")) {
        this.consume();
        const right = this.parseUnary();
        const op = t.value;
        const a = left;
        left = (v) => {
          if (op === "*") {
            return a(v) * right(v);
          }
          const denominator = right(v);
          if (denominator === 0) {
            throw new Error("除数为零");
          }
          return a(v) / denominator;
        };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): EvalFn {
    const t = this.peek();
    if (t?.type === "op" && t.value === "-") {
      this.consume();
      const operand = this.parseUnary();
      return (v) => -operand(v);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): EvalFn {
    const t = this.consume();
    if (t.type === "num") {
      const value = t.value;
      return () => value;
    }
    if (t.type === "ident") {
      if (t.name !== "v") {
        throw new Error(`不允许的标识符: ${t.name}（仅可用变量 v）`);
      }
      return (v) => v;
    }
    if (t.type === "op" && t.value === "(") {
      const inner = this.parseExpr();
      const closing = this.consume();
      if (closing.type !== "op" || closing.value !== ")") {
        throw new Error("缺少右括号");
      }
      return inner;
    }
    throw new Error(`意外的词法单元: ${JSON.stringify(t)}`);
  }
}

const cache = new Map<string, EvalFn>();

export function compileExpression(source: string): EvalFn {
  const cached = cache.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const fn = new Parser(tokenize(source)).parse();
  // 以 0 与 1 做一次健全性检查，触发常量表达式除零等错误。
  fn(0);
  fn(1);
  cache.set(source, fn);
  return fn;
}

export function evalExpression(source: string, v: number): number {
  return compileExpression(source)(v);
}
