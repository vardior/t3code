type ShellToken =
  | { readonly type: "word"; readonly value: string }
  | { readonly type: "operator"; readonly value: string }
  | { readonly type: "heredoc"; readonly body: string };

const COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&", "\n"]);

export function slackTextFromCommand(command: string): string | null {
  if (!command.includes("dm-send")) return null;
  const tokens = tokenizeShell(command);
  if (tokens === null) return null;
  const commands = splitCommands(tokens);
  const [shell, flag, script] = commands[0]?.words ?? [];
  if (commands.length === 1 && isShell(shell) && /^-[a-z]*c$/.test(flag ?? "") && script) {
    return slackTextFromCommand(script);
  }
  for (let index = 0; index < commands.length; index += 1) {
    const current = commands[index]!;
    if (!isDmSend(current.words[0])) continue;
    if (current.heredoc !== null) return current.heredoc.trim() || null;
    const previous = commands[index - 1];
    if (previous === undefined || previous.separator !== "|") continue;
    const text = stdoutOf(previous);
    if (text !== null && text.trim()) return text.trim();
  }
  return null;
}

interface SimpleCommand {
  readonly words: ReadonlyArray<string>;
  readonly heredoc: string | null;
  readonly separator: string | null;
}

function isShell(word: string | undefined): boolean {
  return word !== undefined && /(^|\/)(sh|bash|zsh)$/.test(word);
}

function isDmSend(word: string | undefined): boolean {
  return word !== undefined && (word === "dm-send" || word.endsWith("/dm-send"));
}

function stdoutOf(command: SimpleCommand): string | null {
  const [name, ...args] = command.words;
  if (name === "cat" && args.length === 0) return command.heredoc;
  if (name === "echo") return args.filter((arg) => arg !== "-n" && arg !== "-e").join(" ");
  if (name !== "printf" || args.length === 0) return null;
  const [format, ...values] = args as [string, ...string[]];
  if (values.length === 0) return unescapePrintf(format);
  if (!/^%s(\\n)?$/.test(format)) return null;
  return values.join("");
}

const PRINTF_ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\" };

function unescapePrintf(format: string): string {
  return format.replace(/\\([nt\\])/g, (_, char: string) => PRINTF_ESCAPES[char]!);
}

function splitCommands(tokens: ReadonlyArray<ShellToken>): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let heredoc: string | null = null;
  let skipNextWord = false;
  const flush = (separator: string | null) => {
    if (words.length > 0 || heredoc !== null) commands.push({ words, heredoc, separator });
    words = [];
    heredoc = null;
  };
  for (const token of tokens) {
    if (token.type === "heredoc") {
      heredoc = token.body;
    } else if (token.type === "operator") {
      if (COMMAND_SEPARATORS.has(token.value)) {
        flush(token.value);
      } else {
        skipNextWord = true;
      }
    } else if (skipNextWord) {
      skipNextWord = false;
    } else {
      words.push(token.value);
    }
  }
  flush(null);
  return commands;
}

function tokenizeShell(input: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  const pendingHeredocs: Array<{ delimiter: string; insertAt: number }> = [];
  let index = 0;
  let word: string | null = null;
  const pushWord = () => {
    if (word !== null) tokens.push({ type: "word", value: word });
    word = null;
  };
  const appendToWord = (text: string) => {
    word = (word ?? "") + text;
  };

  while (index < input.length) {
    const char = input[index]!;
    if (char === "\n") {
      pushWord();
      tokens.push({ type: "operator", value: "\n" });
      index += 1;
      for (const pending of pendingHeredocs.splice(0)) {
        const lines: string[] = [];
        while (index <= input.length) {
          const end = input.indexOf("\n", index);
          const line = input.slice(index, end === -1 ? input.length : end);
          index = end === -1 ? input.length + 1 : end + 1;
          if (line.trim() === pending.delimiter) break;
          lines.push(line);
        }
        tokens.splice(pending.insertAt, 0, { type: "heredoc", body: lines.join("\n") });
      }
      continue;
    }
    if (char === " " || char === "\t") {
      pushWord();
      index += 1;
      continue;
    }
    if (char === "#" && word === null) {
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }
    if (char === "\\") {
      if (input[index + 1] === "\n") {
        index += 2;
        continue;
      }
      appendToWord(input[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = input.indexOf("'", index + 1);
      if (end === -1) return null;
      appendToWord(input.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === "\\" && '"\\$`\n'.includes(input[index + 1] ?? "")) {
          if (input[index + 1] !== "\n") value += input[index + 1];
          index += 2;
        } else {
          value += input[index];
          index += 1;
        }
      }
      if (index >= input.length) return null;
      appendToWord(value);
      index += 1;
      continue;
    }
    const operator = /^(\|\||&&|<<-?|>>|>&|<&|[|&;<>])/.exec(input.slice(index))?.[0];
    if (operator !== undefined) {
      const fdPrefix = word !== null && /^\d+$/.test(word) && /^[<>]/.test(operator);
      if (fdPrefix) word = null;
      pushWord();
      index += operator.length;
      if (operator.startsWith("<<")) {
        while (input[index] === " ") index += 1;
        const start = index;
        while (index < input.length && !/[\s|&;<>]/.test(input[index]!)) index += 1;
        const delimiter = input.slice(start, index).replace(/['"]/g, "");
        if (!delimiter) return null;
        pendingHeredocs.push({ delimiter, insertAt: tokens.length });
        continue;
      }
      tokens.push({ type: "operator", value: operator });
      continue;
    }
    appendToWord(char);
    index += 1;
  }
  pushWord();
  if (pendingHeredocs.length > 0) return null;
  return tokens;
}
