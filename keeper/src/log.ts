// Short structured log lines: "<iso time> <LEVEL> [component] message key=value ...".
// Callers must never pass secrets; nothing here reads the environment.
type Fields = Record<string, string | number | bigint | boolean | null | undefined>;

function fmt(level: string, component: string, message: string, fields?: Fields): string {
  let line = `${new Date().toISOString()} ${level} [${component}] ${message}`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      line += ` ${k}=${String(v)}`;
    }
  }
  return line;
}

export function logger(component: string) {
  return {
    info: (message: string, fields?: Fields) => console.log(fmt("INFO ", component, message, fields)),
    warn: (message: string, fields?: Fields) => console.warn(fmt("WARN ", component, message, fields)),
    error: (message: string, fields?: Fields) => console.error(fmt("ERROR", component, message, fields)),
  };
}

export type Logger = ReturnType<typeof logger>;

/** One-line, length-capped description of any thrown value. */
export function errText(err: unknown, max = 300): string {
  let text: string;
  if (err instanceof Error) {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    text = typeof short === "string" && short.length > 0 ? short : err.message;
  } else {
    text = String(err);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
