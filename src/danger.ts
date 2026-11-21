/**
 * Which bash commands of a `code` bot need a person's approval in the chat first.
 * Pure: no I/O, no environment. The rules are the owner's and final:
 *
 * - recursive delete: `rm` with `-r`, `-R`, `--recursive`, or a combined short flag (`-rf`, `-fr`, ...);
 * - `git push`, in any form (`git -C dir push`, `git -c k=v push`, ...);
 * - a download piped into a shell (`curl ... | sh`, `wget ... | sudo bash`) or run by one
 *   (`sh -c "$(curl ...)"`, `bash <(curl ...)`);
 * - `sudo`, `su`, `doas`;
 * - any mention of the Yewholt state folder: `YEWHOLT_HOME`, `.yewholt`, or its path.
 *
 * Fail closed: a command that does not parse, or whose command name is a variable or a
 * substitution, needs approval. The parser is a small shell lexer, not a shell: it sees
 * `;`, `&&`, `||`, `|`, `&`, newlines, subshells, quotes, escapes, `$(...)`, backticks,
 * `<(...)` and `-c` strings of sh/bash/zsh/dash/ksh/su, and looks into each.
 */

export type BashVerdict = { approval: boolean; reasons: string[] };
export type BashContext = { home: string; homeAliases?: readonly string[] };

const RECURSIVE_DELETE = "recursive delete (rm -r)";
const GIT_PUSH = "git push";
const DOWNLOAD_TO_SHELL = "pipes or feeds a download into a shell";
const PRIVILEGE = "privilege change (sudo/su/doas)";
const STATE = "mentions the Yewholt state folder";
const UNPARSED = "could not parse the command";
const DYNAMIC = "runs a command named by a variable or substitution";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const DOWNLOADERS = new Set(["curl", "wget"]);
const PRIVILEGED = new Set(["sudo", "su", "doas"]);
/** Commands that run another command from their arguments: every later word may be a command. */
const WRAPPERS = new Set([
  "sudo", "doas", "su", "env", "command", "builtin", "exec", "nice", "nohup", "time", "timeout",
  "xargs", "stdbuf", "ionice", "watch", "find", "chroot", "setsid", "flock", "unbuffer", "parallel",
]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac", "!", "{", "}", "in"]);
/** Shell-like commands whose argument is itself a script. */
const EVALUATORS = new Set(["eval", "source", "."]);
const MAX_DEPTH = 8;

type Word = { text: string; subs: string[]; dynamic: boolean; redirect?: boolean };
type Pipeline = Word[][];

export function classifyBash(command: string, context: BashContext): BashVerdict {
  const reasons = new Set<string>();
  if (mentionsState(command, context)) reasons.add(STATE);
  analyze(command, reasons, 0);
  const list = [...reasons];
  return { approval: list.length > 0, reasons: list };
}

function mentionsState(command: string, context: BashContext): boolean {
  if (/YEWHOLT_HOME/.test(command) || command.includes(".yewholt")) return true;
  const homes = [context.home, ...(context.homeAliases ?? [])].map((path) => path.replace(/\/+$/, "")).filter((path) => path.length > 1);
  return homes.some((path) => command.includes(path));
}

/** Adds reasons; returns whether the text downloads something (for `sh -c "$(curl ...)"`). */
function analyze(script: string, reasons: Set<string>, depth: number): boolean {
  if (depth > MAX_DEPTH) {
    reasons.add(UNPARSED);
    return true;
  }
  const parsed = lex(script);
  if (!parsed) {
    reasons.add(UNPARSED);
    return true;
  }
  let downloads = false;
  for (const pipeline of parsed) {
    let downloadedBefore = false;
    for (const stage of pipeline) {
      const result = analyzeStage(stage, reasons, depth);
      if (result.shell && downloadedBefore) reasons.add(DOWNLOAD_TO_SHELL);
      if (result.downloads) {
        downloadedBefore = true;
        downloads = true;
      }
    }
  }
  return downloads;
}

function analyzeStage(stage: Word[], reasons: Set<string>, depth: number): { shell: boolean; downloads: boolean } {
  let downloads = false;
  let subDownloads = false;
  for (const word of stage) {
    for (const sub of word.subs) if (analyze(sub, reasons, depth + 1)) subDownloads = true;
  }
  // Redirection targets are looked into (above) but are not arguments.
  stage = stage.filter((word) => !word.redirect);
  // Leading assignments and keywords are not the command.
  let start = 0;
  while (start < stage.length && (KEYWORDS.has(stage[start]!.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(stage[start]!.text))) start++;
  if (start >= stage.length) return { shell: false, downloads: subDownloads };
  const words = stage.slice(start);
  const commandAt: number[] = [0];
  if (WRAPPERS.has(base(words[0]!.text))) for (let i = 1; i < words.length; i++) commandAt.push(i);
  let shell = false;
  for (const index of commandAt) {
    const word = words[index]!;
    const name = base(word.text);
    const rest = words.slice(index + 1);
    if (index === 0 && word.dynamic) reasons.add(DYNAMIC);
    if (name === "rm" && hasRecursiveFlag(rest)) reasons.add(RECURSIVE_DELETE);
    if (name === "git" && gitSubcommand(rest) === "push") reasons.add(GIT_PUSH);
    if (PRIVILEGED.has(name)) reasons.add(PRIVILEGE);
    if (DOWNLOADERS.has(name)) downloads = true;
    if (SHELLS.has(name) || name === "su") {
      const script = dashC(rest);
      if (script !== undefined && analyze(script, reasons, depth + 1)) reasons.add(DOWNLOAD_TO_SHELL);
    }
    if (SHELLS.has(name) || EVALUATORS.has(name)) {
      shell = true;
      if (subDownloads) reasons.add(DOWNLOAD_TO_SHELL);
      if (name === "eval" && analyze(rest.map((item) => item.text).join(" "), reasons, depth + 1)) reasons.add(DOWNLOAD_TO_SHELL);
    }
  }
  return { shell, downloads: downloads || subDownloads };
}

function base(text: string): string {
  const slash = text.lastIndexOf("/");
  return slash === -1 ? text : text.slice(slash + 1);
}

function hasRecursiveFlag(args: Word[]): boolean {
  for (const arg of args) {
    const text = arg.text;
    if (text === "--") return false;
    if (text === "--recursive" || text.startsWith("--recursive=")) return true;
    if (/^-[A-Za-z]*[rR][A-Za-z]*$/.test(text)) return true;
  }
  return false;
}

/** git's subcommand after its global options. */
function gitSubcommand(args: Word[]): string | undefined {
  const withValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (withValue.has(text)) {
      i++;
      continue;
    }
    if (text.startsWith("-")) continue;
    return text;
  }
  return undefined;
}

/** The script of `sh -c script`, `bash -lc script`, `su -c script`. */
function dashC(args: Word[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (text === "--") return undefined;
    if (text === "-c" || text === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(text)) return args[i + 1]?.text;
  }
  return undefined;
}

/**
 * Split a script into pipelines of simple commands of words. Returns undefined when it does
 * not parse (unterminated quote or substitution). Redirections and their targets are dropped.
 */
function lex(script: string): Pipeline[] | undefined {
  const pipelines: Pipeline[] = [];
  let pipeline: Word[][] = [];
  let stage: Word[] = [];
  let word: Word | null = null;
  let redirectNext = false;
  const src = script.replace(/\\\r?\n/g, "");
  const n = src.length;
  let i = 0;

  const ensure = (): Word => (word ??= { text: "", subs: [], dynamic: false });
  const endWord = () => {
    if (word === null) return;
    if (redirectNext) {
      redirectNext = false;
      word.redirect = true;
    }
    stage.push(word);
    word = null;
  };
  const endStage = () => {
    endWord();
    redirectNext = false;
    if (stage.length) pipeline.push(stage);
    stage = [];
  };
  const endPipeline = () => {
    endStage();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };
  /** Index just past the `)` that closes a `(` opened at `open`, honoring quotes; -1 if none. */
  const closeParen = (open: number): number => {
    let depthCount = 1;
    let j = open + 1;
    while (j < n) {
      const c = src[j]!;
      if (c === "\\") j += 2;
      else if (c === "'") {
        const end = src.indexOf("'", j + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else if (c === '"') {
        j++;
        while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
        if (j >= n) return -1;
        j++;
      } else if (c === "`") {
        const end = src.indexOf("`", j + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else if (c === "(") {
        depthCount++;
        j++;
      } else if (c === ")") {
        depthCount--;
        j++;
        if (depthCount === 0) return j;
      } else j++;
    }
    return -1;
  };
  /** `$(...)`, `<(...)`, `>(...)` at `at` (the `(` is at at+1): adds the inside as a sub. */
  const substitution = (at: number): number => {
    const end = closeParen(at + 1);
    if (end === -1) return -1;
    const w = ensure();
    w.subs.push(src.slice(at + 2, end - 1));
    w.text += src.slice(at, end);
    w.dynamic = true;
    return end;
  };
  const backtick = (at: number): number => {
    let j = at + 1;
    while (j < n && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
    if (j >= n) return -1;
    const w = ensure();
    w.subs.push(src.slice(at + 1, j).replace(/\\`/g, "`"));
    w.text += src.slice(at, j + 1);
    w.dynamic = true;
    return j + 1;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n" || c === ";") {
      endPipeline();
      i++;
    } else if (c === "&") {
      if (src[i + 1] === ">") {
        endWord();
        redirectNext = true;
        i += src[i + 2] === ">" ? 3 : 2;
      } else {
        endPipeline();
        i += src[i + 1] === "&" ? 2 : 1;
      }
    } else if (c === "|") {
      if (src[i + 1] === "|") {
        endPipeline();
        i += 2;
      } else {
        endStage();
        i += src[i + 1] === "&" ? 2 : 1;
      }
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
      i = substitution(i);
      if (i === -1) return undefined;
    } else if (c === "<" || c === ">") {
      // A redirection: `>`, `>>`, `<`, `<<`, `<<<`, `>&`, `2>`, `2>&1`. Its target is not an argument.
      const pending = word as Word | null;
      if (pending !== null && /^\d+$/.test(pending.text)) word = null;
      else endWord();
      let j = i + 1;
      while (j < n && (src[j] === "<" || src[j] === ">" || src[j] === "&" || src[j] === "|" || src[j] === "-")) j++;
      // A here-document's body lines are parsed as commands too (fail closed); its delimiter is the target.
      redirectNext = true;
      i = j;
    } else if (c === "(" || c === ")") {
      endPipeline();
      i++;
    } else if (c === "#" && word === null) {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "\\") {
      if (i + 1 >= n) return undefined;
      ensure().text += src[i + 1];
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return undefined;
      ensure().text += src.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const w = ensure();
      let j = i + 1;
      for (;;) {
        if (j >= n) return undefined;
        const d = src[j]!;
        if (d === '"') break;
        if (d === "\\" && j + 1 < n && '"\\$`\n'.includes(src[j + 1]!)) {
          w.text += src[j + 1];
          j += 2;
        } else if (d === "$" && src[j + 1] === "(") {
          j = substitution(j);
          if (j === -1) return undefined;
        } else if (d === "`") {
          j = backtick(j);
          if (j === -1) return undefined;
        } else {
          if (d === "$" && /[A-Za-z_{]/.test(src[j + 1] ?? "")) w.dynamic = true;
          w.text += d;
          j++;
        }
      }
      i = j + 1;
    } else if (c === "$" && src[i + 1] === "(") {
      i = substitution(i);
      if (i === -1) return undefined;
    } else if (c === "`") {
      i = backtick(i);
      if (i === -1) return undefined;
    } else {
      const w = ensure();
      if (c === "$" && /[A-Za-z_{0-9@*#?$!-]/.test(src[i + 1] ?? "")) w.dynamic = true;
      w.text += c;
      i++;
    }
  }
  endPipeline();
  return pipelines;
}
