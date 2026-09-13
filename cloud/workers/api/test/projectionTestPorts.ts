import { gameplayTestPort } from "./gameSessionTestPorts.ts";
import {
  attachEventTestPorts,
  type EventTestSource,
} from "./eventTestPorts.ts";
import { eventReadFixture } from "./eventReadFixture.ts";
import type { StateRepository } from "../test/stateRepositoryTestTypes.ts";

export function attachProjectionTestPorts<T extends EventTestSource>(
  source: T,
) {
  const storage: StateRepository = {
    getPath: (path, query, signal) => {
      const read = source.getStatePath || source.getPath;
      if (!read) throw new Error("unexpected-projection-test-read");
      return read(path, query, signal);
    },
    patchRoot: (updates, signal) => {
      const patch = source.patchStateRoot || source.patchRoot;
      if (!patch) throw new Error("unexpected-projection-test-write");
      return patch(updates, signal);
    },
    transactPath: (path, updater, signal) => {
      const transact = source.transactStatePath || source.transactPath;
      if (!transact) throw new Error("unexpected-projection-test-transaction");
      return transact(path, updater, signal);
    },
  };
  const gameplay = gameplayTestPort(storage);
  if (typeof source.readInviteMetadata === "function") {
    gameplay.readInviteMetadata =
      source.readInviteMetadata as typeof gameplay.readInviteMetadata;
  }
  const reads = eventReadFixture(storage.getPath);
  for (const [name, method] of Object.entries(reads)) {
    if (!(name in source)) Reflect.set(source, name, method);
  }
  return attachEventTestPorts(Object.assign(source, gameplay));
}
