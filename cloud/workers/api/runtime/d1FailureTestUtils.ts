export function observeD1FailureDatabase(
  db: D1Database,
  options: {
    beforeBatch?: (attempt: number) => Promise<void>;
    diagnosticFailure?: Error;
  } = {},
) {
  const batches: D1PreparedStatement[][] = [];
  const errors: unknown[] = [];
  const sessions: D1SessionBookmark[] = [];
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches.push(statements);
          await options.beforeBatch?.(batches.length);
          try {
            return await target.batch(statements);
          } catch (error) {
            errors.push(error);
            throw error;
          }
        };
      }
      if (property === "withSession") {
        return (constraint: D1SessionBookmark) => {
          sessions.push(constraint);
          if (options.diagnosticFailure) throw options.diagnosticFailure;
          return target.withSession(constraint);
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, batches, errors, sessions };
}
