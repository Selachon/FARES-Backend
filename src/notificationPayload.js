export function buildCertificateCreatedPayload(cert, options = {}) {
  const certificate = cert || {};
  const payload = {
    type: "CERTIFICATE_CREATED",
    certificate: {
      numCert: certificate.numCert,
      serial: certificate.serial,
      empresa: certificate.empresa,
    },
    timestamp: Number.isFinite(options.timestamp)
      ? options.timestamp
      : Date.now(),
    source: options.source || "realtime",
  };

  if (Number.isInteger(options.pendingCount) && options.pendingCount > 0) {
    payload.pendingCount = options.pendingCount;
  }

  if (Array.isArray(options.pendingNumbers) && options.pendingNumbers.length > 0) {
    payload.pendingNumbers = options.pendingNumbers
      .map((item) => {
        if (item === null || item === undefined) return "";
        return String(item).trim();
      })
      .filter(Boolean);
  }

  return payload;
}
