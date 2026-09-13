export type D1FailureKind =
  | "event-conflict"
  | "profile-conflict"
  | "username-conflict"
  | "guard"
  | "integrity"
  | "unknown";

export function classifyD1Failure(error: unknown): D1FailureKind {
  const visited = new Set<Error>();
  let failure: D1FailureKind = "unknown";
  for (let depth = 0; error instanceof Error && depth < 8; depth++) {
    if (visited.has(error)) break;
    visited.add(error);
    const message = error.message
      .replace(/^D1_ERROR:\s*/, "")
      .replace(
        /:\s*SQLITE_CONSTRAINT(?:_[A-Z_]+)?(?: \(extended: SQLITE_CONSTRAINT_[A-Z_]+\))?$/,
        "",
      );
    switch (message) {
      case "UNIQUE constraint failed: event_transaction_guards.singleton":
        return "event-conflict";
      case "NOT NULL constraint failed: profile_transaction_guards.singleton":
        return "profile-conflict";
      case "UNIQUE constraint failed: profile_records.username_key":
        return "username-conflict";
    }
    if (/^CHECK constraint failed: singleton\s*=\s*1$/.test(message)) {
      failure = "guard";
    } else if (
      failure === "unknown" &&
      (/^(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed(?::|$)/.test(
        message,
      ) ||
        /:\s*SQLITE_CONSTRAINT(?:_[A-Z_]+)?(?: \(extended: SQLITE_CONSTRAINT_[A-Z_]+\))?$/.test(
          error.message,
        ))
    ) {
      failure = "integrity";
    }
    error = error.cause;
  }
  return failure;
}
