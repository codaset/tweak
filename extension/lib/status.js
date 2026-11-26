// The connection status shown in the side panel: "connecting", "connected",
// "disconnected" or "refused" (with the bridge's message). A refusal stays
// shown until a try ends otherwise, or a new port makes it moot. Likewise,
// once the bridge is down it stays "disconnected" through each retry until
// one is accepted, so what follows it (faded pins, the badge, the side
// panel's start hint) doesn't flicker.
const clear = (connection) => ({ connection, message: "" });

export function nextStatus(status, event) {
  switch (event.type) {
    case "connecting": // a retry: a refusal or a down bridge stands until this try ends otherwise
      return status.connection === "refused" || status.connection === "disconnected" ? status : clear("connecting");
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
