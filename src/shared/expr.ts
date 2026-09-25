/**
 * 受限条件表达式求值器：仅支持数字字面量、标识符、四则运算、
 * 比较运算（< <= > >= == !=）与逻辑运算（&& || !）及括号。
 * 不执行任意代码，规则包中的 when / 区间界表达式都经由此求值。
 */

type Token =
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

const OPS = ["&&", "||", "<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/", "!", "(", ")"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (OPS.includes(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
    if (OPS.includes(ch)) { tokens.push({ t: "op", v: ch }); i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      if (!m) throw new Error(`非法数字: ${src.slice(i)}`);
      tokens.push({ t: "num", v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ t: "ident", v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error(`表达式含非法字符: ${ch}`);
  }
  return tokens;
}

type Value = number | boolean;

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private scope: Record<string, number>) {}

  parse(): Value {
    const v = this.parseOr();
    if (this.pos !== this.tokens.length) throw new Error("表达式存在多余内容");
    return v;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private takeOp(...ops: string[]): string | null {
    const tk = this.peek();
    if (tk && tk.t === "op" && ops.includes(tk.v)) { this.pos++; return tk.v; }
    return null;
  }

  private parseOr(): Value {
    let l = this.parseAnd();
    while (this.takeOp("||")) {
      const r = this.parseAnd();
      l = this.truthy(l) || this.truthy(r);
    }
    return l;
  }

  private parseAnd(): Value {
    let l = this.parseCmp();
    while (this.takeOp("&&")) {
      const r = this.parseCmp();
      l = this.truthy(l) && this.truthy(r);
    }
    return l;
  }

  private parseCmp(): Value {
    let l = this.parseAdd();
    for (;;) {
      const op = this.takeOp("<", "<=", ">", ">=", "==", "!=");
      if (!op) return l;
      const r = this.parseAdd();
      const ln = this.num(l), rn = this.num(r);
      switch (op) {
        case "<": l = ln < rn; break;
        case "<=": l = ln <= rn; break;
        case ">": l = ln > rn; break;
        case ">=": l = ln >= rn; break;
        case "==": l = ln === rn; break;
        case "!=": l = ln !== rn; break;
      }
    }
  }

  private parseAdd(): Value {
    let l = this.parseMul();
    for (;;) {
      const op = this.takeOp("+", "-");
      if (!op) return l;
      const r = this.parseMul();
      l = op === "+" ? this.num(l) + this.num(r) : this.num(l) - this.num(r);
    }
  }

  private parseMul(): Value {
    let l = this.parseUnary();
    for (;;) {
      const op = this.takeOp("*", "/");
      if (!op) return l;
      const r = this.parseUnary();
      l = op === "*" ? this.num(l) * this.num(r) : this.num(l) / this.num(r);
    }
  }

  private parseUnary(): Value {
    if (this.takeOp("!")) return !this.truthy(this.parseUnary());
    if (this.takeOp("-")) return -this.num(this.parseUnary());
    return this.parseAtom();
  }

  private parseAtom(): Value {
    const tk = this.peek();
    if (!tk) throw new Error("表达式意外结束");
    if (tk.t === "num") { this.pos++; return tk.v; }
    if (tk.t === "ident") {
      this.pos++;
      if (!(tk.v in this.scope)) throw new Error(`未知变量: ${tk.v}`);
      return this.scope[tk.v]!;
    }
    if (tk.t === "op" && tk.v === "(") {
      this.pos++;
      const v = this.parseOr();
      if (!this.takeOp(")")) throw new Error("缺少右括号");
      return v;
    }
    throw new Error(`表达式语法错误: ${JSON.stringify(tk)}`);
  }

  private num(v: Value): number {
    if (typeof v === "boolean") throw new Error("布尔值不能参与算术运算");
    return v;
  }
  private truthy(v: Value): boolean {
    return typeof v === "boolean" ? v : v !== 0;
  }
}

export function evalExpr(src: string, scope: Record<string, number>): number | boolean {
  return new Parser(tokenize(src), scope).parse();
}

export function evalCondition(src: string | undefined, scope: Record<string, number>): boolean {
  if (!src) return true;
  const v = evalExpr(src, scope);
  return typeof v === "boolean" ? v : v !== 0;
}

export function evalNumber(src: string, scope: Record<string, number>): number {
  const v = evalExpr(src, scope);
  if (typeof v !== "number") throw new Error(`表达式 ${src} 不是数值`);
  return v;
}
