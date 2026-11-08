// The supported Pi SDK exports no MCP config validator from its package root
// (1.5.0 still keeps it in dist/core/mcp-servers.js), so this read-only
// acceptance check stays aligned with Pi's own validator; never resolve
// credentials, execute commands, or return raw validation errors.
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): boolean {
  return record(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function exposure(value: unknown): boolean {
  return typeof value === "string" && [
    "codemode", "codemode-deferred", "deferred", "direct", "hidden",
  ].includes(value);
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  return new URL(value);
}

function validOAuth(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  for (const key of ["clientId", "clientSecret", "scope"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return false;
  }
  const callback = parseUrl(value.callbackUrl);
  if (value.callbackUrl !== undefined && (!callback || callback.protocol !== "http:" ||
    !LOOPBACK_HOSTS.includes(callback.hostname) || callback.search !== "" || callback.hash !== "" ||
    (callback.port !== "" && port !== undefined && Number(callback.port) !== port))) return false;
  if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
    return false;
  }
  if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
    if (value.clientRegistration !== "cimd" || value.clientId !== undefined || value.clientName !== undefined ||
      (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback"))) return false;
  }
  if (value.authServerMetadataUrl !== undefined) {
    const url = parseUrl(value.authServerMetadataUrl);
    if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
      return false;
    }
  }
  return true;
}

/** Validate native config entries; adapter-only fields such as disabled are not native settings. */
export function validNativeMcpServer(value: Record<string, unknown>): boolean {
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.exposure !== undefined && !exposure(value.exposure)) return false;
  if (value.toolExposure !== undefined && (!record(value.toolExposure) || !Object.values(value.toolExposure).every(exposure))) {
    return false;
  }
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (value.timeout !== undefined && (typeof value.timeout !== "number" || !(value.timeout > 0))) return false;
  const type = value.type;
  if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    const url = parseUrl(value.url);
    if (!url || !["http:", "https:"].includes(url.protocol)) return false;
    if (value.headers !== undefined && !stringRecord(value.headers)) return false;
    if (!validOAuth(value.oauth)) return false;
    if (value.auth !== undefined && (!record(value.auth) || typeof value.auth.provider !== "string" ||
      !value.auth.provider || (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)))) return false;
    return true;
  }
  if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
    if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))) {
      return false;
    }
    if (value.env !== undefined && !stringRecord(value.env)) return false;
    return value.cwd === undefined || typeof value.cwd === "string";
  }
  return false;
}
