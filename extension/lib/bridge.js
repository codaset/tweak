// Where the bridge is, and which contract it speaks (docs/design.md, "Bridge
// contract"). Shared by the worker and the side panel.
export const DEFAULT_PORT = 47391;
export const PROTOCOL = 1; // internal/version.Protocol

export const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;
