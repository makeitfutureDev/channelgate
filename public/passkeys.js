// Shared same-origin WebAuthn helper. No bundle or external browser dependency is needed.
(() => {
  function decode(value) {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  function encode(value) {
    let binary = "";
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function publicKeyOptions(options) {
    const decoded = { ...options, challenge: decode(options.challenge) };
    if (options.user) decoded.user = { ...options.user, id: decode(options.user.id) };
    for (const field of ["allowCredentials", "excludeCredentials"]) {
      if (options[field]) decoded[field] = options[field].map((credential) => ({ ...credential, id: decode(credential.id) }));
    }
    return decoded;
  }
  function serialize(credential) {
    if (!credential) throw new Error("No passkey was selected. Please try again.");
    const response = { clientDataJSON: encode(credential.response.clientDataJSON) };
    for (const field of ["attestationObject", "authenticatorData", "signature"]) {
      if (credential.response[field]) response[field] = encode(credential.response[field]);
    }
    if ("userHandle" in credential.response) response.userHandle = credential.response.userHandle ? encode(credential.response.userHandle) : null;
    if (credential.response.getTransports) response.transports = credential.response.getTransports();
    return {
      id: credential.id, rawId: encode(credential.rawId), type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults(), response,
    };
  }
  function available() {
    return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
  }
  function requireAvailable() {
    if (!available()) throw new Error("Passkeys need a supported browser and a secure HTTPS connection (or localhost).");
  }
  function errorMessage(error) {
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") return "Passkey request cancelled or timed out. You can try again.";
    if (error?.name === "InvalidStateError") return "This passkey is already registered. Use another authenticator to add a spare.";
    if (error?.name === "SecurityError") return "This address cannot use the gateway's passkeys. Open the configured gateway URL over HTTPS.";
    return error?.message || "Passkey verification failed. Please try again.";
  }
  window.ChannelGatePasskeys = Object.freeze({
    available, errorMessage,
    async create(options) {
      requireAvailable();
      return serialize(await navigator.credentials.create({ publicKey: publicKeyOptions(options) }));
    },
    async get(options) {
      requireAvailable();
      return serialize(await navigator.credentials.get({ publicKey: publicKeyOptions(options) }));
    },
  });
})();
