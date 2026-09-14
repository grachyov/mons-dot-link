export type SocketCapacityLimits = {
  sockets: number;
  spectators: number;
  spectatorsPerIp: number;
  socketsPerParticipant: number;
};

export function socketCapacityFull(
  role: string,
  counts: {
    sockets: number;
    spectators: number;
    spectatorsPerIp: number;
    socketsForRole: number;
  },
  limits: SocketCapacityLimits,
): boolean {
  return (
    counts.sockets >= limits.sockets ||
    (role === "spectator"
      ? counts.spectators >= limits.spectators ||
        counts.spectatorsPerIp >= limits.spectatorsPerIp
      : counts.socketsForRole >= limits.socketsPerParticipant)
  );
}
