export type ParsedBashRedirectOp =
  | ">"
  | ">>"
  | "1>"
  | "1>>"
  | "2>"
  | "2>>"
  | "&>"
  | "&>>"
  | ">|"
  | "<";

export interface ParsedBashRedirect {
  op: ParsedBashRedirectOp;
  target: string;
}

export interface ParsedBashAstCommand {
  command: string;
  args: string[];
  redirects: ParsedBashRedirect[];
  envAssignments: string[];
}

export type ParsedBashAstResult =
  | {
    kind: "simple";
    commands: ParsedBashAstCommand[];
  }
  | {
    kind: "too-complex";
    reason: string;
  };

type BashSeparator = "|" | "&&" | "||" | ";" | "newline";

type BashToken =
  | { type: "word"; value: string }
  | { type: "separator"; value: BashSeparator }
  | { type: "redirect"; op: ParsedBashRedirectOp };

type TooComplexResult = {
  kind: "too-complex";
  reason: string;
};

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

function tooComplex(reason: string): TooComplexResult {
  return {
    kind: "too-complex",
    reason,
  };
}

function pushWord(tokens: BashToken[], current: { value: string }) {
  if (!current.value) {
    return;
  }

  tokens.push({
    type: "word",
    value: current.value,
  });
  current.value = "";
}

function parseSimpleCommand(tokens: BashToken[]): ParsedBashAstCommand | TooComplexResult {
  const envAssignments: string[] = [];
  const redirects: ParsedBashRedirect[] = [];
  const words: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (token.type === "separator") {
      return tooComplex("nested command separator");
    }

    if (token.type === "redirect") {
      const target = tokens[index + 1];
      if (!target || target.type !== "word") {
        return tooComplex("redirect without target path");
      }

      redirects.push({
        op: token.op,
        target: target.value,
      });
      index += 1;
      continue;
    }

    if (words.length === 0 && ENV_ASSIGNMENT_RE.test(token.value)) {
      envAssignments.push(token.value);
      continue;
    }

    words.push(token.value);
  }

  if (words.length === 0) {
    return tooComplex("empty command");
  }

  return {
    command: words[0]!,
    args: words.slice(1),
    redirects,
    envAssignments,
  };
}

export function isOutputRedirectOp(op: ParsedBashRedirectOp) {
  return op !== "<";
}

export function parseBashScriptAst(script: string): ParsedBashAstResult {
  const tokens: BashToken[] = [];
  const current = { value: "" };
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    const next = script[index + 1];
    const nextNext = script[index + 2];

    if (!char) {
      continue;
    }

    if (escape) {
      current.value += char;
      escape = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current.value += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        quote = null;
      } else {
        current.value += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === "#" && !current.value) {
      while (index + 1 < script.length && script[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "$") {
      return tooComplex("variable expansion");
    }

    if (char === "`") {
      return tooComplex("command substitution");
    }

    if (char === "(" || char === ")" || char === "{" || char === "}") {
      return tooComplex("subshell or grouping");
    }

    if (char === "*" || char === "?" || char === "[") {
      return tooComplex("glob expansion");
    }

    if (char === "\n") {
      pushWord(tokens, current);
      tokens.push({
        type: "separator",
        value: "newline",
      });
      continue;
    }

    if (/\s/.test(char)) {
      pushWord(tokens, current);
      continue;
    }

    if ((char === "1" || char === "2") && next === ">") {
      pushWord(tokens, current);
      if (nextNext === ">") {
        tokens.push({
          type: "redirect",
          op: `${char}>>` as ParsedBashRedirectOp,
        });
        index += 2;
      } else {
        tokens.push({
          type: "redirect",
          op: `${char}>` as ParsedBashRedirectOp,
        });
        index += 1;
      }
      continue;
    }

    if (char === "&") {
      pushWord(tokens, current);
      if (next === "&") {
        tokens.push({
          type: "separator",
          value: "&&",
        });
        index += 1;
        continue;
      }

      if (next === ">") {
        if (nextNext === ">") {
          tokens.push({
            type: "redirect",
            op: "&>>",
          });
          index += 2;
        } else {
          tokens.push({
            type: "redirect",
            op: "&>",
          });
          index += 1;
        }
        continue;
      }

      return tooComplex("background execution");
    }

    if (char === "|") {
      pushWord(tokens, current);
      if (next === "|") {
        tokens.push({
          type: "separator",
          value: "||",
        });
        index += 1;
      } else {
        tokens.push({
          type: "separator",
          value: "|",
        });
      }
      continue;
    }

    if (char === ";") {
      pushWord(tokens, current);
      tokens.push({
        type: "separator",
        value: ";",
      });
      continue;
    }

    if (char === "<") {
      pushWord(tokens, current);
      if (next === "<" || next === "(" || next === "&") {
        return tooComplex("unsupported input redirection");
      }

      tokens.push({
        type: "redirect",
        op: "<",
      });
      continue;
    }

    if (char === ">") {
      pushWord(tokens, current);
      if (next === "(") {
        return tooComplex("process substitution");
      }

      if (next === "&") {
        return tooComplex("file descriptor redirection");
      }

      if (next === ">") {
        tokens.push({
          type: "redirect",
          op: ">>",
        });
        index += 1;
        continue;
      }

      if (next === "|") {
        tokens.push({
          type: "redirect",
          op: ">|",
        });
        index += 1;
        continue;
      }

      tokens.push({
        type: "redirect",
        op: ">",
      });
      continue;
    }

    current.value += char;
  }

  if (escape) {
    return tooComplex("unterminated escape");
  }

  if (quote !== null) {
    return tooComplex("unterminated quoted string");
  }

  pushWord(tokens, current);

  const commands: ParsedBashAstCommand[] = [];
  let currentCommandTokens: BashToken[] = [];

  for (const token of tokens) {
    if (token.type === "separator") {
      if (currentCommandTokens.length === 0) {
        continue;
      }

      const command = parseSimpleCommand(currentCommandTokens);
      if ("kind" in command) {
        return command;
      }

      commands.push(command);
      currentCommandTokens = [];
      continue;
    }

    currentCommandTokens.push(token);
  }

  if (currentCommandTokens.length > 0) {
    const command = parseSimpleCommand(currentCommandTokens);
    if ("kind" in command) {
      return command;
    }
    commands.push(command);
  }

  if (commands.length === 0) {
    return tooComplex("empty script");
  }

  return {
    kind: "simple",
    commands,
  };
}
