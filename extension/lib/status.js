// The connection status shown in the side panel: "connecting", "connected",
// "disconnected" or "refused" (with the bridge's message). A refusal stays
// shown until a try ends otherwise, or a new port makes it moot.
const clear = (connection) => ({ connection, message: "" });

export function nextStatus(status, event) {
  switch (event.type) {
    case "connecting": // a retry: a refusal stands until this try ends otherwise
      return status.connection === "refused" ? status : clear("connecting");
    case "reconnect": // a new port: the old refusal no longer applies
      return clear("connecting");
    case "connected":
      return clear("connected");
    case "refused":
      return { connection: "refused", message: event.message };
    case "closed": // refused: this socket was the one refused
      return event.refused ? status : clear("disconnected");
    default:
      return status;
  }
}
